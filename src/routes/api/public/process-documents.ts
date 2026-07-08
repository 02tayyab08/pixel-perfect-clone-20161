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
  org_id: string;
  file_name: string;
  mime_type: string | null;
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
      p_file_search_document: null,
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
      p_file_search_document: null,
      p_error: `download failed: ${dl.error?.message ?? "unknown"}`,
    });
    return;
  }

  // Determine the store to use for this org.
  const { data: org, error: orgErr } = await svc
    .from("organizations")
    .select("id, file_search_store_name")
    .eq("id", row.org_id)
    .maybeSingle();
  if (orgErr || !org) {
    await svc.rpc("update_document_status", {
      p_document_id: row.id,
      p_status: "failed",
      p_file_search_document: null,
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
            { key: "org_id", stringValue: row.org_id },
            { key: "document_id", stringValue: row.id },
          ],
        },
      });

      // Poll operation to completion.
      let current = op;
      let iters = 0;
      while (!current.done && iters < 120) {
        await sleep(1000);
        current = await ai.operations.getVideosOperation
          ? // Fallback shouldn't be needed; use generic operations.get if available.
            await (ai as unknown as { operations: { get: (o: unknown) => Promise<typeof op> } })
              .operations.get(current)
          : current;
        iters++;
        if ((current as { done?: boolean }).done) break;
      }

      const resource =
        (current as { response?: { name?: string } }).response?.name ?? null;

      await svc.rpc("update_document_status", {
        p_document_id: row.id,
        p_status: "ready",
        p_file_search_document: resource,
        p_error: null,
      });
      return;
    } catch (e) {
      lastErr = e;
      console.error("uploadToFileSearchStore attempt failed", e);
    }
  }

  await svc.rpc("update_document_status", {
    p_document_id: row.id,
    p_status: "failed",
    p_file_search_document: null,
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
          const { data, error } = await svc.rpc("claim_queued_documents", { p_limit: 5 });
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