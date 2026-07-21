# SALNI — PROJECT HANDOFF, PART 2

Continues `PROJECT_HANDOFF.md`. That document covers Sections 1–5, 6.1 and 6.2. This document contains ONLY the remainder. Nothing here restates Part 1.

---

# SECTION 8 — NEXT STEPS

## 8.0 PRODUCTION OUTAGE — RESOLVED (2026-07-21)

**Cause confirmed:** the Phase 1 probe route's transitive Node-only import chain crashed `workerd` at boot:

```
probe-documents.ts → document-probe.server → document-text.server → mammoth + require("pdf-parse")
```

**Evidence:** the only delta between the last broken deploy (`c6dfbf4`) and the working one is **`ad75380`**, which removed the probe route from the worker graph. Production recovered after that deploy.

**Permanent removal:** commit **`4eeaf86`** deleted the probe source files and the `mammoth` / `pdf-parse` dependencies. Standing decision: the probe is **not** returning in its current form (full outage + non-discriminative calibration). The `process-documents.ts` L143–147 comment block is retained as historical documentation.

**Historical correction:** the lazy `probeModulePromise` / `await import(...)` fix described in the original §2 / §8.0 **never landed as a commit**. Recovery was graph removal, then full deletion — not a successful lazy-import fix.

**Theories cleared:** production runs fine on `@google/genai` **2.10.0** (bun) with bare `"crypto"` and `Buffer` still on the boot graph — clearing both the SDK-skew and `nodejs_compat` theories for this outage.

### What replaced the bisect prompt

The prepared bisect prompt below is **historical** (executed successfully via `ad75380` / `4eeaf86`). Do not re-run it.

<details><summary>Original prepared Cursor prompt (executed; keep for history)</summary>

```
Production is 500ing on every route, including GET /. The lazy-import fix for probe-documents did not resolve it, and Lovable's runtime logs only show a generic swallowed h3 HTTPError with no stack trace or module name — we cannot diagnose further from logs.

Bisect instead. Temporarily remove the probe feature from the worker's route graph entirely:
1. Delete (or rename out of the routes directory) src/routes/api/public/probe-documents.ts, and remove any import of @/lib/document-probe.server or @/lib/document-text.server from any route file or from process-documents.ts (make process-documents skip the inline probe for now).
2. Regenerate routeTree.gen.ts.
3. Confirm `npm run build` succeeds, commit, push.

If production recovers, the probe/mammoth/pdf-parse path is confirmed as the cause and we decide whether to reinstate it. If production still 500s, the cause is elsewhere and we bisect the citation commit next (the new react-markdown / remark-gfm deps and remark-cite-markers plugin are the other new bundle additions).

Also check: Lovable's deployed build for production shows content_hash eb6af44b… and the preview shows sha c6dfbf44 — confirm which commit is actually deployed to pixel-perfect-clone-20161.lovable.app and whether it matches our HEAD (8a9bc93). If the deploy is stuck on an older or partial build, that's a different problem.
```

</details>

### Decision after the bisect (executed)

- Production recovered → probe/`mammoth`/`pdf-parse` **confirmed** as the cause.
- Probe left **OUT permanently** and source/deps deleted in `4eeaf86`.
- Citation-commit bisect was **not** needed.
- Deploy-artifact mismatch was **not** the root cause for the outage (though dual lockfiles remain an open hazard — see §7).

## 8.1 Ordered plan (production is restored)

1. **Widget lead-capture test** — THE revenue feature, still architecturally unresolved. See §6.5 for the exact prepared prompt and the manual test script. The open question: does `fileSearch` + `capture_lead` compose in one request on `gemini-3.1-flash-lite` with `config.toolConfig.includeServerSideToolInvocations: true`, or is a two-pass design required? Never tested end-to-end; every prior attempt failed for unrelated reasons (missing route, throttle, model 404, store 403) — all now fixed.
2. **De-specification audit** — strip IFZA-specific fee names out of the RUNTIME prompt, keep them in the eval only. Required before onboarding any customer whose documents are not IFZA. See §7.3.
3. **Storage webhook** — indexing is currently cron-only (5-minute worst case). Acceptable per risk R-04 but a legitimate polish item.
4. **XOR verification re-run** — re-run fresh-20 + the two permanent regression cases against the shipped corpus on the live SSE path, to obtain one clean baseline on the exact configuration being shipped (model + corpus + query path all settled). This has never been measured in a single run.
5. **Review / merge `widget-persona-wip`** — see BRANCH STATE. Not deployed; `main` is still what §6.3 / §6.5 describe.

---

# BRANCH STATE

**Branch:** `widget-persona-wip`  
**Commit:** `84eb79e`  
**Status:** pushed to `origin/widget-persona-wip`. **NOT merged. NOT deployed.**

**`main` remains the deployed state.** Everything in §6.3 and §6.5 describes **`main`**, not this branch, unless a sentence explicitly says otherwise.

**Contains (vs `main`):**
- Conversational widget persona rewrite (`widgetPersona` in `widget-query.ts`)
- Arabic consent/locale with `CONSENT_SENTINEL_AR` (`widget.server.ts` + already-asked `.or()` lookup)
- `WIDGET_GROUNDING_MISS_EN` / `WIDGET_GROUNDING_MISS_AR` replacing the staff refusal string for visitors (staff constant still exists as `STAFF_REFUSAL` and is rewritten away if the model emits it)
- `assistant_name` selected from `organizations` for the persona
- Greeting carve-out folded into the persona (plus existing `isGreetingOrSmallTalk` override skip)
- Lead-capture addendum no longer using the `"Happy to have the team follow up — what's your email? …"` template; consent clause is built by `consentSentence(tenantName, locale)`
- `embed.$slug.tsx` removes visitor-facing citation chips / marked markdown (citations still persisted server-side for audit)
- `.cursorrules` product-constants line updated for surface-specific refusals
- `bun.lock` touched on this branch (still may need a deliberate mammoth/pdf-parse prune reconcile with `main`'s `4eeaf86`)

**Related decision:** Part 1 **D16** (refusal strings are surface-specific). Consequence: the planned unanswered-questions inbox that exact-matches the staff refusal constant will not see widget refusals after this branch merges.

---

# SECTION 6 (CONTINUED) — ARTIFACTS

## 6.3 Runtime prompt components

**[UNCERTAIN] The full verbatim staff system prompt was never displayed in this conversation.** What is known with certainty:

- `systemInstruction` is `organizations.system_instruction` if set, otherwise a strict-grounding fallback string defined in code.
- Two addenda are appended **at request time from code constants** in `src/routes/api/query.ts`, NOT written into each org's DB row. This means one source of truth and zero drift across orgs; "all existing + new default" was achieved without a database migration.
  - `FEE_DISAMBIGUATION_ADDENDUM`
  - `FEE_QUOTED_PAIR_RULE`
- To revise either, edit the constant in `src/routes/api/query.ts`; it applies to all orgs on the next query.

**The fee-disambiguation rule as specified (the approved instruction text):**

```
When multiple similarly-worded fee-schedule lines exist (e.g. 'Investor Visa Add-On' vs 'Visa Amendment'; 'Extra Business Activity Fee' vs 'Change/Removing/Adding of Activity'), quote the EXACT figure tied to the EXACT label as it appears in the source, and if a question could involve more than one such fee, explicitly state which fee(s) apply and why — never blend, average, or silently choose between them.
```

**Rule 3 amendment (approved):** this product does not support conversational follow-up (single-turn retrieval by design). The only correct behavior on ambiguity is to list both fees with exact label and figure in the same answer, and let a new, separate turn resolve it.

**Rule 4 amendment (approved):** the fallback "answer using the label whose wording most directly matches" was REMOVED — that heuristic is close to what caused the original conflation. When two similarly-worded lines appear together and the question doesn't clearly specify which, the default is ALWAYS to quote both lines verbatim with labels and figures.

**`FEE_QUOTED_PAIR_RULE` behavior:** forces the model to emit `"<Exact Label>" = <Exact Figure>` for each fee line before any comparison, table, or arithmetic. Rationale: a silent label/figure swap then requires the model to also mis-emit the quoted pair, which is far more visible and self-inconsistent to produce.

**The generic action-verb rule (SPECIFIED, confirmed ABSENT from the runtime prompt path on `main`):**

```
When a question uses an action word (add, change, renew, cancel, upgrade) and the documents contain BOTH a base/setup fee and a separate amendment/modification fee for the same subject, these are different charges — the base fee is the cost of HAVING the item, the amendment fee is the cost of MODIFYING it on an existing record. Quote BOTH with their exact labels and figures, and state which applies to setup vs. modification, rather than returning only the amendment line.
```

That exact block is **not** in `query.ts` or `widget-query.ts`. Adjacent ground is covered by **fee-addendum rule 3** ("cost of having N of something" vs "cost of changing what you have") in `FEE_DISAMBIGUATION_ADDENDUM`.
**Widget-only greeting carve-out (shipped, widget system instruction only — NOT staff):**

```
If the visitor sends a greeting or small talk containing no factual question, reply with one short, friendly sentence welcoming them and inviting them to ask about {tenant name}'s services. Never use the refusal string for greetings. All factual answers remain strictly grounded in the documents — never answer a factual question from outside the documents.
```

The widget grounding-miss override also skips greeting/small-talk so the friendly reply is not immediately overridden to the refusal string.

## 6.4 Fixed product strings (never alter)

| Purpose | Exact string |
|---|---|
| Refusal | `I don't have that in the provided documents.` |
| Throttle | `We're experiencing high demand — please try again in a little while.` |
| Unavailable | `This assistant is currently unavailable.` |
| Consent sentinel (used to derive "already asked") | `By sharing it you agree that` |

## 6.5 Widget lead capture — mechanics and the prepared test

**Architecture (built, untested end-to-end):**

- Lead capture exists ONLY on `/api/public/widget-query`. The staff path `/api/query` never declares `capture_lead` — this is a hard code separation, not a runtime check.
- `capture_lead` is declared as a Gemini function tool alongside `fileSearch`, with `config.toolConfig.includeServerSideToolInvocations: true` (SDK field confirmed as `ToolConfig` in `@google/genai` 2.11.0). This flag is required to combine a built-in tool with custom `functionDeclarations`, is Gemini-3-only, and switches function calling to VALIDATED mode (AUTO not supported).
- Declared parameters: `full_name?`, `email?`, `phone?`, `consent_text` (required, verbatim), `intent_summary?`.
- Gated by `organizations.lead_capture_enabled` (boolean, default true). When false: do NOT declare `capture_lead` and do NOT append the capture addendum. This is "internal-use mode", driven by a real customer requirement.
- **Refusal guard:** if the grounding-miss override fires (answer becomes the refusal string), any pending `capture_lead` call is swallowed — never store a lead attached to a refusal.
- **"Already asked" is derived, not stored** (no schema columns exist for it): either a `leads` row already linked to this conversation, OR a stored assistant message in this conversation containing the sentinel phrase `By sharing it you agree that`.

**The consent template — the EXACT sentence shown to the visitor, folded into the same message as the contact ask (single-step consent):**

```
Happy to have the team follow up — what's your email? By sharing it you agree that {tenant name} may store your details and contact you about your enquiry, as described in the Privacy Policy, including AI processing by Google services which may occur outside the UAE.
```

The model must pass that exact rendered sentence verbatim as `p_consent_text` when it later calls `capture_lead`. PDPL evidence depends on this being verbatim, not paraphrased.

**Server-side handling on a `capture_lead` function call:**
1. Validate: at least one of email/phone present; `consent_text` non-empty.
2. Call `upsert_lead` via service role with the request IP. On `23505` unique_violation, retry once.
3. Send the function response back to the model so the stream continues with a natural acknowledgement.

**Four persona failure modes observed in earlier live widget testing, to design against:**
- Stock example sentences parroted verbatim.
- Greetings routed to the refusal path (now addressed by the greeting carve-out).
- Threads dead-ending after the contact ask.
- The staff refusal string leaking into customer-facing chat.

### The prepared Cursor prompt for the lead-capture test — VERBATIM

```
Widget lead capture — instrument and observe. Do NOT redesign or build two-pass yet.

Context: capture_lead has never been tested end-to-end. Every prior attempt failed for unrelated reasons (missing route, throttle, model 404, store 403) — all now fixed. The model has also changed since it was written (gemini-3.1-flash-lite MEDIUM, not 3.5-flash).

1. Report current state of /api/public/widget-query: is capture_lead still declared alongside fileSearch? Is config.toolConfig.includeServerSideToolInvocations still set? Is the widget lead-capture addendum still appended to the system instruction? Is organizations.lead_capture_enabled being read (recoupr-3 has it true)?

2. Add logging per widget request: the exact tools array sent, the toolConfig sent, and EVERY part type seen in the response stream (text / functionCall / thought). I need to see whether a functionCall part is ever emitted.

3. Confirm the refusal guard still drops a pending capture_lead when the grounding-miss override fires.

Report 1 and 3, add the logging in 2, then stop. I'll run the live conversation myself.

Reminder: upsert_lead is (p_org, p_conversation, p_full_name, p_email, p_phone, p_company, p_notes, p_consent_text, p_ip). Staff /api/query must never declare capture_lead.
```

### The manual test script (run by the human, incognito, on `/embed/recoupr-3`)

1. A normal in-docs question — confirm a grounded, cited answer still works with the tool declared.
2. `I want to set up a company at IFZA with 2 visas — can someone help me with this?` — does the answer come FIRST, then a contact ask with the verbatim consent template naming the tenant?
3. If it asks, reply with an email — does `capture_lead` fire, does `upsert_lead` run, does a row appear on the leads page with verbatim `consent_text`, `consent_at`, `ip`, and the linked conversation?
4. An out-of-corpus question — refusal string, and NO capture attempt.

**The single decisive observation: does a `functionCall` part ever appear in the stream?** If yes and a lead lands, the revenue loop works. If the tools are declared correctly and no `functionCall` ever fires, that is the evidence for the two-pass design.

### The two-pass design (proposed, NOT built)

- Pass 1 = current call, `tools: [fileSearch]` only. Stream the grounded answer.
- After pass 1 completes and the refusal guard clears, run pass 2 ONLY when a cheap deterministic buying-intent gate hits (intent keywords on the user turn, consent sentinel absent, no existing lead). Pass 2 uses `tools: [functionDeclarations: [capture_lead]]`, no fileSearch, a compact system prompt containing the consent template and the last assistant message, and asks the model to either emit `capture_lead` or emit a single sentence to append to the reply.
- Append that sentence via the `override` SSE frame before `done`.
- **Cost warning:** a second Gemini call per widget turn roughly doubles cost on that path. The cheap heuristic gate is what prevents it applying to every message. Pass 2 must only fire when the gate hits.

## 6.6 Eval question sets

### 6.6.1 The "fresh-20" set (used for the final SSE-path validation, 19/20)

Staff path for Q1–17 and Q20; widget path for Q18–19.

**Dense-schedule lookups (6):**
1. `What does IFZA charge for a Certificate of Incumbency?` → 400 standard / 1,000 Gold
2. `How much is visa cancellation within the UAE at IFZA?` → 750
3. `What's the fee for a Company Employee List?` → 400
4. `What does IFZA charge to register MOA & AOA with the regulatory authority?` → 1,500
5. `How much is the Work Permit for Non-IFZA Company Visa Holders?` → 4,500/year
6. `What's the E-Visa Withdrawal fee?` → 500

**Action-verb / base-vs-amendment (3):**
7. `How much to change my company name at IFZA?` → 2,000 + 500 E-card
8. `What does it cost to renew my establishment card?` → 2,200 (distinct from initial 2,000)
9. `How much to upgrade my visa allocation?` → 2,000 + package difference

**Multi-step arithmetic (3):**
10. `New IFZA company, 3-year Zero Visa license, plus establishment card — total upfront?` → 31,000 (discounted 3-yr Zero Visa) + 2,000
11. `Cost to add 2 extra business activities beyond the free three?` → 2 × 1,000 = 2,000
12. `5-year 2-visa license after discount vs standard — what's the saving?` → 84,500 − 59,200 = 25,300

**Meydan (3):**
13. `Meydan investor visa total cost breakdown?` → quota 1,850 + investor 4,020 + medical 320 + Emirates ID 385
14. `Does Meydan require WPS?` → no
15. `Meydan establishment card cost?` → 2,020

**Cross-doc (1):**
16. `Compare establishment card costs between IFZA and Meydan.` → IFZA 2,000 init / 2,200 renewal; Meydan 2,020

**Fabrication traps — must refuse (3):**
17. `What's IFZA's office rent per square foot?`
18. `Does Meydan offer a startup discount for tech companies?`
19. `What's the IFZA bank account opening fee?`

**Widget greeting (1):**
20. `hello` → friendly welcome, not the refusal string

### 6.6.2 The model/thinking eval set (20 questions, used for the flash-lite decision)

Grouped as: 3 fee-conflation pairs, 2 waiver-to-zero, 3 multi-step arithmetic, 4 Meydan-specific, 2 now-answerable (shareholder fees; late-renewal penalty), 3 genuine out-of-corpus refusals (ADGM, JAFZA, UAE trademark), 2 widget greetings, 1 cross-document (General Trading across both corpora).

Key answer keys established during this work:
- **Q6 (three simultaneous amendments: Name + Activity + Shareholder) = AED 4,500**, NOT 4,000. Because the source lists `Change of Company Name | 2,000 + 500 (E-card Amendment)`, the correct calculation is Name 2,000 (full) + E-card 500 (never discountable) + Activity 1,000 (50%) + Shareholder 1,000 (50%). All three model configs produced 4,500 with correct discount logic; the original rubric of 4,000 was a **rubric error**, not a model failure.
- **Q20 (cross-doc General Trading):** must state IFZA's 10,000 fee and its waiver to 0, plus Meydan's activity-list identity (codes `4690.87 General Trading Wholesalers`, `4690.97 General Trading`), WITHOUT inventing a Meydan General Trading waiver.

### 6.6.3 Permanent regression cases (in `eval/known-soft-fail-regressions.json`)

| ID | Case | Expected |
|---|---|---|
| `reg-visa-amend-conflation` | Visa Amendment vs Investor Visa Add-On | Investor Visa Add-On = AED 1,000; Visa Amendment = AED 2,000–4,000; never collapsed to the same figure |
| `reg-cross-biz-waiver` | Cross Business Activity Fee exemption for a new application | Waived for new applications + next three renewals; effectively AED 0. Must NOT say the documents don't state an exemption |
| O1 (eval fixture only) | `What does it cost to add an extra individual shareholder to my IFZA license?` | Both AED 350 setup and AED 2,000 amendment surfaced, distinctly labeled |
| Q11 | Add 2 activities | 2 × 1,000 setup math; surfacing the 2,000 amendment line alongside is acceptable |
| `retrieval-ranking-cross-doc` | Q16 est-card comparison | Known soft-fail: cross-doc comparisons favour the denser corpus; Meydan chunks lose the ranking competition |
| Q14 Meydan WPS | Prose fact | Known soft-fail on BOTH corpora; auto-scorer produced a false PASS by accepting a hedged mainland quote — **mark manual-review-only** |

### 6.6.4 Citation highlighting fixtures (`src/lib/citations/__fixtures__/chunks.ts`)

| ID | Purpose |
|---|---|
| A1 | Cross Business Activity — span on its row and/or waiver sentence; NO span on Extra Business Activity, Pre-Approval, or Downpayment rows |
| A2 | Extra Business Activity row only |
| A3 | General Trading row and/or waiver sentence; NO span on Single Family Office (which also contains 10,000) |
| A4 (negative) | `**Change of Director:** AED 2,000` against Fixture A → **zero spans** |
| A5 (boundary) | `AED 2,000` against a chunk containing only `12,000` → zero spans (token-boundary, never substring) |
| B1 | Flattened-PDF chunk: Tier 1 declines on length gate; Tier 2 gives a label span containing `Director`; ZERO spans containing `2,000` |
| B2 | Unique n-gram `Visa Allocation Upgrade` label span; no figure spans |
| C1 | Arabic-Indic digit matching in both directions |
| D1 | `AED 0` waiver claim → Cross Business waiver sentence via Tier 1 |
| D1b | Claim with no digits at all → zero-figure Tier 1 path |
| D2 | Claim whose only unique anchor is boilerplate → **empty** |

**Standing project policy:** any wrong or missing highlight observed during QA becomes a permanent fixture case in this suite BEFORE the fix for it lands.

## 6.7 Citation highlighting — shipped design (Stage 1 only)

Modules: `src/lib/citations/defaults.ts` (tunable constants), `normalize.ts`, `computeHighlights.ts`, `autoPage.ts`, `__fixtures__/chunks.ts`, `computeHighlights.selftest.ts`; component `src/components/citation-chunk-body.tsx`; plugin `remark-cite-markers`.

Contract:
```ts
export type HighlightSpan = {
  start: number;        // JS char index into the ORIGINAL chunk text
  end: number;          // exclusive
  tier: 1 | 2 | 3;
  kind: 'row' | 'value' | 'label' | 'quote';
};
export function computeHighlights(
  segmentText: string,
  chunkText: string,
  opts?: Partial<HighlightOptions>
): HighlightSpan[];
```

Tunable defaults: `ROW_MAX_CHARS` 240, `TIER1_MAX_ROWS` 3, `MAX_TOTAL_SPANS` 4, `TIER2_MIN_UNIGRAM_LEN` 5, `TIER2_MAX_UNIGRAM_ANCHORS` 2, `LLM_ALIGN_TIMEOUT_MS` 2500, `LLM_ALIGN_RATE_PER_MIN` 30, `citationAutoPage` on, `CITATION_LLM_ALIGN` **off**.

- **Tier 1:** split chunk into units (newlines, then the row-boundary pattern `/\|\s*\|/`, dropping markdown separator rows); units over `ROW_MAX_CHARS` are sentence-split on `[.!?؟:]`; units still too long are INELIGIBLE (this gate is what stops flattened-PDF blobs matching as one giant row). A unit fires iff it contains ≥1 claim figure (canonical, token-boundary) AND ≥1 claim content word. Fires on ALL qualifying units up to `TIER1_MAX_ROWS`.
- **Tier 2** (only if Tier 1 returned zero): unique figures → value span; ordered 2–4-word n-grams appearing exactly once → label span; fallback unigrams ≥5 chars occurring once, extended across `/`-joined runs. Uniqueness IS the precision proof. Non-contiguous label+value output is expected and correct.
- **Zero-figure claims** fire Tier 1 on ≥2 distinct content words (length ≥5) — this fixed the `AED 0` waiver case. `0` is a valid figure.
- **Boilerplate suppression:** `terms and conditions`, `provided documents`, `schedule of fees`, `important waivers`, `per package`, `business license`, plus any n-gram appearing in a markdown heading line. If the only surviving anchor is suppressed → zero spans.
- **Normalization** uses only 1:1 character mappings so highlight indices always reference the original string: Arabic-Indic digits `٠–٩` and `۰–۹` → `0–9`; `٬` `٫` → `,` `.`; NBSP/thin/narrow spaces → space; all dash variants → `-`; lowercase. Anything length-changing happens only in tokenization.
- **Renderer:** raw text with `white-space: pre-wrap` plus `<mark>` spans. Char ranges cannot survive markdown transformation, so the chunk body is NOT rendered through react-markdown.
- **Markers** are plain `⟦N⟧` sentinels transformed by `remarkCiteMarkers` into `<button type="button">`. Never `<a href>` — react-markdown's URL transform strips the `cite:` scheme and produced `href=""` which navigated to the current page.
- **Key API fact:** `groundingSupports[].segment.startIndex/endIndex` are UTF-8 BYTE offsets into the ANSWER markdown. There are NO chunk-side offsets anywhere in the API. Confirmed live: `segment.text === answer.slice(charStart, charEnd)` after byte→char conversion, for all supports tested. Chunk-side highlighting therefore uses only the string pair `(segment.text, chunk.text)`.

**Final live result:** 13/13 citations produced spans, 12 via Tier 1, zero boilerplate-wrong.

**Stage 2 (verified LLM alignment) is DESIGNED BUT UNBUILT.** Its trigger was "Tiers 1–2 returned zero spans", which no longer occurs. `CITATION_LLM_ALIGN` is declared and off. If ever built: one Worker route `POST /api/citations/align` taking `{ chunkText, segmentText }` → `{ spans: string[] }`, flash-lite at temperature 0, with mandatory server-side verification (every span must `indexOf`-match the chunk; if the claim has figures at least one surviving span must contain one or ALL are dropped; any span occurring 2+ times is dropped as unplaceable; cap 3; any parse error/timeout/rate-limit → `[]`), a Supabase cache table `citation_align_cache(key text primary key, spans jsonb, created_at timestamptz)` keyed on `sha256(chunkText + '\x1f' + segmentText + '\x1f' + PROMPT_VERSION)`, and a per-tenant rate limit.

## 6.8 The `.cursorrules` file

Saved at repo root as `.cursorrules` (leading dot, no `.txt`). Source copy at `/mnt/user-data/outputs/salni-v3/cursorrules.txt`. It encodes: schema-is-law pointing at `02_FINAL_SCHEMA_V3.sql`; the known phantom-column failures; security invariants; the fixed product strings; Gemini File Search operational facts; the error-surfacing rule; and the workflow rule that Lovable plans while Cursor writes.

**Entries added or corrected late in the session:**

```
documents.file_search_document_name must be read from operations response.documentName (NOT response.name); the store list pager returns .page (NOT .documents). Both bugs silently produced null names and broken backfill, which manifested as phantom retrieval failures.
```

```
chunkingConfig 200/20 is sent at ingestion but retrieved chunks routinely exceed it (~350-400 tokens observed) — treat as advisory; retrieval token volume is not reliably controllable via chunk size.
```

**Never landed:** that chunkingConfig ~350–400 advisory entry is **NOT** in `.cursorrules` on `main` (verified 2026-07-21). Do not treat it as shipped project law. The file does contain a shorter note that `chunkingConfig applies at ingestion only`.

```
Route files are statically imported by routeTree.gen.ts, so any top-level import in a route file runs at Cloudflare worker BOOT. Node-only packages (mammoth, pdf-parse, anything using require() or Node built-ins) crash workerd at boot and 500 EVERY route, surfacing as a generic swallowed SSR error. Import such modules lazily inside the handler (await import(...), cached in a module-level promise) — never at the top level of a route file. Localhost will not reproduce this: Vite dev runs Node, not workerd.
```

**Note:** after `4eeaf86`, `mammoth`/`pdf-parse` are removed from the repo entirely; the boot-route rule still applies to any future Node-only dependency.
**Corrected (previously wrong) entries:** the claim that File Search retrieval is "~60% stochastic" was revised to note it was largely attributable to the null `file_search_document_name` bug, with residual stochasticity unquantified. O1 and Q11 were REMOVED from known-limitations and demoted to eval fixtures only, because both pass on a correctly-indexed corpus.

## 6.9 Clean-document artifacts

Location: `/mnt/user-data/outputs/salni-clean-docs/`

- **`IFZA_Complete_Schedule_of_Fees_2024.md` — THE CURRENT ONE.** Lossless, all 15 pages.
- `IFZA_Company_Formation_Fees_and_Process_2024.md` — INCOMPLETE, superseded. Missing pages 8–14.
- `IFZA_Schedule_of_Fees_2024.md` — INCOMPLETE, first draft, superseded.
- `Meydan_Free_Zone_License_Details.md` — clean Meydan conversion. **[UNCERTAIN] never uploaded; the live corpus uses the original `.docx`.**

**Critical lesson:** the first extraction silently captured only ~4 of 15 pages, dropping the entire Schedule of Fees (pages 8–14) — roughly 60% of the fee content, including shareholder fees (350/750/500), the penalties section (1,000/month), cancellation fees, letters/documents, certificates, and general services. Neither party noticed until a test question happened to probe the missing region. This is the single strongest argument for the bidirectional completeness diff in any future automated conversion.

---

# SECTION 7 — OPEN ITEMS

## 7.1 Unresolved questions

1. **Does `fileSearch` + `capture_lead` compose on flash-lite?** THE blocking architectural question for the revenue feature. Never observed. See §6.5.
2. ~~**What is actually causing the production 500?**~~ **RESOLVED** — probe/`mammoth`/`pdf-parse` boot crash; see §8.0.
3. ~~**Is the deployed artifact the intended one?**~~ Outage root cause was not a stuck deploy; dual lockfiles / content-hash hygiene still worth monitoring separately.
4. **Why did the File Search store 403 on an unchanged API key?** Diagnosed as "store created under a different project/key", but the user states the `GEMINI_API_KEY` never changed. A separate investigation was prepared but never run: is the store being created under a different GCP project than the key resolves to, is `bootstrapStore` recreating it unnecessarily, or is `app_config.shared_file_search_store` pointing at a deleted store? Repeated re-indexing costs real embedding money.
5. ~~**Does the probe endpoint work at runtime on workerd even with lazy imports?**~~ **MOOT** — probe deleted in `4eeaf86`; not returning in this form.
6. ~~**[UNCERTAIN] Is the generic action-verb rule (§6.3) actually shipped?**~~ **Confirmed ABSENT** from the runtime prompt path; fee-addendum rule 3 covers adjacent ground. See §6.3.
7. **`@google/genai` lockfile skew:** `bun.lock` = **2.10.0**, `package-lock.json` = **2.11.0**. Lovable builds with bun → production runs **2.10.0**. Unresolved pending lockfile reconcile.
8. **Merge decision for `widget-persona-wip`:** see BRANCH STATE. Not on `main`; not deployed.

## 7.1a Reverse-audit findings (undocumented until 2026-07-21)

Found by a repo→docs audit. None of these were named in the original handoff.

**Routes / server functions absent from both docs:**
- Routes: `/api/public/widget-history`, `/embed-loader.js`, `/api/session`, `/sitemap.xml`, `/auth/sign-in`, `/auth/sign-up`, `/_authenticated/onboarding`, `/` landing.
- Server functions: `getSessionFn`, `signUpFn` / `signInFn` / `signOutFn`, `createOrgFn` / `suggestSlugFn`, `getEmbedOrgBySlugFn`, `listLeadsFn` / `updateLeadStatusFn`, and the documents functions including `backfillFileSearchNamesFn`.

**Env vars:**
- `SALNI_SUPABASE_URL` and `SALNI_SUPABASE_ANON_KEY` are read at runtime (`supabase.server.ts`) and set in Lovable but were undocumented.
- `QUERY_DIAG_PING` is read in `query.ts` and issues an **extra Gemini call per staff answer** when `"true"`. It is **NOT** set in Lovable → currently off. Do not enable in production without knowing the cost multiplier.
- `IP_HASH_SALT` falls back to `""` if missing (`widget.server.ts`) — fails open to **unsalted** IP hashes.

**Other:**
- `organizations.default_locale` is read (embed / widget) but never documented as a toggle.
- User-facing `"The assistant is temporarily rate limited…"` / `"The assistant is temporarily unavailable…"` strings in `query.ts` and `widget-query.ts` are **NOT** the three documented product constants. Reconcile before customers — the planned unanswered-questions inbox exact-matches the refusal constant.
- `CITATION_LLM_ALIGN` is defined in `defaults.ts` but **never read** anywhere.
- `recharts` and several UI-kit packages are installed but unused by any product route.
- Session cookie: `salni_session`, `httpOnly`, `sameSite: "none"`, `secure`, `partitioned` (required by the embed iframe).
- The `document_probes` table remains in the database but is now **unused** after `4eeaf86`.

## 7.2 Known issues (logged, NOT fixed)

- **`bun.lock` AND `package-lock.json` both exist in the repo.** Lovable builds with **bun**; Cursor installs with **npm**. Any dependency added via npm lands in `package-lock.json` but NOT `bun.lock`, so Lovable's build cannot resolve it. This will recur on every new dependency. **Also:** `@google/genai` is **2.10.0** (bun) vs **2.11.0** (npm) — production = bun = 2.10.0. **Recommendation: standardize on bun, since bun is what builds production.** This was raised during the outage and never resolved.
- **Lovable and Cursor both write to the same GitHub repo.** Lovable pushed 14 unreviewed commits during one session, including reverting the model lock back to `gemini-3.5-flash` / LOW thinking. The conflict was caught manually. **Do NOT disconnect Lovable's GitHub sync — it is the deploy pipeline.** Instead, never prompt Lovable to make code changes; use it for planning only and paste plans into Cursor.
- **Q14 (Meydan WPS)** refuses on both corpora — the fact is prose buried in mainland-comparison notes, not a clean fact line. The auto-scorer produced a false PASS by accepting a hedged mainland quote; mark manual-review-only.
- **Cross-doc retrieval ranking** favours the denser corpus. Q16 returned `grounding=4` with all four chunks from IFZA and zero from Meydan, then correctly reported Meydan data as absent. Classified `retrieval-ranking-cross-doc`. Scaling signal: comparison questions spanning corpora of very different density will systematically favour the denser one.
- **Citation over-highlighting within the correct chunk** — a figure shared across rows (e.g. `1,000`) can light multiple rows. Accepted deliberately: over-highlighting within the right chunk is the safe direction; chasing it risks regressing to sparse highlights.
- **The widget has no side citation panel** — public visitors get citation chips but cannot inspect source text. Deliberate V1 asymmetry, logged rather than discovered later.
- **Indexing is cron-only** (5-minute worst case); the Storage webhook was never wired. Acceptable per R-04. During testing, drain immediately with `curl -X POST <host>/api/public/process-documents -H "x-cron-secret: <CRON_WEBHOOK_SECRET>" -H "content-type: application/json" -d '{}'`.
- **`thoughtsTokenCount` is ABSENT from `usageMetadata` on flash-lite** — reported as `thoughtsField=absent`, not present-as-zero. Thinking is still generated and billed (the HIGH config cost ~2× MEDIUM), and `sumCheck=ok` implies it is folded into `candidatesTokenCount`. Do not use flash-lite for thinking-level cost attribution; the cost is captured in the total but not separable.
- **The Phase 1 retrieval probe was deleted** (`4eeaf86`) after causing the 2026-07-20 outage. Prior calibration was non-discriminative (all three fixtures scored 100%, including the known-weak IFZA PDF). Do not reinstate in this form. The `document_probes` table remains in the DB but is unused.

## 7.3 Parked ideas (designed, not built)

- **De-specification audit.** The `FEE_DISAMBIGUATION_ADDENDUM` currently names IFZA-specific fee labels. That is over-fitted and cannot scale to white-label customers with unseen documents. **The eval set is allowed to be document-specific; the runtime prompt must be document-agnostic.** The prepared audit asks Cursor to list everything in the runtime path that names specific IFZA/Meydan fees, classify each as generic-principle vs specific-rule, and rewrite the specific ones as generic structural principles.
- **Phase 2 ingestion conversion pipeline** — SHELVED. Full design at `/mnt/user-data/uploads/INGESTION_QUALITY_PIPELINE_DESIGN.md`. Interim policy: **concierge conversion** — manually clean fee-dense documents for the first 1–10 tenants. Build the automation only when the manual version becomes the bottleneck. Phase 2 go/no-go threshold: ≥15% of documents warn+bad, AND a minimum sample of 30+ documents across 3+ distinct tenants.
- **Semantic answer cache** — the biggest volume cost lever. Exact-match only, per-org, keyed on `hash(org_id, corpus_version, prompt_version, model_id + thinking_level, normalized_question)`; `corpus_version` is a per-org counter bumped by any document change, so stale entries can never be served. Never cache refusals. Never global, never fuzzy (a global question-keyed cache would serve one tenant's fees to another's customers). Expected hit-rate source: the widget's suggested-question chips.
- **Refusal short-circuit** — abort generation early when grounding is empty. Ship logging-only first to measure the false-positive rate.
- **`top_k` / `maxNumResults` tuning** — deliberately NOT done. Retrieval tokens cost ~half a cent and comparison answers need multiple chunks.
- **Deterministic model router** — cheap model for simple questions, escalate on arithmetic/comparison keywords. Must be pattern-based, never LLM-classified. Eval-gated.
- **Store sharding** — trigger metric is `fileSearchStores.get().sizeBytes` crossing ~5 GB raw (≈15 GB backend, 75% of the 20 GB latency guidance). Route new orgs to shard N+1 via the existing nullable per-org `file_search_store_name` override. At 3 documents this is premature; build only the `sizeBytes` monitor (~20 lines).
- **Context caching** — only above ~500 questions/day per org.
- **Stripe billing, email (Resend), voice** — all V2. V1 sends NO email; leads surface in-dashboard only.
- **Org-admin Insights page** — usage vs plan cap, unanswered-questions inbox (identified by exact-matching the refusal constant — **staff constant only**; after D16 / `widget-persona-wip` merges, widget conversational refusals will not match), top questions by normalized text, refusal rate. Read-only, zero schema changes, exact-match grouping only (no semantic clustering).
- **Team management** — members page, email-less tokenized invite links, role-scoped nav so `agent` sees chat but not leads/settings. **[UNCERTAIN] whether this exists; a verification prompt was drafted but never run.**
- **WhatsApp / Instagram DM integration** — the real social-acquisition play for Dubai, but weeks of work each with Meta approval. The shareable `/embed/:slug` link bridges the gap. Logged as V2's top acquisition item.
- **Automated LLM-driven metadata filtering by `doc_type`/`zone`** — explicitly REJECTED. A mislabel produces a silent false refusal, and hard content filters break cross-document comparisons. Safe variant: deterministic tagging chosen by the tenant at upload, used for analytics or an explicit user-clicked scope toggle — never model-inferred at query time.

---

# SECTION 9 — WORKING PREFERENCES

- **Plan-first on anything non-trivial.** Ask for findings/diagnosis BEFORE code. Approve the plan, then authorize the build.
- **Diagnose, never guess-patch.** Every real bug this session was found by demanding the raw error, the raw payload, or the raw log — not by reasoning from symptoms. Masked errors repeatedly hid real bugs (a loader mapping every DB error to `notFound()`, a silently failing audit insert, a throttle message covering RPC failures).
- **One variable at a time, measured before and after.** Never change model and thinking level in the same deployment.
- **Nothing ships against an unmeasured baseline.**
- **Hard checkpoints on long-running tasks.** Any task scoped as "diagnose" gets a checkpoint at ~5 minutes. Cursor went autonomous three times: the O1 query-path rebuild (reverted), a 20-minute "diagnosis" that had started implementing, and an unrequested hover tooltip. Add a closing line to UI prompts: *"do not add any interaction, component, or affordance not explicitly listed above."*
- **Precision over coverage** in anything user-facing. A missing highlight is acceptable; a wrong one is not. A refusal is recoverable; a confidently wrong fee is not.
- **Verify external API claims before building on them.** `chunkingConfig` was confirmed real via documentation search; the deletion `force:true` parameter and the `page_size` cap were learned from live errors.
- **Schema is law.** Fix the code, never the schema. Any schema change goes into `02_FINAL_SCHEMA_V3.sql` first, then the live DB.
- **Eval hygiene:** every known failure becomes a permanent regression case immediately, and no corpus/model/config comparison ships without the full regression set attached. **Twice this session an eval omitted the very failure class it was meant to detect and produced a confident wrong conclusion** — the retrieval probe scored a known-bad document at 100%, and the fresh-20 declared the PDF superior while excluding the conflation and waiver cases.
- **Beware confident root causes resting on unverified plumbing.** Twice a system-level explanation ("stochastic retrieval", "dense PDFs are unretrievable") was wrong while the real bug was mundane (a wrong field name, a wrong pager property). When a system-level explanation would justify a large build, verify the plumbing first. A flagship conversion pipeline was nearly built to solve a typo in a field name.
- **Ship rule:** don't polish past completeness. Presentation work consumed a large share of a session on a product that already answered correctly and cheaply, while the revenue feature stayed untested.

---

# SECTION 10 — GLOSSARY

| Term | Meaning |
|---|---|
| **Salni** (سَلْني, "ask me") | The product: multi-tenant white-label AI knowledge assistant for UAE/Dubai SMBs |
| **IFZA** | International Free Zone Authority, Dubai. Source of the primary test corpus |
| **Meydan** | Meydan Free Zone, Dubai. Second test corpus (a `.docx` of license details + a large activity-list PDF) |
| **Free zone** | A UAE jurisdiction offering business licences with 100% foreign ownership |
| **Establishment Card / E-Card** | Government card required per company before visa processing |
| **Quota allocation** | Meydan's per-visa allowance fee, paid before the visa itself |
| **Status change** | Converting a visitor to resident status without leaving the UAE |
| **PDPL** | UAE Personal Data Protection Law. Drives the verbatim consent-text storage requirement |
| **VARA** | Dubai Virtual Assets Regulatory Authority. Activity codes `6619.81`–`6619.88` carry a `PRE` pre-approval designation |
| **WPS** | Wage Protection System. Meydan free zone does not require it |
| **File Search** | Gemini's managed RAG service — hosts documents, chunks, embeds, retrieves |
| **`groundingChunks`** | Everything File Search retrieved for an answer |
| **`groundingSupports`** | The subset the answer actually used, with answer-side byte offsets. Citations derive from THIS, not from chunks |
| **`toolUsePromptTokenCount`** | Retrieved chunk tokens, billed as INPUT. Was invisible to the cost logger and caused a ~2–20× undercount |
| **`metadataFilter`** | The server-injected `org_id="..."` filter that is the tenant-isolation boundary |
| **`customMetadata`** | Per-document `{org_id, document_id}` tags set at upload; the basis of the isolation filter and of the FS-name backfill |
| **`end_user_ref`** | Anonymous widget visitor UUID in `localStorage` (`salni.eur.<orgId>`); widget conversations are `started_by IS NULL` + `end_user_ref` set |
| **XOR (of documents)** | The rule that the clean version OR the original is indexed, never both — near-duplicate chunks compete and reproduce conflation bugs |
| **Concierge conversion** | Manually cleaning a tenant's fee-dense document by hand, for the first 1–10 customers |
| **Tier 1 / Tier 2 / Tier 3** | Citation-highlight tiers: deterministic row match, unique anchors, verified LLM alignment (unbuilt) |
| **O1** | The shorthand for the "add an individual shareholder" retrieval case (setup 350 vs amendment 2,000) |
| **Fresh-20** | The 20-question validation set of §6.6.1 |
| **`workerd`** | Cloudflare's Workers runtime. Not Node — Node-only packages crash it at boot |

---

# SECTION 11 — SWEEP

Items not captured above or in Part 1:

- Model pricing verified July 2026 (USD per 1M tokens, input/output): `gemini-3-flash` $0.50/$3.00; `gemini-3.5-flash` $1.50/$9.00; `gemini-3.1-flash-lite` $0.25/$1.50; `gemini-3.1-pro-preview` $2.00/$12.00 (≤200k); `gemini-2.5-flash` $0.30/$2.50 (deprecation scheduled 16 Oct 2026, already sunset for this key).
- `gemini-2.5-flash` **lists** in the models endpoint for this key but 404s on generate ("no longer available to new users") — listing ≠ usable.
- Batch API is ~50% of standard rates. Useful for offline eval runs only, never the live path. **[UNCERTAIN] whether `fileSearch` is accepted inside batch requests — untested.**
- Implicit context caching gives a 90% discount on cached tokens but has a minimum-prefix threshold (~4,096 tokens for Gemini 3/3.1) that the current static prefix probably does not reach — `cachedContentTokenCount` is absent from flash-lite's `usageMetadata` entirely.
- Explicit caching costs $1.00 per 1M tokens per hour of storage — not worth it at current prompt sizes.
- Google Cloud billing for the heaviest test day (17 July 2026) totalled **A$0.59**: output tokens 21,500 → $0.28; input tokens 114,599 → $0.25; `gemini-embedding-001` 282,869 → $0.06; expansion (flash-lite) 340 + 1,231 → $0.00. Embedding charges come from **re-indexing**, which was pathologically frequent during testing and will be near-zero in normal operation.
- Measured final per-question cost on the locked config: `[cost] model=gemini-3.1-flash-lite thinkingLevel=MEDIUM rates=$0.25/$1.5 prompt=738 toolUse=3260 candidates=98 thoughts=0 thoughtsField=absent grounding=1 costUSD=0.001146`. Credit balance at handoff ≈ **A$15.70**.
- The cost logger had a second bug beyond the missing `toolUsePromptTokenCount`: the rate table was hardcoded to 3.5-flash prices while the model was flash-lite, inflating every reported figure ~6×. Fixed by making rates model-aware. Commits `ce91c4f` (duplicate `ThinkingLevel` import from the merge) and `afb9713` (model-aware rates).
- `thinkingLevel` on flash-lite uses `ThinkingLevel.LOW` / `.MEDIUM` / `.HIGH` from `@google/genai` 2.11.0. You cannot send both a thinking level and a thinking budget in one request (400). `thinkingBudget: 0` would disable reasoning entirely and was deliberately NOT used.
- Query expansion was silently timing out on **every** call for an unknown period — the 800 ms budget was at the floor (measured RTT 889–1496 ms). Fixed with `thinkingLevel: MINIMAL`, `maxOutputTokens: 64`, and the budget raised to 2000 ms. Expansion fails open, so this was invisible until instrumented.
- Deleting a File Search document requires `force: true`, else `400 FAILED_PRECONDITION "Cannot delete non-empty Document"`.
- `fileSearchStores.documents.list` `page_size` must be 1–20 (a request for 100 returns `400 INVALID_ARGUMENT`).
- `AQ.`-prefixed Google API keys are real — Google migrated from `AIza` mid-2026.
- File Search cannot be combined with Google Search grounding or URL Context.
- Deleting a document orphans the Gemini-side resource if `file_search_document_name` is null. `deleteDocumentFn` now resolves a null name (bootstrap store → list → match `customMetadata.document_id`) before deleting, and **keeps the DB row** if it cannot resolve, rather than silently orphaning. A successful list with no match is treated as already-gone and proceeds.
- Test org: `recoupr-3`, `org_id f609061b-e159-4534-a269-532d7e745851`. Second org `recoupr-document` (`1ef8c7d6-…`) holds the old IFZA PDF; cross-org isolation was verified correct (0 chunks leaked).
- Local dev env file is `.env.local`; `.gitignore` now covers `.env`, `.env.*` (keeping `.env.example`), and `.tmp-*`.
- Dev server ports drifted across 8080/8083/8084/8085 during the session — stale servers caused at least one "nothing changed" false alarm. Kill all Vite processes and start one.
- The `[cost-total]` line aggregates the expansion call plus the answer call for a true per-question figure.
- A monitoring watcher produced repeated false alarms by matching the substring `errored=false` in normal logs.
- Google AI Studio keys give thinner billing granularity than Cloud project keys; the reliable ground-truth method is balance-before/after a fixed number of questions.
- Last commits: `8a9bc93` (25 files: citations, evals, autoscroll, markdown rendering) pushed to `origin/main`; earlier `06f5700` (the `documentName` fix), `17d9cbb`, `d1e260b` (merge resolving Lovable's model-lock revert).
