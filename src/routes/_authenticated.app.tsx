import { createFileRoute, Link, redirect } from "@tanstack/react-router";

export const Route = createFileRoute("/_authenticated/app")({
  beforeLoad: ({ context, location }) => {
    if (location.pathname !== "/app") return;
    const orgs = (context as { session: { orgs: Array<{ slug: string }> } }).session.orgs;
    if (orgs.length === 0) {
      throw redirect({ to: "/onboarding" });
    }
    if (orgs.length === 1) {
      throw redirect({ to: "/app/$slug", params: { slug: orgs[0].slug } });
    }
  },
  component: OrgChooser,
});

function OrgChooser() {
  const { session } = Route.useRouteContext() as {
    session: { orgs: Array<{ id: string; name: string; slug: string }> };
  };
  return (
    <div className="mx-auto max-w-md px-6 py-16">
      <h1 className="font-display text-2xl font-semibold">Choose an organization</h1>
      <ul className="mt-6 space-y-2">
        {session.orgs.map((o) => (
          <li key={o.id}>
            <Link
              to="/app/$slug"
              params={{ slug: o.slug }}
              className="block rounded-lg border border-border bg-card px-4 py-3 hover:border-primary"
            >
              <span className="font-medium">{o.name}</span>
              <span className="ml-2 text-xs text-muted-foreground">{o.slug}</span>
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}