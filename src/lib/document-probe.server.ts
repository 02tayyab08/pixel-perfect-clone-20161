/**
 * Phase 1 retrieval self-probe: generate questions from direct text extract,
 * query File Search scoped to document_id, persist class (warn-only).
 */

import { ThinkingLevel } from "@google/genai";
import { gemini, EXPANSION_MODEL } from "@/lib/gemini.server";
import { extractStreamUsage, computeCallCost } from "@/lib/cost-log.server";
import {
  extractDocumentText,
  shouldSkipProbe,
  sliceExtractForPrompt,
} from "@/lib/document-text.server";
import { bootstrapStore } from "@/lib/store-bootstrap.server";
import { salniService } from "@/lib/supabase.server";

export const PROBE_QUESTION_COUNT = 8;
export const PROBE_WARN_THRESHOLD = 0.75;
export const PROBE_BAD_THRESHOLD = 0.5;

export type ProbeClass =
  | "ok"
  | "warn"
  | "bad"
  | "skipped"
  | "inconclusive";

export type ProbeQuestion = {
  question: string;
  expectedAtom?: string;
};

export type ProbeQuestionResult = {
  question: string;
  groundingChunks: number;
  grounded: boolean;
  isRefusal: boolean;
  answerPreview: string;
};

const NOT_IN_DOCS = "I don't have that in the provided documents.";

function classifyRate(rate: number): ProbeClass {
  if (rate < PROBE_BAD_THRESHOLD) return "bad";
  if (rate < PROBE_WARN_THRESHOLD) return "warn";
  return "ok";
}

async function generateQuestions(
  extract: string,
): Promise<{ questions: ProbeQuestion[]; usageCost: number }> {
  const ai = gemini();
  const sliced = sliceExtractForPrompt(extract);
  const prompt =
    `You write retrieval self-test questions for a business document.\n` +
    `From the EXTRACT below, output EXACTLY ${PROBE_QUESTION_COUNT} JSON objects in a JSON array.\n` +
    `Each object: {"question":"...","expectedAtom":"short fact or number from extract"}.\n` +
    `Rules:\n` +
    `- Each question is answerable by ONE atomic fact in the extract.\n` +
    `- Prefer fees, named items, conditions, yes/no rules stated in the text.\n` +
    `- No meta questions (do not ask to summarize or list everything).\n` +
    `- Diversify: mix early and late content; if both setup/base and amendment/` +
    `modification style items exist, include at least one of each.\n` +
    `- Output ONLY the JSON array.\n\nEXTRACT:\n` +
    sliced;

  const r = await ai.models.generateContent({
    model: EXPANSION_MODEL,
    contents: prompt,
    config: {
      temperature: 0,
      maxOutputTokens: 1024,
      thinkingConfig: {
        includeThoughts: false,
        thinkingLevel: ThinkingLevel.MINIMAL,
      },
    },
  });
  const raw = (r as { text?: string }).text ?? "";
  const usage = extractStreamUsage(
    (r as { usageMetadata?: unknown }).usageMetadata,
  );
  const { costUSD } = computeCallCost(usage);

  const match = raw.match(/\[[\s\S]*\]/);
  if (!match) return { questions: [], usageCost: costUSD };
  try {
    const parsed = JSON.parse(match[0]) as ProbeQuestion[];
    const cleaned = parsed
      .filter((q) => q && typeof q.question === "string" && q.question.trim())
      .slice(0, PROBE_QUESTION_COUNT)
      .map((q) => ({
        question: q.question.trim(),
        expectedAtom:
          typeof q.expectedAtom === "string" ? q.expectedAtom.trim() : undefined,
      }));
    return { questions: cleaned, usageCost: costUSD };
  } catch {
    return { questions: [], usageCost: costUSD };
  }
}

async function answerProbeQuestion(args: {
  question: string;
  storeName: string;
  orgId: string;
  documentId: string;
}): Promise<{ result: ProbeQuestionResult; costUSD: number }> {
  const ai = gemini();
  const r = await ai.models.generateContent({
    model: EXPANSION_MODEL,
    contents: args.question,
    config: {
      temperature: 0,
      maxOutputTokens: 256,
      systemInstruction:
        `Answer strictly from the provided documents. If the answer is not in them, ` +
        `reply exactly: "${NOT_IN_DOCS}"`,
      tools: [
        {
          fileSearch: {
            fileSearchStoreNames: [args.storeName],
            metadataFilter: `org_id="${args.orgId}" AND document_id="${args.documentId}"`,
          },
        },
      ],
      thinkingConfig: {
        includeThoughts: false,
        thinkingLevel: ThinkingLevel.MINIMAL,
      },
    },
  });

  const text = ((r as { text?: string }).text ?? "").trim();
  const chunks =
    (r as { candidates?: Array<{ groundingMetadata?: { groundingChunks?: unknown[] } }> })
      .candidates?.[0]?.groundingMetadata?.groundingChunks ?? [];
  const groundingChunks = chunks.length;
  const isRefusal =
    text === NOT_IN_DOCS || text.startsWith(NOT_IN_DOCS) || groundingChunks === 0;
  const grounded = groundingChunks >= 1 && !isRefusal;

  const usage = extractStreamUsage(
    (r as { usageMetadata?: unknown }).usageMetadata,
  );
  const { costUSD } = computeCallCost(usage);

  return {
    result: {
      question: args.question,
      groundingChunks,
      grounded,
      isRefusal,
      answerPreview: text.slice(0, 240),
    },
    costUSD,
  };
}

export type ProbeRunInput = {
  documentId: string;
  organizationId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number | null;
  storagePath: string;
  fileSearchStoreName: string | null;
  /** When true, probe even txt/md (calibration). */
  forceProbe?: boolean;
};

export type ProbeRunOutcome = {
  probeClass: ProbeClass;
  probeConfidence: "high" | "low";
  successRate: number | null;
  questionsTotal: number;
  questionsGrounded: number;
  questions: ProbeQuestion[];
  results: ProbeQuestionResult[];
  extractChars: number;
  model: string;
  costUsd: number;
};

export async function runDocumentProbe(
  input: ProbeRunInput,
): Promise<ProbeRunOutcome> {
  const svc = salniService();
  const model = EXPANSION_MODEL;

  if (
    !input.forceProbe &&
    shouldSkipProbe(input.fileName, input.mimeType, input.sizeBytes)
  ) {
    return {
      probeClass: "skipped",
      probeConfidence: "high",
      successRate: null,
      questionsTotal: 0,
      questionsGrounded: 0,
      questions: [],
      results: [],
      extractChars: 0,
      model,
      costUsd: 0,
    };
  }

  const { data: file, error: dlErr } = await svc.storage
    .from("documents")
    .download(input.storagePath);
  if (dlErr || !file) {
    console.error("[document-probe] download failed", dlErr?.message);
    return {
      probeClass: "inconclusive",
      probeConfidence: "low",
      successRate: null,
      questionsTotal: 0,
      questionsGrounded: 0,
      questions: [],
      results: [],
      extractChars: 0,
      model,
      costUsd: 0,
    };
  }

  const buf = Buffer.from(await file.arrayBuffer());
  const extracted = await extractDocumentText(
    buf,
    input.fileName,
    input.mimeType,
  );

  if (!extracted.usable) {
    return {
      probeClass: "inconclusive",
      probeConfidence: "low",
      successRate: null,
      questionsTotal: 0,
      questionsGrounded: 0,
      questions: [],
      results: [],
      extractChars: extracted.chars,
      model,
      costUsd: 0,
    };
  }

  const { questions, usageCost: genCost } = await generateQuestions(
    extracted.text,
  );
  let costUsd = genCost;

  if (questions.length < Math.ceil(PROBE_QUESTION_COUNT / 2)) {
    return {
      probeClass: "inconclusive",
      probeConfidence: "low",
      successRate: null,
      questionsTotal: questions.length,
      questionsGrounded: 0,
      questions,
      results: [],
      extractChars: extracted.chars,
      model,
      costUsd,
    };
  }

  const storeName = await bootstrapStore(input.fileSearchStoreName);
  const results: ProbeQuestionResult[] = [];
  for (const q of questions) {
    try {
      const { result, costUSD } = await answerProbeQuestion({
        question: q.question,
        storeName,
        orgId: input.organizationId,
        documentId: input.documentId,
      });
      results.push(result);
      costUsd += costUSD;
    } catch (e) {
      console.error(
        "[document-probe] question failed",
        e instanceof Error ? e.message : String(e),
      );
      results.push({
        question: q.question,
        groundingChunks: 0,
        grounded: false,
        isRefusal: true,
        answerPreview: "",
      });
    }
  }

  const grounded = results.filter((r) => r.grounded).length;
  const total = results.length;
  const successRate = total > 0 ? grounded / total : 0;
  const probeClass = classifyRate(successRate);

  return {
    probeClass,
    probeConfidence: "high",
    successRate,
    questionsTotal: total,
    questionsGrounded: grounded,
    questions,
    results,
    extractChars: extracted.chars,
    model,
    costUsd,
  };
}

export async function persistDocumentProbe(
  input: ProbeRunInput,
  outcome: ProbeRunOutcome,
): Promise<void> {
  const svc = salniService();
  const { error } = await svc.from("document_probes").insert({
    document_id: input.documentId,
    organization_id: input.organizationId,
    probe_class: outcome.probeClass,
    probe_confidence: outcome.probeConfidence,
    success_rate: outcome.successRate,
    questions_total: outcome.questionsTotal,
    questions_grounded: outcome.questionsGrounded,
    questions: outcome.questions,
    results: outcome.results,
    extract_chars: outcome.extractChars,
    model: outcome.model,
    cost_usd: outcome.costUsd,
  });
  if (error) {
    throw new Error(`document_probes.insert failed: ${error.message}`);
  }
}
