import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import {
  DOC_CAP_NO_PLAN,
  DOC_CAP_REACHED,
  DocumentCapNoPlanError,
  DocumentCapReachedError,
  SetupInProgressError,
} from "./errors";
import { requireCurrentUser } from "./session.server";
import { salniAsUser, salniService } from "./supabase.server";
import { bootstrapStore } from "./store-bootstrap.server";

const BUCKET = "documents";
const SIGNED_URL_EXPIRY_SECONDS = 60;
const MAX_BYTES = 52_428_800; // 50 MB

const ALLOWED_EXTS = new Set(["pdf", "docx", "txt", "md", "csv", "xlsx", "pptx"]);

function extOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx + 1).toLowerCase() : "";
}

const CreateDocSchema = z.object({
  orgId: z.string().uuid(),
  fileName: z.string().min(1).max(255),
  mimeType: z.string().min(1).max(200),
  size: z.number().int().positive().max(MAX_BYTES),
});

async function assertOrgMember(userAccessToken: string, orgId: string): Promise<void> {
  const asUser = salniAsUser(userAccessToken);
  const { data, error } = await asUser.rpc("is_org_member", { p_org: orgId });
  if (error) throw new Error(`is_org_member failed: ${error.message}`);
  if (data !== true) throw new Error("Forbidden");
}

export type CreateDocResult =
  | {
      ok: true;
      documentId: string;
      storagePath: string;
      uploadUrl: string;
      uploadUrlExpiresAt: number;
    }
  | { ok: false; error: string; retryAfterMs?: number };

export const createDocumentRowFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CreateDocSchema.parse(input))
  .handler(async ({ data }): Promise<CreateDocResult> => {
    const user = await requireCurrentUser();
    await assertOrgMember(user.accessToken, data.orgId);

    if (!ALLOWED_EXTS.has(extOf(data.fileName))) {
      return { ok: false, error: "Unsupported file type" };
    }

    // Resolve the org as the authenticated user so RLS applies. If the read
    // fails with a Data API grant/permission error, log it verbatim so we can
    // tell the operator which table needs to be exposed.
    const asUser = salniAsUser(user.accessToken);
    const orgRead = await asUser
      .from("organizations")
      .select("id, file_search_store_name, is_active")
      .eq("id", data.orgId)
      .maybeSingle();
    if (orgRead.error) {
      console.error("createDocumentRow: organizations read failed", {
        code: (orgRead.error as { code?: string }).code,
        message: orgRead.error.message,
        details: (orgRead.error as { details?: string }).details,
        hint: (orgRead.error as { hint?: string }).hint,
      });
      return { ok: false, error: `Organization lookup failed: ${orgRead.error.message}` };
    }
    const orgRow = orgRead.data;
    if (!orgRow) return { ok: false, error: "Organization not found" };
    if (orgRow.is_active === false)
      return { ok: false, error: "This assistant is currently unavailable." };

    try {
      await bootstrapStore(orgRow.file_search_store_name ?? null);
    } catch (e) {
      if (e instanceof SetupInProgressError) {
        return { ok: false, error: "setup_in_progress", retryAfterMs: e.retryAfterMs };
      }
      throw e;
    }

    // Row-first insert. The trigger enforces the plan cap atomically.
    // storage_path uses the row id, so we let the DB generate the id and then
    // update the storage_path in the same round-trip.
    const svc = salniService();
    const insert = await svc
      .from("documents")
      .insert({
        organization_id: data.orgId,
        uploaded_by: user.userId,
        file_name: data.fileName,
        mime_type: data.mimeType,
        size_bytes: data.size,
        status: "queued",
        // storage_path is nullable in the schema; we set it after the row id is known.
      })
      .select("id")
      .single();

    if (insert.error) {
      const msg = insert.error.message ?? "";
      if (msg.includes(DOC_CAP_REACHED)) {
        // Try to enrich with plan name for a friendlier message.
        let planLabel = "your current plan";
        try {
          const { data: planRow } = await svc
            .from("subscriptions")
            .select("plan:plans(name, doc_cap)")
            .eq("organization_id", data.orgId)
            .maybeSingle();
          const plan = (planRow as { plan?: { name?: string; doc_cap?: number } } | null)?.plan;
          if (plan?.name) planLabel = plan.name;
          const cap = plan?.doc_cap;
          const cause = new DocumentCapReachedError(plan?.name, cap);
          return {
            ok: false,
            error: `You've reached the ${planLabel} document cap${
              cap ? ` (${cap} documents)` : ""
            }. Upgrade your plan to add more.`,
          };
          void cause;
        } catch {
          return {
            ok: false,
            error: `You've reached the ${planLabel} document cap. Upgrade your plan to add more.`,
          };
        }
      }
      if (msg.includes(DOC_CAP_NO_PLAN)) {
        void new DocumentCapNoPlanError();
        return {
          ok: false,
          error: "This organization has no active plan — please contact support.",
        };
      }
      console.error("documents.insert failed", insert.error);
      return { ok: false, error: "Could not create document row" };
    }

    const documentId = insert.data.id as string;
    const storagePath = `${data.orgId}/${documentId}/${data.fileName}`;

    const upd = await svc
      .from("documents")
      .update({ storage_path: storagePath })
      .eq("id", documentId);
    if (upd.error) {
      console.error("documents.update storage_path failed", upd.error);
      return { ok: false, error: "Could not finalize document row" };
    }

    // Only after the row is committed do we mint the 60s signed upload URL.
    const signed = await svc.storage
      .from(BUCKET)
      .createSignedUploadUrl(storagePath);
    if (signed.error || !signed.data) {
      console.error("createSignedUploadUrl failed", signed.error);
      return { ok: false, error: "Could not create upload URL" };
    }

    return {
      ok: true,
      documentId,
      storagePath,
      uploadUrl: signed.data.signedUrl,
      uploadUrlExpiresAt: Math.floor(Date.now() / 1000) + SIGNED_URL_EXPIRY_SECONDS,
    };
  });

export const markDocumentUploadFailedFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ documentId: z.string().uuid(), orgId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    await assertOrgMember(user.accessToken, data.orgId);
    const svc = salniService();
    const { error } = await svc.rpc("update_document_status", {
      p_document_id: data.documentId,
      p_status: "failed",
      p_file_search_name: null,
      p_error: "upload failed",
    });
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });

export const listDocumentsFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ orgId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    await assertOrgMember(user.accessToken, data.orgId);
    const asUser = salniAsUser(user.accessToken);
    const { data: rows, error } = await asUser
      .from("documents")
      .select("id, file_name, mime_type, size_bytes, status, error_message, retry_count, created_at")
      .eq("organization_id", data.orgId)
      .order("created_at", { ascending: false })
      .limit(200);
    if (error) return { ok: false as const, error: error.message, rows: [] as [] };
    return { ok: true as const, rows: rows ?? [] };
  });

export const retryDocumentFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ documentId: z.string().uuid(), orgId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    await assertOrgMember(user.accessToken, data.orgId);
    const svc = salniService();
    // Increment retry_count and requeue.
    const { data: row, error: readErr } = await svc
      .from("documents")
      .select("retry_count")
      .eq("id", data.documentId)
      .maybeSingle();
    if (readErr || !row) return { ok: false as const, error: "Document not found" };
    const { error } = await svc
      .from("documents")
      .update({
        status: "queued",
        error_message: null,
        retry_count: (row.retry_count ?? 0) + 1,
      })
      .eq("id", data.documentId);
    if (error) return { ok: false as const, error: error.message };
    return { ok: true as const };
  });