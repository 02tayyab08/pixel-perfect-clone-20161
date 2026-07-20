/**
 * Normalization for citation highlighting.
 * Indexed copy uses only 1:1 char mappings so original indices stay valid.
 * Length-changing transforms happen only during tokenization.
 */

const ARABIC_INDIC: Record<string, string> = {
  "٠": "0", "١": "1", "٢": "2", "٣": "3", "٤": "4",
  "٥": "5", "٦": "6", "٧": "7", "٨": "8", "٩": "9",
  "۰": "0", "۱": "1", "۲": "2", "۳": "3", "۴": "4",
  "۵": "5", "۶": "6", "۷": "7", "۸": "8", "۹": "9",
};

const STOPWORDS = new Set([
  "the", "a", "an", "and", "or", "but", "of", "for", "to", "in", "on", "at",
  "by", "with", "as", "is", "are", "was", "were", "be", "it", "its", "this",
  "that", "from", "not", "fee", "fees", "cost", "costs", "price", "prices",
  "aed", "usd", "eur", "gbp", "dh", "per", "based", "following", "listed",
  "the", "new", "may", "will", "can", "each", "any", "all", "more", "than",
  "في", "من", "إلى", "على", "عن", "و", "او", "أو", "ما", "الرسوم",
]);

/** 1:1 indexed normalization — same length as input. */
export function indexedNormalize(s: string): string {
  let out = "";
  for (const ch of s) {
    if (ARABIC_INDIC[ch] != null) {
      out += ARABIC_INDIC[ch];
      continue;
    }
    if (ch === "٬") {
      out += ",";
      continue;
    }
    if (ch === "٫") {
      out += ".";
      continue;
    }
    if (ch === "\u00a0" || ch === "\u2009" || ch === "\u202f" || ch === "\u2007") {
      out += " ";
      continue;
    }
    if (ch === "–" || ch === "—" || ch === "‐" || ch === "−") {
      out += "-";
      continue;
    }
    out += ch.toLowerCase();
  }
  return out;
}

export type FigureToken = {
  /** Original slice [start, end) */
  start: number;
  end: number;
  raw: string;
  /** Canonical digits-only key for matching (separators stripped). */
  key: string;
};

function canonicalKey(raw: string): string {
  const n = indexedNormalize(raw);
  return n.replace(/^(aed|usd|eur|gbp|dh)\s*/i, "").replace(/[^\d.]/g, "");
}

/**
 * Extract figure tokens with whole-token boundaries (never substring of a larger number).
 * Ranges yield both endpoints.
 */
export function extractFigures(text: string): FigureToken[] {
  const out: FigureToken[] = [];
  const push = (start: number, end: number) => {
    const raw = text.slice(start, end);
    const key = canonicalKey(raw);
    // Empty after strip only — bare "0" / "AED 0" is a valid fee value (waivers).
    if (!key) return;
    out.push({ start, end, raw, key: /^0+$/.test(key) ? "0" : key });
  };

  // Currency + number, optional range
  const currencyRe =
    /(?:AED|USD|EUR|GBP|DH)\s*[\d٠-٩۰-۹,٬]+(?:[.٫]\d+)?(?:\s*-\s*[\d٠-٩۰-۹,٬]+(?:[.٫]\d+)?)?/gi;
  // Thousand-separated or plain numbers with lookaround (no digit/comma adjacency)
  const numRe =
    /(?<![\d٠-٩۰-۹,٬])[\d٠-٩۰-۹]{1,3}(?:[,٬][\d٠-٩۰-۹]{3})+(?:[.٫]\d+)?(?![\d٠-٩۰-۹,٬])|(?<![\d٠-٩۰-۹,٬])[\d٠-٩۰-۹]{1,6}(?:[.٫]\d+)?%?(?![\d٠-٩۰-۹,٬])/g;

  const occupied = (a: number, b: number) => out.some((t) => a < t.end && b > t.start);

  for (const m of text.matchAll(currencyRe)) {
    const full = m[0]!;
    const start = m.index!;
    const range = full.match(
      /^((?:AED|USD|EUR|GBP|DH)\s*)([\d٠-٩۰-۹,٬]+(?:[.٫]\d+)?)\s*-\s*([\d٠-٩۰-۹,٬]+(?:[.٫]\d+)?)$/i,
    );
    if (range) {
      const p0 = start + range[1]!.length;
      const p1 = p0 + range[2]!.length;
      // Second number after " - "
      const secondStart = start + full.lastIndexOf(range[3]!);
      push(start, p1); // include currency on first endpoint highlight later
      // Store endpoints as separate figure keys; keep raw number spans for matching
      push(p0, p1);
      push(secondStart, secondStart + range[3]!.length);
      continue;
    }
    if (!occupied(start, start + full.length)) push(start, start + full.length);
  }

  for (const m of text.matchAll(numRe)) {
    const start = m.index!;
    const end = start + m[0]!.length;
    if (occupied(start, end)) continue;
    push(start, end);
  }

  return out;
}

export type ContentWord = { token: string; /** original form if recovered */ };

/**
 * Content words from claim/chunk text for matching.
 * Markup stripped only here (tokenization), not in indexed copy.
 */
export function extractContentWords(text: string): string[] {
  const expanded = text
    .replace(/"([^"]+)"/g, " $1 ")
    .replace(/<([^>]+)>/g, " $1 ")
    .replace(/\*\*([^*]+)\*\*/g, " $1 ")
    .replace(/\*([^*]+)\*/g, " $1 ")
    .replace(/`([^`]+)`/g, " $1 ")
    .replace(/#{1,6}\s*/g, " ")
    .replace(/\|/g, " ")
    .replace(/(?:AED|USD|EUR|GBP|DH)\s*[\d٠-٩۰-۹,٬]+(?:[.٫]\d+)?(?:\s*-\s*[\d٠-٩۰-۹,٬]+(?:[.٫]\d+)?)?/gi, " ")
    .replace(/[\d٠-٩۰-۹,٬]+(?:[.٫]\d+)?%?/g, " ");

  const words: string[] = [];
  for (const w of indexedNormalize(expanded).split(/[^a-z0-9\u0600-\u06ff]+/)) {
    if (!w || w.length < 3) continue;
    if (STOPWORDS.has(w)) continue;
    if (/^\d+$/.test(w)) continue;
    if (!words.includes(w)) words.push(w);
  }
  return words;
}

/** Whole-token figure occurrences of a canonical key in original text. */
export function findFigureKeyOccurrences(
  text: string,
  key: string,
): Array<{ start: number; end: number }> {
  if (!key) return [];
  const want = /^0+$/.test(key) ? "0" : key;
  const hits: Array<{ start: number; end: number }> = [];
  for (const f of extractFigures(text)) {
    if (f.key === want) hits.push({ start: f.start, end: f.end });
  }
  return hits;
}

/** Extend a value span to include adjacent `AED ` prefix or `%` suffix. */
export function extendValueSpan(
  text: string,
  start: number,
  end: number,
): { start: number; end: number } {
  let s = start;
  let e = end;
  const before = text.slice(Math.max(0, s - 4), s);
  const aed = before.match(/(?:AED|USD|EUR|GBP|DH)\s*$/i);
  if (aed) s = s - aed[0].length;
  if (text[e] === "%") e += 1;
  return { start: s, end: e };
}

export function isStopword(w: string): boolean {
  return STOPWORDS.has(w.toLowerCase());
}
