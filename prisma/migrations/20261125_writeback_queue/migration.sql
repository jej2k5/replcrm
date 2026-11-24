CREATE SCHEMA writeback;

CREATE TABLE writeback.submissions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id text,
  entity_key text,
  operation text,
  record_id text,
  fields jsonb,
  author_kind text,
  author_label text,
  reason text,
  idempotency_key text,
  status text NOT NULL CHECK (status IN ('accepted', 'refused')),
  change_request_id text,
  messages text[] NOT NULL,
  created_at timestamptz NOT NULL
);

-- Keep the in-memory policy predicate and canonical value rules in step with these helpers.
CREATE FUNCTION writeback.is_writable(attr public."AttributeDefinition", operation text)
RETURNS boolean LANGUAGE sql IMMUTABLE SET search_path = pg_catalog AS $$
  SELECT CASE WHEN operation = 'update' THEN attr."isUpdatable" ELSE attr."isCreatable" END
    AND NOT attr."isComputed" AND NOT attr."isSystem"
    AND attr."dataType"::text NOT IN ('Computed', 'Identifier')
    AND lower(attr.key) NOT IN ('record_id', 'source_id', 'is_deleted', 'source_modified_at',
                                'owner_id', 'owner_username', 'created_by_id', 'last_modified_by_id')
$$;

CREATE FUNCTION writeback.value_error(attr public."AttributeDefinition", value jsonb)
RETURNS text LANGUAGE plpgsql IMMUTABLE SET search_path = pg_catalog AS $$
DECLARE
  kind text := jsonb_typeof(value);
  raw text := value #>> '{}';
  number numeric;
  calendar_day text;
BEGIN
  IF kind = 'null' THEN
    IF NOT attr."isNullable" THEN RETURN 'null is not allowed'; END IF;
    RETURN NULL;
  END IF;
  CASE attr."dataType"::text
    WHEN 'Boolean' THEN
      IF kind <> 'boolean' THEN RETURN 'Canonical boolean required'; END IF;
    WHEN 'Number', 'Currency', 'Percent' THEN
      IF kind NOT IN ('number', 'string') OR raw !~ '^[+-]?([0-9]+(\.[0-9]*)?|\.[0-9]+)([eE][+-]?[0-9]+)?$' THEN
        RETURN 'Canonical number or decimal string required';
      END IF;
      number := raw::numeric;
      IF abs(round(number, 18)) >= 100000000000000000000 THEN
        RETURN 'Canonical decimal exceeds 20 integer digits';
      END IF;
      IF round(number, 18) <> number OR ((number::double precision)::text)::numeric <> number THEN
        RETURN 'Number cannot be represented without losing precision';
      END IF;
    WHEN 'Date', 'DateTime' THEN
      IF kind <> 'string' OR
          (attr."dataType"::text = 'Date' AND raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$') OR
          (attr."dataType"::text = 'DateTime' AND
           raw !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9]\.[0-9]{3}Z$') THEN
        RETURN 'Invalid canonical date or datetime';
      END IF;
      calendar_day := left(raw, 10);
      IF left(calendar_day, 4) = '0000' THEN calendar_day := '2000' || substr(calendar_day, 5); END IF;
      PERFORM calendar_day::date;
    WHEN 'Time' THEN
      IF kind <> 'string' OR raw !~ '^([01][0-9]|2[0-3]):[0-5][0-9]:[0-5][0-9](\.[0-9]{1,3})?$' THEN
        RETURN 'Canonical time HH:mm:ss[.SSS] required';
      END IF;
    WHEN 'MultiEnum' THEN
      IF kind <> 'array' THEN RETURN 'Canonical collection of strings required'; END IF;
      IF EXISTS (SELECT 1 FROM jsonb_array_elements(value) AS item
                 WHERE jsonb_typeof(item) <> 'string' OR (item #>> '{}') ~ '^$|;') THEN
        RETURN 'Invalid multi-value option';
      END IF;
    WHEN 'Reference', 'Composition' THEN
      IF (kind = 'object' AND value->>'kind' = 'reference' AND
          jsonb_typeof(value->'entityKey') = 'string' AND
          value->>'entityKey' = ANY(attr."referenceEntityKeys") AND
          jsonb_typeof(value->'sourceId') = 'string' AND value->>'sourceId' ~ '[^[:space:]]') IS NOT TRUE THEN
        RETURN 'Reference must identify a permitted source record';
      END IF;
    WHEN 'Address', 'Geolocation' THEN
      NULL;
    ELSE
      IF kind <> 'string' THEN RETURN 'Canonical string required for ' || attr."dataType"::text; END IF;
  END CASE;
  RETURN NULL;
EXCEPTION WHEN data_exception THEN
  RETURN 'Invalid canonical value';
END
$$;

CREATE FUNCTION writeback.enqueue_submission()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  entity_id text;
  policy public."WritebackPolicy"%ROWTYPE;
  target public."Record"%ROWTYPE;
  attr public."AttributeDefinition"%ROWTYPE;
  field record;
  normalized jsonb := '{}'::jsonb;
  problem text;
BEGIN
  NEW.status := 'refused';
  NEW.change_request_id := NULL;
  NEW.messages := ARRAY[]::text[];
  NEW.created_at := statement_timestamp();

  IF NEW.operation = 'delete' THEN
    NEW.messages := ARRAY['deletes are not supported by write-back'];
    RETURN NEW;
  ELSIF NEW.operation IS NULL OR NEW.operation NOT IN ('create', 'update') THEN
    NEW.messages := ARRAY['Unsupported write-back operation'];
    RETURN NEW;
  END IF;

  IF NEW.idempotency_key IS NOT NULL THEN
    SELECT id INTO NEW.change_request_id FROM public."ChangeRequest"
    WHERE "deploymentId" = NEW.deployment_id AND "idempotencyKey" = NEW.idempotency_key;
    IF FOUND THEN
      NEW.status := 'accepted';
      RETURN NEW;
    END IF;
  END IF;

  SELECT id INTO entity_id FROM public."EntityDefinition"
  WHERE "deploymentId" = NEW.deployment_id AND key = NEW.entity_key;
  IF NOT FOUND THEN
    NEW.messages := ARRAY['Unknown object ' || coalesce(NEW.entity_key, '(missing)')];
    RETURN NEW;
  END IF;

  SELECT * INTO policy FROM public."WritebackPolicy"
  WHERE "deploymentId" = NEW.deployment_id AND "entityKey" = NEW.entity_key;
  IF policy.enabled IS NOT TRUE THEN
    NEW.messages := array_append(NEW.messages, 'Write-back is disabled for ' || NEW.entity_key);
  END IF;

  IF jsonb_typeof(NEW.fields) IS DISTINCT FROM 'object' THEN
    NEW.messages := array_append(NEW.messages, 'Fields must be an object');
  ELSE
    IF NEW.operation = 'update' AND NEW.fields = '{}'::jsonb THEN
      NEW.messages := array_append(NEW.messages, 'An update requires at least one field');
    END IF;
    FOR field IN SELECT * FROM jsonb_each(NEW.fields) LOOP
      SELECT * INTO attr FROM public."AttributeDefinition"
      WHERE "entityDefinitionId" = entity_id AND key = field.key;
      IF NOT FOUND OR NOT writeback.is_writable(attr, NEW.operation) OR
         field.key = ANY(policy."excludedAttributeKeys") THEN
        NEW.messages := array_append(NEW.messages, field.key || ' is not writable on ' || NEW.operation);
      END IF;

      IF jsonb_typeof(field.value) <> 'object' OR NOT (field.value ? 'value') THEN
        NEW.messages := array_append(NEW.messages, field.key || ' requires a value');
      ELSIF attr.id IS NOT NULL THEN
        problem := writeback.value_error(attr, field.value->'value');
        IF problem IS NOT NULL THEN
          NEW.messages := array_append(NEW.messages, field.key || ' has an invalid value (' || problem || ')');
        END IF;
      END IF;

      IF NEW.operation = 'update' THEN
        IF jsonb_typeof(field.value) <> 'object' OR NOT (field.value ? 'base') THEN
          NEW.messages := array_append(NEW.messages, field.key || ' requires a base value');
        END IF;
        normalized := normalized || jsonb_build_object(field.key,
          jsonb_build_object('base', field.value->'base', 'value', field.value->'value'));
      ELSE
        normalized := normalized || jsonb_build_object(field.key, jsonb_build_object('value', field.value->'value'));
      END IF;
    END LOOP;
  END IF;

  IF NEW.operation = 'update' THEN
    SELECT * INTO target FROM public."Record"
    WHERE "deploymentId" = NEW.deployment_id AND "entityDefinitionId" = entity_id
      AND (id = NEW.record_id OR "sourceId" = NEW.record_id)
    ORDER BY (id = NEW.record_id) DESC LIMIT 1;
    IF NOT FOUND THEN
      NEW.messages := array_append(NEW.messages, 'Update target record does not exist');
    ELSIF target."isDeleted" THEN
      NEW.messages := array_append(NEW.messages, 'Update target record is deleted');
    ELSIF coalesce(target."sourceId", '') = '' THEN
      NEW.messages := array_append(NEW.messages, 'Update target record has no source ID');
    END IF;
  ELSE
    IF NEW.record_id IS NOT NULL THEN
      NEW.messages := array_append(NEW.messages, 'A create cannot have a target record');
    END IF;
    FOR attr IN SELECT a.* FROM public."AttributeDefinition" a
      WHERE a."entityDefinitionId" = entity_id AND writeback.is_writable(a, 'create')
        AND NOT a."isNullable" AND NOT a."hasCreateDefault"
        AND NOT coalesce(NEW.fields ? a.key, false)
      ORDER BY a.key
    LOOP
      NEW.messages := array_append(NEW.messages, attr.key || ' is required on create');
    END LOOP;
  END IF;

  IF NEW.author_kind IS NULL OR NEW.author_kind NOT IN ('person', 'app', 'agent') THEN
    NEW.messages := array_append(NEW.messages, 'Invalid author kind');
  END IF;
  IF NEW.author_label IS NULL OR NEW.author_label !~ '[^[:space:]]' THEN
    NEW.messages := array_append(NEW.messages, 'An author label is required');
  END IF;
  IF cardinality(NEW.messages) > 0 THEN RETURN NEW; END IF;

  INSERT INTO public."ChangeRequest" (
    id, "deploymentId", "entityKey", operation, "targetRecordId", "targetSourceId",
    fields, "authorKind", "authorLabel", reason, "idempotencyKey", "createdAt", "updatedAt"
  ) VALUES (
    gen_random_uuid()::text, NEW.deployment_id, NEW.entity_key, NEW.operation::public."ChangeOperation",
    target.id, target."sourceId", normalized, NEW.author_kind::public."ChangeAuthorKind",
    NEW.author_label, NEW.reason, NEW.idempotency_key,
    timezone('UTC', clock_timestamp()), timezone('UTC', clock_timestamp())
  ) ON CONFLICT ("deploymentId", "idempotencyKey") DO NOTHING
  RETURNING id INTO NEW.change_request_id;

  IF NEW.change_request_id IS NULL THEN
    SELECT id INTO STRICT NEW.change_request_id FROM public."ChangeRequest"
    WHERE "deploymentId" = NEW.deployment_id AND "idempotencyKey" = NEW.idempotency_key;
  END IF;
  NEW.status := 'accepted';
  RETURN NEW;
END
$$;

CREATE TRIGGER enqueue_submission BEFORE INSERT ON writeback.submissions
FOR EACH ROW EXECUTE FUNCTION writeback.enqueue_submission();

CREATE FUNCTION writeback.refuse_submission_mutation()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'writeback.submissions is insert-only';
END
$$;

CREATE TRIGGER submissions_insert_only BEFORE UPDATE OR DELETE OR TRUNCATE ON writeback.submissions
FOR EACH STATEMENT EXECUTE FUNCTION writeback.refuse_submission_mutation();

REVOKE ALL ON ALL FUNCTIONS IN SCHEMA writeback FROM PUBLIC;
