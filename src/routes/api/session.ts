import { createFileRoute } from "@tanstack/react-router";
import { getCurrentUser } from "@/lib/session.server";
import { salniService } from "@/lib/supabase.server";

export const Route = createFileRoute("/api/session")({
  server: {
    handlers: {
      GET: async () => {
        const user = await getCurrentUser();
        if (!user) {
          return Response.json({ userId: null, email: null, orgs: [] }, { status: 401 });
        }

        const svc = salniService();
        const { data, error } = await svc
          .from("organization_members")
          .select("role, org:organizations(id, name, slug)")
          .eq("user_id", user.userId);

        if (error) {
          console.error("/api/session: failed to load orgs", error);
          return Response.json({ userId: user.userId, email: user.email, orgs: [] });
        }

        const orgs = (data ?? [])
          .map((row) => {
            const raw = row as {
              role: string;
              org:
                | { id: string; name: string; slug: string }
                | Array<{ id: string; name: string; slug: string }>
                | null;
            };
            const org = Array.isArray(raw.org) ? raw.org[0] : raw.org;
            return org ? { id: org.id, name: org.name, slug: org.slug, role: raw.role } : null;
          })
          .filter((v): v is { id: string; name: string; slug: string; role: string } => v !== null);

        return Response.json({ userId: user.userId, email: user.email, orgs });
      },
    },
  },
});