import { createClient, type SupabaseClient } from "@supabase/supabase-js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

/**
 * Anonymous Supabase client — used only to validate a user-provided bearer JWT
 * against `supabase.auth.getUser(jwt)`. Never authorizes writes.
 */
export function salniAnon(): SupabaseClient {
  return createClient(requireEnv("SALNI_SUPABASE_URL"), requireEnv("SALNI_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
  });
}

/**
 * Service-role Supabase client — bypasses RLS. Used for privileged reads/writes
 * and Storage operations. Never expose the returned client to the browser and
 * never authorize based on client-provided identifiers alone.
 */
export function salniService(): SupabaseClient {
  return createClient(
    requireEnv("SALNI_SUPABASE_URL"),
    requireEnv("SALNI_SUPABASE_SERVICE_ROLE_KEY"),
    {
      auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    },
  );
}

/**
 * Anon client with a user JWT attached — reads/writes go through RLS as that user.
 */
export function salniAsUser(accessToken: string): SupabaseClient {
  return createClient(requireEnv("SALNI_SUPABASE_URL"), requireEnv("SALNI_SUPABASE_ANON_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false, storage: undefined },
    global: { headers: { Authorization: `Bearer ${accessToken}` } },
  });
}

/**
 * Verifies the given JWT and returns the corresponding user id, or null.
 */
export async function verifyAccessToken(
  accessToken: string,
): Promise<{ userId: string; email: string | null } | null> {
  const anon = salniAnon();
  const { data, error } = await anon.auth.getUser(accessToken);
  if (error || !data?.user) return null;
  return { userId: data.user.id, email: data.user.email ?? null };
}