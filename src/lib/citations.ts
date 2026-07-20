/**
 * Citation presentation from Gemini groundingSupports (not raw groundingChunks).
 *
 * Segment startIndex/endIndex are UTF-8 byte offsets into the answer string.
 *
 * Inline markers use the sentinel ⟦N⟧ (not markdown links) so react-markdown
 * never emits an <a href>.
 *
 * Chunk-body highlighting lives in `src/lib/citations/computeHighlights.ts`.
 */

export type GroundingChunkRow = {
  source_title: string | null;
  snippet: string | null;
  page: number | null;
  document_id: string | null;
};

export type GroundingSupportRow = {
  segment?: {
    startIndex?: number;
    endIndex?: number;
    text?: string;
  };
  groundingChunkIndices?: number[];
};

export type CitationSource = {
  /** 1-based display number */
  n: number;
  /** Index into the groundingChunks array */
  chunkIndex: number;
  source_title: string | null;
  snippet: string | null;
  page: number | null;
  document_id: string | null;
  /** Answer segment text that cited this chunk (for chunk-side highlight). */
  answerSegment: string | null;
};

export type CitationPresentation = {
  sources: CitationSource[];
  /** Answer with ⟦N⟧ cite sentinels inserted at segment ends */
  markedMarkdown: string;
};

/** Sentinel wrapping a citation number — must not parse as markdown link/URL. */
export const CITE_SENTINEL_RE = /⟦(\d+)⟧/g;

export function citeSentinel(n: number): string {
  return `⟦${n}⟧`;
}

/** Convert a UTF-8 byte offset into a JS string (UTF-16 code unit) index. */
export function utf8ByteOffsetToCharIndex(text: string, byteOffset: number): number {
  if (byteOffset <= 0) return 0;
  const bytes = new TextEncoder().encode(text);
  if (byteOffset >= bytes.length) return text.length;

  let bytePos = 0;
  let charPos = 0;
  for (const ch of text) {
    const chBytes = new TextEncoder().encode(ch);
    if (bytePos + chBytes.length > byteOffset) break;
    bytePos += chBytes.length;
    charPos += ch.length;
  }
  return charPos;
}

type NormalizedSpan = {
  startChar: number;
  endChar: number;
  width: number;
  chunkIndices: number[];
  segmentText: string;
};

function normalizeSupports(
  answer: string,
  supports: GroundingSupportRow[],
  chunkCount: number,
): NormalizedSpan[] {
  const out: NormalizedSpan[] = [];
  for (const s of supports) {
    const endByte = s.segment?.endIndex;
    if (typeof endByte !== "number" || !Number.isFinite(endByte)) continue;
    const startByte =
      typeof s.segment?.startIndex === "number" && Number.isFinite(s.segment.startIndex)
        ? s.segment.startIndex
        : 0;
    const indices = (s.groundingChunkIndices ?? []).filter(
      (i) => Number.isInteger(i) && i >= 0 && i < chunkCount,
    );
    if (indices.length === 0) continue;
    const startChar = utf8ByteOffsetToCharIndex(answer, startByte);
    const endChar = utf8ByteOffsetToCharIndex(answer, endByte);
    if (endChar < startChar) continue;
    const clampedEnd = Math.min(endChar, answer.length);
    const segmentText =
      (s.segment?.text && s.segment.text.length > 0
        ? s.segment.text
        : answer.slice(startChar, clampedEnd)) || "";
    out.push({
      startChar,
      endChar: clampedEnd,
      width: Math.max(0, clampedEnd - startChar),
      chunkIndices: [...new Set(indices)],
      segmentText,
    });
  }
  return out;
}

/**
 * Assign each cited chunk to the narrowest support span that includes it.
 * Returns endChar + segment text for that assignment.
 */
function assignChunksToNarrowestSpans(
  spans: NormalizedSpan[],
): Map<number, { endChar: number; segmentText: string }> {
  const chunkToSpan = new Map<number, { endChar: number; segmentText: string }>();

  const allChunks = new Set<number>();
  for (const s of spans) for (const i of s.chunkIndices) allChunks.add(i);

  for (const chunkIndex of allChunks) {
    const candidates = spans.filter((s) => s.chunkIndices.includes(chunkIndex));
    if (candidates.length === 0) continue;
    candidates.sort((a, b) => {
      if (a.width !== b.width) return a.width - b.width;
      if (a.endChar !== b.endChar) return a.endChar - b.endChar;
      return a.startChar - b.startChar;
    });
    const best = candidates[0]!;
    chunkToSpan.set(chunkIndex, {
      endChar: best.endChar,
      segmentText: best.segmentText,
    });
  }
  return chunkToSpan;
}

function firstUseChunkOrder(
  supports: GroundingSupportRow[],
  cited: Set<number>,
): number[] {
  const order: number[] = [];
  const seen = new Set<number>();
  for (const s of supports) {
    for (const i of s.groundingChunkIndices ?? []) {
      if (!cited.has(i) || seen.has(i)) continue;
      seen.add(i);
      order.push(i);
    }
  }
  return order;
}

/**
 * Build numbered sources + marked markdown from supports → chunk indices only.
 */
export function buildCitationPresentation(
  answer: string,
  chunks: GroundingChunkRow[],
  supports: GroundingSupportRow[],
): CitationPresentation {
  if (!answer || chunks.length === 0 || supports.length === 0) {
    return { sources: [], markedMarkdown: answer };
  }

  const spans = normalizeSupports(answer, supports, chunks.length);
  if (spans.length === 0) return { sources: [], markedMarkdown: answer };

  const chunkToSpan = assignChunksToNarrowestSpans(spans);
  if (chunkToSpan.size === 0) return { sources: [], markedMarkdown: answer };

  const citedSet = new Set(chunkToSpan.keys());
  const order = firstUseChunkOrder(supports, citedSet);
  for (const i of citedSet) if (!order.includes(i)) order.push(i);

  const chunkToNum = new Map<number, number>();
  const sources: CitationSource[] = [];
  order.forEach((chunkIndex, idx) => {
    const n = idx + 1;
    chunkToNum.set(chunkIndex, n);
    const c = chunks[chunkIndex]!;
    const assigned = chunkToSpan.get(chunkIndex);
    sources.push({
      n,
      chunkIndex,
      source_title: c.source_title,
      snippet: c.snippet,
      page: c.page,
      document_id: c.document_id,
      answerSegment: assigned?.segmentText ?? null,
    });
  });

  const endToNums = new Map<number, number[]>();
  for (const chunkIndex of order) {
    const assigned = chunkToSpan.get(chunkIndex);
    if (!assigned) continue;
    const n = chunkToNum.get(chunkIndex)!;
    const list = endToNums.get(assigned.endChar) ?? [];
    list.push(n);
    endToNums.set(assigned.endChar, list);
  }

  type Insertion = { endChar: number; markdown: string };
  const insertions: Insertion[] = [];
  for (const [endChar, nums] of endToNums) {
    const deduped: number[] = [];
    for (const n of nums) {
      if (deduped[deduped.length - 1] === n) continue;
      deduped.push(n);
    }
    if (deduped.length === 0) continue;
    insertions.push({
      endChar,
      markdown: deduped.map((n) => citeSentinel(n)).join(""),
    });
  }

  insertions.sort((a, b) => b.endChar - a.endChar);
  let marked = answer;
  for (const ins of insertions) {
    const i = Math.max(0, Math.min(ins.endChar, marked.length));
    marked = marked.slice(0, i) + ins.markdown + marked.slice(i);
  }

  return { sources, markedMarkdown: marked };
}

export function mapGroundingChunk(raw: unknown): GroundingChunkRow | null {
  const c = raw as {
    retrievedContext?: {
      title?: string;
      text?: string;
      pageNumber?: number;
      customMetadata?: Array<{ key: string; stringValue?: string }>;
    };
  };
  const rc = c.retrievedContext;
  if (!rc) return null;
  const meta = rc.customMetadata ?? [];
  const docId = meta.find((m) => m.key === "document_id")?.stringValue ?? null;
  return {
    source_title: rc.title ?? "Untitled source",
    snippet: rc.text ?? null,
    page: rc.pageNumber ?? null,
    document_id: docId,
  };
}

export function mapGroundingChunks(rawChunks: unknown[]): GroundingChunkRow[] {
  return rawChunks.map((raw) => {
    const row = mapGroundingChunk(raw);
    if (row) return row;
    return {
      source_title: null,
      snippet: null,
      page: null,
      document_id: null,
    };
  });
}

export function normalizeSupportsPayload(raw: unknown[]): GroundingSupportRow[] {
  return raw.map((s) => {
    const o = s as GroundingSupportRow;
    return {
      segment: o.segment
        ? {
            startIndex: o.segment.startIndex,
            endIndex: o.segment.endIndex,
            text: o.segment.text,
          }
        : undefined,
      groundingChunkIndices: o.groundingChunkIndices,
    };
  });
}
