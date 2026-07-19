# Fresh-20: original IFZA PDF vs clean .md — 2026-07-19

## Question

Was “dense PDF unretrievable” a **document-quality** problem, or an **infrastructure** artifact (`response.documentName` vs `name`, list pager `.page` vs `.documents`)?

## Method

- Corpus for this run: **original IFZA PDF only** + Meydan docs. Clean `IFZA_Complete_Schedule_of_Fees_2024.md` **removed** from File Search for the run (then restored).
- PDF upload: confirmed non-null FS name, `STATE_ACTIVE`, chunking `200/20`.
- Query path mirrored staff `/api/query`: `gemini-3.1-flash-lite` + `thinkingLevel=MEDIUM`, org_id File Search filter, expansion terms, fee disambiguation + quoted-pair addenda.
- Harness note: direct `generateContent` (not SSE `/api/query`). Same model/tools/filters/prompts.
- Clean .md baseline: `eval/fresh20-2026-07-18-results.json` (**16/20**).

## Headlines

| Corpus | Score | Fabrications |
|--------|-------|--------------|
| Clean .md + Meydan (2026-07-18) | **16/20** | 0 |
| Original IFZA PDF + Meydan (2026-07-19) | **18/20** | 0 |

**Original PDF scored at least as well as the clean .md — better on this run.** The clean-file conversion was **not** what unlocked retrieval for this fixture under a correctly indexed store.

### Action-verb cases (PDF corpus)

| Case | Result | Notes |
|------|--------|-------|
| **O1** (add individual shareholder) | **PASS** | Both setup **350** and amendment **2,000** surfaced (g=2) |
| **Q11** (add 2 extra activities) | **PASS** | Setup math present; amendment line also surfaced (`bothSurfaced=true`, g=3) — same dual-surface pattern as before, but numbers pass |

→ O1/Q11 failures look like **retrieval-ranking / dual-line** behavior (stochastic soft-fail class), **not** name-resolution artifacts. On this correctly indexed PDF they did **not** reproduce as hard misses.

## Side-by-side

| Q | PDF (this run) | g | Clean .md baseline | g |
|---|---|---|---|---|
| 1 | PASS | 1 | PASS | 1 |
| 2 | PASS | 0* | PASS | 2 |
| 3 | PASS | 1 | FAIL | 0 |
| 4 | PASS | 1 | PASS | 1 |
| 5 | PASS | 1 | PASS | 1 |
| 6 | PASS | 0* | PASS | 2 |
| 7 | PASS | 1 | PASS | 1 |
| 8 | PASS | 4 | PASS | 3 |
| 9 | PASS | 2 | PASS | 2 |
| 10 | FAIL | 2 | PASS | 3 |
| 11 | PASS | 3 | FAIL | 2 |
| 12 | PASS | 2 | PASS | 1 |
| 13 | PASS | 1 | PASS | 2 |
| 14 | FAIL | 0 | FAIL | 0 |
| 15 | PASS | 1 | PASS | 1 |
| 16 | PASS | 3 | FAIL | 3 |
| 17 | PASS | 0 | PASS | 0 |
| 18 | PASS | 0 | PASS | 0 |
| 19 | PASS | 0 | PASS | 0 |
| 20 | PASS | 0 | PASS | 0 |

\*Q2/Q6 returned correct figures with `groundingChunks=0` in metadata — treat as API metadata quirk or weak attribution, not as proof of ungrounded invention (answers match schedule lines).

### PDF-only failures

- **Q10** — see investigation below.
- **Q14** — Meydan WPS: still hard miss (g=0) on **both** corpora → Meydan-doc issue, not IFZA PDF vs md.

### Q10 investigation — 38,700 standard vs 31,000 discounted

**Verdict: answer-key / dual-column disambiguation — not missing PDF content.**

The original PDF text layer has **both** figures on the same Zero Visa 3-year package row: `38,700 AED` (standard) then `31,000 AED` (after multi-year discount). A separate bullet states “20% Extra Discount on 3-Year License.”

| Run | Quoted license figure | Why |
|-----|----------------------|-----|
| Clean `.md` baseline | **31,000** under explicit label `Zero Visa \| 3-Year (20% off)` | Structured label makes discounted column obvious |
| PDF (2026-07-19) | **38,700** as `Zero Visa License`, notes discounts may apply | Model preferred the first/standard column when headers are weak in extract |

So Q10’s unique PDF fail is **not** “discounted fee absent from PDF.” Keeping the clean `.md` is optional clarity on package labels, not a requirement to make the schedule retrievable. Prefer **one** indexed representation (clean XOR original).

### PDF wins vs md baseline

- **Q3** Employee List — PASS on PDF, FAIL on md.
- **Q11** activities — PASS on PDF, FAIL on md.
- **Q16** est-card compare — PASS on PDF, FAIL on md.

## Verdict for pipeline premise

1. **Infrastructure bugs were real** and made document-scoped probes / deletes unreliable. Fixing `documentName` + list `.page` was necessary.
2. For this IFZA fixture, **correctly indexing the original PDF does not show a document-quality gap vs clean .md** on fresh-20 (18/20 ≥ 16/20).
3. Clean-file conversion premise is **falsified** for this fixture. **Phase 2 SHELVED.**
4. Remaining open eval misses: Q14 Meydan WPS; Q10 dual-column preference on PDF. O1/Q11 are regression fixtures only (PASS on correct PDF index).
5. Phase 1 probe kept as **index-health / regression detection**, not conversion triage.

Raw: `eval/fresh20-pdf-vs-md-2026-07-19.json`
