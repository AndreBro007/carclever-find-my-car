/** Catalogue database schema (PostgreSQL). Idempotent: safe to run on every load. */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS dealer (
  id integer PRIMARY KEY,
  name text, street text, city text, state char(2), zip char(5), lat real, lon real
);
CREATE TABLE IF NOT EXISTS listing (
  id text PRIMARY KEY,
  vin char(17) NOT NULL,
  year smallint,
  make text NOT NULL, make_key text NOT NULL,
  model text NOT NULL, model_key text NOT NULL,
  trim text,
  condition char(1),
  price integer, odometer integer,
  body_raw text, body_class text, doors smallint,
  ext_color text, int_color text,
  dealer_id integer, state char(2), zip char(5), lat real, lon real,
  image_url text,
  link_override text,
  loaded_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE listing ADD COLUMN IF NOT EXISTS first_seen date;
ALTER TABLE listing ADD COLUMN IF NOT EXISTS price_prev integer;
ALTER TABLE listing ADD COLUMN IF NOT EXISTS price_changed_at date;
CREATE UNLOGGED TABLE IF NOT EXISTS listing_stage (
  id text, vin char(17), year smallint, make text, make_key text, model text, model_key text, trim text,
  condition char(1), price integer, odometer integer, body_raw text, body_class text, doors smallint,
  ext_color text, int_color text, dealer_id integer, state char(2), zip char(5), lat real, lon real,
  image_url text, link_override text, dealer_name text, dealer_street text, dealer_city text
);
CREATE TABLE IF NOT EXISTS catalog_meta (key text PRIMARY KEY, value text NOT NULL);
CREATE INDEX IF NOT EXISTS listing_vin_idx ON listing (vin);
CREATE INDEX IF NOT EXISTS listing_make_model_year_idx ON listing (make_key, model_key, year);
CREATE INDEX IF NOT EXISTS listing_body_price_idx ON listing (body_class, price);
CREATE INDEX IF NOT EXISTS listing_state_idx ON listing (state);
CREATE INDEX IF NOT EXISTS listing_lat_lon_idx ON listing (lat, lon);
CREATE INDEX IF NOT EXISTS listing_price_idx ON listing (price);
`;

/** Columns copied into listing_stage, in order (the COPY text format below must match). */
export const STAGE_COLUMNS = [
  "id", "vin", "year", "make", "make_key", "model", "model_key", "trim", "condition", "price", "odometer",
  "body_raw", "body_class", "doors", "ext_color", "int_color", "dealer_id", "state", "zip", "lat", "lon",
  "image_url", "link_override", "dealer_name", "dealer_street", "dealer_city",
] as const;
