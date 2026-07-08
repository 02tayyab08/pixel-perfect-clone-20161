import { createFileRoute, Link } from "@tanstack/react-router";
import { Button } from "@/components/ui/button";
import { ArrowRight, FileSearch, Quote, Shield } from "lucide-react";

export const Route = createFileRoute("/")({
  component: Landing,
});

function Landing() {
  return (
    <div className="min-h-screen bg-background text-foreground">
      <header className="mx-auto flex max-w-6xl items-center justify-between px-6 py-6">
        <Link to="/" className="flex items-center gap-2 font-display text-xl font-semibold">
          <span className="grid h-8 w-8 place-items-center rounded-md bg-primary text-primary-foreground">
            S
          </span>
          Salni
        </Link>
        <nav className="flex items-center gap-2">
          <Button asChild variant="ghost">
            <Link to="/auth/sign-in">Sign in</Link>
          </Button>
          <Button asChild>
            <Link to="/auth/sign-up">
              Get started <ArrowRight className="ml-1 h-4 w-4" />
            </Link>
          </Button>
        </nav>
      </header>

      <main className="mx-auto max-w-6xl px-6 py-16">
        <section className="grid gap-10 md:grid-cols-[1.2fr_1fr] md:items-center">
          <div>
            <p className="mb-4 inline-flex items-center gap-2 rounded-full border border-border bg-card px-3 py-1 text-xs font-medium text-muted-foreground">
              For UAE SMBs · Bilingual EN / AR
            </p>
            <h1 className="font-display text-5xl leading-[1.05] tracking-tight md:text-6xl">
              A branded AI assistant that only answers from{" "}
              <span className="text-primary">your documents</span>.
            </h1>
            <p className="mt-6 max-w-xl text-lg text-muted-foreground">
              Upload your policies, manuals, and menus. Salni gives your staff and customers
              grounded, cited answers — never guesses. When the answer isn&rsquo;t in your
              documents, it says so.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Button asChild size="lg">
                <Link to="/auth/sign-up">
                  Start free <ArrowRight className="ml-1 h-4 w-4" />
                </Link>
              </Button>
              <Button asChild size="lg" variant="outline">
                <Link to="/auth/sign-in">I have an account</Link>
              </Button>
            </div>
          </div>

          <div className="rounded-2xl border border-border bg-card p-6 shadow-sm">
            <div className="rounded-lg bg-muted p-4 text-sm">
              <p className="font-medium">Guest</p>
              <p className="text-muted-foreground">What&rsquo;s your refund policy?</p>
            </div>
            <div className="mt-3 rounded-lg bg-accent/40 p-4 text-sm">
              <p className="font-medium text-accent-foreground">Assistant</p>
              <p className="mt-1">
                Refunds are processed within 14 days for unused items in original packaging.
              </p>
              <p className="mt-2 inline-flex items-center gap-1 rounded-md bg-background px-2 py-1 text-xs text-muted-foreground">
                <Quote className="h-3 w-3" /> refund-policy.pdf · page 2
              </p>
            </div>
          </div>
        </section>

        <section className="mt-24 grid gap-6 md:grid-cols-3">
          {[
            {
              icon: FileSearch,
              title: "Grounded, cited answers",
              body: "Every answer links back to the exact source document and page.",
            },
            {
              icon: Shield,
              title: "Strict document scope",
              body: 'No hallucinations. Off-topic questions get: "I don\'t have that in the provided documents."',
            },
            {
              icon: ArrowRight,
              title: "Embed anywhere",
              body: "Drop a single script into your site to add a branded, bilingual chat widget.",
            },
          ].map(({ icon: Icon, title, body }) => (
            <div key={title} className="rounded-2xl border border-border bg-card p-6">
              <Icon className="h-6 w-6 text-primary" />
              <h3 className="mt-4 font-display text-lg font-semibold">{title}</h3>
              <p className="mt-2 text-sm text-muted-foreground">{body}</p>
            </div>
          ))}
        </section>
      </main>

      <footer className="border-t border-border">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-8 text-sm text-muted-foreground">
          <p>© {new Date().getFullYear()} Salni</p>
          <p>Made for the UAE</p>
        </div>
      </footer>
    </div>
  );
}
