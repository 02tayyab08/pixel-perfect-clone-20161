# Design: Document Ingestion Quality Pipeline

**Status (2026-07-19):**  
- **Phase 1 — KEEP**, reframed: **retrieval regression detection / index-health check** (not conversion triage).  
- **Phase 2 — SHELVED** — premise not supported: original IFZA PDF scored **18/20** vs clean markdown **16/20** once indexing was correct (2026-07-19). Root cause of prior “unretrievable dense pages” was two infra bugs: `response.documentName` vs `response.name` (null `file_search_document_name`) and list pager `.page` vs `.documents` breaking backfill. **Revisit Phase 2 only if real tenant documents probe badly.**

**Prior status:** APPROVED 2026-07-18 (with amendments). Phase 1 build authorized; Phase 2 was gated on go/no-go — **that gate is moot; premise falsified.**

**Evidence:** `eval/FRESH20_PDF_VS_MD.md`, `eval/fresh20-pdf-vs-md-2026-07-19.json`, `eval/PROBE_CALIBRATION.md`.

**Related:** `eval/DECISION_LOG.md`, `eval/known-soft-fail-regressions.json` (eval regression cases only — not ingestion-conversion drivers).

### Approved amendments (2026-07-18)

1. **§1.3** — Probe questions from **direct text extraction** only (never File Search inventory).
2. **§3.2** — Boilerplate suppression for numeric diff (headers/footers/phones/URLs/dates).
3. **§11 Phase 2** — Gold fixture must include a **deliberately corrupted** transcript to prove Direction B. *(Shelved with Phase 2.)*

### Locked decisions (updated 2026-07-19)

| # | Decision |
|---|----------|
| 1 | Phase 1 thresholds (**8Q**, warn **\< 0.75**, bad **\< 0.50**) remain as starting values for **index-health / regression** probes — not as conversion triage scores. Dense-page Q-gen weighting is **deprioritized** (no known-bad document to weight toward after infra fix). |
| 2 | Phase 2 go/no-go — **SHELVED**. Do not build conversion until real tenant docs probe badly under correct indexing. |
| 3 | Schema: **Option A** (side quality state; `ready` keeps current meaning). |
| 4 | `probe_bad`: **WARN-ONLY** — does not block widget publish. |

---

## 0. Principles (non-negotiable)

1. **Measure index health** — can File Search retrieve this document’s own facts under the stamped `document_id`? A null `file_search_document_name`, failed backfill, or empty extract should surface here. This is **not** a static “complexity score” and is **not** (after 2026-07-19) treated as conversion triage.
2. **Zero-loss conversion** — *(Phase 2 shelved)* omission and invention are both blocking if conversion is ever revived.
3. **Page-by-page conversion** — *(Phase 2 shelved)* never whole-document single-pass.
4. **Index one representation only** — clean XOR original; never both (near-duplicate conflation observed live).
5. **Human approval gates indexing of converted content** — *(Phase 2 shelved)* diff-driven, not “looks right?”
6. **Schema is law** — any new columns/enums/tables land in `02_FINAL_SCHEMA_V3.sql` first; this design proposes them, does not invent them in app code.
7. **Do not change the locked answer path** (`gemini-3.1-flash-lite` / MEDIUM, single File Search, question in contents) to compensate for bad ingestion.

---

## 1. Detection: retrieval self-probe

### 1.1 Purpose

**Primary purpose (reframed 2026-07-19):** **retrieval regression detection** — catch silent index/infra failures automatically (e.g. null `file_search_document_name`, broken list backfill, empty text layer, store mismatch). A Phase 1 probe scoped to `document_id` would have failed hard when the resource name was null / the doc was not listable — that is the value.

**Not the purpose:** ranking documents for clean-file conversion. The IFZA “known bad PDF vs known good markdown” calibration premise is **falsified** once indexing is correct.

After a document reaches File Search `ready`, automatically ask: *“Can this store retrieve facts that exist in this file under this `document_id`?”* Failures indicate **index/health problems** first; only sustained `probe_bad` on correctly named, listable docs should reopen conversion discussion.

### 1.2 Pre-filter (cheap heuristics — skip probe)

Skip the probe (treat as **probe_skipped / assume OK**) when **all** of:

| Condition | Rationale |
|-----------|-----------|
| Extension ∈ `{.txt, .md, .markdown, .csv, .tsv}` **or** MIME is plain text / markdown / csv | Already text; our failures cluster on PDF/DOCX/scanned dense layouts |
| Size below a small floor (e.g. `< 2 KB`) | Nothing meaningful to probe; avoid noise |

Still probe:

- PDF, DOCX, DOC, RTF, HTML, images-as-docs (if ever allowed), XLSX (tabular-but-layout-heavy)
- Any type that went through binary→File Search ingestion without a tenant-supplied clean markdown twin

Pre-filter is **not** a quality score; it only saves cost when the failure mode is empirically rare.

### 1.3 Probe-question generation

**When:** Immediately after successful index (`status=ready` + `file_search_document_name` set), enqueue `probe_document`.

**Model:** Cheap (`gemini-3.1-flash-lite` or equivalent expansion-tier model). Temperature 0.

**Input to generator — DIRECT TEXT EXTRACTION ONLY (mandatory):**

1. Extract text from the **stored original bytes** with a local text-layer tool — e.g. `pdftotext` (or equivalent PDF text-layer extract), DOCX document.xml / mammoth text layer, raw read for txt/md/csv.
2. Cap/truncate the extract for the Q-gen prompt (e.g. first + middle + last slices totaling ≤ ~12–16K tokens) so generation stays cheap while still sampling late pages.
3. Feed that extract to the cheap model to produce 8 atomic probe questions (and optional expected answer atoms for soft scoring).

**FORBIDDEN:** Generating questions via a File Search “inventory” call (or any other use of the retrieval system under test). That is circular: if retrieval is broken, inventory only sees the retrievable subset and the document scores **falsely high**.

**No text layer (true scan / empty extract):**

- Do **not** invent questions from filename or File Search.
- Mark `probe_confidence = low` and `probe_class = inconclusive` (not `probe_ok`, not a pass).
- Tenant messaging: “Could not text-extract this file for a retrieval check (possible scan). Answers may be unreliable until a text-based version is available.”

**Output:** 8 questions (N locked as starting value), JSON array. Constraints for the generator:

- Each question must be answerable by a **single atomic fact** in the **extracted text** (one fee, one condition, one named item).
- Prefer **numeric** or **named-entity** answers (figures, yes/no on stated rules, exact labels).
- Forbid meta questions (“summarize the document”, “list all fees”).
- Diversify: mix setup/base vs amendment-like labels when both appear in the extract; mix early and late slices of the extract.
- Language: same as document / org default locale.

**Example shapes (generic):** “What is the exact fee labeled \<X\>?”, “Under what condition is \<Y\> waived?”, “What is the renewal fee for \<Z\>?”

### 1.4 Probe execution

For each question:

1. Call the **same File Search stack** as production answers (shared store + `metadataFilter` on `document_id` **and** `org_id` — never trust client org; resolve server-side).
2. Use cheap model + **MINIMAL/LOW** thinking; short `maxOutputTokens`.
3. Record per question:
   - `grounding_chunk_count` (and whether any chunk’s `document_id` metadata matches this doc)
   - `is_refusal` (exact refusal string or empty grounding + refusal behavior)
   - optional: whether expected numeric token from the generator’s “atom” appears in the answer (soft signal; primary gate is grounding)

**Scoped retrieval:** Probes must filter to **this document only**. If File Search metadata cannot isolate by `document_id`, Phase 1 must block on that as a prerequisite (we already stamp `document_id` in customMetadata at ingest — design assumes that continues).

### 1.5 Grounding-rate threshold

Define:

```
probe_success_rate = (# questions with grounding_chunk_count ≥ 1
                      AND not hard-refusal)
                   / (# questions asked)
```

| Rate | Classification | Tenant-visible (Phase 1) |
|------|----------------|--------------------------|
| ≥ **0.75** (e.g. ≥ 6/8) | `probe_ok` | Silent / optional “looks good” |
| **0.50 – 0.749** | `probe_warn` | Warning: may answer questions unreliably |
| **\< 0.50** | `probe_bad` | Strong warning; recommend text/markdown — **WARN-ONLY** (does not block widget publish) |
| n/a | `inconclusive` | No usable text layer / low confidence — not a pass |

**Locked starting values:** **N = 8**; `probe_warn` if success **\< 0.75**; `probe_bad` if **\< 0.50**.

**Calibration gate (before treating thresholds as operational):** Run the probe on three known fixtures and confirm ranking **original IFZA PDF (bad) ≤ Meydan docx (mixed) ≤ IFZA_Complete_Schedule_of_Fees_2024.md (good)**. Record and publish the three `probe_success_rate` values. If ranking fails, retune N/thresholds before Phase 1 is considered calibrated.

**Re-probe after conversion (Phase 2):** Same N and same question set **frozen** from the pre-conversion probe (stored). Success metric = **before/after `probe_success_rate` delta**, not a new random question set. Also require post-conversion rate ≥ warn threshold before offering approval.

### 1.6 Cost per document (probe)

Assumptions (order-of-magnitude, lite list rates ~$0.25/M in / $1.50/M out; File Search toolUse dominates):

| Step | Calls | Est. tokens (in+toolUse / out) | Est. USD |
|------|-------|--------------------------------|----------|
| Local text extract | 0 model | — | ~$0 |
| Q-gen from extract | 1 | ~4–8K in / ~0.5K out | ~$0.002–0.003 |
| Probe answers × 8 | 8 | ~3–5K toolUse each / ~0.1–0.3K out | ~$0.008–0.012 |
| **Total probe** | | | **~$0.01–0.02 / doc** |

At 100 docs: **~$1–2** probe-only. Negligible vs answer traffic.

---

## 2. Conversion: page-by-page, flagship model (Phase 2)

### 2.1 Model

Flagship transcription model (e.g. **gemini-3.1-pro** or current best multimodal doc model). One-time per document (and per re-convert). Quality ≫ cost.

### 2.2 Unit of work: one page (or equivalent slice)

**Never** send the whole document in one generation call.

| Source type | Slice |
|-------------|--------|
| PDF | One PDF page image + optional embedded text layer for that page |
| DOCX | One exported “page” or logical section ≤ ~1–1.5K tokens of source; prefer print-pagination if available |
| Other | Fixed-size chunks with overlap **only** for continuity notes — still one model call per slice |

**Per-page call contract:**

- System: “Transcribe this page to Markdown. Preserve every figure, label, condition, and non-tabular sentence. Do not summarize. Do not omit rows. Do not invent figures. Self-label every table row.”
- User: page image and/or page text + page index `i/N`.
- Output: Markdown for **this page only**, wrapped with markers:

```markdown
<!-- page:3 of:15 -->
...content...
<!-- /page:3 -->
```

**Completeness signals (local):**

- Empty / near-empty page output when source page has text density → auto-retry once with stricter prompt.
- Page fails after retry → mark page `conversion_failed`; document cannot enter `pending-review` until resolved (re-run page or human paste).

Concatenate pages in order → candidate clean markdown.

### 2.3 Output format rules (generic)

**Default: Markdown with self-labeling rows**

```markdown
| Item | Fee (AED) |
| --- | --- |
| Additional Individual Shareholder | 350 |
| Change/Adding/Removing of Shareholder | 2,000 |
```

Or prose-equivalent lines that remain self-describing after arbitrary chunk cuts:

```text
Additional Individual Shareholder: AED 350
Change/Adding/Removing of Shareholder: AED 2,000
```

**Why not CSV as default:** File Search chunks by token count; a mid-file CSV slice loses the header and becomes “350” without a label — retrievable but harmful. Self-labeled markdown/prose rows survive chunk boundaries.

**CSV allowed only when:** pure enumeration (code + name), no fees, no conditions, no waivers, no multi-column semantics that depend on a header.

### 2.4 Structural principles (document-agnostic)

1. **Separate similarly labeled but semantically distinct families into different sections**  
   e.g. “Base / setup / add-on fees” vs “Amendments / modifications / changes” — addresses action-verb retrieval competition (O1 / fresh-Q11 class).

2. **Conditions, waivers, exceptions INLINE next to the item they modify**  
   Not on a later page alone — addresses multi-page reconciliation misses.

3. **Preserve ALL non-tabular content**  
   Process steps, requirements, timelines, footnotes, prose. Omission → false refusals (fresh-Q14 class).

4. **No summarization, no “key points only,” no merging of two fee lines into a range** unless the source itself states a range.

---

## 3. Completeness gate: bidirectional numeric diff

### 3.1 Role

Blocking gate between conversion and human approval. **No approve** while unresolved discrepancies exist (human may resolve by editing transcript or marking an explained exception — see 3.5).

### 3.2 Numeric token extraction (both sides)

Normalize then extract from **original** (text layer + OCR of page images if needed) and **transcript**:

1. Unicode normalize (NFKC); map exotic spaces to ASCII space.
2. Lowercase currency words optional; keep symbols.
3. Extract candidates with a single regex family, then normalize each to a **canonical key**:

**Patterns to catch:**

| Form | Example | Canonical |
|------|---------|-----------|
| Plain integers | `350`, `4500` | `350`, `4500` |
| Thousands separators | `2,000`, `2.000` (EU — careful), `2 000` | `2000` |
| Decimals | `2,020.50`, `2020.5` | `2020.50` (scale-aware) |
| Currency prefix/suffix | `AED 2,000`, `$1,500`, `2000 AED` | numeric core `2000` |
| Ranges | `2,000-4,000`, `2000–4000`, `2,000 – 4,000` | **two** tokens: `2000`, `4000` |
| Percentages | `50%`, `20 percent` | `50%` as distinct token type `pct:50` |
| Multipliers in prose | `1,000/month`, `4500/year` | numeric `1000` / `4500` plus optional unit tag (unit not required for gate) |

**Canonicalization rules:**

- Strip currency codes/symbols and units for the **numeric multiset** used in the gate.
- Remove thousands separators; unify decimal to `.`.
- Ranges → emit both endpoints (and optionally a composite `2000-4000` for logging only).
- Percentages live in a separate multiset (`pct`) so `50` (AED) does not collide with `50%` incorrectly — compare pct-to-pct and amount-to-amount.
- Ignore pure page numbers / list indices only when **high confidence** they are pagination (optional heuristic: isolated `1`…`N` matching page count). Prefer **false positive discrepancy** over dropping a real fee `1` or `5` if ambiguous — human resolves.

**Boilerplate suppression (mandatory — non-blocking bucket):**

Before multiset comparison, classify tokens that would otherwise drown Direction A with header/footer noise. Move these to a **`boilerplate` bucket** that is **logged but does not block** approval:

| Class | Detection (heuristic) |
|-------|------------------------|
| Repeated-identical-across-pages | Same canonical token appears on ≥ **K** distinct pages (default K = 3) with near-identical local context (header/footer band) — e.g. a phone number on all 15 pages |
| Phone numbers | Patterns like `+971…`, `(0xx) …`, national numbers ≥ 7 digits with phone separators |
| PO boxes | `P.O. Box`, `PO Box`, `P.O.B` + following digits |
| URLs | `http(s)://`, `www.`, common domain tokens |
| Dates | Explicit dates (`2024-09-01`, `1 September 2024`, `09/2024`) — year-alone `2024` may stay in the gate if it appears as a fee-schedule year label; prefer suppressing only full date forms |

**Rationale:** Without this, page headers/footers generate dozens of false Direction-A discrepancies and reviewers rubber-stamp, destroying the gate. Fee-like amounts that are **not** boilerplate remain in the blocking multisets `O` / `T`.

### 3.3 Multiset comparison

Let `O` = multiset of canonical amount tokens in original.  
Let `T` = multiset of canonical amount tokens in transcript.  
(Same for `O_pct` / `T_pct`.)

**Direction A — omission (original → transcript):**  
For each distinct key `k` in `O`: if `count_T(k) < count_O(k)`, emit discrepancy:

```
MISSING_OR_UNDERCOUNTED { key, original_count, transcript_count, delta }
```

**Direction B — invention/substitution (transcript → original):**  
For each distinct key `k` in `T`: if `count_O(k) < count_T(k)`, emit:

```
EXTRA_OR_OVERCOUNTED { key, original_count, transcript_count, delta }
```

Direction B is **mandatory** and blocking — a transcript figure absent from the source is a **fabricated fee**.

**Per-figure count** is exactly the multiset rule above (e.g. `2000` appears 8× in original, 3× in transcript → undercount delta 5).

### 3.4 Diff report artifact

Store structured JSON + human-readable list:

- Summary counts: missing keys, extra keys, undercounts, overcounts
- Top discrepancies with optional page hints (from page markers / nearest heading)
- Full multisets for audit

### 3.5 On diff failure

- Document state stays **`conversion_diff_failed`** or **`pending_review` with `diff_blocking=true`** (see §5) — **cannot approve for clean-index**.
- UI lists each discrepancy; human must either:
  - **Edit** the markdown so the multiset matches, then re-run diff, or
  - **Mark explained** with a reason code (rare): e.g. `ocr_garbage_in_source`, `decorative_page_number` — requires typed justification; Direction B extras still default to **disallowed** unless reason is in an allowlist reviewed in design approval.
- Re-diff after every edit until `diff_blocking=false`.

**Pass condition:** Direction A and B both empty (or only allowlisted explained exceptions).

---

## 4. Human review UI

### 4.1 Layout

| Region | Content |
|--------|---------|
| Left | Original preview (PDF page viewer / DOCX preview) — page-aligned when possible |
| Right | **Editable Markdown** of the clean transcript (textarea or MD editor) — typing, not PDF surgery |
| Top / drawer | Diff panel: “**N figures could not be verified** — confirm or correct each” with highlighted keys |

### 4.2 Interaction rules

- **Do not** lead with “Does this look right?”
- Diff items are first-class: jump-to-highlight in markdown; show expected multiset counts.
- Probe before/after rates shown as secondary metric (“retrieval self-probe: 3/8 → 7/8”).
- **Explicit Approve** control disabled while `diff_blocking=true`.
- Approve writes audit row: actor, timestamp, diff snapshot hash, probe scores, which storage object will be indexed.

### 4.3 Roles

Org members who can manage documents (existing membership); no anonymous access. Service role performs conversion jobs only.

---

## 5. Indexing rules & state machine

### 5.1 Hard rule

**Index clean XOR original — never both.**

- On approve: upload clean `.md` to File Search with same `document_id` metadata; **delete** the previous File Search resource for that document (`force:true`); update `file_search_document_name`; keep original bytes in Storage under an audit path.
- On reject / abandon conversion: leave original indexed; discard or archive clean draft.
- Re-convert: same exclusivity.

Near-duplicate dual-index reproduced fee conflation in production; this rule exists to prevent regression.

### 5.2 Proposed state machine

Current V3 `doc_status`: `queued | indexing | ready | failed` only. **Phase 2 requires a schema extension** (new enum values and/or side tables). Proposed logical states:

```
uploaded
  → queued
  → indexing
  → ready                    # original in File Search
  → probing
  → probe_ok | probe_warn | probe_bad
       ↘ (Phase 1: stop here — warning only)
  → converting               # Phase 2
  → conversion_failed        # page-level failure
  → diffing
  → diff_blocking            # cannot approve
  → pending_review           # diff clean or explained
  → approved
  → clean_indexing
  → ready                    # clean in File Search; original Storage retained, not indexed
```

**Implementation options (decide at build):**

- **A (preferred):** Keep `documents.status` as today’s enum for “is this answerable?” (`ready`/`failed`/…) and add `documents.ingestion_quality jsonb` + table `document_conversion_jobs` for substates — avoids overloading answer-path status.
- **B:** Extend `doc_status` enum with the new values — simpler mentally, wider blast radius on RPCs/UI.

Design recommendation: **Option A (approved)** so `ready` continues to mean “eligible for File Search answers,” while quality substate lives beside it. Warnings show when `probe_class ∈ {warn,bad,inconclusive}` even if `status=ready`. Widget publish is **not** blocked by probe class in Phase 1.

### 5.3 Storage layout (conceptual)

```
documents/{org_id}/{document_id}/original/<file_name>
documents/{org_id}/{document_id}/clean/transcript.md
documents/{org_id}/{document_id}/clean/diff.json
documents/{org_id}/{document_id}/probes/latest.json
```

Only one File Search document resource active per `documents.id`.

### 5.4 Deletion

Existing delete path must remove the **active** File Search resource (resolve by name / `document_id` metadata) and Storage originals + clean drafts. No orphans (already a known failure mode).

---

## 6. Phased delivery

### Phase 1 — Probe + warning only (build first)

**Scope:**

- Pre-filter + self-probe after index
- Persist probe results (questions, per-Q grounding, success rate, class)
- Tenant UI: badge/banner on document list + detail — e.g. “This document may not answer questions reliably (probe 3/8). Consider uploading a text or markdown version.”
- Cron/worker extension beside `process-documents` (or chained job)
- **No** conversion, **no** flagship calls, **no** review UI, **no** re-index swap

**Duration target:** days, not weeks.

**Success of Phase 1 itself:** Warnings fire on a non-trivial share of real uploads; zero impact on locked answer model path.

### Phase 2 go / no-go metric — SHELVED (2026-07-19)

**Do not build Phase 2.** The IFZA PDF-vs-md premise that motivated conversion is falsified (PDF 18/20 ≥ md 16/20 under correct indexing). Historical go/no-go thresholds below are retained only as archive:

| Requirement | Threshold (was locked) |
|-------------|-------------------|
| Share of probed docs with `probe_warn` or `probe_bad` | **≥ 15%** |
| Minimum sample | **≥ 30 documents** |
| Tenant diversity | **≥ 3 distinct tenants** |

**Revisit only if** real tenant documents probe badly when `file_search_document_name` is non-null and the doc is `STATE_ACTIVE` in the store.

### Phase 2 — Full pipeline (SHELVED)

Conversion (page-by-page) → bidirectional diff → editable review → approve → clean-index / original-deindex → **re-probe with frozen questions** → require post-probe improvement or absolute ≥ warn threshold.

*Not authorized for implementation.*

---

## 7. Cost model & unit economics

### 7.1 Per document

| Stage | When | Est. USD / doc |
|-------|------|----------------|
| Self-probe (8Q) | Every binary-ish upload | **$0.01–0.02** |
| Conversion (flagship × pages) | Phase 2, flagged/opt-in | **~$0.05–0.25 / page** (order-of-magnitude; calibrate on first 10 PDFs) → 15-page PDF **~$1–4** |
| Re-probe | After conversion | **$0.01–0.02** |
| Diff | CPU only | ~$0 |

### 7.2 Tenant onboarding 100 documents

| Scenario | Est. cost |
|----------|-----------|
| Phase 1 only (all probed; 70% skip as md/txt) | 30 × ~$0.015 ≈ **~$0.45** |
| Phase 1, all 100 need probe | **~$1–2** |
| Phase 2 converts 20 flagged 10-page PDFs | 20 × ~$2 ≈ **~$40** one-time |

**Unit economics:** Probe cost is noise. Conversion is the meaningful line item — acceptable as one-time onboarding if it prevents fabricated/conflated answers and support burden. Optionally bill conversion as a premium “document cleanup” action; Phase 1 warnings remain free.

---

## 8. What could go wrong (and mitigations)

| Risk | Mitigation |
|------|------------|
| Probe questions too easy / not covering dense pages | Generate from full extract slices (early/mid/late); freeze questions for before/after; calibrate on known bad/good/mixed fixtures |
| Circular probe via File Search inventory | **Forbidden** — direct text extract only; scans → `inconclusive` |
| Probe false `probe_ok` on bad docs | Prefer numeric atoms; require grounding chunks; never greenwash `inconclusive` |
| Probe false `probe_bad` on good docs (File Search flake) | Allow one automatic re-probe on `bad`; warn-only (no publish block); measure FP rate in Phase 1 |
| Diff false Direction-A from headers/footers | Boilerplate suppression bucket (§3.2) |
| Flagship still omits a page | Page markers + empty-page detection + per-page retry; bidirectional diff catches missing numbers |
| Flagship invents a fee | Direction B blocks approval; gold fixture includes deliberate digit corruption |
| OCR garbage creates fake “original” numbers | Prefer embedded text layer when present; explained exceptions allowlist; human review |
| Dual-index regression | Hard exclusivity rule + delete-before-add; integration test |
| Schema / status confusion breaks answer path | Option A side quality state; `ready` keeps meaning |
| Cost blow-up on huge PDFs | Page cap / size cap with explicit “too large for auto-convert”; probe still runs |
| Tenant ignores Phase 1 warnings | Warn-only for V1; revisit publish-block only after FP rate known |
| Conversion prompt drifts into IFZA-specific rules | Keep structural principles generic only (this doc) |

---

## 9. Explicitly OUT of scope (V1)

- Changing answer model, thinking level, or query-path retrieval architecture to mask bad ingestion
- Dual File Search queries / moving user question out of `contents` / parallel fee-snippet injects
- Requiring tenants to manually clean files before upload
- Auto-approving conversion without human gate
- Indexing clean **and** original together
- Whole-document single-call conversion
- Static complexity scoring as the primary quality signal
- Multilingual probe quality guarantees beyond “same locale as doc” best-effort
- Re-writing org `system_instruction` per document
- Real-time re-probe on every user question
- Perfect handling of charts/diagrams-as-sole-carriers of fees (flag for human; may remain warn)
- Phase 2 build before Phase 1 metric gate is met

---

## 10. Schema / product touchpoints (Option A — approved)

*Schema additions go into `02_FINAL_SCHEMA_V3.sql` first. Do not invent columns in app code.*

**Phase 1:**

- Table `document_probes` (side state; does not change `doc_status`):
  - `id`, `document_id`, `organization_id`
  - `probe_class` (`ok` | `warn` | `bad` | `skipped` | `inconclusive`)
  - `probe_confidence` (`high` | `low`)
  - `success_rate` numeric, `questions_total`, `questions_grounded`
  - `questions` jsonb, `results` jsonb
  - `extract_chars`, `model`, `cost_usd` (optional), `created_at`
  - Latest probe wins for UI (or `is_latest` flag)
- Staff UI: document list probe badge + short warning copy
- Worker: `POST /api/public/probe-documents` + cron (mirror process-documents)
- **No** change to `/api/query` retrieval contract

**Phase 2 (SHELVED):** `document_conversions`, clean Storage paths, review route — only if real tenant docs probe badly under correct indexing.

---

## 11. Acceptance criteria (by phase)

### Phase 1 done when

1. Every newly ready non-skipped doc gets a persisted probe within N minutes.
2. Tenant sees warn/bad/inconclusive messaging when applicable (**warn-only** — widget publish not blocked).
3. Probe cost logged per doc; dashboard or log aggregate available.
4. Answer path unchanged.
5. Probe acts as **index-health / regression detector** (null FS name, unlistable doc, empty extract → not a silent pass). Dense-page Q-weighting is **not** required for Phase 1 done.

### Phase 2 done when

**N/A — SHELVED 2026-07-19.** Criteria below are archive only if conversion is ever revived:

1. Page-by-page conversion + bidirectional diff + editable review + explicit approve.
2. Clean XOR original enforced (automated test).
3. Frozen-question re-probe shows before/after rates; approve blocked on diff failures.
4. Gold fixture set includes a clean path **and** a deliberately corrupted transcript that must hit Direction B.
5. Sustained real-tenant `probe_bad` under correct indexing before build starts.

---

## 12. Decisions — locked

| # | Decision | Status |
|---|----------|--------|
| 1 | Phase 1 thresholds 8Q / warn \<0.75 / bad \<0.50 as index-health starting values | **Locked** |
| 2 | Phase 2 conversion | **SHELVED 2026-07-19** (premise falsified) |
| 3 | Schema Option A (side quality state) | **Locked** |
| 4 | `probe_bad` warn-only (no widget publish block) | **Locked** |

**Phase 1 keep (regression detection).** **Do not build Phase 2** unless real tenant documents probe badly under correct indexing.