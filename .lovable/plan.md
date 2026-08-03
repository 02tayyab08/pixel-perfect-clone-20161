# Switch to your own Gemini API key + rebuild the File Search store

## Short answer

Do not paste the key into chat. Once you approve this plan I will open a secure
secret form (Cloud secret `GEMINI_API_KEY`) where you enter the key yourself. It
is stored encrypted and never appears in chat or logs — only a `len/prefix/tail`
fingerprint is logged by the existing `[gemini-key]` line.

## Why a rebuild is unavoidable

A Gemini File Search store belongs to the Google project that owns the API key.
The SDK exposes only create / list / delete for stores and upload / list / delete
for documents — no export, copy, or ownership transfer, and indexed chunks cannot
be read back out. So the current store `salnisharedv21783566089761-mtddxxu2lj9k`
becomes unreachable (403) the moment the key changes, and a fresh store must be
created under your key and re-ingested.

The source of truth is safe: original files live in Supabase Storage and the
editable master lives in `documents.master_md`. Re-ingest replays from those.

## Steps

1. **Capture the key** — secure secret form for `GEMINI_API_KEY`. I confirm the
   new fingerprint from the `[gemini-key]` log line and that it is not `AQ.A…kcbw`.
2. **Point bootstrap at a fresh store** — clear the persisted shared store name
   and any per-org `organizations.file_search_store_name` override that still
   points at the old store, so the existing `claim_store_bootstrap` /
   `finalize_store_bootstrap` path creates a new store on the next call. No
   schema change, no new RPC: the reset is a data update through the service
   client in a one-shot admin server function.
3. **Verify the new store exists** — log the new store name once and confirm it
   lists as empty under your key.
4. **Re-ingest every document** — set every non-deleted `documents` row back to
   `queued` and clear `file_search_document_name`. The existing cron worker
   (`process-documents-worker`, every minute) drains the queue; the Phase 2a
   pre-upload sweep keeps it at one store copy per document.
5. **Watch it drain** — report per-org counts of `queued` → `ready` → `failed`,
   plus the raw error text for any row that ends `failed`.
6. **Verify end to end** — staff chat factual question returns a grounded answer
   with `grounding=` non-zero and no 403; widget question same; one citation
   chip opens with a real snippet.

## Cost and downtime

Re-ingest is one upload + indexing pass per document (currently ~20 documents),
billed to your Google project. During the window between step 2 and the queue
draining, chat will refuse for lack of grounding rather than error.

## Files to change

- `src/lib/store-bootstrap.server.ts` — no logic change; add a single log of the
  resolved store name for the record.
- `src/lib/admin.functions.ts` (new) — `resetSharedStoreAndReingest`, protected by
  `requireSupabaseAuth` plus an admin role check via `context.supabase` before
  any privileged client is loaded. Clears the shared store pointer, clears stale
  org overrides, re-queues documents.
- No schema migration. No change to the query path, models, prompts, or the
  refusal string.

## Rollback

If your key turns out to lack File Search access, restoring the previous key does
not restore the old store contents once step 2 has run — but nothing is lost:
re-ingest replays from Supabase Storage / `master_md` against whichever key is
active. I will confirm your key can create a store (step 3) before touching any
document rows.
