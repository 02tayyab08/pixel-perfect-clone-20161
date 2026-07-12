import { createFileRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useMemo, useState } from "react";
import { listLeadsFn, updateLeadStatusFn } from "@/lib/widget.functions";
import { Button } from "@/components/ui/button";

type LeadStatus = "new" | "qualified" | "contacted" | "converted" | "archived";
const STATUSES: LeadStatus[] = ["new", "qualified", "contacted", "converted", "archived"];

type Lead = {
  id: string;
  created_at: string;
  updated_at: string;
  status: LeadStatus;
  full_name: string | null;
  email: string | null;
  phone: string | null;
  company: string | null;
  notes: string | null;
  consent_text: string | null;
  consent_at: string | null;
  ip: string | null;
  conversation_id: string | null;
};

export const Route = createFileRoute("/_authenticated/app/$slug/leads")({
  head: () => ({ meta: [{ title: "Leads — Salni" }] }),
  component: LeadsPage,
});

function LeadsPage() {
  const { org } = Route.useRouteContext() as { org: { id: string; name: string } };
  const list = useServerFn(listLeadsFn);
  const update = useServerFn(updateLeadStatusFn);

  const [filter, setFilter] = useState<LeadStatus | "all">("all");
  const [leads, setLeads] = useState<Lead[]>([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Lead | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function reload() {
    setLoading(true);
    setErr(null);
    try {
      const res = await list({
        data: { orgId: org.id, status: filter === "all" ? null : filter },
      });
      setLeads(res.leads as Lead[]);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter]);

  async function setStatus(lead: Lead, status: LeadStatus) {
    await update({ data: { orgId: org.id, leadId: lead.id, status } });
    setLeads((rows) => rows.map((r) => (r.id === lead.id ? { ...r, status } : r)));
    if (selected?.id === lead.id) setSelected({ ...selected, status });
  }

  const counts = useMemo(() => {
    const c: Record<string, number> = { all: leads.length };
    for (const s of STATUSES) c[s] = leads.filter((l) => l.status === s).length;
    return c;
  }, [leads]);

  function exportCsv() {
    const cols: Array<keyof Lead> = [
      "created_at",
      "status",
      "full_name",
      "email",
      "phone",
      "company",
      "notes",
      "consent_text",
      "consent_at",
      "ip",
      "conversation_id",
    ];
    const esc = (v: unknown) => {
      const s = v == null ? "" : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    const header = cols.join(",");
    const body = leads.map((l) => cols.map((c) => esc(l[c])).join(",")).join("\n");
    const blob = new Blob([header + "\n" + body], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `leads-${org.name.replace(/\s+/g, "-")}-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div className="mx-auto max-w-6xl">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-display text-3xl font-semibold">Leads</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Widget visitors who consented to be contacted.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={exportCsv} disabled={leads.length === 0}>
          Export CSV
        </Button>
      </div>

      <div className="mt-6 flex flex-wrap gap-2">
        <FilterTab label={`All (${counts.all ?? 0})`} active={filter === "all"} onClick={() => setFilter("all")} />
        {STATUSES.map((s) => (
          <FilterTab
            key={s}
            label={`${s} (${counts[s] ?? 0})`}
            active={filter === s}
            onClick={() => setFilter(s)}
          />
        ))}
      </div>

      {err ? (
        <p className="mt-4 rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
          {err}
        </p>
      ) : null}

      <div className="mt-4 overflow-hidden rounded-2xl border border-border bg-card">
        <table className="w-full text-sm">
          <thead className="bg-muted/40 text-left text-xs uppercase text-muted-foreground">
            <tr>
              <th className="px-4 py-2">Created</th>
              <th className="px-4 py-2">Name</th>
              <th className="px-4 py-2">Email</th>
              <th className="px-4 py-2">Phone</th>
              <th className="px-4 py-2">Status</th>
              <th className="px-4 py-2" />
            </tr>
          </thead>
          <tbody>
            {loading ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  Loading…
                </td>
              </tr>
            ) : leads.length === 0 ? (
              <tr>
                <td colSpan={6} className="px-4 py-8 text-center text-muted-foreground">
                  No leads yet.
                </td>
              </tr>
            ) : (
              leads.map((l) => (
                <tr
                  key={l.id}
                  className="cursor-pointer border-t border-border hover:bg-muted/30"
                  onClick={() => setSelected(l)}
                >
                  <td className="px-4 py-2 text-muted-foreground">
                    {new Date(l.created_at).toLocaleString()}
                  </td>
                  <td className="px-4 py-2">{l.full_name ?? "—"}</td>
                  <td className="px-4 py-2">{l.email ?? "—"}</td>
                  <td className="px-4 py-2">{l.phone ?? "—"}</td>
                  <td className="px-4 py-2">
                    <StatusBadge status={l.status} />
                  </td>
                  <td className="px-4 py-2 text-right text-xs text-muted-foreground">Open →</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {selected ? (
        <LeadPanel lead={selected} onClose={() => setSelected(null)} onStatus={setStatus} />
      ) : null}
    </div>
  );
}

function FilterTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`rounded-md px-3 py-1.5 text-xs font-medium capitalize transition-colors ${
        active
          ? "bg-primary text-primary-foreground"
          : "bg-muted text-muted-foreground hover:bg-muted/70"
      }`}
    >
      {label}
    </button>
  );
}

function StatusBadge({ status }: { status: LeadStatus }) {
  const cls: Record<LeadStatus, string> = {
    new: "bg-blue-100 text-blue-800",
    qualified: "bg-amber-100 text-amber-900",
    contacted: "bg-purple-100 text-purple-900",
    converted: "bg-green-100 text-green-900",
    archived: "bg-slate-100 text-slate-700",
  };
  return (
    <span className={`inline-block rounded px-2 py-0.5 text-xs capitalize ${cls[status]}`}>
      {status}
    </span>
  );
}

function LeadPanel({
  lead,
  onClose,
  onStatus,
}: {
  lead: Lead;
  onClose: () => void;
  onStatus: (l: Lead, s: LeadStatus) => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        className="h-full w-full max-w-md overflow-y-auto bg-background p-6 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between">
          <div>
            <h2 className="font-display text-xl font-semibold">
              {lead.full_name ?? lead.email ?? lead.phone ?? "Lead"}
            </h2>
            <p className="mt-1 text-xs text-muted-foreground">
              Received {new Date(lead.created_at).toLocaleString()}
            </p>
          </div>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground">
            ×
          </button>
        </div>

        <dl className="mt-6 space-y-3 text-sm">
          <Row label="Email" value={lead.email} />
          <Row label="Phone" value={lead.phone} />
          <Row label="Company" value={lead.company} />
          <Row label="Intent / notes" value={lead.notes} />
          <Row label="IP" value={lead.ip} mono />
          <Row
            label="Conversation"
            value={lead.conversation_id}
            mono
          />
        </dl>

        <div className="mt-6">
          <p className="text-xs font-medium uppercase text-muted-foreground">Consent</p>
          <p className="mt-1 text-xs text-muted-foreground">
            Given {lead.consent_at ? new Date(lead.consent_at).toLocaleString() : "—"}
          </p>
          <blockquote className="mt-2 whitespace-pre-wrap border-l-4 border-primary/60 bg-muted/40 p-3 text-sm italic">
            {lead.consent_text ?? "—"}
          </blockquote>
        </div>

        <div className="mt-6">
          <p className="mb-2 text-xs font-medium uppercase text-muted-foreground">Status</p>
          <div className="flex flex-wrap gap-2">
            {STATUSES.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => onStatus(lead, s)}
                className={`rounded px-2.5 py-1 text-xs capitalize ${
                  lead.status === s
                    ? "bg-primary text-primary-foreground"
                    : "border border-border text-muted-foreground hover:bg-muted"
                }`}
              >
                {s}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function Row({ label, value, mono }: { label: string; value: string | null; mono?: boolean }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className={mono ? "mt-0.5 font-mono text-xs break-all" : "mt-0.5"}>{value ?? "—"}</dd>
    </div>
  );
}