import { createServerFn } from "@tanstack/react-start";
import { getCurrentUser, getSessionOrgs } from "./session.server";
import { salniAsUser } from "./supabase.server";

export type SessionSummary = {
  user: { id: string; email: string | null } | null;
  orgs: Array<{ id: string; name: string; slug: string; role: string }>;
};

export const getSessionFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionSummary> => {
    const user = await getCurrentUser();
    if (!user) return { user: null, orgs: [] };

    // Read as the authenticated user so RLS applies and Data API grant issues
    // surface loudly instead of being masked by the service role.
    const asUser = salniAsUser(user.accessToken);
    const { data, error } = await asUser
      .from("organization_members")
      .select("role, organization_id, org:organizations(id, name, slug)")
      .eq("user_id", user.userId);

    if (error) {
      console.error("getSessionFn orgs read failed", {
        code: (error as { code?: string }).code,
        message: error.message,
        details: (error as { details?: string }).details,
        hint: (error as { hint?: string }).hint,
      });
      // Only fall back to cookie-cached orgs when the read errored — an empty
      // successful read means the user genuinely has no memberships.
      return { user: { id: user.userId, email: user.email }, orgs: getSessionOrgs() };
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
      .filter((v): v is NonNullable<typeof v> => v !== null);

    return { user: { id: user.userId, email: user.email }, orgs };
  },
);