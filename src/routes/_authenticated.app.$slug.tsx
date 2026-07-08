import { createFileRoute, Link, Outlet, redirect, useMatchRoute } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { signOutFn } from "@/lib/auth.functions";
import { FileText, LayoutDashboard, MessageSquare, LogOut } from "lucide-react";
import { Button } from "@/components/ui/button";

export const Route = createFileRoute("/_authenticated/app/$slug")({
  beforeLoad: ({ context, params }) => {
    const orgs = (context as { session: { orgs: Array<{ id: string; slug: string; name: string }> } })
      .session.orgs;
    const org = orgs.find((o) => o.slug === params.slug);
    if (!org) throw redirect({ to: "/app" });
    return { org };
  },
  component: DashboardShell,
});

function DashboardShell() {
  const { org } = Route.useRouteContext() as {
    org: { id: string; slug: string; name: string };
  };
  const signOut = useServerFn(signOutFn);
  const matchRoute = useMatchRoute();
  const isDocuments = !!matchRoute({
    to: "/app/$slug/documents",
    params: { slug: org.slug },
  });
  const isChat = !!matchRoute({ to: "/app/$slug/chat", params: { slug: org.slug } });

  const nav = [
    { to: "/app/$slug", label: "Overview", icon: LayoutDashboard, end: true },
    { to: "/app/$slug/documents", label: "Documents", icon: FileText, end: false },
    { to: "/app/$slug/chat", label: "Chat", icon: MessageSquare, end: false },
  ] as const;

  async function onSignOut() {
    await signOut();
    window.location.href = "/";
  }

  return (
    <div className="min-h-screen bg-background text-foreground">
      <div className="mx-auto grid min-h-screen max-w-7xl grid-cols-[240px_1fr]">
        <aside className="flex flex-col border-r border-border bg-sidebar text-sidebar-foreground">
          <div className="p-6">
            <Link to="/" className="flex items-center gap-2 font-display text-lg font-semibold">
              <span className="grid h-7 w-7 place-items-center rounded-md bg-primary text-primary-foreground text-sm">
                S
              </span>
              Salni
            </Link>
            <p className="mt-4 text-xs uppercase tracking-wider text-muted-foreground">
              Organization
            </p>
            <p className="mt-1 truncate font-medium">{org.name}</p>
            <p className="text-xs text-muted-foreground">/{org.slug}</p>
          </div>
          <nav className="px-3">
            {nav.map((item) => {
              const active = !!matchRoute({
                to: item.to,
                params: { slug: org.slug },
                fuzzy: !item.end,
              });
              return (
                <Link
                  key={item.to}
                  to={item.to}
                  params={{ slug: org.slug }}
                  className={`mb-1 flex items-center gap-2 rounded-md px-3 py-2 text-sm transition-colors ${
                    active
                      ? "bg-sidebar-accent text-sidebar-accent-foreground"
                      : "hover:bg-sidebar-accent/60"
                  }`}
                >
                  <item.icon className="h-4 w-4" />
                  {item.label}
                </Link>
              );
            })}
          </nav>
          <div className="mt-auto p-3">
            <Button variant="ghost" size="sm" className="w-full justify-start" onClick={onSignOut}>
              <LogOut className="mr-2 h-4 w-4" /> Sign out
            </Button>
          </div>
        </aside>
        <main className="p-8">{isDocuments || isChat ? <Outlet /> : <Overview org={org} />}</main>
      </div>
    </div>
  );
}

function Overview({ org }: { org: { name: string; slug: string } }) {
  const steps = [
    {
      title: "Upload documents",
      body: "Add PDFs, Word docs, spreadsheets, or menus. Up to 50 MB per file.",
      to: "/app/$slug/documents" as const,
    },
    {
      title: "Wait for indexing",
      body: "Salni indexes your documents securely — usually within a minute.",
    },
    {
      title: "Ask a question",
      body: "Try your assistant in the chat playground. Every answer is cited.",
      to: "/app/$slug/chat" as const,
    },
  ];

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold">Welcome to {org.name}</h1>
      <p className="mt-2 text-muted-foreground">Three steps to your first grounded answer.</p>
      <ol className="mt-8 grid gap-4 md:grid-cols-3">
        {steps.map((step, index) => {
          const content = (
            <div className="h-full rounded-2xl border border-border bg-card p-6 transition-colors hover:border-primary">
              <p className="text-xs font-medium text-muted-foreground">Step {index + 1}</p>
              <h3 className="mt-2 font-display text-lg font-semibold">{step.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{step.body}</p>
            </div>
          );
          return (
            <li key={step.title}>
              {step.to ? (
                <Link to={step.to} params={{ slug: org.slug }} className="block h-full">
                  {content}
                </Link>
              ) : (
                content
              )}
            </li>
          );
        })}
      </ol>
    </div>
  );
}