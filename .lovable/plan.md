## Salni V2.1 — Phase 1 Build Plan (rev 2)

Changes from rev 1: `bootstrapStore()` wait behavior and signed upload URL semantics tightened per your feedback.

### Architecture decisions (locked from your answers)

- Stack: TanStack Start on Cloudflare Workers. All "Edge Functions" become TanStack **server functions** (`createServerFn`) for authenticated dashboard calls, and **server routes** under `src/routes/api/public/*` for external triggers (cron ping, Storage webhook, and later the widget).
- Backend: your existing Supabase Mumbai project. `SUPABASE_` is a reserved prefix in Lovable, so the three keys are stored as `SALNI_SUPABASE_URL`, `SALNI_SUPABASE_ANON_KEY`, `SALNI_SUPABASE_SERVICE_ROLE_KEY`. Schema/RPCs assumed deployed exactly per V2.1 — nothing altered.
- Secrets already saved: `GEMINI_API_KEY`, `CRON_WEBHOOK_SECRET`, `IP_HASH_SALT`, plus the three `SALNI_SUPABASE_*`.
- Gemini File Search via `@google/genai` with `GEMINI_API_KEY` directly. No Lovable AI Gateway.
- Widget never opens Realtime. Dashboard uses Realtime for `documents` status only.

### Deliverables in Phase 1

1. **Supabase clients** (server-only, `*.server.ts`):
   - `salniAnon()` — anon key, validates user bearer JWT.
   - `salniService()` — service role, all privileged DB/Storage work.
   - `salniAsUser(jwt)` — anon key + user JWT for RLS-scoped reads.
   Browser never sees any Supabase key or client.

2. **Auth** (email/password via Supabase Auth):
   - Routes: `/auth/sign-in`, `/auth/sign-up`, `/auth/callback`.
   - Session as httpOnly cookie set by a server fn; `/api/session` returns `{ userId, email, orgs }`.
   - `_authenticated` layout gates the dashboard.

3. **Onboarding** (`/onboarding`):
   - Form: org name + slug (auto-suggested).
   - Server fn calls `create_organization(name, slug)`. Slug-taken → suggestions (`slug-2`, `slug-3`, …).
   - On success, route to `/app/[slug]`.

4. **Store bootstrap** — `bootstrapStore()` server helper, called lazily before first upload/query:
   - Call `claim_store_bootstrap()`.
   - `ready` → return `store_name`.
   - `claimed` → create Gemini File Search store `salni-shared-v1` via `@google/genai`, then `finalize_store_bootstrap(name)`, return the name.
   - `wait` → **sleep 1s, re-call `claim_store_bootstrap()` once**. If still `wait` (or `claimed` from another worker not yet finalized), **throw `SetupInProgressError` → HTTP 409** with body `{ error: "setup_in_progress", retry_after_ms: 2000 }`. No long polling on the server; the client owns the wait UX.
   - Per-org override: if `organizations.file_search_store_name` non-null, use it and skip the shared bootstrap entirely.

5. **Row-first upload** (`/app/[slug]/documents`):
   - Client validates type + ≤50 MB; optional `can_upload_document` pre-check.
   - Server fn `createDocumentRow({ orgId, fileName, mimeType, size })`:
     1. Ensures store is ready via `bootstrapStore()` (may 409 — see below).
     2. Inserts `documents` row (`queued`, `storage_path = <org_id>/<document_id>/<file_name>`). Trigger errors `DOC_CAP_REACHED` → friendly cap message with plan name; `DOC_CAP_NO_PLAN` → support-contact error.
     3. **Only after the insert succeeds**, mints a **60-second signed upload URL** for that exact `storage_path` via the service-role client, and returns `{ documentId, storagePath, uploadUrl, uploadUrlExpiresAt }`.
   - Client PUTs the file to the signed URL within 60s. Upload failure → server fn `markDocumentUploadFailed(id)` sets row `failed` with "upload failed" (retryable).
   - **409 handling on the client:** the upload initiator (and the query client, below) catches HTTP 409 `setup_in_progress`, shows an inline "Setting up your workspace…" state (spinner + subtext), and retries the same server fn after `retry_after_ms` with jittered backoff up to ~30 s total, then surfaces "Still preparing your workspace — please retry in a moment" as a non-blocking notice. No error toast, no console error.
   - Realtime subscription in the dashboard on `documents` for live status.

6. **`process-documents` route** — `src/routes/api/public/process-documents.ts` (POST):
   - Cron path: header `x-cron-secret` must equal `CRON_WEBHOOK_SECRET`, else 401. Never uses the service key for authn.
   - Storage-webhook path: validate the Supabase-issued webhook signature header (HMAC over raw body, timing-safe compare). If your project isn't sending signed webhooks yet, the cron path fully covers the flow within 5 min.
   - Loop: `claim_queued_documents(5)` until empty.
   - Per doc: re-check Storage object size (>50 MB or missing → `update_document_status(id,'failed',null,'oversize or missing object')`); download; `ai.files.upload` into the store with `displayName` = file name and `customMetadata: [{key:'org_id',stringValue}, {key:'document_id',stringValue}]`; poll op; `update_document_status → 'ready'` (+ resource name) or `'failed'` (+ error).
   - Try/catch with exponential backoff on transient Gemini errors.

7. **Query server route** — `src/routes/api/public/query.ts` (POST) and a `queryAsMember` server fn for the dashboard. Both share the gate chain (widget wiring itself is Phase 2):
   - Ensure store ready via `bootstrapStore()` — same 409 contract; client polls with the same "setting up your workspace" state.
   - Resolve org (slug for widget, membership for dashboard). `is_active=false` → "This assistant is currently unavailable."
   - Widget only: `allowed_domains` origin check.
   - Widget only, in order: `check_rate_limit(org,'ref:'+end_user_ref,20)` → `check_org_hourly_ceiling(org,300)` → `check_rate_limit(org,'ip:'+sha256(ip+IP_HASH_SALT),120)`. Any false → high-demand reply.
   - `generateContent` on `gemini-2.5-flash` with `tools:[{fileSearch:{fileSearchStoreNames:[store], metadataFilter:'org_id="<uuid>"'}}]` and org `system_instruction`. **`org_id` in `metadataFilter` is resolved server-side; any org id in the client payload is discarded.**
   - Stream tokens (SSE). Persist `messages` (tokens + latency), parse `groundingMetadata.groundingChunks[]`, link each via `customMetadata.document_id` → `documents.id`, insert `citations`. Call `record_query_usage(org)`.
   - Grounding miss → literal `"I don't have that in the provided documents."`. Gemini 429/5xx → backoff → friendly fallback.

8. **Design system baseline** (only what Phase 1 needs to not look like a template):
   - Semantic tokens in `src/styles.css`: neutral palette + one restrained accent (deep teal `oklch(0.55 0.09 195)`); serif display (Fraunces) + sans body (Inter); IBM Plex Arabic loaded via `<link>` in `__root.tsx` head (used by AR later).
   - Real head metadata (title "Salni — AI Knowledge Assistant", description, og/twitter tags). Sitemap + robots at end of Phase 1.

### Explicitly NOT in Phase 1

Widget (`/embed/:slug`), lead capture UI, deletion Edge Function, compliance pages, audit wiring beyond obvious document events, EN/AR toggle in the widget, team invites. Those are Phase 2/3.

### Technical / risk notes

- I cannot verify the Mumbai schema, RPCs, `documents` bucket, or cron from here. If a call errors with "function does not exist" / "relation does not exist", I stop and report — I will NOT create replacement schema.
- `@supabase/supabase-js` and `@google/genai` both run on the Worker under `nodejs_compat`. All Supabase clients live in `*.server.ts`.
- `SetupInProgressError` is a shared server-side class; the server route returns `Response.json({error:'setup_in_progress',retry_after_ms:2000},{status:409, headers:{'Retry-After':'2'}})`, and the server-fn variant maps to the same shape via a typed return so `useServerFn` callers can `switch` on it.

### Checkpoint report at end of Phase 1

I'll report which of acceptance criteria 1–4 and (partially) 5, 10 pass, and flag anything stubbed.

Reply "go" to build Phase 1, or edit any of the above first.