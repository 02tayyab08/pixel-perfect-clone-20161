import { createServerFn } from "@tanstack/react-start";
import { getCurrentUser } from "./session.server";
import { salniService } from "./supabase.server";

export type SessionSummary = {
  user: { id: string; email: string | null } | null;
  orgs: Array<{ id: string; name: string; slug: string; role: string }>;
};

export const getSessionFn = createServerFn({ method: "GET" }).handler(
  async (): Promise<SessionSummary> => {
    const user = await getCurrentUser();
    if (!user) return { user: null, orgs: [] };

    const svc = salniService();
    // Read the user's org memberships via service role (schema-authoritative table names
    // from V2.1: `organization_members(user_id, org_id, role)` joined to `organizations`).
    const { data, error } = await svc
      .from("organization_members")
      .select("role, org:organizations(id, name, slug)")
      .eq("user_id", user.userId);
    // schema: organization_members(organization_id, user_id, role) — join alias 'org' works via FK.

    if (error) {
      console.error("getSessionFn: failed to load orgs", error);
      return { user: { id: user.userId, email: user.email }, orgs: [] };
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