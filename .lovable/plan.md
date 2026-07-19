# Fix: staff chat 403 on File Search store

## Root cause (evidence in logs, not a guess)

Published worker log for the failed turn:

```
gemini.generateContentStream failed name=ApiError status=403
  "You do not have permission to access the file search store
   salnisharedv1-9sqs31x63vml or it may not exist."
```

The current `GEMINI_API_KEY` (`prefix=AQ.A tail=kcbw`) belongs to a different Gemini project than the one that originally created `salnisharedv1-9sqs31x63vml`. File Search stores are project-scoped, so the persisted `app_state.shared_store_name` is now unreachable. `bootstrapStore` reads `status:ready` from `claim_store_bootstrap` and returns the dead name unchanged.

Model bump is not implicated:
- `[gemini-model] query=gemini-3.5-flash source=default` — env resolution correct.
- No `INVALID_ARGUMENT`, no `thinkingConfig` complaint — the request shape (including `thinkingLevel: LOW`) was accepted.
- The 403 is store-permission, not model/tool.

Side note: `[query-expansion] skipped: timeout` on `gemini-3.1-flash-lite` — the 800ms budget missed on cold path. Non-fatal (fail-open), not the failure. Leave for a separate pass.

## Fix (schema is law — do NOT bypass RPCs)

The recovery has to happen through the existing bootstrap RPCs in `02_FINAL_SCHEMA_V3.sql`. I will:

### 1. Confirm current state before touching anything
- Read `app_state` row to confirm `shared_store_name = 'salnisharedv1-9sqs31x63vml'`.
- Read any `organizations.file_search_store_name` overrides — if a per-org override exists and is also orphaned, same problem applies to that org.
- List stores under the current key via `ai.fileSearchStores.list()` in a one-shot server function log to prove the store isn't visible.

### 2. Reset shared bootstrap state via a new admin RPC
Add migration that introduces `reset_store_bootstrap()`:
- `SECURITY DEFINER`, granted to `service_role` only.
- Clears `app_state.shared_store_name` and resets any claim/lease columns so the next `claim_store_bootstrap()` call returns `claimed` and re-creates the store under the current key.
- No changes to the `claim_store_bootstrap` / `finalize_store_bootstrap` contract already used by `bootstrapStore`.

### 3. Trigger a one-time reset + re-bootstrap
- Add a protected `createServerFn` `resetSharedStore` gated behind `requireSupabaseAuth` + `has_role(auth.uid(), 'admin')`. On call: RPC `reset_store_bootstrap`, then `bootstrapStore(null)` which enters the `claimed` branch and creates a fresh store on the current key.
- Also delete the old (unreachable) store name from any `organizations.file_search_store_name` overrides that match the orphan.
- After reset, org documents will need to be re-uploaded to the new store. The document-processing path already handles enqueue/re-upload against the current shared store — I will confirm the reprocess trigger exists (or add a "reprocess all" admin action if it doesn't).

### 4. Verify
- Staff chat one factual question → expect `[query] grounding=<n>` non-zero, no 403.
- Widget one factual question → same.
- Log the new store name once from `bootstrapStore` for the record.

## Not doing in this change

- No touch to `thinkingLevel`, `QUERY_MODEL`, `expandQueryTerms`, tool array shape, or prompt text. All ruled out by the raw error.
- No revert of the model bump. Cursor's changes stay.
- No schema rewrite — only an additive `reset_store_bootstrap` RPC in a new migration.

## Files to change

- `supabase/migrations/<ts>_reset_store_bootstrap.sql` — new RPC + grants (adheres to public-schema-grants + user-roles rules).
- `src/lib/store-bootstrap.server.ts` — small helper to invoke the reset (server-only).
- `src/lib/admin.functions.ts` (new or existing) — `resetSharedStore` protected server fn; admin-role checked via `context.supabase` under RLS before importing `supabaseAdmin`.
- No client UI change required for the fix itself (I'll call it once from a server-fn invocation); can add an admin button later if you want.

## Open question before I build

The re-created store will be empty. Do you want the reset fn to also enqueue a full reprocess of every org's documents into the new store in the same turn, or should reprocess be a separate explicit admin step so you can watch it? Default I'll go with if you don't answer: same turn, enqueue all, log per-org counts.
