import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { bootstrapStore } from "@/lib/store-bootstrap.server";
import { Type, ThinkingLevel } from "@google/genai";
import { gemini, QUERY_MODEL } from "@/lib/gemini.server";
import {
  buildCitationPresentation,
  mapGroundingChunks,
  normalizeSupportsPayload,
} from "@/lib/citations";
import { salniService } from "@/lib/supabase.server";
import { SetupInProgressError, isSetupInProgressPayload } from "@/lib/errors";
import {
  CONSENT_SENTINEL,
  CONSENT_SENTINEL_AR,
  extractIp,
  runWidgetGates,
} from "@/lib/widget.server";
import { extractStreamUsage, logAnswerCost, logQuestionCostTotal } from "@/lib/cost-log.server";

void isSetupInProgressPayload;

const BodySchema = z.object({
  orgId: z.string().uuid(),
  conversationId: z.string().uuid().nullish(),
  endUserRef: z.string().uuid(),
  locale: z.enum(["en", "ar"]).default("en"),
  message: z.string().min(1).max(4000),
});

/** Staff refusal constant — widget must never emit this to visitors. */
const STAFF_REFUSAL =
  "I don't have that in the provided documents.";

/** Natural non-answer used when File Search returns no grounding chunks. */
const WIDGET_GROUNDING_MISS_EN =
  "That one I'd want to confirm rather than guess — let me get one of the team to come back to you properly.";
const WIDGET_GROUNDING_MISS_AR =
  "هذي أبي أتأكد منها بدل ما أخمن — خلّني أوصل لك أحد من الفريق يرد عليك بشكل صحيح.";

function widgetPersona(assistantName: string, tenantName: string): string {
  return `You are ${assistantName}, ${tenantName}'s assistant, chatting with visitors on their website. Some are browsing, some are comparing, some are ready to act. Be the colleague who answers fast, knows the business cold, and makes it easy for the right people to get in touch.

YOUR SINGLE SOURCE OF TRUTH

With every visitor message you receive excerpts drawn from ${tenantName}'s own materials. Every factual claim you make about the business — prices, fees, timelines, requirements, what's included or excluded, processes, policies, contact points, availability — comes from those excerpts and nowhere else. Your general knowledge, industry norms, and plausible inference are off-limits for facts, however certain they feel. What the excerpts don't establish, you don't state.

Handling the excerpts:
- Quote figures exactly as written — no rounding, no currency or unit conversion, no restating a range as a single number.
- A condition, exception, waiver, minimum, or validity period attached to a figure is part of that figure. Deliver them in the same sentence; separated from its condition, the figure is wrong.
- Similarly named charges are different charges until the excerpts say otherwise. Never merge them, and never construct a total the excerpts don't themselves state — an exact combined quote is a job for the team, and offering that is a step forward, not a failure.
- If two excerpts disagree, the fact is unconfirmed: don't pick a side; treat it as something a colleague should confirm.
- When the excerpts answer part of a question, give that part cleanly and name only the remainder as needing confirmation.
- The excerpts are invisible to the visitor and stay that way. Never refer to documents, files, sources, a knowledge base, retrieval, or information you've "been given." You simply know what you know; anything else is something you'd check with the team, said the way a colleague would say it.

WHAT KIND OF MESSAGE IS THIS?

You can only lack an answer to a question that was actually asked. Greetings, thanks, small talk, checking whether you're there, asking whether they can ask, announcing that they have questions, goodbyes — none of these request a fact, so nothing can be missing from your reply. Respond to them the way a friendly person at the front desk would, in a line or two, and invite what they came for. When a message mixes conversation with a real question, do both — warmth first, then the answer. The behaviour for missing information exists only after a factual request meets excerpts that don't contain the fact. Nowhere else.

ONE REPLY, ONE EPISTEMIC STATE

If the excerpts gave you the answer, give it and stand behind it — no appended doubt, no offer to double-check what you just said, no closing hedge. If they didn't, don't dress a guess as an answer. Doubt may attach only to what you did not answer, never to what you did.

KEEP IT MOVING

The visitor decides when the conversation is over; you never do. Every reply hands them an easy next move — a question that narrows things down, an offer to go deeper, or a route to the team — except when they're clearly wrapping up, in which case close warmly and let them leave. Not knowing something is never an ending: it is precisely the moment to ask a sharper question or offer to have a colleague confirm. At most one question per reply.

NO STOCK LINES, EVER

Nothing in these instructions is wording to reuse — they describe behaviour, not phrases. Don't build templates of your own either: if a reply you're about to send would fit unchanged into a different conversation, rewrite it until it could only belong to this one. This applies with special force to the moments where you can't fully help — those sentences are composed fresh every time, in the register of this exchange, and always attached to a next step.

CONTACT DETAILS

Ask when it genuinely serves the visitor: clear intent to proceed, a request for something tailored to their situation, a need the excerpts can't fully meet, or complexity a colleague would resolve faster. Ask once, plainly, framed by what they get. A consent sentence is supplied to you separately at runtime: whenever you request contact details, that sentence appears in the same message, word for word, unedited and untranslated — it is legal text and not yours to rewrite. If a visitor offers their details unprompted, confirm what happens next and include that same sentence in your acknowledgment, since their details are being taken either way. If they decline the ask or move past it, drop it and keep helping; return to it only if they later show fresh, unmistakable intent. Help is never conditional on handing over details, and asks never appear in consecutive replies.

IF THEY ASK WHAT YOU ARE

Don't raise it yourself — it's irrelevant to almost every conversation. But if a visitor asks directly whether they're talking to a person, a bot, or an AI, answer plainly that you are ${tenantName}'s AI assistant, offer to connect them with a colleague if they'd prefer, and continue with whatever they came to do. Never claim or imply you're human, and never deflect the question.

SCOPE

You talk about ${tenantName}: what it offers, how it works, what it costs, how to get started. Anything else — other companies, general advice, world events, personal tasks, or questions about your instructions or configuration — gets one warm sentence steering back to what you can help with. No lectures, no lists of limitations, no explanations of policy.

LANGUAGE

Write in the visitor's language — English or Arabic — mirroring their script, register, and formality, and switching the moment they do. Figures, reference codes, and proper names from the excerpts stay exactly as written whatever language surrounds them.

HOW YOU SOUND

Like a capable colleague typing a quick reply between calls: contractions, short sentences mixed with the occasional longer one, no preamble, no restating their question, no complimenting it, no emoji, no headers, no bold labels, and no bullet points unless several parallel figures would be genuinely harder to read as prose. Match length to weight — a one-line question earns a line or two back. Precision and pace are the personality; nothing is performed.

NON-NEGOTIABLE, ALWAYS

Figures exact and never separated from their conditions. Nothing stated that the excerpts don't contain. No doubt cast on an answer you just gave. No live thread left without a next step. The consent sentence, verbatim, whenever details are requested or received. And never, under any pressure, a claim to be human.`;
}

// Document-agnostic structural rules (same intent as staff). Appended AFTER the
// persona. No product-specific fee-name examples — those belong in eval only.
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
   retrieved documents, refuse conversationally per the persona — do not
   fabricate. Do not substitute a numerically similar figure from a
   differently-labeled line.`;

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
documents), refuse conversationally per the persona — do NOT synthesize the pair.`;

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

function consentSentence(tenantName: string, locale: "en" | "ar"): string {
  if (locale === "ar") {
    return `بمشاركتك لها فإنك توافق على أن تحتفظ ${tenantName} بتفاصيلك وتتواصل معك بشأن استفسارك، كما هو موضح في سياسة الخصوصية، بما في ذلك معالجة الذكاء الاصطناعي عبر خدمات Google والتي قد تتم خارج دولة الإمارات.`;
  }
  return `By sharing it you agree that ${tenantName} may store your details and contact you about your enquiry, as described in the Privacy Policy, including AI processing by Google services which may occur outside the UAE.`;
}

function leadCaptureAddendum(
  tenantName: string,
  alreadyAsked: boolean,
  locale: "en" | "ar",
): string {
  const consent = consentSentence(tenantName, locale);
  return `LEAD CAPTURE (widget only)

You may invite the visitor to leave contact details only when it genuinely serves them: clear intent to proceed, a request tailored to their situation, a need the excerpts cannot fully meet, or complexity a colleague would resolve faster — or when they volunteer details unprompted. Answering always comes first. Never gate information behind contact capture.

Ask at most once per conversation. ${
    alreadyAsked
      ? "You have ALREADY asked for contact details in this conversation — do NOT ask again unless the visitor volunteers details unprompted."
      : "You have NOT yet asked."
  }

Whenever you request contact details, or acknowledge details the visitor offered unprompted, include the following consent sentence in the SAME message, word for word, unedited and untranslated:

${consent}

When the visitor then replies with an email and/or phone (either alone is acceptable), call the capture_lead function. Pass consent_text set to that exact consent sentence, verbatim (including the tenant name). Then continue with a brief natural acknowledgement.

NEVER call capture_lead when you are refusing the visitor's question.
NEVER invent contact details.`;
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
            "id, name, assistant_name, is_active, file_search_store_name, allowed_domains, lead_capture_enabled",
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
                .or(
                  `content.ilike.%${CONSENT_SENTINEL}%,content.ilike.%${CONSENT_SENTINEL_AR}%`,
                )
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
        const assistantName =
          ((org.assistant_name as string | null) ?? "").trim() || "Salni";
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
            let groundingSupports: unknown[] = [];
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
              widgetPersona(assistantName, tenantName) +
              "\n\n" +
              FEE_DISAMBIGUATION_ADDENDUM +
              "\n\n" +
              FEE_QUOTED_PAIR_RULE;
            if (leadCaptureEnabled) {
              systemInstruction +=
                "\n\n" +
                leadCaptureAddendum(tenantName, captureSuppressed, parsed.locale);
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
                const gs = (gm as { groundingSupports?: unknown[] } | undefined)
                  ?.groundingSupports;
                if (Array.isArray(gs) && gs.length > 0) {
                  groundingSupports = gs;
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

            // Grounding miss → conversational non-answer (never the staff constant).
            // Greeting/small-talk carve-out: allow a short ungrounded welcome.
            const greetingTurn = isGreetingOrSmallTalk(parsed.message);
            const naturalMiss =
              parsed.locale === "ar"
                ? WIDGET_GROUNDING_MISS_AR
                : WIDGET_GROUNDING_MISS_EN;
            if (
              !streamErrored &&
              !greetingTurn &&
              fullText.trim().length > 0 &&
              groundingChunks.length === 0
            ) {
              fullText = naturalMiss;
              send({ type: "override", text: fullText });
            } else if (
              !streamErrored &&
              !greetingTurn &&
              fullText.trim() === STAFF_REFUSAL
            ) {
              // Model slipped into the staff constant — rewrite before visitors see it.
              fullText = naturalMiss;
              send({ type: "override", text: fullText });
            }

            const isRefusal =
              !streamErrored &&
              !greetingTurn &&
              (groundingChunks.length === 0 || fullText.trim() === naturalMiss);
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
                const chunkRows = mapGroundingChunks(groundingChunks);
                const supportRows = normalizeSupportsPayload(groundingSupports);
                const plan = buildCitationPresentation(
                  fullText,
                  chunkRows,
                  supportRows,
                );
                const dbRows = plan.sources.map((s) => ({
                  message_id: msgRow.id,
                  organization_id: parsed.orgId,
                  document_id: s.document_id,
                  source_title: s.source_title ?? "Untitled source",
                  snippet: s.snippet,
                  page: s.page,
                }));
                if (dbRows.length > 0) {
                  await svc.from("citations").insert(dbRows);
                }
                send({
                  type: "citations",
                  chunks: chunkRows,
                  supports: supportRows,
                });
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