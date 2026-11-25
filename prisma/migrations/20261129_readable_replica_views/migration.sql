CREATE TABLE wide.__replcrm_view_schemas (
  deployment_id text PRIMARY KEY,
  schema_name text NOT NULL UNIQUE
);

CREATE TABLE wide.__replcrm_readable_views (
  deployment_id text NOT NULL REFERENCES wide.__replcrm_view_schemas (deployment_id),
  entity_key text NOT NULL,
  view_name text NOT NULL,
  suffixed boolean NOT NULL,
  columns jsonb NOT NULL,
  PRIMARY KEY (deployment_id, entity_key),
  UNIQUE (deployment_id, view_name)
);

CREATE FUNCTION wide.__replcrm_reject_view_delete()
RETURNS trigger LANGUAGE plpgsql SET search_path = pg_catalog AS $$
BEGIN
  RAISE EXCEPTION 'deletes are not supported by write-back';
END;
$$;
