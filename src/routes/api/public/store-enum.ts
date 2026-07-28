import { createFileRoute } from "@tanstack/react-router";
import { gemini } from "@/lib/gemini.server";

const STORE = "fileSearchStores/salnisharedv21783566089761-mtddxxu2lj9k";

type Doc = {
  name?: string;
  displayName?: string;
  customMetadata?: Array<{ key?: string; stringValue?: string }>;
};

export const Route = createFileRoute("/api/public/store-enum")({
  server: {
    handlers: {
      GET: async () => {
        try {
        const ai = gemini();
        const out: Doc[] = [];
        let pageToken: string | undefined = undefined;
        let pages = 0;
        do {
          const page = (await ai.fileSearchStores.documents.list({
            parent: STORE,
            config: { pageSize: 50, pageToken },
          } as never)) as {
            documents?: Doc[];
            page?: Doc[];
            nextPageToken?: string;
          };
          const batch = page.page ?? page.documents ?? [];
          for (const d of batch) out.push(d);
          pageToken = page.nextPageToken;
          pages++;
          if (pages >= 100) break;
        } while (pageToken);

        const grouped: Record<string, { org_id: string | null; copies: Array<{ name: string; displayName: string }> }> = {};
        for (const d of out) {
          const meta = d.customMetadata ?? [];
          const docId = meta.find((m) => m.key === "document_id")?.stringValue ?? "(no document_id)";
          const orgId = meta.find((m) => m.key === "org_id")?.stringValue ?? null;
          if (!grouped[docId]) grouped[docId] = { org_id: orgId, copies: [] };
          grouped[docId].copies.push({ name: d.name ?? "", displayName: d.displayName ?? "" });
        }

        return Response.json({
          store: STORE,
          pages_fetched: pages,
          total: out.length,
          grouped,
          raw: out,
        });
        } catch (e) {
          const err = e as { message?: string; stack?: string; status?: number };
          return Response.json({ error: err.message ?? String(e), status: err.status, stack: err.stack }, { status: 500 });
        }
      },
    },
  },
});