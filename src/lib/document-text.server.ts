/**
 * Direct text-layer extraction for retrieval self-probes.
 * Never use File Search inventory for probe question generation.
 */

import { createRequire } from "module";
import mammoth from "mammoth";

const require = createRequire(import.meta.url);
const pdfParse = require("pdf-parse") as (
  data: Buffer,
) => Promise<{ text?: string }>;

const MIN_USEFUL_CHARS = 80;

export type TextExtractResult = {
  text: string;
  chars: number;
  method: "pdf-text-layer" | "docx-text" | "plain" | "empty" | "unsupported";
  /** True when extract is long enough to generate probe questions. */
  usable: boolean;
};

function extOf(fileName: string): string {
  const i = fileName.lastIndexOf(".");
  return i >= 0 ? fileName.slice(i + 1).toLowerCase() : "";
}

export function shouldSkipProbe(
  fileName: string,
  mimeType: string | null | undefined,
  sizeBytes: number | null | undefined,
): boolean {
  const ext = extOf(fileName);
  if (["txt", "md", "markdown", "csv", "tsv"].includes(ext)) return true;
  const mime = (mimeType ?? "").toLowerCase();
  if (
    mime.startsWith("text/plain") ||
    mime.startsWith("text/markdown") ||
    mime.startsWith("text/csv")
  ) {
    return true;
  }
  if (sizeBytes != null && sizeBytes > 0 && sizeBytes < 2048) return true;
  return false;
}

/** Cap extract for Q-gen: head + mid + tail slices. */
export function sliceExtractForPrompt(text: string, maxChars = 48_000): string {
  const t = text.replace(/\u0000/g, "").trim();
  if (t.length <= maxChars) return t;
  const third = Math.floor(maxChars / 3);
  const midStart = Math.max(0, Math.floor(t.length / 2) - Math.floor(third / 2));
  return (
    t.slice(0, third) +
    "\n\n…\n\n" +
    t.slice(midStart, midStart + third) +
    "\n\n…\n\n" +
    t.slice(-third)
  );
}

export async function extractDocumentText(
  bytes: Buffer,
  fileName: string,
  mimeType?: string | null,
): Promise<TextExtractResult> {
  const ext = extOf(fileName);
  const mime = (mimeType ?? "").toLowerCase();

  try {
    if (ext === "pdf" || mime === "application/pdf") {
      const parsed = await pdfParse(bytes);
      const text = (parsed.text ?? "").trim();
      return {
        text,
        chars: text.length,
        method: "pdf-text-layer",
        usable: text.length >= MIN_USEFUL_CHARS,
      };
    }

    if (
      ext === "docx" ||
      mime.includes(
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      )
    ) {
      const result = await mammoth.extractRawText({ buffer: bytes });
      const text = (result.value ?? "").trim();
      return {
        text,
        chars: text.length,
        method: "docx-text",
        usable: text.length >= MIN_USEFUL_CHARS,
      };
    }

    if (
      ["txt", "md", "markdown", "csv", "tsv"].includes(ext) ||
      mime.startsWith("text/")
    ) {
      const text = bytes.toString("utf8").trim();
      return {
        text,
        chars: text.length,
        method: "plain",
        usable: text.length >= MIN_USEFUL_CHARS,
      };
    }

    return { text: "", chars: 0, method: "unsupported", usable: false };
  } catch (e) {
    console.error(
      "[document-text] extract failed",
      fileName,
      e instanceof Error ? e.message : String(e),
    );
    return { text: "", chars: 0, method: "empty", usable: false };
  }
}
