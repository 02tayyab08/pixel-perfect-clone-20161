# Probe calibration — re-run 2026-07-19

Per design decision #1: thresholds (8Q, warn \<0.75, bad \<0.50) must be calibrated so **original IFZA PDF ≤ Meydan docx ≤ IFZA complete .md**.

## Fix applied before this run

1. **List backfill bug:** `@google/genai` pager exposes the batch as `.page`, not `.documents`. Empty-list backfill made `file_search_document_name` appear permanently null.
2. **Upload op response:** completed ops return `response.documentName`, not `response.name`. `process-documents.ts` now reads both.

## Index confirmation (IFZA PDF)

| Field | Value |
|-------|-------|
| Temp `document_id` | `9a230fcd-4174-481d-8dfd-92048277ff33` |
| `file_search_document_name` | `…/documents/ifzaoriginalcalibrationpdf-j0wai802xt7q` (**non-null**) |
| List state | `STATE_ACTIVE` |
| Chunking | `maxTokensPerChunk: 200`, `maxOverlapTokens: 20` |

## Measured rates (valid index)

| Fixture | Expect | Rate | Class |
|---------|--------|------|-------|
| Original IFZA PDF | bad | **100%** (8/8) | ok |
| Meydan License Details.docx | mixed | **100%** (8/8) | ok |
| IFZA_Complete_Schedule_of_Fees_2024.md | good | **100%** (8/8) | ok |

**Ranking:** still **non-discriminative** (all 100%).

## 8 auto-generated questions — primary source pages

Page numbers from equal char-slices of `pdf-parse` text (15 pages; PDF has almost no form-feeds). “Dense” = pages **8–14** (Schedule of Fees / fee tables).

| # | Question | Atom | Primary page (exact phrase) | Dense 8–14? |
|---|----------|------|------------------------------|-------------|
| 1 | Max business activities per license? | 7 | **~10** (“maximum of 7” in Schedule) | **Yes** |
| 2 | Establishment Card renewal cost? | AED 2,200 | **~1** overview *and* **~11** schedule row | Dual — answerable from early page |
| 3 | License issuance working days? | 5–6 working days | **~4** (process timelines) | **No** |
| 4 | Extra discount for 5-year license? | 30% | **~4** (package discounts) | **No** |
| 5 | Additional individual shareholder fee? | AED 350 | **~10** (Schedule of Fees) | **Yes** |
| 6 | VIP Medical and EID service? | AED 3,500 | **~15** (general services) | **No** (late, outside 8–14) |
| 7 | Visa Status Change (inside UAE)? | AED 1,600 | **~11** (schedule) | **Yes** |
| 8 | Standard company stamp? | AED 120 | **~15** (general services) | **No** |

**Dense-only primaries (8–14, not also printed early): 3/8 (Q1, Q5, Q7).**  
Counting dual-sourced Q2 as dense: **4/8.**  
**\< half on the strict/useful definition → probe design bug** — half the set is early process/discount or page-15 services; a 100% score does not prove Schedule-of-Fees (pp. 8–14) retrieval.

Naive keyword overlap had marked 5/8 dense — that overcount is **not** trustworthy (short atoms like `"7"` / headers spill across slices).

## Known-fail queries vs correctly indexed PDF

These historically returned `grounding=0` on the original PDF. Against this re-upload:

| Query | Grounding chunks | Result |
|-------|------------------|--------|
| General Trading fee waiver | 1 | Retrieved (waiver = new apps + next 3 renewals / 4 years) — fact on **~p9** |
| Cross Business Activity Fee waived | 1 | Retrieved (same waiver window) — fact on **~p9** |
| establishment card renewal fee | 4 | Retrieved (AED 2,200) |

**Known-fail with grounding=0: 0/3.** So on a *correctly named + tightly chunked* index, these dense-page facts are retrievable. The earlier grounding=0 failures likely mixed **null FS name / broken list backfill** with genuine dense-table fragility — they are not a clean “auto-probe 100% vs known-fail 0” contradiction on this re-run.

## Verdict

1. Prior 2026-07-18 calibration is **invalid** (null FS name + list bug).
2. Valid re-run still gives **100%/100%/100%** — thresholds still not calibrated.
3. **Q-gen coverage bug confirmed:** only **2–3 of 8** questions target pages 8–14; need explicit weighting toward late/dense extract slices (and prefer facts that are *not* also printed on early overview pages).
4. Production fix shipped in-repo: persist `response.documentName` on upload.

Raw: `eval/probe-calibration-2026-07-19-rerun.json`
