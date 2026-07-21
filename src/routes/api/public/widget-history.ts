import { createFileRoute } from "@tanstack/react-router";
import { z } from "zod";
import { salniService } from "@/lib/supabase.server";
import { extractIp, runWidgetGates } from "@/lib/widget.server";

const BodySchema = z.object({
  slug: z.string().min(1).max(64),
  endUserRef: z.string().uuid(),
});

/**
 * Public — returns the most recent widget conversation for an end_user_ref
 * so the widget can rehydrate on page reload. Service role bypasses RLS;
 * results are scoped by (resolved org.id, endUserRef).
 *
 * Gate order (before any conversation read):
 *   resolve org by slug → is_active → Origin → IP rate
 * (ref + org-hourly spend gates are skipped via skipRefAndHourly).
 */
export const Route = createFileRoute("/api/public/widget-history")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        // a. Parse and validate input.
        let parsed: z.infer<typeof BodySchema>;
        try {
          parsed = BodySchema.parse(await request.json());
        } catch (e) {
          const msg = e instanceof z.ZodError ? JSON.stringify(e.issues) : String(e);
          return new Response(`Bad Request: ${msg}`, { status: 400 });
        }

        const svc = salniService();

        // b. Resolve organization by slug. Not found → 404. Nothing else before this.
        const { data: org, error: orgErr } = await svc
          .from("organizations")
          .select("id, is_active, allowed_domains")
          .eq("slug", parsed.slug)
          .maybeSingle();
        if (orgErr || !org) return new Response("Not Found", { status: 404 });

        // c. Gates on the resolved org (is_active → Origin → IP). No conversation read yet.
        const gate = await runWidgetGates({
          orgId: org.id,
          isActive: org.is_active !== false,
          allowedDomains: (org.allowed_domains as string[] | null) ?? null,
          originHeader: request.headers.get("origin"),
          endUserRef: parsed.endUserRef,
          ip: extractIp(request.headers),
          skipRefAndHourly: true,
        });
        if (!gate.ok) {
          console.error(
            `[widget-history] gate FAILED reason=${gate.reason} status=${gate.status} message=${gate.message}`,
          );
          return new Response(gate.message, { status: gate.status });
        }

        // d. ONLY after gates pass: read conversations and messages.
        const { data: convs, error: convErr } = await svc
          .from("conversations")
          .select("id, created_at")
          .eq("organization_id", org.id)
          .eq("end_user_ref", parsed.endUserRef)
          .is("started_by", null)
          .order("created_at", { ascending: false })
          .limit(1);
        if (convErr) return new Response(convErr.message, { status: 500 });

        const conv = convs?.[0];
        if (!conv) {
          console.log(
            `[widget-history] orgId=${org.id} endUserRef=${parsed.endUserRef} convFound=false msgCount=0`,
          );
          return Response.json({ conversationId: null, messages: [] });
        }

        const { data: msgs } = await svc
          .from("messages")
          .select("id, role, content, created_at")
          .eq("conversation_id", conv.id)
          .order("created_at", { ascending: true })
          .limit(200);

        const messages = msgs ?? [];
        console.log(
          `[widget-history] orgId=${org.id} endUserRef=${parsed.endUserRef} convFound=true msgCount=${messages.length}`,
        );

        return Response.json(
          { conversationId: conv.id, messages },
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
