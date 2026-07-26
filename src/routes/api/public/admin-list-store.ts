import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "crypto";
import { gemini } from "@/lib/gemini.server";
import { salniService } from "@/lib/supabase.server";

const STORE_NAME =
  "fileSearchStores/salnisharedv21783566089761-mtddxxu2lj9k";

function tsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

type MetaKV = { key?: string; stringValue?: string };

function readMeta(md: MetaKV[] | undefined, key: string): string | null {
  if (!Array.isArray(md)) return null;
  const hit = md.find((kv) => kv?.key === key);
  const v = hit?.stringValue;
  return typeof v === "string" && v.length > 0 ? v : null;
}

export const Route = createFileRoute("/api/public/admin-list-store")({
  server: {
    handlers: {
      GET: async ({ request }) => {
        const hdr = request.headers.get("x-cron-secret");
        const expected = process.env.CRON_WEBHOOK_SECRET;
        if (!hdr || !expected || !tsEqual(hdr, expected)) {
          return new Response("Unauthorized", { status: 401 });
        }

        const ai = gemini();

        // Iterate all pages via the SDK's async iterator (auto-paginates).
        const entries: Array<{
          name: string | null;
          displayName: string | null;
          customMetadata: MetaKV[];
          org_id: string | null;
          document_id: string | null;
        }> = [];

        let pagerErr: string | null = null;
        let firstPageLength = -1;
        try {
          const pager = await ai.documents.list({ parent: STORE_NAME });
          firstPageLength = pager.pageLength;
          for await (const doc of pager) {
            const d = doc as {
              name?: string;
              displayName?: string;
              customMetadata?: MetaKV[];
            };
            const md = d.customMetadata ?? [];
            entries.push({
              name: d.name ?? null,
              displayName: d.displayName ?? null,
              customMetadata: md,
              org_id: readMeta(md, "org_id"),
              document_id: readMeta(md, "document_id"),
            });
          }
        } catch (e) {
          pagerErr = (e as Error)?.message ?? String(e);
        }

        // Sanity check: if we got zero, count DB "ready" docs to compare.
        const svc = salniService();
        const { count: readyCount } = await svc
          .from("documents")
          .select("id", { count: "exact", head: true })
          .eq("status", "ready");

        let sanityWarning: string | null = null;
        if (entries.length === 0) {
          sanityWarning = pagerErr
            ? `pager threw: ${pagerErr}`
            : `pager returned 0 documents (firstPageLength=${firstPageLength}); DB has ${readyCount ?? "?"} ready docs. Pager shape may be wrong — do NOT trust the empty orphan list.`;
        } else if (typeof readyCount === "number" && readyCount >= 18 && entries.length < readyCount / 2) {
          sanityWarning = `only ${entries.length} store documents vs ${readyCount} ready in DB — pager may be truncating.`;
        }

        // Cross-check document_id against documents table (filter nulls).
        const documentIds = entries
          .map((e) => e.document_id)
          .filter((v): v is string => typeof v === "string" && v.length > 0);

        let existingIds = new Set<string>();
        let dbErr: string | null = null;
        if (documentIds.length > 0) {
          const { data, error } = await svc
            .from("documents")
            .select("id")
            .in("id", documentIds);
          if (error) dbErr = error.message;
          else existingIds = new Set((data ?? []).map((r) => r.id as string));
        }

        const missingMetadata = entries
          .filter((e) => !e.org_id || !e.document_id)
          .map((e) => ({
            name: e.name,
            displayName: e.displayName,
            customMetadata: e.customMetadata,
          }));

        const orphans = entries
          .filter(
            (e) =>
              e.org_id &&
              e.document_id &&
              !existingIds.has(e.document_id),
          )
          .map((e) => ({
            name: e.name,
            displayName: e.displayName,
            org_id: e.org_id,
            document_id: e.document_id,
          }));

        const healthyCount =
          entries.length - missingMetadata.length - orphans.length;

        return Response.json({
          store: STORE_NAME,
          totalDocuments: entries.length,
          readyDocumentsInDb: readyCount ?? null,
          healthyCount,
          orphanCount: orphans.length,
          missingMetadataCount: missingMetadata.length,
          sanityWarning,
          pagerError: pagerErr,
          dbError: dbErr,
          orphans,
          missingMetadata,
          documents: entries.map((e) => ({
            name: e.name,
            displayName: e.displayName,
            org_id: e.org_id,
            document_id: e.document_id,
            customMetadata: e.customMetadata,
          })),
        });
      },
    },
  },
});