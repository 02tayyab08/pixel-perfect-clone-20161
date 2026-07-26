import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { salniService } from "@/lib/supabase.server";
import { bootstrapStore } from "@/lib/store-bootstrap.server";
import { gemini, sleep } from "@/lib/gemini.server";

const BUCKET = "documents";
const MAX_BYTES = 52_428_800;

function tsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type ClaimedRow = {
  id: string;
  organization_id: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string;
};

async function processOne(row: ClaimedRow) {
  const svc = salniService();

  // Re-check the Storage object's size / existence from Storage metadata.
  const listPath = row.storage_path.split("/").slice(0, -1).join("/");
  const fileNameOnly = row.storage_path.split("/").slice(-1)[0];
  const { data: objects, error: listErr } = await svc.storage
    .from(BUCKET)
    .list(listPath, { search: fileNameOnly, limit: 1 });
  const meta = objects?.[0];
  const objSize = (meta?.metadata as { size?: number } | undefined)?.size;
  if (listErr || !meta || typeof objSize !== "number" || objSize > MAX_BYTES) {
    await svc.rpc("update_document_status", {
      p_document_id: row.id,
      p_status: "failed",
      p_file_search_name: null,
      p_error: "oversize or missing object",
    });
    return;
  }

  // Download the object.
  const dl = await svc.storage.from(BUCKET).download(row.storage_path);
  if (dl.error || !dl.data) {
    await svc.rpc("update_document_status", {
      p_document_id: row.id,
      p_status: "failed",
      p_file_search_name: null,
      p_error: `download failed: ${dl.error?.message ?? "unknown"}`,
    });
    return;
  }

  // Determine the store to use for this org.
  const { data: org, error: orgErr } = await svc
    .from("organizations")
    .select("id, file_search_store_name")
    .eq("id", row.organization_id)
    .maybeSingle();
  if (orgErr || !org) {
    await svc.rpc("update_document_status", {
      p_document_id: row.id,
      p_status: "failed",
      p_file_search_name: null,
      p_error: "organization not found",
    });
    return;
  }

  let storeName: string;
  try {
    storeName = await bootstrapStore(org.file_search_store_name ?? null);
  } catch (e) {
    // If setup is still in progress, leave the doc queued for the next tick
    // by re-queueing it (claim already flipped it out of queued).
    console.warn("bootstrapStore not ready during processing", e);
    await svc
      .from("documents")
      .update({ status: "queued" })
      .eq("id", row.id);
    return;
  }

  // Upload with backoff on transient errors.
  const ai = gemini();
  const backoffs = [0, 1000, 3000];
  let lastErr: unknown = null;
  for (const wait of backoffs) {
    if (wait > 0) await sleep(wait);
    try {
      const op = await ai.fileSearchStores.uploadToFileSearchStore({
        fileSearchStoreName: storeName,
        file: dl.data,
        config: {
          displayName: row.file_name,
          customMetadata: [
            { key: "org_id", stringValue: row.organization_id },
            { key: "document_id", stringValue: row.id },
          ],
          // Tight chunking for fee-schedule / tabular sources. Smaller
          // chunks with modest overlap keep visually-adjacent rows
          // (e.g. "Investor Visa Add-On" vs "Visa Amendment") in
          // separate retrieval units so the model is less likely to
          // swap their figures. Applies only to documents uploaded
          // AFTER this change ships — existing docs keep their prior
          // chunking until re-uploaded.
          chunkingConfig: {
            whiteSpaceConfig: {
              maxTokensPerChunk: 200,
              maxOverlapTokens: 20,
            },
          },
        },
      });

      // Poll operation to completion (up to ~2 min).
      let current = op as { done?: boolean; response?: { name?: string } };
      for (let iters = 0; iters < 120 && !current.done; iters++) {
        await sleep(1000);
        current = (await ai.operations.get({
          operation: current as never,
        })) as typeof current;
      }

      // SDK may return documentName (not name) when the long-running op completes.
      const resource =
        current.response?.name ??
        (current.response as { documentName?: string } | undefined)?.documentName ??
        null;

      await svc.rpc("update_document_status", {
        p_document_id: row.id,
        p_status: "ready",
        p_file_search_name: resource,
        p_error: null,
      });

      // Phase 1: best-effort retrieval self-probe (warn-only). Failures must
      // not fail the document index — cron /api/public/probe-documents retries
      // any ready doc still missing a probe row.
      try {
        const { runDocumentProbe, persistDocumentProbe } = await import(
          "@/lib/document-probe.server"
        );
        const probeInput = {
          documentId: row.id,
          organizationId: row.organization_id,
          fileName: row.file_name,
          mimeType: row.mime_type,
          sizeBytes: row.size_bytes ?? objSize,
          storagePath: row.storage_path as string,
          fileSearchStoreName: org.file_search_store_name ?? null,
        };
        const outcome = await runDocumentProbe(probeInput);
        await persistDocumentProbe(probeInput, outcome);
        console.log(
          `[process-documents] probe doc=${row.id} class=${outcome.probeClass} ` +
            `rate=${outcome.successRate ?? "n/a"}`,
        );
      } catch (probeErr) {
        console.error(
          "[process-documents] probe deferred to cron",
          row.id,
          probeErr instanceof Error ? probeErr.message : String(probeErr),
        );
      }
      return;
    } catch (e) {
      lastErr = e;
      console.error("uploadToFileSearchStore attempt failed", e);
    }
  }

  await svc.rpc("update_document_status", {
    p_document_id: row.id,
    p_status: "failed",
    p_file_search_name: null,
    p_error: `gemini upload failed: ${(lastErr as Error)?.message ?? "unknown"}`,
  });
}

export const Route = createFileRoute("/api/public/process-documents")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const cronSecretHeader = request.headers.get("x-cron-secret");
        const expected = process.env.CRON_WEBHOOK_SECRET;

        if (cronSecretHeader) {
          if (!expected || !tsEqual(cronSecretHeader, expected)) {
            return new Response("Unauthorized", { status: 401 });
          }
        } else {
          // Storage-webhook path: for now we require the cron secret too.
          // Full HMAC verification of the Supabase Storage webhook body will
          // be added when the webhook is wired up.
          return new Response("Unauthorized", { status: 401 });
        }

        const svc = salniService();
        let processed = 0;
        let failed = 0;

        // Claim in a loop until empty.
        // Safety cap: 20 batches per invocation to avoid unbounded runtime.
        for (let batch = 0; batch < 20; batch++) {
          const { data, error } = await svc.rpc("claim_queued_documents", { p_batch: 5 });
          if (error) {
            console.error("claim_queued_documents failed", error);
            return new Response(JSON.stringify({ error: error.message }), {
              status: 500,
              headers: { "content-type": "application/json" },
            });
          }
          const rows = (data ?? []) as ClaimedRow[];
          if (rows.length === 0) break;

          for (const row of rows) {
            try {
              await processOne(row);
              processed++;
            } catch (e) {
              failed++;
              console.error("processOne threw", e);
              // Never mass-fail: leave to next tick if we can't classify.
            }
          }
        }

        return Response.json({ ok: true, processed, failed });
      },
    },
  },
});