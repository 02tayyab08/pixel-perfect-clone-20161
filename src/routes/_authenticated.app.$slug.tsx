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
        <main className="p-8">
          <Outlet />
        </main>
      </div>
    </div>
  );
}