import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireCurrentUser } from "./session.server";
import { salniAsUser, salniService } from "./supabase.server";

/**
 * Public — returns the branding + operational flags a widget needs to render
 * for an anonymous visitor. No auth. Returns null when the org doesn't exist
 * or is disabled, so the embed route can render a friendly unavailable state.
 */
export const getEmbedOrgBySlugFn = createServerFn({ method: "GET" })
  .inputValidator((input: unknown) => z.object({ slug: z.string().min(1).max(64) }).parse(input))
  .handler(async ({ data }) => {
    const svc = salniService();
    const { data: org, error } = await svc
      .from("organizations")
      .select("id, name, slug, is_active, branding, allowed_domains, default_locale")
      .eq("slug", data.slug)
      .maybeSingle();
    if (error || !org) return { ok: false as const, reason: "not_found" as const };
    if (org.is_active === false) {
      return { ok: false as const, reason: "inactive" as const, name: org.name };
    }
    return {
      ok: true as const,
      org: {
        id: org.id as string,
        name: (org.name as string) ?? "Assistant",
        slug: org.slug as string,
        branding: (org.branding as Record<string, unknown> | null) ?? null,
        allowedDomains: (org.allowed_domains as string[] | null) ?? null,
        defaultLocale: (org.default_locale as string | null) ?? "en",
      },
    };
  });

const LeadStatus = z.enum(["new", "qualified", "contacted", "converted", "archived"]);

/** Authenticated — list leads for an org (dashboard view). */
export const listLeadsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ orgId: z.string().uuid(), status: LeadStatus.nullish() })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    const asUser = salniAsUser(user.accessToken);
    const { data: ok, error: mErr } = await asUser.rpc("is_org_member", { p_org: data.orgId });
    if (mErr || ok !== true) throw new Error("Forbidden");

    const svc = salniService();
    let q = svc
      .from("leads")
      .select(
        "id, created_at, updated_at, status, full_name, email, phone, company, notes, consent_text, consent_at, ip, conversation_id",
      )
      .eq("organization_id", data.orgId)
      .order("created_at", { ascending: false })
      .limit(500);
    if (data.status) q = q.eq("status", data.status);
    const { data: rows, error } = await q;
    if (error) throw new Error(error.message);
    return { leads: rows ?? [] };
  });

/** Authenticated — update lead pipeline stage. */
export const updateLeadStatusFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z
      .object({ orgId: z.string().uuid(), leadId: z.string().uuid(), status: LeadStatus })
      .parse(input),
  )
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    const asUser = salniAsUser(user.accessToken);
    const { data: ok, error: mErr } = await asUser.rpc("is_org_member", { p_org: data.orgId });
    if (mErr || ok !== true) throw new Error("Forbidden");

    const svc = salniService();
    const { error } = await svc
      .from("leads")
      .update({ status: data.status })
      .eq("id", data.leadId)
      .eq("organization_id", data.orgId);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  });