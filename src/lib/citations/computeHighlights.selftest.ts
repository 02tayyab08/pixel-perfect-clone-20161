/**
 * Stage 1 citation highlight self-tests.
 * Run: npx --yes tsx src/lib/citations/computeHighlights.selftest.ts
 */
import { spansToMarkSegments } from "../../components/citation-chunk-body.tsx";
import { FIXTURE_A, FIXTURE_B, FIXTURE_C } from "./__fixtures__/chunks.ts";
import { computeHighlights, type HighlightSpan } from "./computeHighlights.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function spanTexts(chunk: string, spans: HighlightSpan[]): string[] {
  return spans.map((s) => chunk.slice(s.start, s.end));
}

function assertNoOverlap(spans: HighlightSpan[]): void {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) {
    assert(sorted[i]!.start >= sorted[i - 1]!.end, "spans overlap after merge");
  }
}

function assertInBounds(chunk: string, spans: HighlightSpan[]): void {
  for (const s of spans) {
    assert(s.start >= 0 && s.end <= chunk.length && s.end > s.start, "span out of bounds");
  }
}

function noneContain(texts: string[], needle: string | RegExp): void {
  for (const t of texts) {
    if (typeof needle === "string") {
      assert(!t.includes(needle), `unexpected highlight containing ${needle}: ${t.slice(0, 80)}`);
    } else {
      assert(!needle.test(t), `unexpected highlight matching ${needle}`);
    }
  }
}

function someContain(texts: string[], needle: string | RegExp): void {
  const ok = texts.some((t) => (typeof needle === "string" ? t.includes(needle) : needle.test(t)));
  assert(ok, `expected a highlight containing ${needle}; got: ${JSON.stringify(texts)}`);
}

// --- A1 ---
{
  const seg = "**Cross Business Activity Fee:** AED 2,000 (waived for new applications)";
  const spans = computeHighlights(seg, FIXTURE_A);
  assertInBounds(FIXTURE_A, spans);
  assertNoOverlap(spans);
  assert(spans.length >= 1, "A1: expected ≥1 span");
  const texts = spanTexts(FIXTURE_A, spans);
  someContain(texts, /Cross Business Activity/i);
  noneContain(texts, "Extra Business Activity");
  noneContain(texts, "Pre-Approval");
  noneContain(texts, "Downpayment");
  console.log("ok: A1 Cross Business Activity");
}

// --- A2 ---
{
  const seg = "*   **Extra Business Activity Fee:** AED 1,000 per additional business activity";
  const spans = computeHighlights(seg, FIXTURE_A);
  assertInBounds(FIXTURE_A, spans);
  assertNoOverlap(spans);
  assert(spans.length >= 1, "A2: expected ≥1 span");
  const texts = spanTexts(FIXTURE_A, spans);
  someContain(texts, /Extra Business Activity/i);
  assert(
    texts.every((t) => /Extra Business Activity/i.test(t)),
    "A2: only Extra Business Activity row",
  );
  console.log("ok: A2 Extra Business Activity");
}

// --- A3 ---
{
  const seg = "**General Trading:** AED 10,000 (waived for new applications)";
  const spans = computeHighlights(seg, FIXTURE_A);
  assertInBounds(FIXTURE_A, spans);
  assertNoOverlap(spans);
  assert(spans.length >= 1, "A3: expected ≥1 span");
  const texts = spanTexts(FIXTURE_A, spans);
  someContain(texts, /General Trading/i);
  noneContain(texts, "Single Family Office");
  console.log("ok: A3 General Trading (not SFO)");
}

// --- A4 negative ---
{
  const seg = "**Change of Director:** AED 2,000";
  const spans = computeHighlights(seg, FIXTURE_A);
  assert(spans.length === 0, `A4: expected zero spans, got ${spans.length}`);
  console.log("ok: A4 negative Change of Director on A");
}

// --- A5 boundary ---
{
  const seg = "AED 2,000";
  const chunk = "Package price is 12,000 for the year.";
  const spans = computeHighlights(seg, chunk);
  assert(spans.length === 0, `A5: expected zero spans, got ${JSON.stringify(spans)}`);
  console.log("ok: A5 token-boundary 2,000 vs 12,000");
}

// --- B1 ---
{
  const seg = "**Change of Director:** AED 2,000";
  const spans = computeHighlights(seg, FIXTURE_B);
  assertInBounds(FIXTURE_B, spans);
  assertNoOverlap(spans);
  assert(spans.length >= 1, "B1: expected ≥1 span");
  assert(
    spans.every((s) => s.tier === 2),
    "B1: Tier 1 must decline (length gate)",
  );
  const texts = spanTexts(FIXTURE_B, spans);
  someContain(texts, /Director/i);
  noneContain(texts, "2,000");
  noneContain(texts, "2000");
  console.log("ok: B1 Director label only (no 2,000)");
}

// --- B2 ---
{
  const seg =
    "**Visa Allocation Upgrade:** fee equal to the difference between license packages";
  const spans = computeHighlights(seg, FIXTURE_B);
  assertInBounds(FIXTURE_B, spans);
  assertNoOverlap(spans);
  assert(spans.length >= 1, "B2: expected ≥1 span");
  const texts = spanTexts(FIXTURE_B, spans);
  someContain(texts, /Visa Allocation Upgrade/i);
  noneContain(texts, "2,000");
  console.log("ok: B2 Visa Allocation Upgrade n-gram");
}

// --- C1 ---
{
  const seg = "**رسوم النشاط التجاري المتقاطع:** AED 2,000";
  const spans = computeHighlights(seg, FIXTURE_C);
  assertInBounds(FIXTURE_C, spans);
  assertNoOverlap(spans);
  assert(spans.length >= 1, "C1: expected ≥1 span for Arabic-Indic figure match");
  const texts = spanTexts(FIXTURE_C, spans);
  someContain(texts, "٢٬٠٠٠");
  noneContain(texts, "١٠٬٠٠٠");
  console.log("ok: C1 Arabic-Indic figure match");
}

// --- Edge battery ---
{
  assert(computeHighlights("foo", "").length === 0, "empty chunk");
  assert(computeHighlights("", "bar").length === 0, "empty segment");
  const longSeg = "x".repeat(5000) + " AED 999";
  const shortChunk = "AED 999 only here once UniqueLabelWord";
  const spans = computeHighlights(longSeg, shortChunk);
  assertInBounds(shortChunk, spans);
  assertNoOverlap(spans);
  console.log("ok: edge empty + long segment no throw");
}

{
  // RTL mark segments: Arabic + Latin mixed, marks preserve order
  const chunk = "الرسوم AED 2,000 للتداول";
  const spans = computeHighlights("**التداول:** AED 2,000", chunk);
  const segs = spansToMarkSegments(chunk, spans);
  const joined = segs.map((s) => s.text).join("");
  assert(joined === chunk, "RTL segments must reconstruct chunk");
  assert(segs.some((s) => s.mark), "RTL: expected at least one mark when spans fire");
  console.log("ok: RTL mark segment reconstruction");
}

// --- D1: zero-figure / AED 0 waiver claim → waiver sentence (not boilerplate) ---
{
  const seg =
    "Per the terms and conditions in the provided documents, this fee is waived for new applications and the next three renewals (a total of four years), effectively making the charge AED 0 for a new application";
  const spans = computeHighlights(seg, FIXTURE_A);
  assertInBounds(FIXTURE_A, spans);
  assertNoOverlap(spans);
  assert(spans.length >= 1, "D1: expected ≥1 span");
  assert(
    spans.every((s) => s.tier === 1),
    "D1: expected Tier 1 (AED 0 + content words), not Tier 2 boilerplate",
  );
  const texts = spanTexts(FIXTURE_A, spans);
  someContain(
    texts,
    /The Cross Business Activity Fee \(AED 2,000\) is WAIVED for new applications and the next three renewals/i,
  );
  noneContain(texts, /^Terms\s*&\s*Conditions$/i);
  for (const t of texts) {
    assert(
      !/^terms\s*(&|and)?\s*conditions$/i.test(t.trim()),
      `D1: must not highlight bare boilerplate: ${t}`,
    );
  }
  console.log("ok: D1 AED 0 waiver → Cross Business waiver sentence");
}

// --- D1b: truly zero-figure waiver claim (no digits) → content-word Tier 1 ---
{
  const seg =
    "this fee is waived for new applications and the next three renewals, effectively making the charge for a new application";
  const spans = computeHighlights(seg, FIXTURE_A);
  assertInBounds(FIXTURE_A, spans);
  assertNoOverlap(spans);
  assert(spans.length >= 1, "D1b: expected ≥1 span via zero-figure path");
  const texts = spanTexts(FIXTURE_A, spans);
  someContain(texts, /WAIVED for new applications and the next three renewals/i);
  console.log("ok: D1b zero-figure content-word Tier 1");
}

// --- D2: only unique anchor is boilerplate → zero spans ---
{
  const seg = "Per the terms and conditions in the provided documents.";
  const spans = computeHighlights(seg, FIXTURE_A);
  assert(
    spans.length === 0,
    `D2: expected zero spans for boilerplate-only claim, got ${JSON.stringify(spanTexts(FIXTURE_A, spans))}`,
  );
  console.log("ok: D2 boilerplate-only claim → empty");
}

console.log("\nAll computeHighlights self-tests passed.");
