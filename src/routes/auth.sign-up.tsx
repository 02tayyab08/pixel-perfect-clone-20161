import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useServerFn } from "@tanstack/react-start";
import { useState } from "react";
import { toast } from "sonner";
import { signUpFn } from "@/lib/auth.functions";
import { AuthShell } from "@/components/auth-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export const Route = createFileRoute("/auth/sign-up")({
  head: () => ({ meta: [{ title: "Create your Salni account" }] }),
  component: SignUpPage,
});

function SignUpPage() {
  const signUp = useServerFn(signUpFn);
  const navigate = useNavigate();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setNotice(null);
    setLoading(true);
    try {
      const res = await signUp({ data: { email, password } });
      if (!res.ok) {
        setError(res.error);
        toast.error(res.error || "Sign up failed");
        return;
      }
      if (res.needsConfirmation) {
        setNotice("Check your inbox to confirm your email, then sign in.");
        return;
      }
      try {
        await navigate({ to: "/onboarding" });
      } catch (navErr) {
        console.error("post sign-up navigation failed", navErr);
        if (typeof window !== "undefined") window.location.assign("/onboarding");
      }
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Something went wrong creating your account.";
      console.error("sign-up failed", err);
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <AuthShell
      title="Create your account"
      subtitle="Set up a branded assistant for your business."
      footer={
        <>
          Already have an account?{" "}
          <Link to="/auth/sign-in" className="text-primary underline-offset-4 hover:underline">
            Sign in
          </Link>
        </>
      }
    >
      <form onSubmit={onSubmit} className="space-y-4">
        <div className="space-y-2">
          <Label htmlFor="email">Work email</Label>
          <Input
            id="email"
            type="email"
            autoComplete="email"
            required
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </div>
        <div className="space-y-2">
          <Label htmlFor="password">Password</Label>
          <Input
            id="password"
            type="password"
            autoComplete="new-password"
            minLength={8}
            required
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
          <p className="text-xs text-muted-foreground">Minimum 8 characters.</p>
        </div>
        {error ? <p className="text-sm text-destructive">{error}</p> : null}
        {notice ? <p className="text-sm text-primary">{notice}</p> : null}
        <Button type="submit" className="w-full" disabled={loading}>
          {loading ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}