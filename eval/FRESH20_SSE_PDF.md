# Fresh-20 SSE path (original IFZA PDF) — 2026-07-19

**Path:** deployed SSE `/api/query` + `/api/public/widget-query` (not direct Gemini mirror)  
**Corpus:** re-indexed original IFZA PDF + Meydan activity PDF + Meydan License Details.docx  
**Config:** `gemini-3.1-flash-lite` / `thinkingLevel=MEDIUM`  
**Observation only** — no query-path fixes.

## Score

| Run | Score | Fabrications |
|-----|-------|--------------|
| **SSE (this run)** | **19/20** | 0 |
| Mirror (same corpus class, earlier) | 18/20 | 0 |

SSE performs at least as well as the mirror on this set.

## Per question

| Q | SSE | g | cost-total USD | Mirror | Notes |
|---|-----|---|----------------|--------|-------|
| 1 Incumbency | PASS | 1 | 0.0014 | PASS | |
| 2 Visa cancel UAE | PASS | 1 | 0.0014 | PASS | |
| 3 Employee List | PASS | 1 | 0.0015 | PASS | |
| 4 MOA/AOA | PASS | 2 | 0.0014 | PASS | |
| 5 Work permit non-IFZA | PASS | 2 | 0.0035 | PASS | |
| 6 E-Visa withdrawal | PASS | 2 | 0.0015 | PASS | |
| 7 Company name | PASS | 1 | 0.0015 | PASS | |
| 8 Est-card renewal | PASS | 5 | 0.0015 | PASS | |
| 9 Visa upgrade | PASS | 2 | 0.0015 | PASS | |
| 10 3yr Zero+est card | PASS | 3 | 0.0016 | FAIL | SSE got discounted **31,000** |
| 11 Add 2 activities | PASS | 1 | 0.0015 | PASS | setup-only this run |
| 12 5yr 2-visa saving | PASS | 2 | 0.0015 | PASS | |
| 13 Meydan investor | PASS | 1 | 0.0015 | PASS | 4020+1850+320+385 |
| 14 Meydan WPS | PASS* | 1 | 0.0015 | FAIL | *auto-score weak — hedges |
| 15 Meydan est card | PASS | 1 | 0.0012 | PASS | 2020 |
| 16 Est-card compare | **FAIL** | 4 | 0.0017 | PASS | IFZA OK; Meydan missed |
| 17–19 refuse | PASS | 5/0/0 | ~0.0013 | PASS | |
| 20 hello (widget) | PASS | 0 | 0.0002 | PASS | |

**Total cost (20Q):** ~$0.030

## Known limitation this run

**Q16 (cross-doc compare) — class: `retrieval-ranking-cross-doc`:**  
`[query-grounding-diag] n=4` sources were **all** `Ifza - Licesen cost - Shedule off charges (1).pdf` (0 Meydan). Model claimed Meydan absent because retrieval never returned Meydan chunks — not because it ignored grounded Meydan text. Same-run Q15 did retrieve Meydan est-card 2020. Logged in `eval/known-soft-fail-regressions.json`. No query-path fix from this observation.

**Q14 caveat:** Scorer matched `\bno\b` inside a hedged answer; treat as weak, not a clean WPS “no”.

Raw: `eval/fresh20-sse-pdf-2026-07-19.json`
