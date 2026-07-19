import { createFileRoute } from "@tanstack/react-router";
import { salniService } from "@/lib/supabase.server";
import {
  persistDocumentProbe,
  runDocumentProbe,
} from "@/lib/document-probe.server";

function tsEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let out = 0;
  for (let i = 0; i < a.length; i++) out |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return out === 0;
}

type DocRow = {
  id: string;
  organization_id: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  storage_path: string | null;
};

async function processOne(row: DocRow): Promise<void> {
  if (!row.storage_path) {
    console.error("[probe-documents] missing storage_path", row.id);
    return;
  }

  const svc = salniService();
  const { data: org, error: orgErr } = await svc
    .from("organizations")
    .select("id, file_search_store_name")
    .eq("id", row.organization_id)
    .single();
  if (orgErr || !org) {
    console.error("[probe-documents] org lookup failed", orgErr?.message);
    return;
  }

  const input = {
    documentId: row.id,
    organizationId: row.organization_id,
    fileName: row.file_name,
    mimeType: row.mime_type,
    sizeBytes: row.size_bytes,
    storagePath: row.storage_path,
    fileSearchStoreName: org.file_search_store_name as string | null,
  };

  const outcome = await runDocumentProbe(input);
  await persistDocumentProbe(input, outcome);
  console.log(
    `[probe-documents] doc=${row.id} class=${outcome.probeClass} ` +
      `rate=${outcome.successRate ?? "n/a"} grounded=${outcome.questionsGrounded}/` +
      `${outcome.questionsTotal} costUSD=${outcome.costUsd.toFixed(4)} ` +
      `extractChars=${outcome.extractChars}`,
  );
}

export const Route = createFileRoute("/api/public/probe-documents")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const cronSecretHeader = request.headers.get("x-cron-secret");
        const expected = process.env.CRON_WEBHOOK_SECRET;
        if (
          !cronSecretHeader ||
          !expected ||
          !tsEqual(cronSecretHeader, expected)
        ) {
          return new Response("Unauthorized", { status: 401 });
        }

        const svc = salniService();
        let processed = 0;
        let failed = 0;

        for (let batch = 0; batch < 10; batch++) {
          const { data: rows, error } = await svc.rpc(
            "claim_documents_for_probe",
            { p_batch: 3 },
          );
          if (error) {
            console.error("[probe-documents] claim failed", error.message);
            return Response.json(
              { ok: false, error: error.message, processed, failed },
              { status: 500 },
            );
          }
          if (!rows?.length) break;

          for (const row of rows as DocRow[]) {
            try {
              await processOne(row);
              processed += 1;
            } catch (e) {
              failed += 1;
              console.error(
                "[probe-documents] processOne failed",
                row.id,
                e instanceof Error ? e.message : String(e),
              );
            }
          }
        }

        return Response.json({ ok: true, processed, failed });
      },
    },
  },
});
