import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session.server";
import { salniService, salniAsUser } from "@/lib/supabase.server";
import { bootstrapStore } from "@/lib/store-bootstrap.server";
import { gemini, QUERY_MODEL } from "@/lib/gemini.server";
import { SetupInProgressError, isSetupInProgressPayload } from "@/lib/errors";

const BodySchema = z.object({
  orgId: z.string().uuid(),
  conversationId: z.string().uuid().nullish(),
  message: z.string().min(1).max(4000),
});

const NOT_IN_DOCS = "I don't have that in the provided documents.";

void isSetupInProgressPayload; // exported for client consumers of /api/query

// Best-effort retrieval-term expansion. Never blocks or breaks an answer.
async function expandQueryTerms(question: string): Promise<string | null> {
  const TIMEOUT_MS = 800;
  try {
    const ai = gemini();
    const prompt =
      "Given a user question for a business knowledge assistant in the UAE, " +
      "output 3–8 comma-separated retrieval keywords/synonyms covering domain " +
      "terminology (e.g. 'hiring UAE nationals' → Emiratisation, local hiring " +
      "quota, workforce nationalization). Output ONLY the comma-separated terms, " +
      "nothing else.\n\nQuestion: " +
      question;
    const call = ai.models.generateContent({
      model: "gemini-2.5-flash-lite",
      contents: prompt,
    });
    const timeout = new Promise<null>((resolve) =>
      setTimeout(() => resolve(null), TIMEOUT_MS),
    );
    const res = await Promise.race([call, timeout]);
    if (!res) {
      console.log("[query-expansion] skipped: timeout");
      return null;
    }
    const text = (res as { text?: string }).text?.trim() ?? "";
    if (!text) {
      console.log("[query-expansion] skipped: empty");
      return null;
    }
    // Sanitize to one line of comma-separated terms.
    const terms = text
      .replace(/\n+/g, " ")
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
      .slice(0, 8)
      .join(", ");
    if (!terms) return null;
    console.log("[query-expansion] terms=", terms);
    return terms;
  } catch (e) {
    console.log(
      "[query-expansion] skipped: error",
      e instanceof Error ? e.message : String(e),
    );
    return null;
  }
}

export const Route = createFileRoute("/api/query")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const user = await getCurrentUser();
        if (!user) return new Response("Unauthorized", { status: 401 });

        let parsed: z.infer<typeof BodySchema>;
        try {
          parsed = BodySchema.parse(await request.json());
        } catch (e) {
          const msg =
            e instanceof z.ZodError
              ? JSON.stringify(e.issues)
              : e instanceof Error
                ? e.message
                : String(e);
          console.error("query BodySchema.parse failed (raw)", msg);
          return new Response(`Bad Request: ${msg}`, { status: 400 });
        }

        // Verify org membership using the user's JWT (RLS).
        const asUser = salniAsUser(user.accessToken);
        const { data: memberOk, error: memberErr } = await asUser.rpc("is_org_member", {
          p_org: parsed.orgId,
        });
        if (memberErr || memberOk !== true) return new Response("Forbidden", { status: 403 });

        const svc = salniService();
        const { data: org, error: orgErr } = await svc
          .from("organizations")
          .select("id, is_active, system_instruction, file_search_store_name")
          .eq("id", parsed.orgId)
          .maybeSingle();
        if (orgErr || !org) return new Response("Not Found", { status: 404 });
        if (org.is_active === false) {
          return new Response("This assistant is currently unavailable.", { status: 503 });
        }

        let storeName: string;
        try {
          storeName = await bootstrapStore(org.file_search_store_name ?? null);
        } catch (e) {
          if (e instanceof SetupInProgressError) {
            return new Response(JSON.stringify(e.toPayload()), {
              status: 409,
              headers: { "content-type": "application/json", "Retry-After": "2" },
            });
          }
          const msg = e instanceof Error ? `${e.name}: ${e.message}` : String(e);
          console.error("bootstrapStore failed (raw)", e);
          return new Response(`bootstrapStore failed: ${msg}`, { status: 500 });
        }

        // Ensure a conversation exists.
        let conversationId = parsed.conversationId ?? null;
        if (!conversationId) {
          const { data: conv, error: convErr } = await svc
            .from("conversations")
            .insert({
              organization_id: parsed.orgId,
              channel: "text",
              started_by: user.userId,
            })
            .select("id")
            .single();
          if (convErr) {
            console.error("conversations.insert failed", convErr);
            const raw = [
              (convErr as { code?: string }).code,
              convErr.message,
              (convErr as { details?: string }).details,
              (convErr as { hint?: string }).hint,
            ]
              .filter(Boolean)
              .join(" | ");
            return new Response(`conversations.insert failed: ${raw}`, { status: 500 });
          }
          conversationId = conv.id as string;
        }

        // Persist user message immediately.
        await svc.from("messages").insert({
          conversation_id: conversationId,
          organization_id: parsed.orgId,
          role: "user",
          modality: "text",
          content: parsed.message,
        });

        const stream = new ReadableStream<Uint8Array>({
          async start(controller) {
            const enc = new TextEncoder();
            const send = (obj: unknown) => {
              controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`));
            };
            send({ type: "conversation", id: conversationId });

            const startedAt = Date.now();
            let fullText = "";
            let groundingChunks: unknown[] = [];
            let streamErrored = false;

            try {
              const ai = gemini();
              const terms = await expandQueryTerms(parsed.message);
              const retrievalPrompt = terms
                ? `${parsed.message}\n(Related terms to consider when searching the documents: ${terms})`
                : parsed.message;
              const toolsPayload = [
                {
                  fileSearch: {
                    fileSearchStoreNames: [storeName],
                    metadataFilter: `org_id="${org.id}"`,
                  },
                },
              ];
              // SINGLE-TURN RETRIEVAL (V1): only the current question is sent to
              // File Search. Do NOT append prior transcript turns here — that would
              // let earlier refusals poison later lookups. Conversational follow-ups
              // ("what about X?") are a V2 feature.
              const iter = await ai.models.generateContentStream({
                model: QUERY_MODEL,
                contents: retrievalPrompt,
                config: {
                  systemInstruction:
                    org.system_instruction ||
                    "You answer strictly from the provided documents. If the answer is not in them, reply exactly: \"" +
                      NOT_IN_DOCS +
                      "\"",
                  tools: toolsPayload,
                },
              });

              for await (const chunk of iter) {
                const text = chunk.text ?? "";
                if (text) {
                  fullText += text;
                  send({ type: "delta", text });
                }
                const cand = chunk.candidates?.[0];
                const gm = cand?.groundingMetadata;
                if (gm?.groundingChunks && gm.groundingChunks.length > 0) {
                  groundingChunks = gm.groundingChunks;
                }
              }
            } catch (e) {
              console.error("gemini.generateContentStream failed (raw)", e);
              streamErrored = true;
              const err = e as { name?: string; message?: string; status?: number };
              const status = err?.status;
              const userMsg =
                status === 429
                  ? "The assistant is temporarily rate limited. Please try again in a moment."
                  : status === 402
                    ? "The assistant is temporarily unavailable (billing)."
                    : "The assistant hit an unexpected error. Please try again.";
              // Do NOT write the error into fullText — that would trigger the
              // grounding-miss override and masquerade as a refusal.
              send({ type: "error", message: userMsg });
            }

            const latencyMs = Date.now() - startedAt;

            // Grounding miss → override with the canonical string.
            // Skip when the stream errored: the client already got an {type:"error"}
            // frame, and we must not synthesize a refusal on top of an infra failure.
            if (
              !streamErrored &&
              fullText.trim().length > 0 &&
              groundingChunks.length === 0
            ) {
              fullText = NOT_IN_DOCS;
              send({ type: "override", text: fullText });
            }

            // Explicit refusal signal (transport-only, no schema change).
            const isRefusal =
              !streamErrored &&
              (fullText.trim() === NOT_IN_DOCS || groundingChunks.length === 0);
            send({ type: "meta", isRefusal });
            console.log(
              `[query] grounding=${groundingChunks.length} refusal=${isRefusal} errored=${streamErrored} latency=${latencyMs}ms`,
            );

            // Persist assistant message + citations + usage.
            try {
              const { data: msgRow } = await svc
                .from("messages")
                .insert({
                  conversation_id: conversationId,
                  organization_id: parsed.orgId,
                  role: "assistant",
                  modality: "text",
                  content: fullText,
                  model: QUERY_MODEL,
                  latency_ms: latencyMs,
                })
                .select("id")
                .single();
              if (msgRow?.id && !isRefusal && groundingChunks.length > 0) {
                const rows = groundingChunks
                  .map((raw) => {
                    const c = raw as {
                      retrievedContext?: {
                        title?: string;
                        text?: string;
                        pageNumber?: number;
                        customMetadata?: Array<{ key: string; stringValue?: string }>;
                      };
                    };
                    const rc = c.retrievedContext;
                    if (!rc) return null;
                    const meta = rc.customMetadata ?? [];
                    const docId =
                      meta.find((m) => m.key === "document_id")?.stringValue ?? null;
                    return {
                      message_id: msgRow.id,
                      organization_id: parsed.orgId,
                      document_id: docId,
                      source_title: rc.title ?? "Untitled source",
                      snippet: rc.text ?? null,
                      page: rc.pageNumber ?? null,
                    };
                  })
                  .filter((v): v is NonNullable<typeof v> => v !== null);
                // Dedupe by document_id (fallback source_title) + page,
                // preserving Gemini's original relevance order.
                const seen = new Set<string>();
                const deduped = rows.filter((r) => {
                  const key = `${r.document_id ?? r.source_title}|${r.page ?? ""}`;
                  if (seen.has(key)) return false;
                  seen.add(key);
                  return true;
                });
                if (deduped.length > 0) {
                  await svc.from("citations").insert(deduped);
                  send({ type: "citations", rows: deduped });
                }
              }
              await svc.rpc("record_query_usage", { p_org: parsed.orgId });
            } catch (e) {
              console.error("persist messages/citations/usage failed", e);
            }

            send({ type: "done" });
            controller.close();
          },
        });

        return new Response(stream, {
          status: 200,
          headers: {
            "content-type": "text/event-stream",
            "cache-control": "no-cache, no-transform",
            connection: "keep-alive",
          },
        });
      },
    },
  },
});