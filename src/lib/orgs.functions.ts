import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireCurrentUser } from "./session.server";
import { salniAsUser, salniService } from "./supabase.server";

const SlugSchema = z
  .string()
  .min(2)
  .max(48)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "Slug must be lowercase letters, numbers, or dashes");

const CreateOrgSchema = z.object({
  name: z.string().min(2).max(80),
  slug: SlugSchema,
});

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

async function suggestAlternateSlugs(base: string, take = 5): Promise<string[]> {
  const svc = salniService();
  const cleanBase = base.replace(/-\d+$/, "");
  const candidates: string[] = [];
  let i = 2;
  while (candidates.length < take) {
    const candidate = `${cleanBase}-${i++}`;
    const { data } = await svc
      .from("organizations")
      .select("id")
      .eq("slug", candidate)
      .maybeSingle();
    if (!data) candidates.push(candidate);
    if (i > 200) break;
  }
  return candidates;
}

export const createOrgFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CreateOrgSchema.parse(input))
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    const asUser = salniAsUser(user.accessToken);

    const { data: rpcData, error } = await asUser.rpc("create_organization", {
      p_name: data.name,
      p_slug: data.slug,
    });

    if (error) {
      const msg = error.message ?? "";
      // Postgres unique_violation (23505) or a raised message from the RPC.
      const isSlugTaken =
        error.code === "23505" ||
        /slug.*taken|already exists|duplicate/i.test(msg);
      if (isSlugTaken) {
        const suggestions = await suggestAlternateSlugs(data.slug);
        return { ok: false as const, error: "slug_taken", suggestions } as const;
      }
      return { ok: false as const, error: msg || "Could not create organization" } as const;
    }

    // The RPC returns the org id (uuid) or a row containing it — normalize.
    let orgId: string | null = null;
    if (typeof rpcData === "string") orgId = rpcData;
    else if (rpcData && typeof rpcData === "object") {
      const rec = Array.isArray(rpcData) ? rpcData[0] : rpcData;
      orgId = (rec as { id?: string; org_id?: string })?.id ??
        (rec as { id?: string; org_id?: string })?.org_id ??
        null;
    }

    return { ok: true as const, orgId, slug: data.slug } as const;
  });

export const suggestSlugFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ name: z.string().min(1).max(80) }).parse(input))
  .handler(async ({ data }) => {
    const base = slugify(data.name) || "org";
    const svc = salniService();
    const { data: existing } = await svc
      .from("organizations")
      .select("id")
      .eq("slug", base)
      .maybeSingle();
    if (!existing) return { slug: base };
    const alts = await suggestAlternateSlugs(base, 1);
    return { slug: alts[0] ?? `${base}-${Math.floor(Math.random() * 900 + 100)}` };
  });