CREATE SCHEMA IF NOT EXISTS wide;
CREATE TABLE IF NOT EXISTS wide.__replcrm_projections (
  deployment_id text NOT NULL,
  entity_key text NOT NULL,
  table_name text NOT NULL UNIQUE,
  column_map jsonb NOT NULL,
  PRIMARY KEY (deployment_id, entity_key)
);
ALTER TABLE wide.__replcrm_projections ADD COLUMN watermark bigint;

CREATE TABLE wide.__replcrm_projection_positions (
  entity_id text PRIMARY KEY REFERENCES public."EntityDefinition"(id) ON DELETE CASCADE,
  position bigint NOT NULL,
  transaction_id bigint NOT NULL
);
CREATE TABLE wide.__replcrm_projection_changes (
  entity_id text NOT NULL REFERENCES wide.__replcrm_projection_positions(entity_id) ON DELETE CASCADE,
  record_id text NOT NULL,
  position bigint NOT NULL,
  PRIMARY KEY (entity_id, record_id)
);
CREATE INDEX ON wide.__replcrm_projection_changes (entity_id, position);
CREATE INDEX "Record_ownerId_idx" ON public."Record" ("ownerId");

-- The counter row serializes transactions in commit order for this entity.
CREATE FUNCTION public.replcrm_note_projection_change(entity text, record_key text)
RETURNS void LANGUAGE plpgsql SET search_path = pg_catalog AS $$
DECLARE
  writer bigint := txid_current();
  revision bigint;
BEGIN
  SELECT position INTO revision FROM wide.__replcrm_projection_positions
  WHERE entity_id = entity AND transaction_id = writer;
  IF NOT FOUND THEN
    INSERT INTO wide.__replcrm_projection_positions AS counter(entity_id, position, transaction_id)
    SELECT id, 1, writer FROM public."EntityDefinition" WHERE id = entity
    ON CONFLICT (entity_id) DO UPDATE SET position = counter.position + 1, transaction_id = writer
    RETURNING position INTO revision;
  END IF;
  IF revision IS NOT NULL THEN
    INSERT INTO wide.__replcrm_projection_changes AS change(entity_id, record_id, position)
    VALUES (entity, record_key, revision)
    ON CONFLICT (entity_id, record_id) DO UPDATE SET position = EXCLUDED.position
    WHERE change.position <> EXCLUDED.position;
  END IF;
END
$$;
REVOKE EXECUTE ON FUNCTION public.replcrm_note_projection_change(text, text) FROM PUBLIC;

CREATE FUNCTION public.replcrm_track_projection_record()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    PERFORM public.replcrm_note_projection_change(OLD."entityDefinitionId", OLD.id);
  ELSE
    IF TG_OP = 'UPDATE' AND (OLD."entityDefinitionId", OLD.id) IS DISTINCT FROM (NEW."entityDefinitionId", NEW.id) THEN
      PERFORM public.replcrm_note_projection_change(OLD."entityDefinitionId", OLD.id);
    END IF;
    PERFORM public.replcrm_note_projection_change(NEW."entityDefinitionId", NEW.id);
  END IF;
  RETURN NULL;
END
$$;

CREATE TRIGGER replcrm_projection_record_insert_delete AFTER INSERT OR DELETE ON public."Record"
FOR EACH ROW EXECUTE FUNCTION public.replcrm_track_projection_record();
CREATE TRIGGER replcrm_projection_record_update AFTER UPDATE ON public."Record"
FOR EACH ROW WHEN (
  (OLD.id, OLD."entityDefinitionId", OLD."deploymentId", OLD."sourceId", OLD."isDeleted", OLD."sourceModifiedAt",
   OLD."ownerId", OLD."createdById", OLD."lastModifiedById") IS DISTINCT FROM
  (NEW.id, NEW."entityDefinitionId", NEW."deploymentId", NEW."sourceId", NEW."isDeleted", NEW."sourceModifiedAt",
   NEW."ownerId", NEW."createdById", NEW."lastModifiedById")
) EXECUTE FUNCTION public.replcrm_track_projection_record();

CREATE FUNCTION public.replcrm_track_projection_value()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
DECLARE
  record_key text := CASE WHEN TG_OP = 'DELETE' THEN OLD."recordId" ELSE NEW."recordId" END;
BEGIN
  PERFORM public.replcrm_note_projection_change(r."entityDefinitionId", r.id)
  FROM public."Record" r WHERE r.id = record_key OR (TG_OP = 'UPDATE' AND r.id = OLD."recordId")
  ORDER BY r."entityDefinitionId", r.id;
  RETURN NULL;
END
$$;

CREATE TRIGGER replcrm_projection_value_insert_delete AFTER INSERT OR DELETE ON public."AttributeValue"
FOR EACH ROW EXECUTE FUNCTION public.replcrm_track_projection_value();
CREATE TRIGGER replcrm_projection_value_update AFTER UPDATE ON public."AttributeValue"
FOR EACH ROW WHEN (
  (OLD."recordId", OLD."attributeDefinitionId", OLD."textValue", OLD."numberValue", OLD."booleanValue",
   OLD."dateValue", OLD."dateTimeValue", OLD."referenceValue", OLD."jsonValue") IS DISTINCT FROM
  (NEW."recordId", NEW."attributeDefinitionId", NEW."textValue", NEW."numberValue", NEW."booleanValue",
   NEW."dateValue", NEW."dateTimeValue", NEW."referenceValue", NEW."jsonValue")
) EXECUTE FUNCTION public.replcrm_track_projection_value();

CREATE FUNCTION public.replcrm_track_projection_owner()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path = pg_catalog AS $$
BEGIN
  PERFORM public.replcrm_note_projection_change(r."entityDefinitionId", r.id)
  FROM public."Record" r WHERE r."ownerId" = NEW.id
  ORDER BY r."entityDefinitionId", r.id;
  RETURN NULL;
END
$$;
CREATE TRIGGER replcrm_projection_owner_update AFTER UPDATE ON public."User"
FOR EACH ROW WHEN (OLD.username IS DISTINCT FROM NEW.username)
EXECUTE FUNCTION public.replcrm_track_projection_owner();

REVOKE EXECUTE ON FUNCTION public.replcrm_track_projection_record() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.replcrm_track_projection_value() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.replcrm_track_projection_owner() FROM PUBLIC;

-- Historical values can still occupy their old typed slots after discovery.
-- Project those values when they cast cleanly until a source patch replaces them.
CREATE FUNCTION wide.__replcrm_cast_history(value anyelement, target regtype)
RETURNS text LANGUAGE plpgsql STABLE STRICT SET search_path = pg_catalog SET timezone = 'UTC' AS $$
DECLARE
  result text;
BEGIN
  EXECUTE format('SELECT ($1::%s)::text', target) INTO result USING value;
  RETURN result;
EXCEPTION WHEN data_exception OR cannot_coerce THEN
  RETURN NULL;
END
$$;
