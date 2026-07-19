import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { bootstrapStore } from "@/lib/store-bootstrap.server";
import { Type, ThinkingLevel } from "@google/genai";
import { gemini, QUERY_MODEL } from "@/lib/gemini.server";
import { salniService } from "@/lib/supabase.server";
import { SetupInProgressError, isSetupInProgressPayload } from "@/lib/errors";
import { CONSENT_SENTINEL, extractIp, runWidgetGates } from "@/lib/widget.server";
import { extractStreamUsage, logAnswerCost, logQuestionCostTotal } from "@/lib/cost-log.server";

void isSetupInProgressPayload;

const BodySchema = z.object({
  orgId: z.string().uuid(),
  conversationId: z.string().uuid().nullish(),
  endUserRef: z.string().uuid(),
  locale: z.enum(["en", "ar"]).default("en"),
  message: z.string().min(1).max(4000),
});

const NOT_IN_DOCS = "I don't have that in the provided documents.";

const FEE_DISAMBIGUATION_ADDENDUM = `FEE-SCHEDULE DISAMBIGUATION

The source documents contain multiple fee-schedule lines whose labels sound
similar but represent distinct, non-interchangeable fees. Treat each labeled
fee line as atomic. Quote the EXACT figure tied to the EXACT label; never
blend two fees; when a question could apply to more than one line, list each
applicable fee separately with its exact label and figure and one-sentence
applicability note. If the exact label the user asks about is not in the
retrieved documents, refuse using the standard refusal string.`;

function greetingCarveOut(tenantName: string): string {
  return `If the visitor sends a greeting or small talk containing no factual question, reply with one short, friendly sentence welcoming them and inviting them to ask about ${tenantName}'s services. Never use the refusal string for greetings. All factual answers remain strictly grounded in the documents — never answer a factual question from outside the documents.`;
}

/** True when the visitor message is greeting/small-talk with no factual ask. */
function isGreetingOrSmallTalk(message: string): boolean {
  const t = message.trim();
  if (!t || t.length > 80) return false;
  // Factual cues → not a greeting carve-out.
  if (/[?؟]/.test(t)) return false;
  if (
    /\b(what|what's|whats|when|where|which|who|why|how|price|cost|fee|visa|document|require|can i|do you|tell me|explain)\b/i.test(
      t,
    )
  ) {
    return false;
  }
  return /^(hi|hello|hey|yo|sup|good\s*(morning|afternoon|evening)|thanks|thank you|مرحبا|أهلا|اهلا|السلام\s*عليكم|صباح\s*الخير|مساء\s*الخير|شكرا)([\s!,.…]|$)/i.test(
    t,
  );
}

function leadCaptureAddendum(tenantName: string, alreadyAsked: boolean): string {
  return `LEAD CAPTURE (widget only)

You may OPPORTUNISTICALLY invite the visitor to leave contact details ONLY when
they show buying intent (asking about pricing for their specific case, asking
to speak with someone, requesting a follow-up) OR volunteer contact details
unprompted. Answering the visitor's question ALWAYS comes first. NEVER gate
information behind contact capture.

Ask at most ONCE per conversation. ${
    alreadyAsked
      ? "You have ALREADY asked for contact details in this conversation — do NOT ask again unless the visitor volunteers details unprompted."
      : "You have NOT yet asked."
  }

When you do ask, fold the consent notice into the SAME message using this
EXACT template (substitute {tenant name} once, keep the rest verbatim):

"Happy to have the team follow up — what's your email? By sharing it you agree that ${tenantName} may store your details and contact you about your enquiry, as described in the Privacy Policy, including AI processing by Google services which may occur outside the UAE."

When the visitor then replies with an email and/or phone (either alone is
acceptable), call the capture_lead function. Pass consent_text set to the
EXACT sentence you sent to the visitor, verbatim (including the tenant name).
Then continue the conversation with a brief natural acknowledgement.

NEVER call capture_lead when you are refusing the visitor's question (i.e.
when you would answer "${NOT_IN_DOCS}"). NEVER invent contact details.`;
}

const CAPTURE_TOOL_DECL = {
  functionDeclarations: [
    {
      name: "capture_lead",
      description:
        "Store a widget visitor's contact details after they consented in the immediately preceding assistant message. Use only when the visitor has provided at least one of email or phone.",
      parameters: {
        type: Type.OBJECT,
        properties: {
          full_name: { type: Type.STRING, description: "Visitor's name if provided" },
          email: { type: Type.STRING, description: "Visitor's email if provided" },
          phone: { type: Type.STRING, description: "Visitor's phone if provided" },
          intent_summary: {
            type: Type.STRING,
            description: "One-sentence summary of what the visitor is asking about",
          },
          consent_text: {
            type: Type.STRING,
            description:
              "The verbatim consent sentence shown to the visitor in the prior assistant message. Must be non-empty.",
          },
        },
        required: ["consent_text"],
      },
    },
  ],
};

type Part = { text?: string; thought?: boolean; functionCall?: { name?: string; args?: Record<string, unknown> } };

export const Route = createFileRoute("/api/public/widget-query")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        let parsed: z.infer<typeof BodySchema>;
        try {
          parsed = BodySchema.parse(await request.json());
        } catch (e) {
          const msg = e instanceof z.ZodError ? JSON.stringify(e.issues) : String(e);
          return new Response(`Bad Request: ${msg}`, { status: 400 });
        }

        const svc = salniService();
        const { data: org, error: orgErr } = await svc
          .from("organizations")
          .select(
            "id, name, is_active, system_instruction, file_search_store_name, allowed_domains, lead_capture_enabled",
          )
          .eq("id", parsed.orgId)
          .maybeSingle();
        if (orgErr || !org) return new Response("Not Found", { status: 404 });

        const leadCaptureEnabled = org.lead_capture_enabled !== false;

        console.log(
          `[widget-query] gate inputs orgId=${parsed.orgId} endUserRef=${JSON.stringify(parsed.endUserRef)} ` +
            `origin=${JSON.stringify(request.headers.get("origin"))} ` +
            `allowedDomains=${JSON.stringify(org.allowed_domains)} ` +
            `is_active=${org.is_active}`,
        );

        // MANDATORY gates BEFORE any Gemini spend.
        const gate = await runWidgetGates({
          orgId: parsed.orgId,
          isActive: org.is_active !== false,
          allowedDomains: (org.allowed_domains as string[] | null) ?? null,
          originHeader: request.headers.get("origin"),
          endUserRef: parsed.endUserRef,
          ip: extractIp(request.headers),
        });
        if (!gate.ok) {
          console.error(
            `[widget-query] gate FAILED reason=${gate.reason} status=${gate.status} message=${gate.message}`,
          );
          return new Response(gate.message, { status: gate.status });
        }
        console.log(`[widget-query] gate PASSED orgId=${parsed.orgId}`);

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
          const msg = e instanceof Error ? e.message : String(e);
          return new Response(`bootstrapStore failed: ${msg}`, { status: 500 });
        }

        // Ensure a conversation exists. Widget traffic is identified by
        // started_by IS NULL + end_user_ref. Channel enum is ('text','voice').
        let conversationId = parsed.conversationId ?? null;
        let alreadyAskedLead = false;
        let alreadyHasLead = false;

        if (conversationId) {
          if (leadCaptureEnabled) {
            // Detect prior consent ask + prior lead.
            const [{ data: prior }, { data: existingLead }] = await Promise.all([
              svc
                .from("messages")
                .select("id")
                .eq("conversation_id", conversationId)
                .eq("role", "assistant")
                .ilike("content", `%${CONSENT_SENTINEL}%`)
                .limit(1),
              svc
                .from("leads")
                .select("id")
                .eq("conversation_id", conversationId)
                .limit(1),
            ]);
            alreadyAskedLead = (prior?.length ?? 0) > 0;
            alreadyHasLead = (existingLead?.length ?? 0) > 0;
          }
        } else {
          const { data: conv, error: convErr } = await svc
            .from("conversations")
            .insert({
              organization_id: parsed.orgId,
              channel: "text",
              started_by: null,
              end_user_ref: parsed.endUserRef,
            })
            .select("id")
            .single();
          console.log(
            `[widget-query] conversations.insert channel=text endUserRef=${parsed.endUserRef} err=${convErr?.message ?? "null"} id=${conv?.id ?? "null"}`,
          );
          if (convErr) {
            return new Response(`conversations.insert failed: ${convErr.message}`, { status: 500 });
          }
          conversationId = conv.id as string;
        }

        // Persist user message.
        await svc.from("messages").insert({
          conversation_id: conversationId,
          organization_id: parsed.orgId,
          role: "user",
          modality: "text",
          content: parsed.message,
        });

        const tenantName = (org.name as string) || "the team";
        const captureSuppressed = alreadyHasLead || alreadyAskedLead;

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
            let capturedCall: { name: string; args: Record<string, unknown> } | null = null;

            const tools: Array<
              | { fileSearch: { fileSearchStoreNames: string[]; metadataFilter: string } }
              | typeof CAPTURE_TOOL_DECL
            > = [
              {
                fileSearch: {
                  fileSearchStoreNames: [storeName],
                  metadataFilter: `org_id="${org.id}"`,
                },
              },
            ];
            if (leadCaptureEnabled) {
              tools.push(CAPTURE_TOOL_DECL);
            }
            console.log(
              `[widget-query] leadCaptureEnabled=${leadCaptureEnabled} tools=${JSON.stringify(
                tools.map((t) =>
                  "fileSearch" in t
                    ? { fileSearch: { store: storeName, filter: `org_id="${org.id}"` } }
                    : {
                        functionDeclarations: (
                          t as { functionDeclarations?: Array<{ name?: string }> }
                        ).functionDeclarations?.map((d) => d.name),
                      },
                ),
              )}`,
            );

            const localeNote =
              parsed.locale === "ar"
                ? "\n\nRespond in Arabic (the visitor is using the Arabic UI)."
                : "";

            let systemInstruction =
              (org.system_instruction ||
                `You answer strictly from the provided documents. If the answer is not in them, reply exactly: "${NOT_IN_DOCS}"`) +
              "\n\n" +
              greetingCarveOut(tenantName) +
              "\n\n" +
              FEE_DISAMBIGUATION_ADDENDUM;
            if (leadCaptureEnabled) {
              systemInstruction +=
                "\n\n" + leadCaptureAddendum(tenantName, captureSuppressed);
            }
            systemInstruction += localeNote;

            let sawFunctionCall = false;
            const thinkingLevelInEffect = ThinkingLevel.MEDIUM;
            let lastUsageMeta: unknown = undefined;
            try {
              const ai = gemini();
              const iter = await ai.models.generateContentStream({
                model: QUERY_MODEL,
                contents: parsed.message,
                config: {
                  systemInstruction,
                  tools,
                  // Required by Gemini 3.x when combining File Search (built-in)
                  // with client functionDeclarations (capture_lead). Widget-only —
                  // staff /api/query never declares capture_lead and must not set this.
                  toolConfig: { includeServerSideToolInvocations: true },
                  // Do NOT set thinkingBudget alongside thinkingLevel (that 400s).
                  thinkingConfig: {
                    includeThoughts: false,
                    thinkingLevel: ThinkingLevel.MEDIUM,
                  },
                },
              });

              for await (const chunk of iter) {
                if (chunk.usageMetadata) lastUsageMeta = chunk.usageMetadata;
                const parts = (chunk.candidates?.[0]?.content?.parts ?? []) as Part[];
                for (const part of parts) {
                  if (part.thought) continue;
                  if (part.functionCall) {
                    sawFunctionCall = true;
                    console.log(
                      `[widget-query] functionCall name=${part.functionCall.name ?? "(unknown)"}`,
                    );
                    if (part.functionCall.name === "capture_lead") {
                      capturedCall = {
                        name: "capture_lead",
                        args: part.functionCall.args ?? {},
                      };
                    }
                    continue;
                  }
                  const text = part.text ?? "";
                  if (!text) continue;
                  fullText += text;
                  send({ type: "delta", text });
                }
                const gm = chunk.candidates?.[0]?.groundingMetadata;
                if (gm?.groundingChunks && gm.groundingChunks.length > 0) {
                  groundingChunks = gm.groundingChunks;
                }
              }
              console.log(
                `[widget-query] stream done sawFunctionCall=${sawFunctionCall} capturedLead=${!!capturedCall}`,
              );
              const answerCost = logAnswerCost({
                call: "answer",
                model: QUERY_MODEL,
                thinkingLevel: thinkingLevelInEffect,
                usage: extractStreamUsage(lastUsageMeta),
                groundingChunks: groundingChunks.length,
                latencyMs: Date.now() - startedAt,
              });
              logQuestionCostTotal({
                path: "widget",
                parts: [answerCost],
                latencyMs: Date.now() - startedAt,
              });
            } catch (e) {
              const err = e as {
                name?: string;
                message?: string;
                status?: number;
                code?: string | number;
                error?: unknown;
                response?: unknown;
                cause?: unknown;
              };
              console.error(
                `[widget-query] generateContentStream failed model=${QUERY_MODEL} status=${err?.status} code=${err?.code ?? ""} name=${err?.name} message=${err?.message}`,
              );
              console.error(
                `[widget-query] generateContentStream raw=${(() => {
                  try {
                    return JSON.stringify(e);
                  } catch {
                    return String(e);
                  }
                })()}`,
              );
              console.error(
                `[widget-query] toolsAtFailure=${JSON.stringify(tools)} channelInserted=text`,
              );
              streamErrored = true;
              const status = err?.status;
              const userMsg =
                status === 429
                  ? "The assistant is temporarily rate limited. Please try again in a moment."
                  : status === 402
                    ? "The assistant is temporarily unavailable."
                    : "The assistant hit an unexpected error. Please try again.";
              send({ type: "error", message: userMsg });
            }

            // Grounding miss → override with refusal string.
            // Greeting/small-talk carve-out: allow a short ungrounded welcome.
            const greetingTurn = isGreetingOrSmallTalk(parsed.message);
            if (
              !streamErrored &&
              !greetingTurn &&
              fullText.trim().length > 0 &&
              groundingChunks.length === 0
            ) {
              fullText = NOT_IN_DOCS;
              send({ type: "override", text: fullText });
            }

            const isRefusal =
              !streamErrored &&
              !greetingTurn &&
              (fullText.trim() === NOT_IN_DOCS || groundingChunks.length === 0);
            send({ type: "meta", isRefusal });

            // REFUSAL GUARD: drop any pending capture on a refusal.
            if (isRefusal) capturedCall = null;

            const latencyMs = Date.now() - startedAt;

            // Persist assistant message + citations + usage.
            try {
              if (streamErrored) {
                send({ type: "done" });
                controller.close();
                return;
              }
              const { data: msgRow, error: msgErr } = await svc
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

              console.log(
                `[widget-query] persist assistant msgId=${msgRow?.id ?? "null"} convId=${conversationId} endUserRef=${parsed.endUserRef} err=${msgErr?.message ?? "null"}`,
              );

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
                    const docId = meta.find((m) => m.key === "document_id")?.stringValue ?? null;
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

              // Per-answered-turn usage record.
              await svc.rpc("record_query_usage", { p_org: parsed.orgId });

              // Lead capture — only when enabled and after refusal guard cleared it.
              if (leadCaptureEnabled && capturedCall && !alreadyHasLead) {
                const args = capturedCall.args as {
                  full_name?: string;
                  email?: string;
                  phone?: string;
                  intent_summary?: string;
                  consent_text?: string;
                };
                const email = (args.email ?? "").trim() || null;
                const phone = (args.phone ?? "").trim() || null;
                const consentText = (args.consent_text ?? "").trim();

                if ((email || phone) && consentText.length > 0) {
                  const ip = extractIp(request.headers) || null;
                  const params = {
                    p_org: parsed.orgId,
                    p_conversation: conversationId,
                    p_full_name: (args.full_name ?? "").trim() || null,
                    p_email: email,
                    p_phone: phone,
                    p_company: null as string | null,
                    p_notes: (args.intent_summary ?? "").trim() || null,
                    p_consent_text: consentText,
                    p_ip: ip,
                  };
                  let { error: leadErr } = await svc.rpc("upsert_lead", params);
                  if (leadErr && (leadErr as { code?: string }).code === "23505") {
                    ({ error: leadErr } = await svc.rpc("upsert_lead", params));
                  }
                  if (leadErr) {
                    console.error("[widget-query] upsert_lead failed", leadErr);
                  } else {
                    send({ type: "lead_captured" });
                  }
                } else {
                  console.log(
                    "[widget-query] capture_lead dropped: missing contact or consent",
                  );
                }
              }
            } catch (e) {
              const errMsg = e instanceof Error ? e.message : String(e);
              console.error(
                `[widget-query] persist assistant msgId=null convId=${conversationId} endUserRef=${parsed.endUserRef} err=${errMsg}`,
              );
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
            "access-control-allow-origin": request.headers.get("origin") ?? "*",
            "access-control-allow-credentials": "true",
            vary: "Origin",
          },
        });
      },
      OPTIONS: async ({ request }) =>
        new Response(null, {
          status: 204,
          headers: {
            "access-control-allow-origin": request.headers.get("origin") ?? "*",
            "access-control-allow-methods": "POST, OPTIONS",
            "access-control-allow-headers": "content-type",
            "access-control-allow-credentials": "true",
            "access-control-max-age": "86400",
            vary: "Origin",
          },
        }),
    },
  },
});