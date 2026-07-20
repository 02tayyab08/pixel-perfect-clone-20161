/**
 * Prefer the first citation sharing the same answer segment that has ≥1 highlight.
 * Falls back to preferredIdx (clicked citation).
 */
export function resolveCitationAutoPageIndex(
  citations: Array<{ answerSegment: string | null; snippet: string | null }>,
  preferredIdx: number,
  autoPage: boolean,
  compute: (segmentText: string, chunkText: string) => unknown[],
): number {
  if (!autoPage || preferredIdx < 0 || preferredIdx >= citations.length) {
    return Math.max(0, preferredIdx);
  }
  const preferred = citations[preferredIdx]!;
  const seg = preferred.answerSegment;
  const groupIdxs = citations
    .map((c, i) => ({ c, i }))
    .filter(({ c }) => (seg == null ? c === preferred : c.answerSegment === seg))
    .map(({ i }) => i);
  for (const i of groupIdxs) {
    const c = citations[i]!;
    if (!c.snippet || !c.answerSegment) continue;
    if (compute(c.answerSegment, c.snippet).length > 0) return i;
  }
  return preferredIdx;
}
