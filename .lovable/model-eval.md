# Model eval — 20-question set

Set `GEMINI_QUERY_MODEL` per run and re-run the same 20 questions. Startup log
line `[gemini-model] query=<value> source=env` confirms the switch took.

Legend: ✅ pass · ❌ fail · — n/a

| Criterion                                    | gemini-3.5-flash | gemini-3-flash-preview | gemini-3.1-flash-lite |
|----------------------------------------------|:----------------:|:----------------------:|:---------------------:|
| Correct figures (numeric accuracy)           |                  |                        |                       |
| Correct fee labels (Investor Add-On vs Visa Amendment — swap test) |     |     |     |
| Waiver-to-zero reasoning                     |                  |                        |                       |
| Exact refusal string on 5 out-of-scope Qs    |                  |                        |                       |
| Zero fabricated citations                    |                  |                        |                       |
| Comparison-table single-pass (no duplication)|                  |                        |                       |
| Notes / failure IDs                          |                  |                        |                       |

## Decision rule

Winner = cheapest model that passes every row.
Tiebreak: prefer GA (non-preview) endpoint — `gemini-3.5-flash` > `gemini-3-flash-preview`.