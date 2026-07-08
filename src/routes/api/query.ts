import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { getCurrentUser } from "@/lib/session.server";
import { salniService, salniAsUser } from "@/lib/supabase.server";
import { bootstrapStore } from "@/lib/store-bootstrap.server";
import { gemini, QUERY_MODEL } from "@/lib/gemini.server";
import { SetupInProgressError, isSetupInProgressPayload } from "@/lib/errors";

const BodySchema = z.object({
  orgId: z.string().uuid(),
  conversationId: z.string().uuid().optional(),
  message: z.string().min(1).max(4000),
});

const NOT_IN_DOCS = "I don't have that in the provided documents.";

void isSetupInProgressPayload; // exported for client consumers of /api/query

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
          return new Response("Bad Request", { status: 400 });
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

            try {
              const ai = gemini();
              const iter = await ai.models.generateContentStream({
                model: QUERY_MODEL,
                contents: parsed.message,
                config: {
                  systemInstruction:
                    org.system_instruction ||
                    "You answer strictly from the provided documents. If the answer is not in them, reply exactly: \"" +
                      NOT_IN_DOCS +
                      "\"",
                  tools: [
                    {
                      fileSearch: {
                        fileSearchStoreNames: [storeName],
                        // SECURITY INVARIANT: server-resolved uuid, not client input.
                        metadataFilter: `org_id="${org.id}"`,
                      },
                    },
                  ],
                },
              });

              for await (const chunk of iter) {
                const text = chunk.text ?? "";
                if (text) {
                  fullText += text;
                  send({ type: "delta", text });
                }
                const gm = chunk.candidates?.[0]?.groundingMetadata;
                if (gm?.groundingChunks) groundingChunks = gm.groundingChunks;
              }
            } catch (e) {
              console.error("gemini.generateContentStream failed (raw)", e);
              const err = e as { name?: string; message?: string; status?: number };
              const raw = [err?.name, err?.status, err?.message]
                .filter(Boolean)
                .join(" | ");
              const msg = `gemini.generateContentStream failed: ${raw || "unknown"}`;
              send({ type: "error", message: msg });
              send({ type: "delta", text: msg });
              fullText = msg;
            }

            const latencyMs = Date.now() - startedAt;

            // Grounding miss → override with the canonical string.
            if (fullText.trim().length > 0 && groundingChunks.length === 0) {
              fullText = NOT_IN_DOCS;
              send({ type: "override", text: fullText });
            }

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
              if (msgRow?.id && groundingChunks.length > 0) {
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
                if (rows.length > 0) {
                  await svc.from("citations").insert(rows);
                  send({ type: "citations", rows });
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