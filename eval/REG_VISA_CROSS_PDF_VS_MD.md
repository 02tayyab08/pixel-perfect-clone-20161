# Regression head-to-head: Visa Amendment conflation + Cross Business waiver

**Date:** 2026-07-19  
**Path:** SSE `/api/query` (flash-lite MEDIUM)  
**Runs:** 3 each × 2 cases × 2 corpora  
**Index:** temporary FS swap for clean-md leg only; **PDF restored** as live IFZA source afterward.

**Clean md note:** Production `IFZA_Complete_Schedule_of_Fees_2024.md` was gone from Storage. Used reconstructed fixture `eval/fixtures/IFZA_Complete_Schedule_of_Fees_2024.md` (same figures, explicit labels) — the property under test.

## Cases (now permanent in `known-soft-fail-regressions.json`)

| Alias | Id | Question focus |
|-------|-----|----------------|
| Q17 | `reg-visa-amend-conflation` | Investor Visa Add-On 1,000 vs Visa Amendment 2,000–4,000 |
| Q3 | `reg-cross-biz-waiver` | Cross Business Activity Fee waived (new + 3 renewals / 4 years) |

## Pass rates

| Corpus | Q17 (visa conflation) | Q3 (cross waiver) | Overall |
|--------|----------------------|-------------------|---------|
| **Original PDF** | **0/3 (0%)** | 3/3 (100%) | 3/6 (50%) |
| **Clean md fixture** | **3/3 (100%)** | 3/3 (100%) | 6/6 (100%) |

## Implication

Fresh-20’s “PDF 18–19/20 ≥ md 16/20” **did not include these failure classes**. On the swap-test that motivated clean files, **PDF fails hard (0/3)** while structured md passes (3/3). Cross-biz waiver is **intermittent on PDF** (user miss earlier; this H2H 3/3 pass).

Do **not** treat PDF-vs-md as settled in PDF’s favor until the permanent set includes these cases.

Raw: `eval/reg-visa-cross-pdf-vs-md-2026-07-19.json`
