# Salni decision log

## 2026-07-19 — Ingestion Phase 2 shelved; infra root cause

**Premise falsified.** Original IFZA PDF scored **18/20** on fresh-20 vs clean markdown **16/20** once File Search indexing was correct. Prior “dense pages unretrievable” was two infra bugs:

1. Upload op returns `response.documentName`, not `response.name` → null `file_search_document_name`
2. Store list pager exposes `.page`, not `.documents` → broken backfill

**Actions:** Phase 2 conversion **SHELVED**. Phase 1 probe **kept** as retrieval regression / index-health detection. See `docs/INGESTION_QUALITY_PIPELINE_DESIGN.md`, `eval/FRESH20_PDF_VS_MD.md`.

O1 and Q11 **PASS** on correctly indexed PDF — demoted to eval regression fixtures only (`eval/known-soft-fail-regressions.json`).

---

## 2026-07-18 — Answer model lock

**flash-lite MEDIUM locked 2026-07-18.** Validated on 2 independent 20-question sets. Accuracy failures on the clean-.md corpus were retrieval-miss/incomplete (never fabrication). **2026-07-19 update:** the ~60% “dense stochasticity” narrative was largely null-FS-name contamination; residual stochasticity is unquantified. Do not change model/thinking to chase eval soft-fails.

| Field | Value |
|-------|--------|
| `QUERY_MODEL` | `gemini-3.1-flash-lite` |
| `thinkingLevel` | `MEDIUM` (staff `/api/query` + widget `/api/public/widget-query`) |
| Query path | Single File Search call; user question in `contents`; expansion unchanged |
| Validation | Set A (prior 20Q matrix/gate) + Set B (fresh 20Q on clean md, 16/20) + Set C (same Qs on original PDF, 18/20, 2026-07-19) |
| Fabrications | **Zero** across sets |
| Failure mode | Safe: refuse or incomplete retrieval — never invented figures |

### Known limitation class (do not “fix” in query path)

Do not re-architect the query path for dual-fee / dual-column ranking without a scoped decision. Phase 2 clean-file conversion is **SHELVED**. Regression fixtures: `eval/known-soft-fail-regressions.json`.

**Phase 1 probe:** index-health / regression detection — `docs/INGESTION_QUALITY_PIPELINE_DESIGN.md`. Operator must apply `03_DOCUMENT_PROBES_PHASE1.sql` if not already applied.
