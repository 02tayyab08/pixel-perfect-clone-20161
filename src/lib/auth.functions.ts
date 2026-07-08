import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { salniAnon } from "./supabase.server";
import { clearSessionCookie, setSessionCookie } from "./session.server";

const CredsSchema = z.object({
  email: z.string().email().max(254),
  password: z.string().min(8).max(200),
});

function toSessionCookie(
  session: { access_token: string; refresh_token: string; expires_at?: number | null } | null,
) {
  if (!session) return null;
  const expiresAt = session.expires_at ?? Math.floor(Date.now() / 1000) + 3600;
  return {
    access_token: session.access_token,
    refresh_token: session.refresh_token,
    expires_at: expiresAt,
  };
}

export const signUpFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CredsSchema.parse(input))
  .handler(async ({ data }) => {
    const anon = salniAnon();
    const { data: result, error } = await anon.auth.signUp({
      email: data.email,
      password: data.password,
    });
    if (error) return { ok: false as const, error: error.message };
    const cookie = toSessionCookie(result.session);
    if (cookie) setSessionCookie(cookie);
    return {
      ok: true as const,
      needsConfirmation: !result.session,
      userId: result.user?.id ?? null,
    };
  });

export const signInFn = createServerFn({ method: "POST" })
  .inputValidator((input: unknown) => CredsSchema.parse(input))
  .handler(async ({ data }) => {
    const anon = salniAnon();
    const { data: result, error } = await anon.auth.signInWithPassword({
      email: data.email,
      password: data.password,
    });
    if (error || !result.session) {
      console.error("signInFn: supabase error", {
        message: error?.message,
        status: (error as { status?: number } | null)?.status,
        hasSession: !!result?.session,
      });
      const msg = error?.message ?? "Invalid credentials";
      const friendly = /email not confirmed/i.test(msg)
        ? "Please confirm your email address before signing in."
        : /invalid login credentials/i.test(msg)
          ? "Wrong email or password."
          : msg;
      return { ok: false as const, error: friendly };
    }
    const cookie = toSessionCookie(result.session);
    if (cookie) setSessionCookie(cookie);
    return { ok: true as const, userId: result.user?.id ?? null };
  });

export const signOutFn = createServerFn({ method: "POST" }).handler(async () => {
  clearSessionCookie();
  return { ok: true as const };
});