import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDocumentRowFn,
  listDocumentsFn,
  markDocumentUploadFailedFn,
  retryDocumentFn,
} from "@/lib/documents.functions";
import { retryWhileSetup } from "@/lib/retry-setup";
import { Button } from "@/components/ui/button";
import { AlertCircle, CheckCircle2, Loader2, RefreshCw, Upload } from "lucide-react";

type DocRow = {
  id: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number | null;
  status: "queued" | "indexing" | "ready" | "failed" | string;
  error_message: string | null;
  retry_count: number | null;
  created_at: string;
};

const ACCEPT = ".pdf,.docx,.txt,.md,.csv,.xlsx,.pptx";
const MAX_BYTES = 52_428_800;

export const Route = createFileRoute("/_authenticated/app/$slug/documents")({
  head: () => ({ meta: [{ title: "Documents — Salni" }] }),
  component: DocumentsPage,
});

function DocumentsPage() {
  const { org } = Route.useRouteContext() as { org: { id: string; slug: string } };
  const createRow = useServerFn(createDocumentRowFn);
  const markFailed = useServerFn(markDocumentUploadFailedFn);
  const listDocs = useServerFn(listDocumentsFn);
  const retryDoc = useServerFn(retryDocumentFn);

  const [rows, setRows] = useState<DocRow[]>([]);
  const [settingUp, setSettingUp] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const refresh = useCallback(async () => {
    const res = await listDocs({ data: { orgId: org.id } });
    if (res.ok) setRows(res.rows as DocRow[]);
  }, [listDocs, org.id]);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 4000);
    return () => clearInterval(t);
  }, [refresh]);

  async function uploadFiles(files: FileList | File[]) {
    setUploadError(null);
    for (const file of Array.from(files)) {
      if (file.size > MAX_BYTES) {
        setUploadError(`${file.name} is over the 50 MB limit.`);
        continue;
      }
      setBusy(true);
      try {
        const created = await retryWhileSetup(
          () =>
            createRow({
              data: {
                orgId: org.id,
                fileName: file.name,
                mimeType: file.type || "application/octet-stream",
                size: file.size,
              },
            }),
          { onSettingUp: () => setSettingUp(true) },
        );
        setSettingUp(false);

        if ("error" in created && created.error === "setup_in_progress") {
          setUploadError("Still preparing your workspace — please retry in a moment.");
          continue;
        }
        if (!("ok" in created) || !created.ok) {
          setUploadError(("error" in created && created.error) || "Upload failed");
          continue;
        }

        // PUT the file bytes to the signed URL (must complete within 60 s).
        const put = await fetch(created.uploadUrl, {
          method: "PUT",
          headers: { "content-type": file.type || "application/octet-stream" },
          body: file,
        });
        if (!put.ok) {
          await markFailed({
            data: { orgId: org.id, documentId: created.documentId },
          });
          setUploadError(`Upload of ${file.name} failed.`);
        }
      } catch (e) {
        setUploadError(e instanceof Error ? e.message : "Upload failed");
      } finally {
        setBusy(false);
      }
    }
    refresh();
  }

  return (
    <div>
      <div className="flex items-start justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold">Documents</h1>
          <p className="mt-2 text-sm text-muted-foreground">
            PDF, DOCX, TXT, MD, CSV, XLSX, PPTX · up to 50 MB per file.
          </p>
        </div>
        <div>
          <input
            ref={inputRef}
            type="file"
            accept={ACCEPT}
            multiple
            className="hidden"
            onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          />
          <Button onClick={() => inputRef.current?.click()} disabled={busy}>
            <Upload className="mr-2 h-4 w-4" /> Upload files
          </Button>
        </div>
      </div>

      <div
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          if (e.dataTransfer.files.length > 0) uploadFiles(e.dataTransfer.files);
        }}
        className="mt-6 rounded-2xl border border-dashed border-border bg-card p-10 text-center"
      >
        <Upload className="mx-auto h-6 w-6 text-muted-foreground" />
        <p className="mt-2 text-sm">Drag & drop files here, or click Upload above.</p>
      </div>

      {settingUp ? (
        <div className="mt-4 flex items-center gap-2 rounded-md border border-border bg-accent/40 p-3 text-sm">
          <Loader2 className="h-4 w-4 animate-spin" />
          Setting up your workspace…
        </div>
      ) : null}

      {uploadError ? (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {uploadError}
        </div>
      ) : null}

      <div className="mt-8 rounded-2xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="border-b border-border text-left text-xs uppercase tracking-wider text-muted-foreground">
            <tr>
              <th className="px-4 py-3">File</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Size</th>
              <th className="px-4 py-3"></th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-4 py-10 text-center text-muted-foreground">
                  No documents yet — upload one to get started.
                </td>
              </tr>
            ) : null}
            {rows.map((r) => (
              <tr key={r.id} className="border-t border-border">
                <td className="px-4 py-3 font-medium">{r.file_name}</td>
                <td className="px-4 py-3">
                  <StatusPill status={r.status} error={r.error_message} />
                </td>
                <td className="px-4 py-3 text-muted-foreground">{formatBytes(r.size_bytes)}</td>
                <td className="px-4 py-3 text-right">
                  {r.status === "failed" ? (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={async () => {
                        await retryDoc({ data: { orgId: org.id, documentId: r.id } });
                        refresh();
                      }}
                    >
                      <RefreshCw className="mr-2 h-3 w-3" /> Retry
                    </Button>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function StatusPill({ status, error }: { status: string; error: string | null }) {
  if (status === "ready") {
    return (
      <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">
        <CheckCircle2 className="h-3 w-3" /> Ready
      </span>
    );
  }
  if (status === "failed") {
    return (
      <span
        title={error ?? undefined}
        className="inline-flex items-center gap-1 rounded-full bg-destructive/10 px-2 py-0.5 text-xs text-destructive"
      >
        <AlertCircle className="h-3 w-3" /> Failed
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">
      <Loader2 className="h-3 w-3 animate-spin" /> {status === "indexing" ? "Indexing" : "Queued"}
    </span>
  );
}

function formatBytes(n: number | null): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}