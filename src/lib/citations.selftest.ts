/**
 * Self-test for citation byte-offset and narrowest-span presentation.
 * Highlight tests: src/lib/citations/computeHighlights.selftest.ts
 * Run: npx --yes tsx src/lib/citations.selftest.ts
 */
import {
  buildCitationPresentation,
  utf8ByteOffsetToCharIndex,
  type GroundingChunkRow,
  type GroundingSupportRow,
} from "./citations.ts";

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

function utf8Len(s: string): number {
  return new TextEncoder().encode(s).length;
}

{
  const prefix = "الرسوم هي ";
  const fact = "١٠٠٠ درهم";
  const suffix = " حسب الجدول.";
  const answer = prefix + fact + suffix;
  const endByte = utf8Len(prefix + fact);
  const endChar = utf8ByteOffsetToCharIndex(answer, endByte);
  assert(endChar === (prefix + fact).length, `Arabic endChar mismatch: ${endChar}`);

  const chunks: GroundingChunkRow[] = [
    { source_title: "جدول.pdf", snippet: "١٠٠٠", page: 3, document_id: "d1" },
  ];
  const supports: GroundingSupportRow[] = [
    {
      segment: { startIndex: 0, endIndex: endByte, text: prefix + fact },
      groundingChunkIndices: [0],
    },
  ];
  const plan = buildCitationPresentation(answer, chunks, supports);
  assert(plan.sources.length === 1 && plan.sources[0]!.n === 1, "Arabic sources");
  assert(plan.markedMarkdown.includes("⟦1⟧"), "Arabic sentinel missing");
  console.log("ok: arabic byte-offset citation");
}

{
  const answer =
    "Based on the IFZA Schedule of Fees, the costs are as follows:\n\n*   **Investor Visa Add-On:** AED 1,000\n*   **Visa Amendment:** AED 2,000 – 4,000\n\nBecause the Visa Amendment fee is listed as a range…";

  const chunks: GroundingChunkRow[] = [
    {
      source_title: "IFZA.md",
      snippet: "| Investor Visa Add-On | 1,000 |",
      page: 1,
      document_id: "d1",
    },
    {
      source_title: "IFZA.md",
      snippet: "| Visa Amendment | 2,000 - 4,000 |",
      page: 1,
      document_id: "d1",
    },
  ];

  const s0 = answer.indexOf("*   **Investor");
  const e0 = answer.indexOf("\n*   **Visa Amendment");
  const s1 = answer.indexOf("*   **Visa Amendment");
  const e1 = answer.indexOf("\n\nBecause");

  const supports: GroundingSupportRow[] = [
    {
      segment: {
        startIndex: utf8Len(answer.slice(0, s0)),
        endIndex: utf8Len(answer.slice(0, e0)),
        text: answer.slice(s0, e0),
      },
      groundingChunkIndices: [0],
    },
    {
      segment: {
        startIndex: utf8Len(answer.slice(0, s1)),
        endIndex: utf8Len(answer.slice(0, e1)),
        text: answer.slice(s1, e1),
      },
      groundingChunkIndices: [1],
    },
    {
      // Wider overlapping support — narrowest should win for chunk 1
      segment: {
        startIndex: 0,
        endIndex: utf8Len(answer),
        text: answer,
      },
      groundingChunkIndices: [0, 1],
    },
  ];

  const plan = buildCitationPresentation(answer, chunks, supports);
  assert(plan.sources.length === 2, "expected 2 sources");
  assert(plan.sources[0]!.answerSegment?.includes("Investor Visa"), "narrow segment 0");
  assert(plan.sources[1]!.answerSegment?.includes("Visa Amendment"), "narrow segment 1");
  assert(
    !plan.sources[0]!.answerSegment?.includes("Because the Visa"),
    "must not assign wide span",
  );
  assert(plan.markedMarkdown.includes("⟦1⟧"), "sentinel 1");
  assert(plan.markedMarkdown.includes("⟦2⟧"), "sentinel 2");
  console.log("ok: narrowest-span assignment");
}

console.log("\nAll citations presentation self-tests passed.");
