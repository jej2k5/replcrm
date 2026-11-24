CREATE VIEW writeback.pending_edits AS
SELECT id AS change_request_id, "deploymentId" AS deployment_id, "entityKey" AS entity_key,
       "targetRecordId" AS record_id, coalesce("resultingSourceId", "targetSourceId") AS source_id,
       operation, status, fields, "authorLabel" AS author_label, "createdAt" AS created_at
FROM public."ChangeRequest"
WHERE status IN ('pending', 'conflict', 'unknown');

-- Convert projection timestamps and local reference IDs to canonical submission values.
CREATE FUNCTION writeback.projection_value(deployment text, data_type text, input jsonb)
RETURNS jsonb LANGUAGE plpgsql STABLE SET search_path = pg_catalog AS $$
DECLARE
  raw text := input #>> '{}';
  stamp timestamp;
  reference jsonb;
BEGIN
  IF input = 'null'::jsonb THEN RETURN input; END IF;
  CASE data_type
    WHEN 'DateTime' THEN
      stamp := raw::timestamptz AT TIME ZONE 'UTC';
      IF date_trunc('milliseconds', stamp) <> stamp THEN
        RAISE EXCEPTION 'Projection datetime must have millisecond precision';
      END IF;
      RETURN to_jsonb(to_char(stamp, 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'));
    WHEN 'Reference', 'Composition' THEN
      SELECT jsonb_build_object('kind', 'reference', 'entityKey', e.key, 'sourceId', r."sourceId")
      INTO reference
      FROM public."Record" r JOIN public."EntityDefinition" e ON e.id = r."entityDefinitionId"
      WHERE r.id = raw AND r."deploymentId" = deployment;
      RETURN coalesce(reference, input);
    ELSE
      RETURN input;
  END CASE;
END
$$;

CREATE FUNCTION writeback.capture_projection_edit()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  deployment text := TG_ARGV[0];
  entity text := TG_ARGV[1];
  columns jsonb := TG_ARGV[2]::jsonb;
  operation text;
  previous jsonb;
  incoming jsonb;
  field record;
  fields jsonb := '{}'::jsonb;
  blocked text[] := ARRAY[]::text[];
  problems text[];
  request_id text;
BEGIN
  IF current_setting('replcrm.sync', true) = 'on' THEN
    IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'deletes are not supported by write-back';
  END IF;

  operation := CASE TG_OP WHEN 'UPDATE' THEN 'update' ELSE 'create' END;
  previous := CASE TG_OP WHEN 'UPDATE' THEN to_jsonb(OLD) ELSE '{}'::jsonb END;
  incoming := to_jsonb(NEW);
  FOR field IN
    SELECT physical.key AS column_name, physical.value, previous -> physical.key AS base,
           mapped.key AS attribute_key, a."dataType"::text AS data_type,
           writeback.is_writable(a, operation) AND NOT (a.key = ANY(p."excludedAttributeKeys")) AS writable
    FROM jsonb_each(incoming) physical
    LEFT JOIN jsonb_each_text(columns) mapped ON mapped.value = physical.key
    LEFT JOIN public."EntityDefinition" e ON e."deploymentId" = deployment AND e.key = entity
    LEFT JOIN public."AttributeDefinition" a ON a."entityDefinitionId" = e.id AND a.key = mapped.key
    LEFT JOIN public."WritebackPolicy" p ON p."deploymentId" = deployment AND p."entityKey" = entity
    WHERE (TG_OP = 'UPDATE' AND physical.value IS DISTINCT FROM previous -> physical.key)
       OR (TG_OP = 'INSERT' AND physical.value <> 'null'::jsonb)
    ORDER BY physical.key
  LOOP
    IF field.writable IS NOT TRUE THEN
      blocked := array_append(blocked, field.column_name);
      CONTINUE;
    END IF;
    fields := fields || jsonb_build_object(field.attribute_key,
      jsonb_build_object('value', writeback.projection_value(deployment, field.data_type, field.value))
      || CASE WHEN operation = 'update' THEN
        jsonb_build_object('base', writeback.projection_value(deployment, field.data_type, field.base))
      ELSE '{}'::jsonb END);
  END LOOP;
  IF cardinality(blocked) > 0 THEN
    RAISE EXCEPTION 'Columns are not writable on %: %', operation, array_to_string(blocked, ', ');
  END IF;
  IF operation = 'update' AND fields = '{}'::jsonb THEN RETURN NULL; END IF;

  INSERT INTO writeback.submissions (deployment_id, entity_key, operation, record_id, fields, author_kind, author_label)
  VALUES (deployment, entity, operation, previous ->> 'record_id', fields, 'person',
          coalesce(nullif(current_setting('replcrm.author', true), ''), session_user::text))
  RETURNING change_request_id, messages INTO request_id, problems;
  IF request_id IS NULL THEN
    RAISE EXCEPTION '%', array_to_string(problems, E'\n');
  END IF;
  RETURN NULL;
END
$$;

REVOKE ALL ON FUNCTION writeback.projection_value(text, text, jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION writeback.capture_projection_edit() FROM PUBLIC;
