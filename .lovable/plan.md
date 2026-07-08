## Root cause

The post-login org read and the documents-page org resolution both bypass what should be an RLS-scoped, user-JWT read:

- `src/routes/api/session.ts` and `src/lib/session.functions.ts` load `organization_members` with `salniService()` (service role). Service role bypasses RLS, so it never returns "permission denied", but it also masks the real problem: if the row/join really is invisible to the user's JWT, we won't know why. And your prior turn's log ("org membership reads were empty due to API permission denial") points at a Data API exposure/grant problem that service-role reads paper over — so onboarding gets re-shown because the merged list is empty for that user.
- `src/routes/_authenticated.app.$slug.tsx` derives the org purely from `context.session.orgs`. When the session read returns `[]`, `beforeLoad` redirects to `/app` → `_authenticated.app.tsx` sees `orgs.length===0` → `/onboarding`. That's the "asks me to create an organization again" loop.
- `src/lib/documents.functions.ts` `createDocumentRowFn` calls `svc.from("organizations").select(...).eq("id", data.orgId)` with service role. When `org.id` in the client-side session context is stale/missing, `data.orgId` is wrong and the row lookup returns `null` → "Organization not found". Also, the membership check `is_org_member` runs as the user — if the org read was faked from the cookie but the user isn't actually a member per RLS, `assertOrgMember` will throw.

Fix: run the user-facing reads as the authenticated user (`salniAsUser(user.accessToken)`), log the raw Supabase error, and — if the read actually returns `permission denied for table X` — surface which table needs Data API exposure/grants so you can enable it in the dashboard (no schema changes from us).

## Changes

### 1. `src/lib/session.functions.ts` — read orgs as the user

- Replace `salniService()` with `salniAsUser(user.accessToken)`.
- Query: `.from("organization_members").select("role, organization_id, org:organizations(id, name, slug)").eq("user_id", user.userId)`.
- On error, `console.error("getSessionFn orgs read failed", { code, message, details, hint })` including the PostgREST `hint` (this is what tells you "permission denied for table organizations" vs "…organization_members").
- Do NOT merge cookie orgs when the DB read succeeds with `[]` — only fall back to cookie orgs when the read errored. An empty successful read means "genuinely no memberships", so onboarding is correct.
- Normalize the join whether Supabase returns `org` as an object or a single-element array (types already handle both).

### 2. `src/routes/api/session.ts` — same change

Mirror the above (user-JWT client, same logging, same "only fall back on error" rule). This is the endpoint the sign-in page hits to decide where to route.

### 3. `src/routes/auth.sign-in.tsx` — respect the real org list

Already navigates to the first org's slug when `/api/session` returns one — keep that, no logic change beyond confirming the code path works once (1)/(2) return real data.

### 4. `src/lib/documents.functions.ts` — resolve org as the user, and log

- `createDocumentRowFn`: switch the `organizations` lookup from `salniService()` to `salniAsUser(user.accessToken)` (RLS should already let a member `SELECT` their org). Log the raw error on failure. Keep `assertOrgMember` (RPC `is_org_member`) as the authoritative membership check.
- Keep the `documents` insert and `storage_path` update on service role (that's how the DB trigger cap-gate is designed and how signed upload URLs are minted). Not touching that.
- If the `organizations` read returns `permission denied`, report the exact table + hint back to you rather than silently switching to service role.

### 5. `src/lib/session.server.ts` — stop trusting cookie orgs to bypass routing

- Keep `addSessionOrg` (still useful right after `create_organization` before the next request lands), but the routing decision in `_authenticated.app.tsx` must be driven by the DB read, not the cookie. No code change here — just documented — the routing fix comes from (1)/(2) returning authoritative results.

### 6. Diagnostics run (no code, one-shot)

After the edits, in the running app I'll:
- Hit `/api/session` while signed in and read the server logs for the raw Supabase error.
- If logs show `permission denied for table organization_members` or `…organizations`, I'll stop and tell you exactly which table + which role (`authenticated`) needs `GRANT SELECT` in the Data API — you enable it in the Supabase dashboard, no migration from me.
- If logs show the read succeeds and returns rows, verify sign-in lands on `/app/[slug]`, refresh persists, and an upload reaches `queued`.

## Files touched

- `src/lib/session.functions.ts`
- `src/routes/api/session.ts`
- `src/lib/documents.functions.ts`

No schema/migration changes. No service-role workaround for user-facing reads.

## Verification checklist

1. Sign in with existing account → `/api/session` returns `orgs: [{...}]` → redirected straight to `/app/<slug>`.
2. Hard refresh on `/app/<slug>/documents` → stays signed in, org resolves, no `/onboarding` bounce.
3. Upload a file → `createDocumentRowFn` returns `ok:true` with `documentId` + signed URL → row status `queued`.
4. If any Data API grant is missing, report the exact table + role instead of patching around it.