# Diagnose the three failures — surface raw errors first

You asked for real errors, not another guess-patch. Here's the plan.

## 1. Upload — "Could not create upload URL"

`src/lib/documents.functions.ts` (~line 181) swallows the Storage error into a generic string. Raw error is logged but not returned.

Change: return the raw `code | message | statusCode | name` in the response `error`, and expand the `console.error` to include `status`, `error`, `name`.

Once we see the raw error, classify:
- `Bucket not found` → `documents` bucket was never created. Fix: create a **private** bucket via the storage tool (metadata only, not schema).
- `permission denied for table storage.objects` (or `…buckets`) → **grant gap on the storage schema**, same class as the `public.documents` grant fix. Service role is supposed to have `ALL` on `storage.*` by default, but if Lovable Cloud provisioning skipped it, `createSignedUploadUrl` (which does an `INSERT` into `storage.objects` server-side) will 401/403 even with service role. Fix via migration: `GRANT ALL ON storage.objects TO service_role; GRANT ALL ON storage.buckets TO service_role;` (and `USAGE ON SCHEMA storage`). No schema change; only grants.
- `new row violates row-level security policy` on `storage.objects` → an explicit deny policy targeting `service_role`. I'll report the policy name and ask before altering it.

I'll pick the fix from the raw error, not by guessing. No silent auth-method swap.

## 2. Documents stuck in `queued`

I can answer without more logging: `process-documents` has never been invoked. No cron, no Storage webhook, no post-upload ping. The route exists at `src/routes/api/public/process-documents.ts` and rejects anything without `x-cron-secret`.

Wire it manually as a stopgap:

- **URL (preview):** `https://project--630a3e42-fc47-4ca6-8422-2565286ac163-dev.lovable.app/api/public/process-documents`
- **URL (published):** `https://project--630a3e42-fc47-4ca6-8422-2565286ac163.lovable.app/api/public/process-documents`
- **Method:** `POST`
- **Headers:**
  - `x-cron-secret: <CRON_WEBHOOK_SECRET>` (required)
  - `content-type: application/json`
- **Body:** `{}` — handler ignores it, drains the queue via `claim_queued_documents`.
- **Response:** `{ ok: true, processed, failed }` or `401`.

I'll check whether `CRON_WEBHOOK_SECRET` is set; if not, flag it so you can add it before configuring the webhook.

Once it's actually invoked and still fails, I'll surface the raw `claim_queued_documents` / Gemini errors back to the caller in the response body so we don't have to dig through logs.

## 3. Query — "something went wrong"

Two generic-error sites in `src/routes/api/query.ts`:
- Pre-stream failures (bootstrap, membership, conversation insert) return bare status strings.
- In-stream `catch` around `generateContentStream` writes a fallback into the SSE, losing the real error.

Change:
- Pre-stream: return the raw error message in the response body.
- In-stream: emit an SSE `{ type: "error", message }` frame with the raw error (name/message/status).
- `src/routes/_authenticated.app.$slug.chat.tsx`: render the raw error frame / non-ok body verbatim (dev diagnostic).

Likely root causes we'll see:
1. `bootstrapStore` throwing — missing `GEMINI_API_KEY`, `claim_store_bootstrap` RPC error, or Gemini `fileSearchStores.create` failure.
2. Zero grounded chunks → `NOT_IN_DOCS` (only after #2 works).

## Files changed (diagnostics only)

- `src/lib/documents.functions.ts` — return raw `createSignedUploadUrl` error; expand log fields.
- `src/routes/api/query.ts` — raw error on pre-stream failures; SSE error frame with raw message.
- `src/routes/_authenticated.app.$slug.chat.tsx` — render raw error verbatim.

No schema changes. No auth-method swaps. No `process-documents` code changes yet.

## After you approve

1. I apply the three diagnostic edits.
2. I check whether `CRON_WEBHOOK_SECRET` exists.
3. You retry one upload + one chat message.
4. You paste back the three raw error strings.
5. I apply the targeted root-cause fix per error — including a storage-schema `GRANT` migration if that's what upload turns out to be.
