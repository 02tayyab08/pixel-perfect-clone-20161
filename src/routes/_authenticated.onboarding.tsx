import { createFileRoute, useNavigate, useRouter } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useEffect, useState } from "react";
import { createOrgFn, suggestSlugFn } from "@/lib/orgs.functions";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/_authenticated/onboarding")({
  head: () => ({ meta: [{ title: "Set up your organization — Salni" }] }),
  component: OnboardingPage,
});

function OnboardingPage() {
  const createOrg = useServerFn(createOrgFn);
  const suggestSlug = useServerFn(suggestSlugFn);
  const navigate = useNavigate();
  const router = useRouter();
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [slugTouched, setSlugTouched] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (slugTouched || name.trim().length < 2) return;
    const t = setTimeout(async () => {
      const res = await suggestSlug({ data: { name } });
      setSlug(res.slug);
    }, 250);
    return () => clearTimeout(t);
  }, [name, slugTouched, suggestSlug]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setSuggestions([]);
    setLoading(true);
    try {
      const res = await createOrg({ data: { name, slug } });
      if (!res.ok) {
        if (res.error === "slug_taken" && "suggestions" in res) {
          setError("That URL is taken. Try one of these:");
          setSuggestions(res.suggestions ?? []);
        } else {
          setError(res.error);
        }
        return;
      }
      await router.invalidate();
      await navigate({ to: "/app/$slug", params: { slug: res.slug } });
    } catch (err) {
      console.error("Create organization failed", err);
      setError(err instanceof Error ? err.message : "Could not create organization.");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="mx-auto max-w-lg px-6 py-12">
      <h1 className="font-display text-3xl font-semibold">Set up your organization</h1>
      <p className="mt-2 text-sm text-muted-foreground">
        This becomes your assistant&rsquo;s branded workspace. You can rename it later.
      </p>
      <form onSubmit={onSubmit} className="mt-8 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="name">Organization name</Label>
          <Input
            id="name"
            required
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Acme Trading LLC"
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="slug">URL slug</Label>
          <Input
            id="slug"
            required
            value={slug}
            onChange={(e) => {
              setSlug(e.target.value.toLowerCase());
              setSlugTouched(true);
            }}
            placeholder="acme"
            pattern="^[a-z0-9]+(?:-[a-z0-9]+)*$"
          />
          <p className="text-xs text-muted-foreground">
            Used in your widget URL, e.g. <span className="font-mono">/embed/{slug || "your-org"}</span>
          </p>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {suggestions.length > 0 ? (
          <div className="flex flex-wrap gap-2">
            {suggestions.map((s) => (
              <button
                key={s}
                type="button"
                onClick={() => {
                  setSlug(s);
                  setSlugTouched(true);
                }}
                className="rounded-full border border-border bg-card px-3 py-1 text-xs hover:border-primary"
              >
                {s}
              </button>
            ))}
          </div>
        ) : null}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Creating…" : "Create organization"}
        </Button>
      </form>
    </div>
  );
}