-- Incremental apply: add documents.master_md (Phase 2b editable master).
-- Source of truth remains 02_FINAL_SCHEMA_V3.sql — run this on live DBs
-- that already applied V3 before master_md existed.
-- Operator applies; app code must not invent this column.
--
-- master_md is a nullable text override: when present and non-empty, the
-- ingestion worker (process-documents) uploads this text to File Search
-- instead of the binary at storage_path. NULL/empty means "use the
-- original file" — today's behavior, unchanged for every existing row.

alter table public.documents
  add column if not exists master_md text;

comment on column public.documents.master_md is
  'Optional text override for ingestion (Phase 2b). When non-null and non-empty, process-documents uploads this text instead of the storage_path binary. NULL = original file (default, unchanged behavior).';

-- After applying, verify with:
--   select column_name, data_type, is_nullable
--   from information_schema.columns
--   where table_schema = 'public' and table_name = 'documents' and column_name = 'master_md';
