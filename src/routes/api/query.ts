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

// Appended to every org's system_instruction (or to the strict-grounding
// fallback when the org hasn't set one). Kept in code so revisions apply to
// every org — existing and future — without a data migration and without
// drift between org rows.
const FEE_DISAMBIGUATION_ADDENDUM = `FEE-SCHEDULE DISAMBIGUATION

The source documents contain multiple fee-schedule lines whose labels sound
similar but represent distinct, non-interchangeable fees. Treat each labeled
fee line as atomic. When answering any question that touches a fee:

1. Quote the EXACT figure tied to the EXACT label as it appears in the source
   documents. Do not paraphrase the label, do not round or average the figure,
   and do not merge a value from one labeled line onto a different label.

2. If a question could involve more than one fee line, list each applicable
   fee separately by its exact label and figure, and state in one sentence
   why that fee applies to the user's situation. Never silently pick one
   fee over another, and never blend two fees into a single range.

3. Distinguish "cost of having N of something" from "cost of changing what
   you have". The first is a per-item add-on that scales with N. The second
   is a flat amendment/processing fee charged once per change request,
   regardless of how many items are being changed. If a user's question
   could be read either way, list both fees in the same answer with the
   exact label and figure for each, and briefly note the condition under
   which each one applies, so the user can identify which fee fits their
   situation.

4. If two similarly-worded lines appear in the same retrieved passage
   (for example one labeled as an add-on and one labeled as an amendment),
   and the user's question does not unambiguously identify which line is
   being asked about, the default behavior is to quote BOTH lines verbatim
   with their exact labels and figures and state that the user should
   clarify which one they mean. Do not pick the closer wording match as a
   silent default. Do not choose between them on the model's own judgment.

5. If the exact label the user is asking about does not appear in the
   retrieved documents, refuse using the standard refusal string. Do not
   substitute a numerically similar figure from a differently-labeled line.`;

// Extra rule specifically defending against silent label/figure swaps in
// comparison/arithmetic questions. Kept as its own block so it's visually
// obvious in prompt reviews and easy to revise without disturbing rules 1–5.
const FEE_QUOTED_PAIR_RULE = `FEE COMPARISON — QUOTED PAIR PROTOCOL

Before performing ANY comparison, subtraction, addition, ratio, or table
construction that involves two or more fee lines, you MUST first write each
fee as a literal quoted pair on its own line, in the form:

  "<Exact Label From Source>" = <Exact Figure From Source>

Emit every quoted pair BEFORE any comparison prose, table header, or
arithmetic. Do not paraphrase the label or reformat the figure inside the
quoted pair. Only after all quoted pairs have been emitted may you produce
the comparison, difference, or table. If you cannot produce a quoted pair
for a fee line (label or figure not present verbatim in the retrieved
documents), refuse per rule 5 above — do NOT synthesize the pair.`;

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
            let groundingSupportsLen = 0;
            let groundingSupportsSample: unknown = undefined;
            let streamErrored = false;

            try {
              const ai = gemini();
              // [query-diag-ping]: gated off by default. Only enable when
              // explicitly needed for upstream HTTP diagnostics; otherwise it
              // doubles Gemini calls per question in production.
              const DIAG_PING = process.env.QUERY_DIAG_PING === "true";
              if (DIAG_PING) {
                try {
                  const pingStart = Date.now();
                  const pingRes = await ai.models.generateContent({
                    model: QUERY_MODEL,
                    contents: "ping",
                  });
                  const pingText = (pingRes as { text?: string }).text ?? "";
                  console.log(
                    `[query-diag-ping] ok latency=${Date.now() - pingStart}ms textLen=${pingText.length}`,
                  );
                } catch (pe) {
                  const err = pe as {
                    name?: string;
                    message?: string;
                    status?: number;
                    code?: number | string;
                  };
                  let dump = "";
                  try {
                    dump = JSON.stringify(pe, Object.getOwnPropertyNames(pe)).slice(
                      0,
                      4000,
                    );
                  } catch {
                    dump = String(pe).slice(0, 4000);
                  }
                  console.error(
                    `[query-diag-ping] failed name=${err?.name} status=${err?.status} code=${err?.code} message=${err?.message}`,
                  );
                  console.error(`[query-diag-ping] raw=${dump}`);
                }
              }
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
                    (org.system_instruction ||
                      "You answer strictly from the provided documents. If the answer is not in them, reply exactly: \"" +
                        NOT_IN_DOCS +
                        "\"") +
                    "\n\n" +
                    FEE_DISAMBIGUATION_ADDENDUM +
                    "\n\n" +
                    FEE_QUOTED_PAIR_RULE,
                  tools: toolsPayload,
                  thinkingConfig: {
                    // Keep reasoning internal. Do NOT set thinkingBudget: 0 —
                    // fee-disambiguation quality benefits from reasoning; we
                    // only want it kept off the wire.
                    includeThoughts: false,
                  },
                },
              });

              // Diagnostic counters for the (D) long-generation duplication
              // investigation. Logs per-chunk part flags (thought/text length)
              // and candidate count so we can tell whether a duplicated table
              // is a leaked thought, a second candidate, or an actual
              // model-side regeneration in the primary stream.
              let chunkIdx = 0;
              let sawMultiCandidate = false;
              let sawThoughtPart = false;
              let thoughtCharsDropped = 0;
              let textParts = 0;
              for await (const chunk of iter) {
                const candCount = chunk.candidates?.length ?? 0;
                if (candCount > 1) sawMultiCandidate = true;
                // Per-part iteration (not chunk.text) so we can drop any part
                // flagged as reasoning/thought regardless of thinkingConfig or
                // SDK aggregate-getter behavior.
                const parts = chunk.candidates?.[0]?.content?.parts ?? [];
                if (chunkIdx < 5 || chunkIdx % 20 === 0) {
                  try {
                    const shape = parts.map((p) => ({
                      thought: (p as { thought?: boolean }).thought === true,
                      len: ((p as { text?: string }).text ?? "").length,
                    }));
                    console.log(
                      `[query-parts] chunk=${chunkIdx} cands=${candCount} parts=${JSON.stringify(shape)}`,
                    );
                  } catch {
                    /* ignore */
                  }
                }
                for (const part of parts) {
                  if ((part as { thought?: boolean }).thought) {
                    sawThoughtPart = true;
                    thoughtCharsDropped +=
                      ((part as { text?: string }).text ?? "").length;
                    continue;
                  }
                  const text = (part as { text?: string }).text ?? "";
                  if (!text) continue;
                  textParts += 1;
                  fullText += text;
                  send({ type: "delta", text });
                }
                chunkIdx += 1;
                const cand = chunk.candidates?.[0];
                const gm = cand?.groundingMetadata;
                if (gm?.groundingChunks && gm.groundingChunks.length > 0) {
                  groundingChunks = gm.groundingChunks;
                }
                const gs = (gm as { groundingSupports?: unknown[] } | undefined)
                  ?.groundingSupports;
                if (Array.isArray(gs) && gs.length > groundingSupportsLen) {
                  groundingSupportsLen = gs.length;
                  groundingSupportsSample = gs[0];
                }
              }
              console.log(
                `[query-parts-summary] chunks=${chunkIdx} textParts=${textParts} multiCandidate=${sawMultiCandidate} thoughtPartSeen=${sawThoughtPart} thoughtCharsDropped=${thoughtCharsDropped} fullTextLen=${fullText.length}`,
              );
            } catch (e) {
              const err = e as {
                name?: string;
                message?: string;
                status?: number;
                code?: number | string;
              };
              let dump = "";
              try {
                dump = JSON.stringify(e, Object.getOwnPropertyNames(e)).slice(0, 4000);
              } catch {
                dump = String(e).slice(0, 4000);
              }
              console.error(
                `gemini.generateContentStream failed name=${err?.name} status=${err?.status} code=${err?.code} message=${err?.message}`,
              );
              console.error(`gemini.generateContentStream raw=${dump}`);
              streamErrored = true;
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
              `[query] grounding=${groundingChunks.length} supports=${groundingSupportsLen} refusal=${isRefusal} errored=${streamErrored} latency=${latencyMs}ms`,
            );
            if (groundingSupportsLen > 0) {
              try {
                console.log(
                  `[query-supports] sample=${JSON.stringify(groundingSupportsSample).slice(0, 800)}`,
                );
              } catch {
                /* ignore */
              }
            }

            // Persist assistant message + citations + usage.
            try {
              if (streamErrored) {
                // Don't persist a phantom assistant turn on infra errors.
                send({ type: "done" });
                controller.close();
                return;
              }
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