import { GoogleGenAI } from "@google/genai";

let cached: { key: string; client: GoogleGenAI } | null = null;

export function gemini(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: GEMINI_API_KEY");
  if (cached && cached.key === apiKey) return cached.client;
  // One-shot key diagnostic: prefix + tail + length only. Never the full key.
  const prefix = apiKey.slice(0, 4);
  const tail = apiKey.slice(-4);
  console.log(
    `[gemini-key] len=${apiKey.length} prefix=${prefix} tail=${tail} rebuildClient=${cached ? "true" : "false"}`,
  );
  cached = { key: apiKey, client: new GoogleGenAI({ apiKey }) };
  return cached.client;
}

export const SHARED_STORE_DISPLAY_NAME = "salni-shared-v1";
export const QUERY_MODEL = "gemini-2.5-flash";

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}