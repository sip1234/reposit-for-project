-- Derived index data lives on the existing document-version chunk, never in an editable second body table.
CREATE FUNCTION retrieval_normalize_v1(text) RETURNS text LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  SELECT regexp_replace(lower(normalize($1, NFKC)), '[[:space:]]+', ' ', 'g')
$$;
CREATE FUNCTION retrieval_terms_v1(text) RETURNS text[] LANGUAGE sql IMMUTABLE STRICT PARALLEL SAFE AS $$
  WITH words AS (
    SELECT (regexp_matches(retrieval_normalize_v1($1), '[一-鿿㐀-䶿]+|[a-z0-9μ]+(?:[._/:-][a-z0-9μ]+)*', 'g'))[1] AS word
  ), terms AS (
    SELECT 'c:'||substring(word FROM n FOR width) AS term FROM words
      CROSS JOIN generate_series(1,2) width CROSS JOIN LATERAL generate_series(1,char_length(word)-width+1) n
      WHERE word ~ '^[一-鿿㐀-䶿]'
    UNION ALL SELECT 'a:'||word FROM words WHERE word !~ '^[一-鿿㐀-䶿]'
    UNION ALL SELECT 'a:'||part FROM words
      CROSS JOIN LATERAL regexp_split_to_table(word,'[._/:-]+') part
      WHERE word ~ '[a-zμ]' AND word !~ '^[一-鿿㐀-䶿]' AND part<>''
  ) SELECT coalesce(array_agg(DISTINCT term ORDER BY term),ARRAY[]::text[]) FROM terms
$$;
ALTER TABLE parsing_version_chunks ADD COLUMN lexical_terms text[] GENERATED ALWAYS AS (retrieval_terms_v1(content)) STORED;
CREATE INDEX parsing_chunk_lexical_gin ON parsing_version_chunks USING gin(lexical_terms);
CREATE TABLE retrieval_configs (
  id uuid PRIMARY KEY, name text NOT NULL, config jsonb NOT NULL, config_hash text NOT NULL UNIQUE,
  schema_version integer NOT NULL DEFAULT 1, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE retrieval_defaults (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton), config_id uuid NOT NULL REFERENCES retrieval_configs(id)
);
CREATE TABLE retrieval_runs (
  id uuid PRIMARY KEY, query text NOT NULL, scope jsonb NOT NULL, config_id uuid REFERENCES retrieval_configs(id),
  config_snapshot jsonb NOT NULL, status text NOT NULL CHECK(status IN ('complete','failed')),
  trace jsonb NOT NULL, results jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX retrieval_runs_created_idx ON retrieval_runs(created_at DESC);
