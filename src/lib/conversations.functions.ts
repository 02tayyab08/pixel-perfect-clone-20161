import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireCurrentUser } from "./session.server";
import { salniAsUser } from "./supabase.server";

/**
 * Staff conversation history (read-only, DEGRADED reload).
 *
 * Both actions mirror the auth in documents.functions.ts exactly:
 *   requireCurrentUser() -> assertOrgMember() (RLS is_org_member) ->
 *   salniAsUser(accessToken) for the read.
 * The read runs as the authenticated user so RLS applies — never the
 * service role, never a public route. These are DISPLAY reads only: they
 * never call the model or re-run a query; hydration is pure display.
 *
 * Degraded scope: reloaded assistant messages are plain text
 * (messages.content) plus their citation rows (title/snippet/page/doc).
 * The inline ⟦N⟧ markers and in-snippet highlights are NOT reconstructed
 * here (they are computed live from groundingSupports, which is not
 * persisted). Exact-fidelity reload is a queued follow-up.
 */

// Identical to documents.functions.ts::assertOrgMember — kept local so the
// auth gate is verbatim the same across staff server actions.
async function assertOrgMember(userAccessToken: string, orgId: string): Promise<void> {
  const asUser = salniAsUser(userAccessToken);
  const { data, error } = await asUser.rpc("is_org_member", { p_org: orgId });
  if (error) throw new Error(`is_org_member failed: ${error.message}`);
  if (data !== true) throw new Error("Forbidden");
}

const LABEL_MAX = 60;

function deriveLabel(title: string | null, firstUserMessage: string | null): string {
  const t = (title ?? "").trim();
  if (t) return t.length > LABEL_MAX ? t.slice(0, LABEL_MAX - 1) + "…" : t;
  const m = (firstUserMessage ?? "").trim();
  if (m) return m.length > LABEL_MAX ? m.slice(0, LABEL_MAX - 1) + "…" : m;
  return "New conversation";
}

export type ConversationListItem = {
  id: string;
  label: string;
  created_at: string;
};

/**
 * Recent STAFF conversations for an org (started_by IS NOT NULL — widget
 * turns have started_by NULL and are excluded). Ordered most-recent-first
 * by created_at (conversations.last_message_at is not maintained by the
 * query path, so created_at is the reliable recency key). Labelled by title
 * if set, else the first user message, truncated.
 */
export const listConversationsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ orgId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    await assertOrgMember(user.accessToken, data.orgId);
    const asUser = salniAsUser(user.accessToken);

    const { data: convs, error } = await asUser
      .from("conversations")
      .select("id, title, created_at")
      .eq("organization_id", data.orgId)
      .not("started_by", "is", null)
      .order("created_at", { ascending: false })
      .limit(30);
    if (error) {
      return { ok: false as const, error: error.message, conversations: [] as ConversationListItem[] };
    }

    const rows = (convs ?? []) as Array<{ id: string; title: string | null; created_at: string }>;
    if (rows.length === 0) {
      return { ok: true as const, conversations: [] as ConversationListItem[] };
    }

    // One batched read for the first user message of each listed conversation
    // (avoids N+1). Ascending so the FIRST user message per conversation wins.
    const ids = rows.map((r) => r.id);
    const firstUserByConv = new Map<string, string>();
    const { data: userMsgs, error: msgErr } = await asUser
      .from("messages")
      .select("conversation_id, content, created_at")
      .in("conversation_id", ids)
      .eq("role", "user")
      .order("created_at", { ascending: true });
    if (msgErr) {
      // Non-fatal: fall back to title/placeholder labels.
      console.error("listConversationsFn: first-user-message read failed", msgErr.message);
    } else {
      for (const m of (userMsgs ?? []) as Array<{ conversation_id: string; content: string }>) {
        if (!firstUserByConv.has(m.conversation_id)) {
          firstUserByConv.set(m.conversation_id, m.content);
        }
      }
    }

    const conversations: ConversationListItem[] = rows.map((r) => ({
      id: r.id,
      label: deriveLabel(r.title, firstUserByConv.get(r.id) ?? null),
      created_at: r.created_at,
    }));
    return { ok: true as const, conversations };
  });

export type HistoryCitation = {
  source_title: string | null;
  snippet: string | null;
  page: number | null;
  document_id: string | null;
};

export type HistoryMessage = {
  id: string;
  role: string;
  content: string;
  created_at: string;
  citations: HistoryCitation[];
};

/**
 * A single conversation's messages (ordered) with their persisted citation
 * rows. Read-only display; never re-runs a query. Verifies the conversation
 * belongs to the caller's org (belt-and-suspenders on top of RLS, mirroring
 * deleteDocumentFn's ownership re-check).
 */
export const getConversationMessagesFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ orgId: z.string().uuid(), conversationId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    await assertOrgMember(user.accessToken, data.orgId);
    const asUser = salniAsUser(user.accessToken);

    // Ownership re-check: the conversation must belong to this org.
    const { data: conv, error: convErr } = await asUser
      .from("conversations")
      .select("id, organization_id")
      .eq("id", data.conversationId)
      .maybeSingle();
    if (convErr) {
      return { ok: false as const, error: `conversations.select failed: ${convErr.message}`, messages: [] as HistoryMessage[] };
    }
    if (!conv) {
      return { ok: false as const, error: "Conversation not found", messages: [] as HistoryMessage[] };
    }
    if (conv.organization_id !== data.orgId) {
      return { ok: false as const, error: "Forbidden", messages: [] as HistoryMessage[] };
    }

    const { data: msgs, error: msgErr } = await asUser
      .from("messages")
      .select("id, role, content, created_at")
      .eq("conversation_id", data.conversationId)
      .order("created_at", { ascending: true })
      .limit(500);
    if (msgErr) {
      return { ok: false as const, error: `messages.select failed: ${msgErr.message}`, messages: [] as HistoryMessage[] };
    }
    const messageRows = (msgs ?? []) as Array<{
      id: string;
      role: string;
      content: string;
      created_at: string;
    }>;
    if (messageRows.length === 0) {
      return { ok: true as const, messages: [] as HistoryMessage[] };
    }

    // Batch-load citations for these messages, ordered so the display number
    // (n) can follow insertion order on the client.
    const msgIds = messageRows.map((m) => m.id);
    const citationsByMsg = new Map<string, HistoryCitation[]>();
    const { data: cits, error: citErr } = await asUser
      .from("citations")
      .select("message_id, source_title, snippet, page, document_id, created_at")
      .in("message_id", msgIds)
      .order("created_at", { ascending: true });
    if (citErr) {
      // Non-fatal: messages still render as plain text without chips.
      console.error("getConversationMessagesFn: citations read failed", citErr.message);
    } else {
      for (const c of (cits ?? []) as Array<{
        message_id: string;
        source_title: string | null;
        snippet: string | null;
        page: number | null;
        document_id: string | null;
      }>) {
        const list = citationsByMsg.get(c.message_id) ?? [];
        list.push({
          source_title: c.source_title,
          snippet: c.snippet,
          page: c.page,
          document_id: c.document_id,
        });
        citationsByMsg.set(c.message_id, list);
      }
    }

    const messages: HistoryMessage[] = messageRows.map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      created_at: m.created_at,
      citations: citationsByMsg.get(m.id) ?? [],
    }));
    return { ok: true as const, messages };
  });
