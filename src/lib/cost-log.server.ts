/**
 * Shared Gemini usage / cost logging.
 * Rates: input $1.50/M (prompt + File Search toolUse), output $9/M
 * (candidates + thoughts). Estimates only — Google bill is ground truth.
 */

export type StreamUsageSnapshot = {
  promptTokenCount?: number;
  toolUsePromptTokenCount?: number;
  candidatesTokenCount?: number;
  thoughtsTokenCount?: number;
  cachedContentTokenCount?: number;
  totalTokenCount?: number;
  /** Fields actually present (even if 0) on the usageMetadata blob. */
  presentFields: string[];
};

export type CallCostBreakdown = {
  model: string;
  thinkingLevel: string;
  call: string;
  prompt: number;
  toolUse: number;
  candidates: number;
  thoughts: number;
  cached: number;
  totalReported: number;
  totalSum: number;
  costUSD: number;
  groundingChunks: number;
  latencyMs: number;
};

const INPUT_USD_PER_M = 1.5;
const OUTPUT_USD_PER_M = 9.0;

export function extractStreamUsage(meta: unknown): StreamUsageSnapshot | null {
  if (!meta || typeof meta !== "object") return null;
  const m = meta as Record<string, unknown>;
  const presentFields: string[] = [];
  const snap: StreamUsageSnapshot = { presentFields };

  if ("promptTokenCount" in m) {
    presentFields.push("promptTokenCount");
    snap.promptTokenCount = Number(m.promptTokenCount ?? 0);
  }
  if ("toolUsePromptTokenCount" in m) {
    presentFields.push("toolUsePromptTokenCount");
    snap.toolUsePromptTokenCount = Number(m.toolUsePromptTokenCount ?? 0);
  }
  // Stream chunks use candidatesTokenCount; some surfaces use responseTokenCount.
  if ("candidatesTokenCount" in m) {
    presentFields.push("candidatesTokenCount");
    snap.candidatesTokenCount = Number(m.candidatesTokenCount ?? 0);
  } else if ("responseTokenCount" in m) {
    presentFields.push("responseTokenCount");
    snap.candidatesTokenCount = Number(m.responseTokenCount ?? 0);
  }
  if ("thoughtsTokenCount" in m) {
    presentFields.push("thoughtsTokenCount");
    snap.thoughtsTokenCount = Number(m.thoughtsTokenCount ?? 0);
  }
  if ("cachedContentTokenCount" in m) {
    presentFields.push("cachedContentTokenCount");
    snap.cachedContentTokenCount = Number(m.cachedContentTokenCount ?? 0);
  }
  if ("totalTokenCount" in m) {
    presentFields.push("totalTokenCount");
    snap.totalTokenCount = Number(m.totalTokenCount ?? 0);
  }
  return snap;
}

export function computeCallCost(usage: StreamUsageSnapshot | null): {
  prompt: number;
  toolUse: number;
  candidates: number;
  thoughts: number;
  cached: number;
  totalReported: number;
  totalSum: number;
  costUSD: number;
} {
  const prompt = usage?.promptTokenCount ?? 0;
  const toolUse = usage?.toolUsePromptTokenCount ?? 0;
  const candidates = usage?.candidatesTokenCount ?? 0;
  const thoughts = usage?.thoughtsTokenCount ?? 0;
  const cached = usage?.cachedContentTokenCount ?? 0;
  const totalReported = usage?.totalTokenCount ?? 0;
  const totalSum = prompt + toolUse + candidates + thoughts;
  const inputTokens = prompt + toolUse;
  const outputTokens = candidates + thoughts;
  const costUSD =
    (inputTokens / 1_000_000) * INPUT_USD_PER_M +
    (outputTokens / 1_000_000) * OUTPUT_USD_PER_M;
  return {
    prompt,
    toolUse,
    candidates,
    thoughts,
    cached,
    totalReported,
    totalSum,
    costUSD,
  };
}

/** Per-call line. Returns breakdown for [cost-total] aggregation. */
export function logAnswerCost(args: {
  model: string;
  thinkingLevel: string;
  /** Discriminator: answer | expansion */
  call?: string;
  usage: StreamUsageSnapshot | null;
  groundingChunks?: number;
  latencyMs: number;
}): CallCostBreakdown {
  const call = args.call ?? "answer";
  const computed = computeCallCost(args.usage);
  const groundingChunks = args.groundingChunks ?? 0;
  const present = args.usage?.presentFields?.length
    ? args.usage.presentFields.join(",")
    : "none";
  const sumCheck =
    computed.totalReported === 0
      ? "n/a"
      : computed.totalReported === computed.totalSum
        ? "ok"
        : `mismatch reported=${computed.totalReported} sum=${computed.totalSum}`;

  console.log(
    `[cost] call=${call} model=${args.model} thinkingLevel=${args.thinkingLevel} ` +
      `prompt=${computed.prompt} toolUse=${computed.toolUse} candidates=${computed.candidates} ` +
      `thoughts=${computed.thoughts} cached=${computed.cached} totalTokenCount=${computed.totalReported} ` +
      `totalSum=${computed.totalSum} sumCheck=${sumCheck} grounding=${groundingChunks} ` +
      `costUSD=${computed.costUSD.toFixed(6)} latencyMs=${args.latencyMs} usageFields=${present}`,
  );

  return {
    model: args.model,
    thinkingLevel: args.thinkingLevel,
    call,
    ...computed,
    groundingChunks,
    latencyMs: args.latencyMs,
  };
}

/** One line per user question: answer + expansion (if any). */
export function logQuestionCostTotal(args: {
  path: "staff" | "widget";
  parts: CallCostBreakdown[];
  latencyMs: number;
}): void {
  const prompt = args.parts.reduce((s, p) => s + p.prompt, 0);
  const toolUse = args.parts.reduce((s, p) => s + p.toolUse, 0);
  const candidates = args.parts.reduce((s, p) => s + p.candidates, 0);
  const thoughts = args.parts.reduce((s, p) => s + p.thoughts, 0);
  const cached = args.parts.reduce((s, p) => s + p.cached, 0);
  const totalReported = args.parts.reduce((s, p) => s + p.totalReported, 0);
  const totalSum = args.parts.reduce((s, p) => s + p.totalSum, 0);
  const costUSD = args.parts.reduce((s, p) => s + p.costUSD, 0);
  const grounding = args.parts.reduce((s, p) => s + p.groundingChunks, 0);
  const calls = args.parts.map((p) => p.call).join("+") || "none";

  console.log(
    `[cost-total] path=${args.path} calls=${calls} ` +
      `prompt=${prompt} toolUse=${toolUse} candidates=${candidates} thoughts=${thoughts} ` +
      `cached=${cached} totalTokenCount=${totalReported} totalSum=${totalSum} ` +
      `grounding=${grounding} costUSD=${costUSD.toFixed(6)} latencyMs=${args.latencyMs}`,
  );
}
