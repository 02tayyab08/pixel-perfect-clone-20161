# PROJECT_HANDOFF.md — Salni

**Handoff written:** 2026-07-20 (end of a long working session)
**Updated:** 2026-07-21 — production outage **RESOLVED** (see Section 2). Part 2 §8.0 and BRANCH STATE updated same day.

---

## 1. PROJECT OVERVIEW

### What this is

**Salni** (Arabic: سَلْني, "ask me") is a multi-tenant, white-label AI knowledge-assistant SaaS.

Each tenant (a business) uploads their own documents. They get a branded chat assistant that answers questions **strictly from those documents**, with citations. There are two surfaces:

1. **Staff dashboard chat** — authenticated org members ask questions internally. Full citations + evidence panel. No lead capture, ever.
2. **Public embeddable widget** — anonymous visitors on the tenant's own website/social links. Conversational, designed to hook the visitor and generate leads.

### Who it's for

UAE / Dubai SMBs, specifically **business-setup and visa consultancies** (free-zone company formation agents). The test corpus is IFZA and Meydan free-zone fee schedules.

Two customer-validated use cases (from a real conversation with a business):
- **Internal staff / onboarding Q&A** — new and existing employees asking questions about the company's own documents. No lead generation needed.
- **Customer acquisition via online/social channels** — the public widget acting as a staff member, conversing with prospects and capturing leads.

### Goal / success criteria

Per the project brief (`00_PRODUCT_BRIEF`): **one real Dubai business live on the product.** That is the finish line, not feature completeness.

### Commercial model

- Plans: **AED 349 / 749 / 1,499 per month**
- Billing is **manual** in V1 — an `is_active` boolean on the organization gates access. No Stripe integration built.

### Stack

| Layer | Technology |
|---|---|
| Framework | TanStack Start |
| Runtime | Cloudflare Workers (workerd) |
| Database | External Supabase (Mumbai region) |
| RAG | Google Gemini **File Search** (managed RAG) |
| Gemini SDK | `@google/genai` — **`2.10.0` in `bun.lock`**, **`2.11.0` in `package-lock.json`**. Lovable builds with **bun**, so **production runs 2.10.0**. Unresolved pending lockfile reconcile (see §7). Called directly with `GEMINI_API_KEY`. |
| Package managers | **Both** `bun.lock` (Lovable builds with bun) and `package-lock.json` (Cursor installs with npm) — this is a known hazard, see Section 7 |

### Tenant isolation model (security-critical)

- **ONE shared File Search store** for all tenants.
- Each document carries `customMetadata { org_id, document_id }`.
- Isolation is enforced by a **SERVER-INJECTED** `metadataFilter org_id="..."` on every retrieval call.
- This filter is the entire tenant-isolation boundary. It is append-only, server-side, and non-negotiable.
- A per-org override column `organizations.file_search_store_name` exists (nullable) as the future sharding primitive. Currently null for all orgs → everyone uses the shared store.

---

## 2. CURRENT STATUS

### ✅ PRODUCTION OUTAGE RESOLVED (2026-07-21)

**Symptom (2026-07-20):** every route returned HTTP 500, including `GET /`. Lovable logs showed only a generic swallowed h3 `HTTPError` with no stack trace or module name.

**Cause (confirmed):** the Phase 1 probe route's transitive Node-only import chain crashed `workerd` at boot:

```
probe-documents.ts → @/lib/document-probe.server → @/lib/document-text.server → mammoth + require("pdf-parse")
```

`src/routeTree.gen.ts` statically imports every route file, so that chain ran at Cloudflare worker boot. Localhost never reproduced it (Vite dev runs Node, not workerd).

**Evidence:** the only delta between the last broken deploy (`c6dfbf4`) and the working one is **`ad75380`** (`bisect: remove probe-documents route from worker graph`), which removed the probe route from the worker graph. Production recovered after that commit deployed.

**Follow-up (permanent removal):** commit **`4eeaf86`** deleted the probe source files (`probe-documents.ts`, `document-probe.server.ts`, `document-text.server.ts`) and removed the `mammoth` / `pdf-parse` / `@types/pdf-parse` dependencies entirely. Standing decision: the Phase 1 probe is **not** coming back in its current form (full outage + non-discriminative calibration). The explanatory comment block in `process-documents.ts` (L143–147) is retained as historical documentation.

**Note — the lazy `probeModulePromise` fix never landed as a commit.** An earlier narrative that the top-level probe import was replaced with a lazy `await import(...)` cached in a module-level promise is incorrect for this repo's history; that change was never committed. Recovery was the graph removal (`ad75380`), then full deletion (`4eeaf86`).

**Note — theories cleared by the recovery:** production runs fine on **`@google/genai` 2.10.0** (bun lock) with bare `"crypto"` imports and the `Buffer` global still on the boot graph. That clears both the SDK-skew theory and the `nodejs_compat` theory as explanations for the 2026-07-20 outage.

### What is working and verified (before the outage)

Everything below was verified on localhost and, prior to the outage, in production:

- **Accuracy:** 19/20 on the deployed SSE path, 18/20 on a direct Gemini mirror, **zero fabrications** across ~40 eval questions on two independent sets.
- **Cost:** ~**$0.0012 per question** (`gemini-3.1-flash-lite`, thinkingLevel MEDIUM), down from ~$0.032 at session start.
- **Citations:** Stage 1 deterministic highlighting complete. Live retest: 13/13 citations produced spans, 12 via Tier 1, zero boilerplate-wrong highlights.
- **UI:** markdown rendering (react-markdown + remark-gfm), autoscroll pinning the user message near the top, click-to-side-panel citations with multi-`<mark>` highlighting.
- **Widget:** `/embed/:slug` loads, greets correctly, answers grounded questions, gate chain runs before any Gemini call.

### Repo / deployment state

| Item | Value |
|---|---|
| Repo | `02tayyab08/pixel-perfect-clone-20161` (GitHub) |
| Latest commit pushed | `8a9bc93` (25 files — citation Stage 1) |
| Earlier commits this session | `06f5700` (documentName fix), `17d9cbb`, `ce91c4f` (duplicate ThinkingLevel import), `afb9713` (model-aware cost rates), `d1e260b` (merge with Lovable's 14 commits) |
| Working tree | clean, up to date with `origin/main` at time of handoff |
| Production URL | `https://pixel-perfect-clone-20161.lovable.app` |
| Local dev | `npm run dev` — has run on ports 8080, 8083, 8084, 8085 during the session |
| GitHub write access | `02tayyab08` owns it; `tayyab-recoupr` was granted collaborator access mid-session |

### Test organization

| Field | Value |
|---|---|
| Slug | `recoupr-3` |
| `org_id` | `f609061b-e159-4534-a269-532d7e745851` |
| `is_active` | true |
| `allowed_domains` | null (= allow all origins) |
| `lead_capture_enabled` | true |
| Staff chat URL | `/app/recoupr-3/chat` |
| Widget URL | `/embed/recoupr-3` |

A second org exists: **`recoupr-document`**, `org_id` `1ef8c7d6-…` (truncated in conversation). It holds a copy of the original IFZA PDF. Verified **not** leaking into `recoupr-3` results — tenant isolation confirmed working.

### Indexed corpus (as of handoff)

Exactly **3 documents** for `recoupr-3`:

1. `IFZA_Complete_Schedule_of_Fees_2024.md` — the hand-cleaned lossless markdown (see Section 6)
2. `Meydan free zone License Details.docx`
3. `meydan freezone activity list.pdf`

All three have non-null `file_search_document_name`. No orphans in the Gemini store. The original `Ifza - Licesen cost - Shedule off charges (1).pdf` was deleted from `recoupr-3`.

[UNCERTAIN] The very last confirmed corpus state in conversation was the clean `.md` indexed and the PDF deleted, but a temporary swap back to the PDF happened during a head-to-head test and was described as "restored." Verify the actual store contents before trusting any eval numbers.

---

## 3. DECISIONS LOG

### D1 — Cursor is the sole code writer; Lovable is planning-only
**Decision:** All code changes go through Cursor. Lovable is used for planning and diagnosis only.
**Reasoning:** Lovable was writing code without schema access and repeatedly invented columns and RPC signatures (five separate phantom-column bugs — see Section 5). It also pushed 14 commits behind the user's back which, on merge, attempted to revert the model lock back to `gemini-3.5-flash` / LOW thinking.
**Rejected alternative:** Disconnecting Lovable's GitHub sync entirely. **Rejected because** Lovable is also the hosting/deploy pipeline — disconnecting it stops deploys. The connection stays; only the practice of prompting Lovable to write code stops.

### D2 — Answer model locked: `gemini-3.1-flash-lite` at `thinkingLevel: MEDIUM`
**Decision:** Both `src/routes/api/query.ts` (staff) and `src/routes/api/public/widget-query.ts` (widget).
**Reasoning:** Eval-backed across two independent 20-question sets plus targeted probes. Accuracy is **equivalent** to `gemini-3.5-flash` (both ~19/20; both failed the same O1 case identically), at roughly **16× lower cost**. Zero fabrications in every run.
**Rejected alternatives:**
- `gemini-3.5-flash` at LOW — same accuracy, 16× the cost. No evidence it was safer.
- `gemini-3.1-flash-lite` at HIGH — performed *worse* than MEDIUM (failed Q13 by refusing then quoting the wrong line). More thinking ≠ better retrieval.
- `gemini-2.5-flash` / `gemini-2.5-flash-lite` — **sunset for this API key.** They appear in the model list but return 404 "no longer available to new users" on generate.

### D3 — Thinking level reduced from default to LOW, then MEDIUM on flash-lite
**Decision:** Explicitly set thinking rather than relying on defaults.
**Reasoning:** `gemini-3.5-flash` defaults to MEDIUM thinking, and thinking tokens bill as **output** ($9/M). Measured: `thoughts=3050` vs `candidates=329` — thinking was ~9× the actual answer and the bulk of a ~$0.032/question cost. Setting LOW dropped thoughts to ~548 and cost to ~$0.0077 (~76% cut).
**Note:** `includeThoughts: false` only *hides* thoughts; it does not stop them being generated or billed. Both the config and the per-part `thought: true` filter are kept (belt and suspenders against duplicated-text leakage).

### D4 — The `[cost]` logger must include `toolUsePromptTokenCount`
**Decision:** Input cost = `promptTokenCount + toolUsePromptTokenCount`. Output cost = `candidatesTokenCount + thoughtsTokenCount`.
**Reasoning:** The logger originally omitted `toolUsePromptTokenCount` — the retrieved File Search chunks, billed as input. Live proof: `promptTokenCount: 358` vs `toolUsePromptTokenCount: 2782`. The logged cost was fiction for every grounded question; the gap scaled with retrieval volume and reached ~20× on the old bloated PDF.
**Also:** the rate table must be **model-aware**. It was hardcoded to 3.5-flash rates ($1.50/$9) while the model was flash-lite ($0.25/$1.50), inflating every logged figure 6×.

### D5 — IFZA source document = the hand-cleaned markdown, NOT the original PDF
**Decision:** Index `IFZA_Complete_Schedule_of_Fees_2024.md`; delete the original PDF.
**Reasoning:** A broad 20-question eval favoured the PDF (18/20 vs 16/20). But a **targeted head-to-head on the two known failure classes** showed:

| Corpus | Visa Amendment conflation | Cross Business waiver | Overall |
|---|---|---|---|
| Original PDF | **0/3** | 3/3 | 3/6 |
| Clean markdown | **3/3** | 3/3 | 6/6 |

The PDF **deterministically** (0/3) collapses "Visa Amendment" to AED 1,000, the same figure as "Investor Visa Add-On" — a wrong fee stated with confidence. The clean markdown never does.
**The deciding argument is failure mode, not score:** the PDF fails by stating a *wrong figure confidently* (unrecoverable, invisible); the markdown fails by *refusing or under-answering* (recoverable, visible). For a product whose promise is accurate fees, that asymmetry outweighs a two-question score gap.
**Secondary benefit:** markdown chunks render as readable tables in the citation panel; PDF chunks are flattened, unreadable blobs.

### D6 — Ingestion Quality Pipeline: Phase 1 approved, Phase 2 SHELVED
**Decision:** Build the retrieval self-probe (Phase 1) as an **index-health regression detector**. Do NOT build the automated flagship-model conversion pipeline (Phase 2).
**Reasoning:** Phase 2's premise was "dense PDFs are unretrievable." That premise was **falsified** — the original PDF scored 18/20 once two infrastructure bugs were fixed. The bugs were:
1. `file_search_document_name` was being read from `operations response.name` instead of **`response.documentName`** → persisted as **null**.
2. The store list pager returns `.page`, not `.documents` → the backfill always saw 0 documents.
These two typos manufactured months of apparent "retrieval failures."
**However** (important nuance discovered later): the eval that falsified the premise **excluded the conflation and waiver question classes**. On those specific classes the clean markdown genuinely beats the PDF (see D5). Phase 2 stays shelved, but the "premise falsified" framing is only partly right.
**Interim approach for real customers:** **concierge conversion** — manually convert fee-dense documents for the first handful of tenants. Manual, doesn't scale, correct at 1–10 customers, and generates the data that would justify building Phase 2 later.

### D7 — Citation highlighting: Stage 1 (deterministic) only; Stage 2 unbuilt
**Decision:** Ship Tier 1 (row match) + Tier 2 (unique anchors). Leave `CITATION_LLM_ALIGN` declared and **off**; do not implement the LLM alignment route.
**Reasoning:** Stage 2's trigger condition is "Tiers 1–2 returned **zero** spans." After the Stage 1 fixes, the live retest produced spans on **13/13** citations — the trigger condition no longer occurs. Stage 2 would also not have fixed the observed bug (a *wrong* span, not an empty one).
**Rejected alternatives:**
- **Approach A — structural (label, value) pair parsing.** Rejected: its characteristic failure is a silent off-by-one misalignment producing a confident wrong pair, indistinguishable from success at render time. Also a table-reconstruction research problem disguised as a UI fix.
- **Approach C1 — embedding similarity.** Rejected: fails for the same corpus-degeneracy reason a fuzzy-match attempt failed. Fee vocabulary is near-degenerate; the similarity landscape is flat and top-k selects noise.

### D8 — Accept over-highlighting within the correct chunk
**Decision:** A figure shared across rows (e.g. `1,000`) can light multiple rows. Do not chase it.
**Reasoning:** This is over-highlighting *within the right chunk*, not wrong evidence. Tightening the matcher risks regressing to the sparse-highlight problem that took three rounds to escape.

### D9 — Widget UX: no citation chips, no source panel
**Decision:** The public widget shows no citations and no evidence panel. Staff chat keeps both.
**Reasoning:** The customer-facing chat should feel like a natural human conversation whose purpose is hooking the visitor and generating leads. Chunk-level verification is a staff need, not a prospect need.
**Note:** the persona must be **one-size-fits-all across tenant business types** — document-agnostic, no industry specifics.

### D10 — Consent is single-step and supplied at runtime
**Decision:** The consent sentence is supplied at runtime and must appear **verbatim in the same message** as any contact-details ask. The persona prompt must not contain the sentence itself.
**Reasoning:** PDPL compliance requires storing the exact wording the visitor saw. Embedding it in the persona prompt risks the model paraphrasing it.

### D11 — `lead_capture_enabled` toggle added to `organizations`
**Decision:** Boolean column, default `true`. When false, the widget does NOT declare the `capture_lead` tool and does NOT append the capture addendum.
**Reasoning:** A real customer requirement — the internal staff/onboarding use case must not solicit employees for their email.

### D12 — Prompt de-specification is required before real customers
**Decision:** IFZA-specific fee names must be stripped from the **runtime** prompt and kept only in the **eval** set.
**Reasoning:** The product is white-label. Hand-written per-document disambiguation rules do not scale to 500 customers whose documents you've never seen. The eval is allowed to be hyper-specific; the runtime prompt must be document-agnostic.
**Status: NOT DONE.** This is an open item.

### D13 — Eval hygiene rule adopted
**Decision:** Every known failure becomes a permanent regression case **immediately**, and no corpus/model/config comparison ships without the full regression set attached.
**Reasoning:** Twice in one session, an eval omitted the very failure class it was meant to detect and produced a confident wrong conclusion:
1. The retrieval probe scored a known-weak document at 100% because its auto-generated questions missed the dense pages.
2. The fresh-20 declared the PDF superior because it excluded the conflation and waiver classes.

### D14 — Do not re-architect the query path to force specific retrievals
**Decision:** Standing rule, added to `.cursorrules`.
**Reasoning:** Cursor once spent ~20 minutes autonomously rebuilding the query path (moving the user question out of `contents` into the system instruction, dual-query retrieval, parallel base+amendment retrieves, dropping expansion terms) to fix **one** question's retrieval. All of it was reverted. A structural change that fixes one question but destabilises the other 19 is a net loss.

### D15 — Query expansion is kept, not deleted
**Decision:** `expandQueryTerms` stays.
**Reasoning:** Gemini (in an external consultation) argued it should be deleted as redundant with semantic search. Rejected — the feature exists because of an observed failure (a UAE-terminology vocabulary gap, "how many UAE nationals" vs "Emiratisation"). Its cost is ~$0.00002/question, roughly 1% of per-question cost. It was also found to be **silently timing out on every call** (800ms budget, ~0.9–1.5s RTT) and was fixed: `thinkingLevel: MINIMAL`, `maxOutputTokens: 64`, budget raised 800ms → 2000ms.

### D16 — Refusal strings are surface-specific
**Decision:** Staff `/api/query` keeps the exact constant `"I don't have that in the provided documents."` The public widget refuses **conversationally** per the persona (aligned with D9 — customer-facing chat should feel like a natural conversation), not by emitting the staff constant to visitors.
**Reasoning:** Emitting the staff refusal string into the widget leaked a document-assistant voice into a lead-generation surface.
**Consequence:** the planned unanswered-questions inbox (exact-match on the staff refusal constant) will **not** see widget refusals. Reconcile before building that inbox — either dual matchers, or accept that the inbox is staff-path only.
**Branch note:** the conversational widget refusal / `WIDGET_GROUNDING_MISS_*` work lives on `widget-persona-wip` (`84eb79e`) and is **not** merged to `main` yet. See Part 2 BRANCH STATE. Sections §6.3 / §6.5 in Part 2 describe **main** unless noted.

---

## 4. HARD CONSTRAINTS & REQUIREMENTS

### Security invariants (never violate)

- Secrets are **server-side only**. `GEMINI_API_KEY`, `IP_HASH_SALT`, `CRON_WEBHOOK_SECRET`, `SALNI_SUPABASE_SERVICE_ROLE_KEY` must never reach the client bundle.
- Anonymous widget traffic reaches data **only** through service-role server functions. No Supabase client in widget browser code. **No Realtime in the widget** (anonymous users have no RLS grants; a widget Realtime subscription silently fails).
- The staff path `/api/query` must **NEVER** declare the `capture_lead` tool.
- The File Search `metadataFilter` org id is resolved **server-side** from the slug/membership. Never trust a client-supplied org id for retrieval scoping.
- Never use the service role for user-facing reads (e.g. "which orgs does this user belong to") — those must run as the authenticated user so RLS applies.

### The widget gate chain (must run BEFORE any Gemini call, in this order)

1. `is_active` check
2. Origin vs `organizations.allowed_domains` (null = allow all)
3. `check_rate_limit(org, 'ref:' + endUserRef, 20)`
4. `check_org_hourly_ceiling(org, 300)`
5. `check_rate_limit(org, 'ip:' + sha256(ip + IP_HASH_SALT), 120)`

Any limiter returning **false** → throttle message, **zero Gemini spend**. Any limiter **throwing** → a real error; surface it, never disguise an RPC error as a throttle. `record_query_usage(org)` is called once per answered turn (staff and widget alike).

### Product constants (exact strings — do not alter)

| Purpose | Exact string |
|---|---|
| Refusal | `I don't have that in the provided documents.` |
| Throttle | `We're experiencing high demand — please try again in a little while.` |
| Unavailable | `This assistant is currently unavailable.` |

### Schema is law

- `02_FINAL_SCHEMA_V3.sql` is the single source of truth. Never invent, rename, or assume a table, column, enum value, RPC name, or RPC parameter.
- If code needs something the schema doesn't have: **STOP and ask**. Do not add columns or work around it.
- Error `42703` (undefined column) or `42P01` (undefined table) means the **code** is wrong, not the schema.
- Error `42501` (permission denied for table) means a missing **GRANT** — not an RLS issue. Grants sit one layer *below* RLS. `service_role` bypasses RLS but still needs grants.

### Design constraints

- **Retrieval is SINGLE-TURN by design (V1).** Only the current question (plus expansion terms) goes to File Search — never prior turns. Conversational follow-up rewriting is a V2 feature.
- **Consent is single-step.** The ask message folds consent in, and the exact rendered sentence is stored verbatim as `consent_text`. Never store a lead without it.
- **Refusal turns never emit citations and never trigger lead capture.**
- **No hover tooltips or overlays** on citations. Click-to-side-panel is the only interaction.
- **No `<a href>` on citation markers** (they previously hijacked navigation to the current page).

### Error handling

Never swallow errors into generic messages. Surface code + message. Masked errors repeatedly hid real bugs this session: a loader mapping every Supabase error to `notFound()` (produced a phantom 404), a silently failing audit insert, a throttle message covering RPC failures, and the current production outage's generic `HTTPError`.

### White-label constraint

Tenants upload whatever files they have, in whatever format. **The product cannot depend on customers cleaning their own documents.** Any "clean your files" idea can only be an optional best-practice nudge or an automated server-side step — never a requirement.

### Budget reality

Google Cloud spend on the heaviest testing day (July 17, 2026) was **A$0.59 total** for the entire day, broken down by SKU:

| SKU | Usage | Cost |
|---|---|---|
| Generate content output token count gemini 3.5 flash text | 21,500 | $0.28 |
| Generate content input token count gemini 3.5 flash text | 114,599 | $0.25 |
| EmbedContent input token count for gemini-embedding-001 | 282,869 | $0.06 |
| Generate content output/input, gemini 3.1 flash lite preview | 340 / 1,231 | $0.00 |

Credit balance at end of session: ~**A$15.70**. Per-question cost at the locked config: ~**$0.0012**.

---

## 5. KEY INFORMATION

### Verified Gemini pricing (July 2026)

| Model | Input $/M | Output $/M |
|---|---|---|
| `gemini-3-flash` | $0.50 | $3.00 |
| `gemini-3.5-flash` | $1.50 | $9.00 |
| `gemini-3.1-flash-lite` | $0.25 | $1.50 |
| `gemini-3.1-pro-preview` | $2.00 | $12.00 (≤200k tokens) |
| `gemini-2.5-flash` | $0.30 | $2.50 (deprecating 2026-10-16; sunset for this key) |

Output price **includes thinking tokens**. Batch API is ~50% of standard rates.

### Gemini File Search operational facts (hard-won; all in `.cursorrules`)

- Deleting an indexed document requires **`force: true`**, else `400 FAILED_PRECONDITION "Cannot delete non-empty Document"`.
- `fileSearchStores.documents.list` **`page_size` must be 1–20** (requesting 100 returns `400 INVALID_ARGUMENT`).
- The store list pager returns **`.page`**, NOT `.documents`.
- `file_search_document_name` must be read from the operation's **`response.documentName`**, NOT `response.name`. Reading `response.name` persists **null**.
- `chunkingConfig.whiteSpaceConfig` (`maxTokensPerChunk: 200`, `maxOverlapTokens: 20`) is **sent at ingestion and applies at ingestion only** — re-upload a document to re-chunk it. **Observed:** retrieved chunks routinely exceed the cap (~350–400 tokens). Treat the cap as advisory; retrieval token volume is not reliably controllable via chunk size.
- `operations.get` on an upload can complete **without** `response.documentName` → needs the app-level backfill (list store docs, match `customMetadata.document_id`).
- `gemini-2.5-flash` streams **thought parts by default**, which leak into the answer as a duplicated draft-then-final. Fixed with `thinkingConfig.includeThoughts: false` **AND** a per-part `thought === true` filter.
- **File Search + custom `functionDeclarations` in one request** requires `config.toolConfig.includeServerSideToolInvocations: true`. SDK field confirmed as `ToolConfig` in `@google/genai` 2.11.0. Gated to Gemini 3 models. This also switches function calling to VALIDATED mode (AUTO not supported).
- File Search **cannot** be combined with other built-in tools (Google Search grounding, URL Context).
- `groundingSupports[].segment.startIndex/endIndex` are **UTF-8 byte offsets into the ANSWER markdown**, not the chunk. There are **no chunk-side offsets anywhere in the API**.
- Confirmed live: `segment.text === answer.slice(charStart, charEnd)` after byte→char conversion. So chunk-side highlighting works purely on the string pair `(segment.text, chunk.text)`.
- `thoughtsTokenCount` is **absent** from `usageMetadata` on `gemini-3.1-flash-lite` (not present-as-zero). Thinking is still generated and billed — flash-lite HIGH cost ~2× MEDIUM — it is just folded into the total and not separately reportable. Do not use flash-lite for thinking-level cost attribution.
- API keys: Google migrated from `AIza…` to `AQ.…` prefixes mid-2026. `AQ.`-prefixed keys are real and valid.

### Schema facts (bug-relevant — these caused real production errors)

| Fact | Detail |
|---|---|
| `upsert_lead` signature | `(p_org uuid, p_conversation uuid, p_full_name text, p_email text, p_phone text, p_company text, p_notes text, p_consent_text text, p_ip text) returns uuid` — **NO** `p_consent_given` / `p_consent_at` / `p_end_user_ref`; those are set internally. Raises `LEAD_NO_CONTACT` if email and phone both empty. Retry once on `23505`. |
| `conversation_channel` enum | `('text','voice')` **only**. There is no `'widget'` value. Widget conversations use `channel: 'text'`; widget turns are identified by `started_by IS NULL` + `end_user_ref` set. |
| `audit_log` columns | `entity_type` / `entity_id` — **NOT** `target_type` / `target_id`. |
| `organizations` branding | `brand_color` and `logo_url`. There is **no** `primary_color`, **no** `logo`, and **no** composite `branding` column. A phantom `branding` select caused a fake 404 on `/embed/:slug`. |
| Does not exist | `conversations.lead_capture_asked`, `messages.meta`, `organizations.allow_lead_capture` |
| `leads` columns | `id, organization_id, created_at, updated_at, status, full_name, email, phone, company, notes, consent_text, consent_given, consent_at, ip, conversation_id, source` |
| `messages` columns | `conversation_id, organization_id, role, modality, content, model, latency_ms, prompt_tokens, completion_tokens` |
| `citations` columns | `message_id, organization_id, document_id, source_title, snippet, page` — **no offset column**, so highlight positions do not survive a page reload unless a schema change is made |
| Clients have **no DELETE policy** on `documents` | Deletion must go through a privileged server function |

### The five phantom-column bugs (all from Lovable guessing without schema access)

1. `audit_log.target_type` / `target_id` (real: `entity_type` / `entity_id`)
2. `upsert_lead` signature invented extra params
3. Invented `conversations.lead_capture_asked`
4. Invented `messages.meta`
5. Invented `organizations.branding` composite → produced a phantom 404 on the widget route

### Major debug arcs resolved this session

| Issue | Root cause | Fix |
|---|---|---|
| Widget `/embed/:slug` 404 | Loader mapped **any** Supabase error to `notFound()`; the real error was `column organizations.branding does not exist` (42703) | Distinguish `not_found` / `inactive` / `error`; select real columns only |
| Widget throttling everything | Previous hour's `check_org_hourly_ceiling` (300) exhausted by the user's own testing | Self-healed at the hour rollover; not a bug |
| `gemini-2.5-flash` 404 | Model sunset for new users on this key | Bumped to 3.x models |
| File Search store 403 | Store created under a different GCP project than the key resolves to | Recreate store + re-ingest. **Recurs on key/project change — this is an ops fact** |
| Duplicated answer text | Gemini streaming thought parts | `includeThoughts: false` + per-part `thought` filter |
| Orphaned Gemini document | Delete removed the DB row but skipped Gemini because `file_search_document_name` was null | Delete now resolves the name (list store, match `customMetadata.document_id`) before deleting, and **keeps the row** if it can't resolve |
| Backfill returned 0 docs | Pager used `.documents`; API returns `.page` | Fixed |
| `documentName` vs `name` | Upload op returns `response.documentName` | Fixed, committed `06f5700` |

### Cost autopsy timeline (how ~$0.032 became ~$0.0012)

1. **Baseline:** `gemini-3.5-flash`, thinking unset (defaults MEDIUM). Staff: `prompt=1103 candidates=329 thoughts=3050 → costUSD=0.032066`.
2. **thinkingLevel LOW:** thoughts 3050 → 548. Cost → ~$0.0077 (~76% cut).
3. **Discovered the logger was fiction:** `toolUsePromptTokenCount` (2782 tokens on a sample) was not counted. True cost was higher than logged; on the old bloated PDF the gap reached ~20×.
4. **Model swap to `gemini-3.1-flash-lite` MEDIUM:** ~16× cheaper input and output rates.
5. **Discovered the rate table was hardcoded to 3.5-flash prices** while running flash-lite — inflating every logged figure 6×. Made model-aware.
6. **Final measured:** `prompt=738 toolUse=3260 candidates=98 → costUSD=0.001146`; `[cost-total]` (expansion + answer) = `$0.001204`.

### Known limitations (logged, deliberately not fixed)

- **O1 / action-verb setup-vs-amendment:** "add a shareholder" can retrieve the AED 2,000 amendment fee instead of the AED 350 setup fee. Affects **both** models identically. *Note: this was later found to PASS on the correctly-indexed PDF, so it was removed from known-limitations and kept as an eval fixture only.*
- **Q14 — Meydan WPS:** "Does Meydan require WPS?" refuses on both corpora. The fact is prose buried in mainland-comparison notes, not a clean fact line.
- **Q16 / `retrieval-ranking-cross-doc`:** cross-document comparisons favour the denser corpus. Q15 (Meydan est. card, asked directly) retrieves fine; Q16 (comparing IFZA and Meydan est. cards) returned 4 chunks, **all IFZA**, and the model correctly said Meydan data was absent. Classification: retrieval-ranking, NOT model-ignored-content. Expected to recur at scale when tenants compare corpora of different density.
- **Residual File Search stochasticity:** unquantified. Originally logged as "~60% on borderline queries" but that was largely attributable to the null `file_search_document_name` bug. One observed instance post-fix: the same question refused on attempt 1 and answered on attempt 2.
- **Citation over-highlighting:** a shared figure can light multiple rows within the correct chunk.

---

## 6. LATEST ARTIFACTS (verbatim)

### 6.1 `.cursorrules` (repo root)

This file is read by Cursor on every request. It encodes every scar from the build. **Saved as `.cursorrules` — with the leading dot, no `.txt` extension.** (A first commit accidentally created `.cursorrules.txt`; it was renamed.)

The base version below was authored in this session. Amendments made later in the session are listed immediately after and ARE part of the current file.

```
# Salni — Cursor rules (save this file as `.cursorrules` in the repo root)

## Schema is law
- `02_FINAL_SCHEMA_V3.sql` is the single source of truth for the database (supersedes V2_1).
- NEVER invent, rename, or assume a table, column, enum value, RPC name, or RPC parameter. Verify every reference against that file before writing code.
- If code needs something the schema doesn't have: STOP and say so. Do not add columns, do not work around it, do not alter the DB. Schema changes are made in that file first, then applied by the operator.
- Error 42703 (undefined column) or 42P01 (undefined table) means the CODE is wrong, not the schema. Fix the code.
- Error 42501 (permission denied for table) means a missing GRANT (see the V3 grants section) — it is NOT an RLS issue; grants sit one layer below RLS. service_role bypasses RLS but still needs grants.

## Known past failures — never repeat
- audit_log uses entity_type / entity_id (NOT target_type / target_id).
- conversation_channel enum is ('text','voice') only. There is NO 'widget' value. Widget conversations use channel 'text'; widget turns are identified by started_by IS NULL + end_user_ref set.
- organizations has brand_color and logo_url. There is NO primary_color, NO logo, and NO composite `branding` column (a phantom `branding` select caused a fake 404 on /embed/:slug).
- upsert_lead signature is exactly: (p_org, p_conversation, p_full_name, p_email, p_phone, p_company, p_notes, p_consent_text, p_ip) returns uuid. There is NO p_consent_given / p_consent_at / p_end_user_ref — the function sets consent internally. Raises LEAD_NO_CONTACT if email and phone are both empty. On unique_violation (23505), retry once.
- There is NO conversations.lead_capture_asked and NO messages.meta. "Already asked" is derived: an existing lead linked to the conversation, or a stored assistant message containing the consent-template sentinel.
- Gemini File Search: document deletion requires force:true (else 400 FAILED_PRECONDITION). documents.list page_size max is 20. chunkingConfig applies at ingestion only. operations.get can complete without response.documentName → file_search_document_name may be null and needs the backfill (match customMetadata.document_id).
- gemini-2.5-flash streams thought parts: keep thinkingConfig.includeThoughts=false AND the per-part thought filter in every generateContentStream consumer.

## Security invariants
- Secrets are server-side only: GEMINI_API_KEY, IP_HASH_SALT, CRON_WEBHOOK_SECRET, SALNI_SUPABASE_SERVICE_ROLE_KEY must never reach the client bundle.
- Anonymous widget traffic reaches data ONLY through service-role server functions. No Supabase client in the widget browser code. No Realtime in the widget (anonymous users have no RLS grants; a widget Realtime subscription silently fails).
- The staff path /api/query must NEVER declare the capture_lead tool. Lead capture exists only on /api/public/widget-query, and only when organizations.lead_capture_enabled is true.
- The File Search metadataFilter org id is resolved SERVER-SIDE from the slug/membership. Never trust a client-supplied org id for retrieval scoping.
- Never use the service role for user-facing reads (e.g. "which orgs does this user belong to") — those must run as the authenticated user so RLS applies. Service role is for privileged writes/processing only.
- The widget-query gate chain runs BEFORE any Gemini call, in this order: is_active → Origin vs allowed_domains (null = allow all) → check_rate_limit(org,'ref:'+endUserRef,20) → check_org_hourly_ceiling(org,300) → check_rate_limit(org,'ip:'+sha256(ip+IP_HASH_SALT),120). A limiter returning FALSE = throttle message with zero Gemini spend. A limiter THROWING = a real error — surface it, never disguise an RPC error as a throttle.
- record_query_usage(org) is called once per answered turn (staff and widget alike).

## Product constants — do not alter
- Refusal string, exactly: "I don't have that in the provided documents."
- Throttle message: "We're experiencing high demand — please try again in a little while."
- Unavailable message: "This assistant is currently unavailable."
- Retrieval is SINGLE-TURN by design (V1): only the current question (plus expansion terms) goes to File Search — never prior turns. Conversational follow-up rewriting is a V2 feature; do not add it ad hoc.
- Consent is single-step: the ask message folds consent in, and the EXACT rendered sentence is stored verbatim as consent_text. Never store a lead without it.
- Refusal turns never emit citations and never trigger lead capture.

## Error handling
- Never swallow errors into generic messages. Surface code + message. Masked errors repeatedly hid real bugs in this project (a mapped-to-404 loader error, a silently failing audit insert, a throttle message covering RPC failures).
- Streaming responses must never leave a stuck spinner: every failure path emits a user-visible state.

## Workflow
- Lovable is used for planning only; Cursor is the only writer of code. Before implementing any externally-produced plan, verify its assumptions (file existence, column names, RPC signatures) against this repo and the schema file — build reports have drifted from reality before.
- Commit and push in small, labeled increments. Pull before starting work in case anything else touched the repo.
- Local dev: secrets live in .env.local (never committed). Test on the local server first; production logs have a short retention window.
```

**Amendments applied later in the session (these ARE in the current file):**

1. The "~60% stochasticity" known-limitation entry was **revised** to note it was largely attributable to the null `file_search_document_name` bug; residual stochasticity is unquantified.
2. **O1 and Q11 were removed** from known-limitations (both PASS on the correctly indexed PDF) and kept as eval regression cases only.
3. **Added:** `documents.file_search_document_name must be read from operations response.documentName (NOT response.name); the store list pager returns .page (NOT .documents). Both bugs silently produced null names and broken backfill, which manifested as phantom retrieval failures.`
4. **Added:** `Do NOT re-architect the query path to force specific retrievals — the fix for borderline-retrieval cases is clean-file ingestion structuring (future), not query-path changes.`
5. **Recommended but [UNCERTAIN] whether applied:** a rule about Cloudflare worker boot — *"Route files are statically imported by routeTree.gen.ts, so any top-level import in a route file runs at Cloudflare worker BOOT. Node-only packages (mammoth, pdf-parse, anything using require() or Node built-ins) crash workerd at boot and 500 EVERY route, surfacing as a generic swallowed SSR error. Import such modules lazily inside the handler (await import(...), cached in a module-level promise) — never at the top level of a route file. Localhost will not reproduce this: Vite dev runs Node, not workerd."*
6. **Recommended but [UNCERTAIN] whether applied:** `chunkingConfig 200/20 is sent at ingestion but retrieved chunks routinely exceed it (~350-400 tokens observed) — treat as advisory; retrieval token volume is not reliably controllable via chunk size.`

---

### 6.2 `02_FINAL_SCHEMA_V3.sql` — the V3 deltas over V2.1

The full file is ~830 lines and lives in the repo. It was created by copying `02_FINAL_SCHEMA_V2_1.sql` and applying the deltas below. **All V3 deltas were already applied to the live database** — existing DBs need nothing run; only a fresh deploy runs the whole file.

**Header (replaces the V2.1 header):**

```sql
-- ============================================================
-- 02 — SALNI V3 FINAL SCHEMA (LOCKED · CANONICAL SOURCE OF TRUTH)
-- Supersedes 02_FINAL_SCHEMA_V2_1.sql. Any change to the data model
-- is made in THIS file first, then migrated. Never let Lovable or
-- Cursor improvise schema; verify all generated code against this file.
--
-- V3 DELTAS over V2.1 (all already applied to the live database —
-- existing DBs need NOTHING run; fresh deploys run this whole file):
--  * EXPLICIT GRANT BLOCK (public + storage schemas). Supabase's
--    default grants are NOT guaranteed on manually-run schema files;
--    their absence caused live 42501 "permission denied for table"
--    errors for BOTH authenticated and service_role (service_role
--    bypasses RLS but still needs table-level grants). Grants gate
--    table access one layer BELOW RLS; RLS still gates rows.
--  * organizations.lead_capture_enabled (boolean, default true) —
--    per-org switch for widget lead capture ("internal-use mode",
--    driven by a real customer requirement).
--  * Operational facts encoded as comments so nobody re-learns them
--    the hard way: widget conversations use channel 'text' (there is
--    no 'widget' enum value); Gemini File Search document deletion
--    requires force:true; documents.list page_size max is 20; new
--    uploads chunk at 200 tokens / 20 overlap (app-level, applies at
--    ingestion only).
```

**Added to the `organizations` table definition:**

```sql
  allowed_domains        text[],                           -- NULL = allow all; else Origin allow-list for the widget (defense-in-depth, R1)
  lead_capture_enabled   boolean not null default true,    -- V3: widget lead-capture switch; false = internal-use mode (capture_lead tool not declared, capture addendum not appended)
  is_active              boolean not null default true,    -- manual billing gate (ADR-04)
```

**Annotation on the `conversations` table:**

```sql
  channel         conversation_channel not null default 'text',  -- widget ALSO uses 'text' (no 'widget' enum value); widget turns = started_by IS NULL + end_user_ref set
```

**The GRANTS block (new in V3 — this is the fix for live 42501 errors):**

```sql
-- ---------- TABLE-LEVEL GRANTS (V3 — required; see header) ----------
-- Layer BELOW RLS: without these, Postgres returns 42501 "permission
-- denied for table" before RLS is even evaluated. RLS (and the
-- absence of policies) still fully controls WHICH rows each role can
-- touch — e.g. app_config is granted to service_role here but has
-- zero policies, so authenticated/anon remain fully locked out.
grant usage on schema public to authenticated, anon, service_role;

-- Client-facing tables (RLS policies above narrow the rows; tables
-- with no insert/delete policy still deny those actions despite the
-- grant — grants permit, policies decide):
grant select, insert, update on
  public.organizations,
  public.organization_members,
  public.profiles,
  public.documents,
  public.conversations,
  public.messages,
  public.citations,
  public.leads,
  public.subscriptions,
  public.plans
to authenticated;

-- Backend/worker role: full table access on every table. service_role
-- bypasses RLS but NOT grants. Deletion ordering (Gemini → Storage →
-- rows) is enforced in the delete server function, not here.
grant select, insert, update, delete on
  public.plans,
  public.app_config,
  public.organizations,
  public.profiles,
  public.organization_members,
  public.documents,
  public.conversations,
  public.messages,
  public.citations,
  public.leads,
  public.subscriptions,
  public.processed_stripe_events,
  public.usage_counters,
  public.rate_limits,
  public.org_hourly_usage,
  public.audit_log
to service_role;

-- Storage schema (signed upload URLs + object deletion run as
-- service_role; absence of these caused live failures):
grant usage on schema storage to service_role;
grant all on storage.objects, storage.buckets to service_role;

-- No sequences exist (all keys are gen_random_uuid()); no sequence
-- grants required. ANY NEW TABLE added later MUST be appended to the
-- service_role grant list above (and to authenticated if client-read).
```

**Gemini operational facts appended to the storage section:**

```sql
-- ---------- GEMINI FILE SEARCH OPERATIONAL FACTS (V3, app-level) ----------
--  * Deleting an indexed document requires force:true, else 400
--    FAILED_PRECONDITION "Cannot delete non-empty Document".
--  * fileSearchStores.documents.list page_size must be 1–20.
--  * New uploads are chunked at maxTokensPerChunk 200 / overlap 20
--    (set in process-documents). Chunking applies at INGESTION only —
--    re-upload a document to re-chunk it.
--  * operations.get on an upload can complete WITHOUT response.name;
--    documents.file_search_document_name may then be null and needs
--    the app-level backfill (list store docs, match
--    customMetadata.document_id) before deletion can target it.
--  * gemini-2.5-flash streams thought parts by default; the query
--    routes set thinkingConfig.includeThoughts=false AND filter any
--    part with thought=true (belt and suspenders vs. duplicated text).
```

**Separate apply script:** `03_DOCUMENT_PROBES_PHASE1.sql` — creates the `document_probes` table (Phase 1 ingestion probe, schema "Option A": a side quality state so `ready` keeps its current meaning and the answer path is untouched). This was run in Supabase.

