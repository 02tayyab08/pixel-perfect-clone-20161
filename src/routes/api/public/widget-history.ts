import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { salniService } from "@/lib/supabase.server";

const QuerySchema = z.object({
  orgId: z.string().uuid(),
  endUserRef: z.string().uuid(),
});

/**
 * Public — returns the most recent widget conversation for an end_user_ref
 * so the widget can rehydrate on page reload. Service role bypasses RLS;
 * results are scoped by (orgId, endUserRef) which is unguessable.
 */
export const Route = createFileRoute("/api/public/widget-history")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const url = new URL(request.url);
        const parsed = QuerySchema.safeParse({
          orgId: url.searchParams.get("orgId"),
          endUserRef: url.searchParams.get("endUserRef"),
        });
        if (!parsed.success) return new Response("Bad Request", { status: 400 });

        const svc = salniService();
        const { data: convs, error: convErr } = await svc
          .from("conversations")
          .select("id, created_at")
          .eq("organization_id", parsed.data.orgId)
          .eq("end_user_ref", parsed.data.endUserRef)
          .is("started_by", null)
          .order("created_at", { ascending: false })
          .limit(1);
        if (convErr) return new Response(convErr.message, { status: 500 });

        const conv = convs?.[0];
        if (!conv) {
          return Response.json({ conversationId: null, messages: [] });
        }

        const { data: msgs } = await svc
          .from("messages")
          .select("id, role, content, created_at")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: true })
          .limit(200);

        return Response.json(
          { conversationId: conv.id, messages: msgs ?? [] },
          {
            headers: {
              "access-control-allow-origin": request.headers.get("origin") ?? "*",
              vary: "Origin",
            },
          },
        );
      },
    },
  },
});