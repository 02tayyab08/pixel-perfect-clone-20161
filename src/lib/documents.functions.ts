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
import { gemini } from "./gemini.server";

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
      console.error("documents.insert failed (raw)", {
        code: (insert.error as { code?: string }).code,
        message: insert.error.message,
        details: (insert.error as { details?: string }).details,
        hint: (insert.error as { hint?: string }).hint,
      });
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
      const raw = [
        (insert.error as { code?: string }).code,
        insert.error.message,
        (insert.error as { details?: string }).details,
        (insert.error as { hint?: string }).hint,
      ]
        .filter(Boolean)
        .join(" | ");
      return { ok: false, error: `documents.insert failed: ${raw}` };
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
      const err = signed.error as
        | {
            name?: string;
            message?: string;
            status?: number;
            statusCode?: number | string;
            error?: string;
          }
        | null;
      console.error("createSignedUploadUrl failed (raw)", {
        bucket: BUCKET,
        storagePath,
        name: err?.name,
        message: err?.message,
        status: err?.status,
        statusCode: err?.statusCode,
        error: err?.error,
      });
      const raw = [err?.name, err?.statusCode ?? err?.status, err?.error, err?.message]
        .filter(Boolean)
        .join(" | ");
      return {
        ok: false,
        error: `createSignedUploadUrl failed: ${raw || "unknown error"}`,
      };
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

/**
 * Phase-3 single-document delete. Strict ordering per spec:
 *   1. Delete the Gemini File Search document (if the row has a resource name).
 *   2. Only on success → delete the Storage object.
 *   3. Only on success → delete the documents row.
 *   4. Best-effort audit_log insert (never blocks success).
 *
 * Any failure in step 1 or 2 STOPS the chain and returns the raw error to
 * the caller — the row is left untouched so the user can retry after
 * inspecting the error.
 *
 * This function uses the service-role client because:
 *   - Clients have no DELETE policy on `documents` (deliberate).
 *   - Storage removal and Gemini calls need the service-role key.
 * The caller is authorized via `assertOrgMember` before any side effect.
 */
export const deleteDocumentFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) =>
    z.object({ documentId: z.string().uuid(), orgId: z.string().uuid() }).parse(input),
  )
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    await assertOrgMember(user.accessToken, data.orgId);

    const svc = salniService();

    // Load the row we're about to delete. Verify it belongs to the org the
    // caller claimed — belt-and-suspenders on top of assertOrgMember.
    const read = await svc
      .from("documents")
      .select("id, organization_id, storage_path, file_search_document_name, file_name")
      .eq("id", data.documentId)
      .maybeSingle();
    if (read.error) {
      return {
        ok: false as const,
        stage: "read" as const,
        error: `documents.select failed: ${read.error.message}`,
      };
    }
    if (!read.data) {
      return { ok: false as const, stage: "read" as const, error: "Document not found" };
    }
    if (read.data.organization_id !== data.orgId) {
      return { ok: false as const, stage: "read" as const, error: "Forbidden" };
    }

    const row = read.data as {
      id: string;
      organization_id: string;
      storage_path: string | null;
      file_search_document_name: string | null;
      file_name: string | null;
    };

    // ── Step 1: Gemini File Search document delete ────────────────────────
    // If the row never got a resource name (e.g. upload failed before the
    // operation returned one), there is nothing to delete in Gemini — skip
    // step 1 with a warning and proceed. This is the ONLY sanctioned skip.
    let geminiSkipped = false;
    if (row.file_search_document_name && row.file_search_document_name.length > 0) {
      try {
        const ai = gemini();
        await ai.fileSearchStores.documents.delete({
          name: row.file_search_document_name,
          config: { force: true },
        });
      } catch (e) {
        const err = e as {
          name?: string;
          message?: string;
          status?: number;
          code?: number | string;
        };
        // Treat NOT_FOUND as already-deleted upstream; anything else stops
        // the chain and surfaces the raw error to the UI.
        const status = err?.status;
        const code = err?.code;
        const msg = err?.message ?? String(e);
        const looksMissing =
          status === 404 ||
          code === 404 ||
          code === "NOT_FOUND" ||
          /not\s*found/i.test(msg);
        if (!looksMissing) {
          console.error("deleteDocument: gemini delete failed", {
            documentId: row.id,
            fileSearchName: row.file_search_document_name,
            status,
            code,
            message: msg,
          });
          return {
            ok: false as const,
            stage: "gemini" as const,
            error: `Gemini delete failed: ${msg}`,
          };
        }
        console.warn("deleteDocument: gemini reports NOT_FOUND, continuing", {
          documentId: row.id,
          fileSearchName: row.file_search_document_name,
        });
      }
    } else {
      geminiSkipped = true;
      console.warn("deleteDocument: file_search_document_name is null, skipping Gemini step", {
        documentId: row.id,
      });
    }

    // ── Step 2: Storage object delete ─────────────────────────────────────
    if (row.storage_path && row.storage_path.length > 0) {
      const rm = await svc.storage.from(BUCKET).remove([row.storage_path]);
      if (rm.error) {
        // Storage's remove() returns success for missing keys, so any error
        // here is a real failure — stop and surface it.
        console.error("deleteDocument: storage.remove failed", {
          documentId: row.id,
          storagePath: row.storage_path,
          error: rm.error,
        });
        return {
          ok: false as const,
          stage: "storage" as const,
          error: `Storage delete failed: ${rm.error.message}`,
        };
      }
    }

    // ── Step 3: documents row delete ──────────────────────────────────────
    const del = await svc.from("documents").delete().eq("id", row.id);
    if (del.error) {
      console.error("deleteDocument: documents.delete failed", {
        documentId: row.id,
        error: del.error,
      });
      return {
        ok: false as const,
        stage: "row" as const,
        error: `documents.delete failed: ${del.error.message}`,
      };
    }

    // ── Step 4: audit_log (best-effort, never blocks success) ─────────────
    try {
      const audit = await svc.from("audit_log").insert({
        organization_id: row.organization_id,
        actor_user_id: user.userId,
        action: "document.deleted",
        entity_type: "document",
        entity_id: row.id,
        metadata: {
          file_name: row.file_name,
          storage_path: row.storage_path,
          file_search_document_name: row.file_search_document_name,
          gemini_skipped: geminiSkipped,
        },
      });
      if (audit.error) {
        console.warn("deleteDocument: audit_log insert failed (non-fatal)", audit.error);
      }
    } catch (e) {
      console.warn("deleteDocument: audit_log insert threw (non-fatal)", e);
    }

    return { ok: true as const, geminiSkipped };
  });

/**
 * Phase-3 backfill for `documents.file_search_document_name`.
 *
 * Some documents were indexed into Gemini File Search but the resource name
 * never made it back into our row (e.g. the process-documents call crashed
 * after upload but before `update_document_status`, or an older reset
 * cleared the column). Without a resource name, `deleteDocumentFn` cannot
 * target the Gemini side and would orphan the File Search document.
 *
 * Strategy: list every File Search document under the org's store, read its
 * `customMetadata.document_id` (set at upload time), and — for each row that
 * (a) belongs to this org, (b) has `file_search_document_name = NULL`, and
 * (c) matches a listed document — write the resource name back onto the row.
 *
 * Safe to run repeatedly. Never deletes. Never overwrites a non-null
 * `file_search_document_name`. Reports counts + a per-row summary so the
 * caller can see exactly what happened.
 */
export const backfillFileSearchNamesFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => z.object({ orgId: z.string().uuid() }).parse(input))
  .handler(async ({ data }) => {
    const user = await requireCurrentUser();
    await assertOrgMember(user.accessToken, data.orgId);

    const svc = salniService();

    // Resolve the store name for this org (may be the shared bootstrap store).
    const orgRead = await svc
      .from("organizations")
      .select("id, file_search_store_name")
      .eq("id", data.orgId)
      .maybeSingle();
    if (orgRead.error) {
      return { ok: false as const, error: `organizations.select failed: ${orgRead.error.message}` };
    }
    if (!orgRead.data) return { ok: false as const, error: "Organization not found" };

    let storeName: string;
    try {
      storeName = await bootstrapStore(orgRead.data.file_search_store_name ?? null);
    } catch (e) {
      return { ok: false as const, error: `store bootstrap failed: ${(e as Error).message}` };
    }

    // Load candidate rows: this org's documents missing a resource name.
    const rowsRead = await svc
      .from("documents")
      .select("id, file_name, status, file_search_document_name")
      .eq("organization_id", data.orgId)
      .is("file_search_document_name", null);
    if (rowsRead.error) {
      return { ok: false as const, error: `documents.select failed: ${rowsRead.error.message}` };
    }
    const candidates = (rowsRead.data ?? []) as Array<{
      id: string;
      file_name: string | null;
      status: string | null;
      file_search_document_name: string | null;
    }>;
    if (candidates.length === 0) {
      return {
        ok: true as const,
        storeName,
        candidates: 0,
        listed: 0,
        matched: 0,
        updated: 0,
        updates: [] as Array<{ documentId: string; fileName: string | null; resourceName: string }>,
      };
    }
    const wantedIds = new Set(candidates.map((r) => r.id));

    // Page through every File Search document under this store.
    const ai = gemini();
    type FsDoc = {
      name?: string;
      displayName?: string;
      customMetadata?: Array<{ key?: string; stringValue?: string }>;
    };
    const listed: FsDoc[] = [];
    let pageToken: string | undefined = undefined;
    let pages = 0;
    try {
      do {
        const page = (await ai.fileSearchStores.documents.list({
          parent: storeName,
          config: { pageSize: 20, pageToken },
        } as never)) as {
          documents?: FsDoc[];
          nextPageToken?: string;
          page?: FsDoc[];
        };
        const batch = page.documents ?? page.page ?? [];
        for (const d of batch) listed.push(d);
        pageToken = page.nextPageToken;
        pages++;
        // Safety cap: 50 pages (~5k docs) per invocation.
        if (pages >= 50) break;
      } while (pageToken);
    } catch (e) {
      return {
        ok: false as const,
        error: `Gemini list failed: ${(e as Error).message}`,
        listed: listed.length,
      };
    }

    // Match by customMetadata.document_id → our row id.
    const updates: Array<{ documentId: string; fileName: string | null; resourceName: string }> =
      [];
    const seen = new Set<string>();
    for (const d of listed) {
      const resourceName = d.name;
      if (!resourceName) continue;
      const docIdMeta = (d.customMetadata ?? []).find((m) => m.key === "document_id");
      const docId = docIdMeta?.stringValue;
      if (!docId || !wantedIds.has(docId) || seen.has(docId)) continue;
      seen.add(docId);
      const row = candidates.find((c) => c.id === docId);
      updates.push({ documentId: docId, fileName: row?.file_name ?? null, resourceName });
    }

    // Apply updates one row at a time — small volumes, and we want per-row
    // error visibility. Never overwrite a non-null value (defensive `.is()`).
    let updated = 0;
    const failures: Array<{ documentId: string; error: string }> = [];
    for (const u of updates) {
      const upd = await svc
        .from("documents")
        .update({ file_search_document_name: u.resourceName })
        .eq("id", u.documentId)
        .is("file_search_document_name", null);
      if (upd.error) {
        failures.push({ documentId: u.documentId, error: upd.error.message });
        continue;
      }
      updated++;
    }

    // Best-effort audit entry.
    try {
      await svc.from("audit_log").insert({
        organization_id: data.orgId,
        actor_user_id: user.userId,
        action: "documents.backfill_file_search_names",
        entity_type: "organization",
        entity_id: data.orgId,
        metadata: {
          store_name: storeName,
          candidates: candidates.length,
          listed: listed.length,
          matched: updates.length,
          updated,
          failures,
        },
      });
    } catch (e) {
      console.warn("backfill: audit_log insert threw (non-fatal)", e);
    }

    return {
      ok: true as const,
      storeName,
      candidates: candidates.length,
      listed: listed.length,
      matched: updates.length,
      updated,
      updates,
      failures,
    };
  });