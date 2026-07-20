/** Tunable defaults for citation chunk highlighting (Stage 1). */
export const HIGHLIGHT_DEFAULTS = {
  ROW_MAX_CHARS: 240,
  TIER1_MAX_ROWS: 3,
  MAX_TOTAL_SPANS: 4,
  TIER2_MIN_UNIGRAM_LEN: 5,
  TIER2_MAX_UNIGRAM_ANCHORS: 2,
  /** Prefer first cited chunk with ≥1 span when opening the panel. */
  citationAutoPage: true,
  /** Stage 2 only — unused while CITATION_LLM_ALIGN is off. */
  LLM_ALIGN_TIMEOUT_MS: 2500,
  LLM_ALIGN_RATE_PER_MIN: 30,
  CITATION_LLM_ALIGN: false,
} as const;

export type HighlightOptions = typeof HIGHLIGHT_DEFAULTS;
