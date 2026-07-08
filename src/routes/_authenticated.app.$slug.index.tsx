import { createFileRoute, Link } from "@tanstack/react-router";
import { FileText, MessageSquare } from "lucide-react";

export const Route = createFileRoute("/_authenticated/app/$slug/")({
  component: OverviewPage,
});

function OverviewPage() {
  const { org } = Route.useRouteContext() as { org: { name: string; slug: string } };
  const steps = [
    {
      title: "Upload documents",
      body: "Add PDFs, Word docs, spreadsheets, or menus. Up to 50 MB per file.",
      to: "/app/$slug/documents" as const,
      icon: FileText,
    },
    {
      title: "Wait for indexing",
      body: "Salni indexes your documents securely — usually within a minute.",
      icon: FileText,
    },
    {
      title: "Ask a question",
      body: "Try your assistant in the chat playground. Every answer is cited.",
      to: "/app/$slug/chat" as const,
      icon: MessageSquare,
    },
  ];

  return (
    <div>
      <h1 className="font-display text-3xl font-semibold">Welcome to {org.name}</h1>
      <p className="mt-2 text-muted-foreground">
        Three steps to your first grounded answer.
      </p>
      <ol className="mt-8 grid gap-4 md:grid-cols-3">
        {steps.map((s, i) => {
          const content = (
            <div className="h-full rounded-2xl border border-border bg-card p-6 transition-colors hover:border-primary">
              <p className="text-xs font-medium text-muted-foreground">Step {i + 1}</p>
              <h3 className="mt-2 font-display text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{s.body}</p>
            </div>
          );
          return (
            <li key={s.title}>
              {s.to ? (
                <Link to={s.to} params={{ slug: org.slug }} className="block h-full">
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