import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  createDocumentRowFn,
  deleteDocumentFn,
  listDocumentsFn,
  markDocumentUploadFailedFn,
  retryDocumentFn,
  backfillFileSearchNamesFn,
} from "@/lib/documents.functions";
import { retryWhileSetup } from "@/lib/retry-setup";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  CheckCircle2,
  ChevronDown,
  ChevronUp,
  Loader2,
  Lightbulb,
  RefreshCw,
  Trash2,
  Upload,
  Wrench,
  X,
} from "lucide-react";

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
  const deleteDoc = useServerFn(deleteDocumentFn);
  const backfill = useServerFn(backfillFileSearchNamesFn);

  const [rows, setRows] = useState<DocRow[]>([]);
  const [settingUp, setSettingUp] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<DocRow | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [backfilling, setBackfilling] = useState(false);
  const [backfillResult, setBackfillResult] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const tipsKey = `salni.docs-tips-dismissed.${org.id}`;
  const [tipsDismissed, setTipsDismissed] = useState(false);
  const [tipsOpen, setTipsOpen] = useState(true);
  useEffect(() => {
    if (typeof window !== "undefined") {
      setTipsDismissed(window.localStorage.getItem(tipsKey) === "1");
    }
  }, [tipsKey]);
  const dismissTips = () => {
    setTipsDismissed(true);
    if (typeof window !== "undefined") window.localStorage.setItem(tipsKey, "1");
  };

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

  async function performDelete(row: DocRow) {
    setDeleteError(null);
    setDeletingId(row.id);
    try {
      const res = await deleteDoc({ data: { orgId: org.id, documentId: row.id } });
      if (!("ok" in res) || !res.ok) {
        // Surface the raw stage-labeled error, per the same discipline as
        // every other privileged route.
        const stage = "stage" in res ? res.stage : "unknown";
        const msg = "error" in res ? res.error : "Delete failed";
        setDeleteError(`[${stage}] ${msg}`);
        return;
      }
      // Optimistic removal; the interval refresh will confirm.
      setRows((prev) => prev.filter((r) => r.id !== row.id));
      setConfirmDelete(null);
    } catch (e) {
      setDeleteError(e instanceof Error ? e.message : "Delete failed");
    } finally {
      setDeletingId(null);
    }
  }

  async function runBackfill() {
    setBackfillResult(null);
    setBackfilling(true);
    try {
      const res = await backfill({ data: { orgId: org.id } });
      if (!("ok" in res) || !res.ok) {
        setBackfillResult(`Backfill failed: ${"error" in res ? res.error : "unknown"}`);
        return;
      }
      setBackfillResult(
        `Backfill: ${res.candidates} candidate row(s), ${res.listed} File Search doc(s) listed, ${res.matched} matched, ${res.updated} updated.`,
      );
      refresh();
    } catch (e) {
      setBackfillResult(e instanceof Error ? e.message : "Backfill failed");
    } finally {
      setBackfilling(false);
    }
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
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              onClick={runBackfill}
              disabled={backfilling}
              title="List File Search docs and rewrite missing file_search_document_name values"
            >
              {backfilling ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <Wrench className="mr-2 h-4 w-4" />
              )}
              Backfill FS names
            </Button>
            <Button onClick={() => inputRef.current?.click()} disabled={busy}>
              <Upload className="mr-2 h-4 w-4" /> Upload files
            </Button>
          </div>
        </div>
      </div>

      {backfillResult ? (
        <div className="mt-4 rounded-md border border-border bg-accent/40 p-3 text-sm">
          {backfillResult}
        </div>
      ) : null}

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

      {!tipsDismissed ? (
        <div className="mt-4 rounded-xl border border-border bg-accent/30 p-4">
          <div className="flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setTipsOpen((v) => !v)}
              className="flex items-center gap-2 text-sm font-medium"
            >
              <Lightbulb className="h-4 w-4 text-primary" />
              Get the best answers from your documents
              {tipsOpen ? (
                <ChevronUp className="h-4 w-4 text-muted-foreground" />
              ) : (
                <ChevronDown className="h-4 w-4 text-muted-foreground" />
              )}
            </button>
            <button
              type="button"
              onClick={dismissTips}
              aria-label="Dismiss tips"
              className="rounded-md p-1 text-muted-foreground hover:bg-muted"
            >
              <X className="h-4 w-4" />
            </button>
          </div>
          {tipsOpen ? (
            <ul className="mt-3 list-disc space-y-1 pl-6 text-sm text-muted-foreground">
              <li>
                Use descriptive file names (e.g. &ldquo;Visa Renewal Process
                2025.pdf&rdquo;, not &ldquo;Doc_final(1).pdf&rdquo;).
              </li>
              <li>Use clear headings inside documents for each topic.</li>
              <li>
                Where possible, keep one topic per document — several focused files
                beat one giant mixed file.
              </li>
              <li>Text-based files work best; scanned image-only PDFs may index poorly.</li>
              <li>Files up to 50 MB: PDF, Word, Excel, PowerPoint, TXT, MD, CSV.</li>
            </ul>
          ) : null}
        </div>
      ) : null}

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

      {deleteError ? (
        <div className="mt-4 rounded-md border border-destructive/40 bg-destructive/5 p-3 text-sm text-destructive">
          {deleteError}
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
                  <div className="inline-flex items-center gap-2">
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
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`Delete ${r.file_name}`}
                      disabled={deletingId === r.id}
                      onClick={() => setConfirmDelete(r)}
                    >
                      {deletingId === r.id ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <Trash2 className="h-4 w-4 text-muted-foreground" />
                      )}
                    </Button>
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {confirmDelete ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-background/70 p-4"
          role="dialog"
          aria-modal="true"
          onClick={() => {
            if (deletingId !== confirmDelete.id) setConfirmDelete(null);
          }}
        >
          <div
            className="w-full max-w-md rounded-2xl border border-border bg-card p-6 shadow-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <h2 className="font-display text-lg font-semibold">Delete document?</h2>
            <p className="mt-2 text-sm text-muted-foreground">
              Delete <span className="font-medium text-foreground">{confirmDelete.file_name}</span>?
              This removes the file from indexing and cannot be undone.
            </p>
            <div className="mt-6 flex justify-end gap-2">
              <Button
                variant="outline"
                onClick={() => setConfirmDelete(null)}
                disabled={deletingId === confirmDelete.id}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                onClick={() => performDelete(confirmDelete)}
                disabled={deletingId === confirmDelete.id}
              >
                {deletingId === confirmDelete.id ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" /> Deleting…
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </>
                )}
              </Button>
            </div>
          </div>
        </div>
      ) : null}
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