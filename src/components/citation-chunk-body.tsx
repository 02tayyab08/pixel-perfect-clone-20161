import type { HighlightSpan } from "@/lib/citations/computeHighlights";

export type MarkSegment = { text: string; mark: boolean };

/** Split chunk text into mark/unmark segments (RTL-safe plain text). */
export function spansToMarkSegments(
  chunkText: string,
  spans: Array<Pick<HighlightSpan, "start" | "end">>,
): MarkSegment[] {
  if (!chunkText) return [];
  if (!spans.length) return [{ text: chunkText, mark: false }];
  const sorted = [...spans]
    .filter((r) => r.end > r.start && r.start >= 0 && r.end <= chunkText.length)
    .sort((a, b) => a.start - b.start);
  const clean: Array<{ start: number; end: number }> = [];
  for (const r of sorted) {
    const last = clean[clean.length - 1];
    if (last && r.start < last.end) continue;
    clean.push({ start: r.start, end: r.end });
  }
  const segs: MarkSegment[] = [];
  let cursor = 0;
  for (const r of clean) {
    if (r.start > cursor) segs.push({ text: chunkText.slice(cursor, r.start), mark: false });
    segs.push({ text: chunkText.slice(r.start, r.end), mark: true });
    cursor = r.end;
  }
  if (cursor < chunkText.length) segs.push({ text: chunkText.slice(cursor), mark: false });
  return segs;
}

/**
 * Raw-text citation chunk body with <mark> highlights.
 * Char ranges cannot survive markdown — do not render through react-markdown.
 */
export function CitationChunkBody({
  chunkText,
  spans,
  className,
}: {
  chunkText: string;
  spans: HighlightSpan[];
  className?: string;
}) {
  const segs = spansToMarkSegments(chunkText, spans);
  return (
    <blockquote
      dir="auto"
      className={
        className ??
        "whitespace-pre-wrap border-l-4 border-primary/50 bg-muted/60 px-4 py-3 text-sm italic leading-relaxed text-foreground"
      }
    >
      {segs.map((seg, i) =>
        seg.mark ? (
          <mark
            key={i}
            className="rounded bg-yellow-200 px-0.5 not-italic text-yellow-950 dark:bg-yellow-300/40 dark:text-yellow-50"
          >
            {seg.text}
          </mark>
        ) : (
          <span key={i}>{seg.text}</span>
        ),
      )}
    </blockquote>
  );
}
