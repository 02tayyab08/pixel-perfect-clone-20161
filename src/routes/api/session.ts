import { createFileRoute } from "@tanstack/react-router";
import { getCurrentUser, getSessionOrgs } from "@/lib/session.server";
import { salniAsUser } from "@/lib/supabase.server";

export const Route = createFileRoute("/api/session")({
  server: {
    handlers: {
      GET: async () => {
        const user = await getCurrentUser();
        if (!user) {
          return Response.json({ userId: null, email: null, orgs: [] }, { status: 401 });
        }

        const asUser = salniAsUser(user.accessToken);
        const { data, error } = await asUser
          .from("organization_members")
          .select("role, organization_id, org:organizations(id, name, slug)")
          .eq("user_id", user.userId);

        if (error) {
          console.error("/api/session orgs read failed", {
            code: (error as { code?: string }).code,
            message: error.message,
            details: (error as { details?: string }).details,
            hint: (error as { hint?: string }).hint,
          });
          return Response.json({
            userId: user.userId,
            email: user.email,
            orgs: getSessionOrgs(),
          });
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