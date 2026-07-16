import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireCurrentUser } from "./session.server";
import { salniAsUser, salniService } from "./supabase.server";

/**
 * Public — returns the branding + operational flags a widget needs to render
 * for an anonymous visitor. No auth. Distinguishes genuine missing slugs from
 * Supabase/infra errors so the embed route does not surface a false 404.
 *
 * organizations has NO `branding` jsonb column — brand fields are scalars.
 * We select real columns and assemble a branding object in code for the UI.
 */
export const getEmbedOrgBySlugFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ slug: z.string().min(1).max(64) }).parse(input))
  .handler(async ({ data }) => {
    const svc = salniService();
    const { data: org, error } = await svc
      .from("organizations")
      .select(
        "id, name, slug, is_active, assistant_name, brand_color, logo_url, default_locale, allowed_domains",
      )
      .eq("slug", data.slug)
      .maybeSingle();

    if (error) {
      console.error(
        `[embed] getEmbedOrgBySlug slug=${data.slug} supabaseErr=${error.message} code=${(error as { code?: string }).code ?? ""}`,
      );
      return {
        ok: false as const,
        reason: "error" as const,
        message: error.message,
      };
    }
    if (!org) {
      console.log(`[embed] getEmbedOrgBySlug slug=${data.slug} reason=not_found`);
      return { ok: false as const, reason: "not_found" as const };
    }
    if (org.is_active === false) {
      console.log(`[embed] getEmbedOrgBySlug slug=${data.slug} reason=inactive`);
      return { ok: false as const, reason: "inactive" as const, name: org.name as string };
    }

    // Constructed in code — not a DB column.
    const branding = {
      assistant_name: (org.assistant_name as string | null) ?? null,
      brand_color: (org.brand_color as string | null) ?? null,
      logo_url: (org.logo_url as string | null) ?? null,
    };
    console.log(
      `[embed] getEmbedOrgBySlug slug=${data.slug} orgId=${org.id} ok=true`,
    );
    return {
      ok: true as const,
      org: {
        id: org.id as string,
        name: (org.name as string) ?? "Assistant",
        slug: org.slug as string,
        branding,
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