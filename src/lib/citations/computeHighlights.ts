/**
 * Deterministic citation chunk highlighting (Stage 1).
 * Pure: (segmentText, chunkText) → spans into original chunkText.
 */
import { HIGHLIGHT_DEFAULTS, type HighlightOptions } from "./defaults";
import {
  extractContentWords,
  extractFigures,
  extendValueSpan,
  findFigureKeyOccurrences,
  indexedNormalize,
} from "./normalize";

export type HighlightSpan = {
  start: number;
  end: number;
  tier: 1 | 2 | 3;
  kind: "row" | "value" | "label" | "quote";
};

type Unit = { start: number; end: number; text: string };

function isSeparatorUnit(text: string): boolean {
  const t = text.replace(/[|\s:\-]+/g, "");
  return t.length === 0;
}

function trimPipeBounds(
  chunk: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = start;
  let e = end;
  while (s < e && /[\s|]/.test(chunk[s]!)) s += 1;
  while (e > s && /[\s|]/.test(chunk[e - 1]!)) e -= 1;
  return { start: s, end: e };
}

/** Split chunk into Tier-1 candidate units with original indices. */
export function splitCandidateUnits(
  chunkText: string,
  rowMaxChars: number,
): Unit[] {
  const linePieces: Unit[] = [];
  let ls = 0;
  for (let i = 0; i <= chunkText.length; i++) {
    if (i === chunkText.length || chunkText[i] === "\n") {
      if (i > ls) linePieces.push({ start: ls, end: i, text: chunkText.slice(ls, i) });
      ls = i + 1;
    }
  }
  if (linePieces.length === 0 && chunkText.length > 0) {
    linePieces.push({ start: 0, end: chunkText.length, text: chunkText });
  }

  const rowSplit: Unit[] = [];
  for (const piece of linePieces) {
    const sub = piece.text;
    const re = /\|\s*\|/g;
    let last = 0;
    let m: RegExpExecArray | null;
    let any = false;
    while ((m = re.exec(sub)) !== null) {
      any = true;
      const unitEnd = m.index + 1; // include trailing | of previous row
      if (unitEnd > last) {
        rowSplit.push({
          start: piece.start + last,
          end: piece.start + unitEnd,
          text: sub.slice(last, unitEnd),
        });
      }
      last = m.index + m[0].length - 1; // leading | of next row
    }
    if (last < sub.length || !any) {
      rowSplit.push({
        start: piece.start + last,
        end: piece.end,
        text: sub.slice(last),
      });
    }
  }

  const filtered = rowSplit.filter((u) => u.text.trim().length > 0 && !isSeparatorUnit(u.text));

  const units: Unit[] = [];
  for (const u of filtered) {
    if (u.text.length <= rowMaxChars) {
      units.push(u);
      continue;
    }
    // Sentence-split oversized units on [.!?؟:] + whitespace
    const sub = u.text;
    const sentRe = /[.!?؟:]\s+/g;
    let last = 0;
    let m: RegExpExecArray | null;
    const parts: Unit[] = [];
    while ((m = sentRe.exec(sub)) !== null) {
      const end = m.index + m[0].length;
      parts.push({
        start: u.start + last,
        end: u.start + end,
        text: sub.slice(last, end),
      });
      last = end;
    }
    if (last < sub.length) {
      parts.push({
        start: u.start + last,
        end: u.end,
        text: sub.slice(last),
      });
    }
    for (const p of parts) {
      if (p.text.trim().length === 0) continue;
      if (p.text.length > rowMaxChars) continue; // ineligible for Tier 1
      units.push(p);
    }
  }
  return units;
}

function unitHasClaimFigure(unitText: string, claimKeys: Set<string>): boolean {
  for (const f of extractFigures(unitText)) {
    if (claimKeys.has(f.key)) return true;
  }
  return false;
}

function unitContentWordOverlap(unitText: string, claimWords: string[]): number {
  const unitWords = new Set(extractContentWords(unitText));
  let n = 0;
  for (const w of claimWords) if (unitWords.has(w)) n += 1;
  return n;
}

/** Distinct claim content words of length ≥5 present in the unit. */
function unitLongContentOverlap(unitText: string, claimWords: string[]): string[] {
  const unitWords = new Set(extractContentWords(unitText));
  return claimWords.filter((w) => w.length >= 5 && unitWords.has(w));
}

/**
 * Meta/boilerplate phrases — uniqueness ≠ evidence.
 * Matched on content-word keys (stopwords already stripped) and surface forms.
 */
const BOILERPLATE_PHRASES = [
  "terms and conditions",
  "terms conditions",
  "provided documents",
  "schedule of fees",
  "important waivers",
  "per package",
  "business license",
] as const;

function normalizePhrase(s: string): string {
  return indexedNormalize(s)
    .replace(/[^a-z0-9\u0600-\u06ff\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Content-word key for a phrase (stopwords stripped — matches n-gram keys). */
function phraseContentKey(phrase: string): string {
  return extractContentWords(phrase).join(" ");
}

const BOILERPLATE_KEYS = new Set(
  BOILERPLATE_PHRASES.map((p) => phraseContentKey(p)).filter((k) => k.length > 0),
);

const BOILERPLATE_SURFACE = new Set(BOILERPLATE_PHRASES.map((p) => normalizePhrase(p)));

/** Tokens that appear in boilerplate phrases — never highlight alone as unigrams. */
const BOILERPLATE_UNIGRAMS = new Set(
  [...BOILERPLATE_KEYS].flatMap((k) => k.split(" ").filter(Boolean)),
);

function extractHeadingBodies(chunkText: string): string[] {
  const out: string[] = [];
  for (const line of chunkText.split("\n")) {
    const m = line.match(/^\s*#{1,6}\s+(.*)$/);
    if (m?.[1]) out.push(m[1].trim());
  }
  // Flattened retrieval often keeps ## mid-string without a preceding newline.
  const re = /#{1,6}\s+([^#\n|]+)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(chunkText)) !== null) {
    const body = m[1]!.trim();
    if (body && !out.includes(body)) out.push(body);
  }
  return out;
}

function headingContentKeys(chunkText: string): Set<string> {
  const keys = new Set<string>();
  for (const h of extractHeadingBodies(chunkText)) {
    const words = extractContentWords(h);
    for (let n = words.length; n >= 2; n--) {
      for (let i = 0; i <= words.length - n; i++) {
        keys.add(words.slice(i, i + n).join(" "));
      }
    }
    if (words.length === 1) keys.add(words[0]!);
  }
  return keys;
}

function isBoilerplateLabel(
  spanText: string,
  ngramKey: string | null,
  headingKeys: Set<string>,
): boolean {
  const surface = normalizePhrase(spanText);
  if (BOILERPLATE_SURFACE.has(surface)) return true;
  for (const b of BOILERPLATE_SURFACE) {
    if (surface === b) return true;
  }
  const key = ngramKey ?? phraseContentKey(spanText);
  if (key && BOILERPLATE_KEYS.has(key)) return true;
  if (key && headingKeys.has(key)) return true;
  return false;
}

/** True when every overlapping long word is covered by one boilerplate phrase. */
function longOverlapIsOnlyBoilerplate(longOverlap: string[]): boolean {
  if (longOverlap.length === 0) return false;
  const set = new Set(longOverlap);
  for (const key of BOILERPLATE_KEYS) {
    const parts = key.split(" ").filter(Boolean);
    if (parts.length === 0) continue;
    if (parts.every((p) => set.has(p)) && [...set].every((w) => parts.includes(w))) {
      return true;
    }
  }
  return false;
}

function tier1(
  segmentText: string,
  chunkText: string,
  opts: HighlightOptions,
): HighlightSpan[] {
  const claimFigs = extractFigures(segmentText);
  const claimKeys = new Set(claimFigs.map((f) => f.key));
  const claimWords = extractContentWords(segmentText);
  if (claimWords.length === 0) return [];

  const hasFigures = claimKeys.size > 0;
  const units = splitCandidateUnits(chunkText, opts.ROW_MAX_CHARS);
  type Cand = { unit: Unit; overlap: number };
  const cands: Cand[] = [];

  for (const u of units) {
    if (hasFigures) {
      if (!unitHasClaimFigure(u.text, claimKeys)) continue;
      const overlap = unitContentWordOverlap(u.text, claimWords);
      if (overlap < 1) continue;
      cands.push({ unit: u, overlap });
      continue;
    }
    // Zero-figure path: ≥2 distinct claim content words (len ≥5), rank by that count.
    const longOverlap = unitLongContentOverlap(u.text, claimWords);
    if (longOverlap.length < 2) continue;
    if (longOverlapIsOnlyBoilerplate(longOverlap)) continue;
    cands.push({ unit: u, overlap: longOverlap.length });
  }

  cands.sort((a, b) => b.overlap - a.overlap);
  const kept = cands.slice(0, opts.TIER1_MAX_ROWS);

  const spans: HighlightSpan[] = [];
  for (const c of kept) {
    const trimmed = trimPipeBounds(chunkText, c.unit.start, c.unit.end);
    if (trimmed.end <= trimmed.start) continue;
    spans.push({
      start: trimmed.start,
      end: trimmed.end,
      tier: 1,
      kind: "row",
    });
  }
  return spans;
}

function findAdjacentNgram(
  chunkText: string,
  words: string[],
): { start: number; end: number } | null {
  if (words.length < 2) return null;
  const norm = indexedNormalize(chunkText);
  // Tokenize chunk into (token, start, end) on original via norm alignment (1:1)
  const tokens: Array<{ t: string; start: number; end: number }> = [];
  const re = /[a-z0-9\u0600-\u06ff]+/gi;
  let m: RegExpExecArray | null;
  const normOrig = norm; // same length as chunkText
  while ((m = re.exec(normOrig)) !== null) {
    tokens.push({ t: m[0]!.toLowerCase(), start: m.index, end: m.index + m[0]!.length });
  }
  const want = words.map((w) => w.toLowerCase());
  const hits: Array<{ start: number; end: number }> = [];
  for (let i = 0; i <= tokens.length - want.length; i++) {
    let ok = true;
    for (let j = 0; j < want.length; j++) {
      if (tokens[i + j]!.t !== want[j]) {
        ok = false;
        break;
      }
    }
    if (!ok) continue;
    // Adjacent: only whitespace/punct between tokens
    let adjacent = true;
    for (let j = 0; j < want.length - 1; j++) {
      const gap = chunkText.slice(tokens[i + j]!.end, tokens[i + j + 1]!.start);
      if (/[a-z0-9\u0600-\u06ff]/i.test(gap)) {
        adjacent = false;
        break;
      }
    }
    if (!adjacent) continue;
    hits.push({ start: tokens[i]!.start, end: tokens[i + want.length - 1]!.end });
  }
  if (hits.length === 1) return hits[0]!;
  return null;
}

function extendJoinedRun(chunkText: string, start: number, end: number): { start: number; end: number } {
  let s = start;
  let e = end;
  // Extend only across letters/digits and `/` (Director/Secretary/Legal), not punctuation.
  const joinChar = /[a-z0-9/\u0600-\u06ff]/i;
  while (s > 0 && joinChar.test(chunkText[s - 1]!)) s -= 1;
  while (e < chunkText.length && joinChar.test(chunkText[e]!)) e += 1;
  return { start: s, end: e };
}

function tier2(
  segmentText: string,
  chunkText: string,
  opts: HighlightOptions,
): HighlightSpan[] {
  const spans: HighlightSpan[] = [];
  const claimFigs = extractFigures(segmentText);
  const seenKeys = new Set<string>();
  const headingKeys = headingContentKeys(chunkText);

  for (const f of claimFigs) {
    if (seenKeys.has(f.key)) continue;
    seenKeys.add(f.key);
    const occ = findFigureKeyOccurrences(chunkText, f.key);
    if (occ.length !== 1) continue;
    const ext = extendValueSpan(chunkText, occ[0]!.start, occ[0]!.end);
    spans.push({ start: ext.start, end: ext.end, tier: 2, kind: "value" });
  }

  const claimWords = extractContentWords(segmentText);
  // Collect unique adjacent n-grams (longest first); drop shorter ones subsumed by longer.
  type NgramHit = { start: number; end: number; n: number; key: string };
  const ngramHits: NgramHit[] = [];
  for (let n = 4; n >= 2; n--) {
    if (claimWords.length < n) continue;
    for (let i = 0; i <= claimWords.length - n; i++) {
      const gram = claimWords.slice(i, i + n);
      const key = gram.join(" ");
      const hit = findAdjacentNgram(chunkText, gram);
      if (!hit) continue;
      ngramHits.push({ ...hit, n, key });
    }
  }
  ngramHits.sort((a, b) => b.n - a.n || a.start - b.start);
  const keptNgrams: NgramHit[] = [];
  for (const hit of ngramHits) {
    if (keptNgrams.some((k) => k.start <= hit.start && k.end >= hit.end)) continue;
    for (let k = keptNgrams.length - 1; k >= 0; k--) {
      const cur = keptNgrams[k]!;
      if (hit.start <= cur.start && hit.end >= cur.end) keptNgrams.splice(k, 1);
    }
    keptNgrams.push(hit);
  }
  for (const hit of keptNgrams) {
    const text = chunkText.slice(hit.start, hit.end);
    if (isBoilerplateLabel(text, hit.key, headingKeys)) continue;
    spans.push({ start: hit.start, end: hit.end, tier: 2, kind: "label" });
  }

  const hasLabel = spans.some((s) => s.kind === "label");
  if (!hasLabel) {
    let added = 0;
    for (const w of claimWords) {
      if (added >= opts.TIER2_MAX_UNIGRAM_ANCHORS) break;
      if (w.length < opts.TIER2_MIN_UNIGRAM_LEN) continue;
      if (/^\d+$/.test(w)) continue;
      if (BOILERPLATE_UNIGRAMS.has(w)) continue;
      const norm = indexedNormalize(chunkText);
      const re = new RegExp(
        `(^|[^a-z0-9\\u0600-\\u06ff])(${w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")})(?=[^a-z0-9\\u0600-\\u06ff]|$)`,
        "gi",
      );
      const hits: Array<{ start: number; end: number }> = [];
      let m: RegExpExecArray | null;
      while ((m = re.exec(norm)) !== null) {
        const start = m.index + m[1]!.length;
        hits.push({ start, end: start + m[2]!.length });
      }
      if (hits.length !== 1) continue;
      const ext = extendJoinedRun(chunkText, hits[0]!.start, hits[0]!.end);
      const text = chunkText.slice(ext.start, ext.end);
      if (isBoilerplateLabel(text, w, headingKeys)) continue;
      spans.push({ start: ext.start, end: ext.end, tier: 2, kind: "label" });
      added += 1;
    }
  }

  // If only surviving Tier 2 anchors were suppressed labels, values may remain.
  // If nothing remains at all, return [] (nothing > boilerplate).
  return spans;
}

function mergeSpans(spans: HighlightSpan[], max: number): HighlightSpan[] {
  const sorted = [...spans]
    .filter((s) => s.end > s.start)
    .sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: HighlightSpan[] = [];
  for (const s of sorted) {
    const last = merged[merged.length - 1];
    if (last && s.start <= last.end) {
      // Prefer longer / keep tier of primary
      if (s.end > last.end) last.end = s.end;
      continue;
    }
    merged.push({ ...s });
  }
  return merged.slice(0, max);
}

function clampSpans(spans: HighlightSpan[], len: number): HighlightSpan[] {
  return spans
    .map((s) => ({
      ...s,
      start: Math.max(0, Math.min(s.start, len)),
      end: Math.max(0, Math.min(s.end, len)),
    }))
    .filter((s) => s.end > s.start);
}

/**
 * Compute highlight spans for a citation panel chunk.
 * Tier 1 first; Tier 2 only if Tier 1 produced zero spans.
 */
export function computeHighlights(
  segmentText: string,
  chunkText: string,
  opts?: Partial<HighlightOptions>,
): HighlightSpan[] {
  const o = { ...HIGHLIGHT_DEFAULTS, ...opts };
  if (!segmentText || !chunkText) return [];

  let spans = tier1(segmentText, chunkText, o);
  if (spans.length === 0) {
    spans = tier2(segmentText, chunkText, o);
  }
  return clampSpans(mergeSpans(spans, o.MAX_TOTAL_SPANS), chunkText.length);
}
