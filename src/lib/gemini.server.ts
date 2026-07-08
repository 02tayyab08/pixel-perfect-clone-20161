import { GoogleGenAI } from "@google/genai";

let cached: GoogleGenAI | null = null;

export function gemini(): GoogleGenAI {
  if (cached) return cached;
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("Missing required env var: GEMINI_API_KEY");
  cached = new GoogleGenAI({ apiKey });
  return cached;
}

export const SHARED_STORE_DISPLAY_NAME = "salni-shared-v1";
export const QUERY_MODEL = "gemini-2.5-flash";

export async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}