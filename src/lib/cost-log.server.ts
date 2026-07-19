/**
 * Shared Gemini usage / cost logging.
 *
 * Rates are model-aware (paid list, estimates only — Google bill is ground truth):
 *   gemini-*-flash-lite → input $0.25/M, output $1.50/M
 *   gemini-*-flash (non-lite) → input $1.50/M, output $9.00/M
 *   unknown models → flash (non-lite) rates + warn once
 *
 * Input = prompt + File Search toolUse. Output = candidates + thoughts.
 *
 * Note on thoughtsTokenCount: gemini-3.1-flash-lite with thinkingLevel=MEDIUM
 * often omits thoughtsTokenCount from usageMetadata entirely (field absent,
 * not present-as-0). When omitted we cannot measure thinking-token cost on
 * this model — do not treat thoughts=0 as "thinking is free."
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
  /** Resolved $/M rates used for this call. */
  inputUsdPerM: number;
  outputUsdPerM: number;
};

type ModelRates = { inputUsdPerM: number; outputUsdPerM: number; tier: string };

const FLASH_LITE: ModelRates = {
  inputUsdPerM: 0.25,
  outputUsdPerM: 1.5,
  tier: "flash-lite",
};
const FLASH: ModelRates = {
  inputUsdPerM: 1.5,
  outputUsdPerM: 9.0,
  tier: "flash",
};

const warnedUnknownModels = new Set<string>();

/** Resolve list rates for a Gemini model id. */
export function ratesForModel(model: string | null | undefined): ModelRates {
  const id = (model ?? "").trim().toLowerCase();
  if (!id) return FLASH;
  // Lite before generic flash (ids look like gemini-3.1-flash-lite).
  if (id.includes("flash-lite") || id.includes("flash_lite")) return FLASH_LITE;
  if (id.includes("flash")) return FLASH;
  if (!warnedUnknownModels.has(id)) {
    warnedUnknownModels.add(id);
    console.warn(
      `[cost] unknown model rates for "${model}" — using flash ($1.50/$9) until table updated`,
    );
  }
  return FLASH;
}

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

export function computeCallCost(
  usage: StreamUsageSnapshot | null,
  model?: string | null,
): {
  prompt: number;
  toolUse: number;
  candidates: number;
  thoughts: number;
  cached: number;
  totalReported: number;
  totalSum: number;
  costUSD: number;
  inputUsdPerM: number;
  outputUsdPerM: number;
} {
  const rates = ratesForModel(model);
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
    (inputTokens / 1_000_000) * rates.inputUsdPerM +
    (outputTokens / 1_000_000) * rates.outputUsdPerM;
  return {
    prompt,
    toolUse,
    candidates,
    thoughts,
    cached,
    totalReported,
    totalSum,
    costUSD,
    inputUsdPerM: rates.inputUsdPerM,
    outputUsdPerM: rates.outputUsdPerM,
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
  const computed = computeCallCost(args.usage, args.model);
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
  const thoughtsFieldPresent = present.includes("thoughtsTokenCount");

  console.log(
    `[cost] call=${call} model=${args.model} thinkingLevel=${args.thinkingLevel} ` +
      `rates=$${computed.inputUsdPerM}/$${computed.outputUsdPerM} ` +
      `prompt=${computed.prompt} toolUse=${computed.toolUse} candidates=${computed.candidates} ` +
      `thoughts=${computed.thoughts} thoughtsField=${thoughtsFieldPresent ? "present" : "absent"} ` +
      `cached=${computed.cached} totalTokenCount=${computed.totalReported} ` +
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
