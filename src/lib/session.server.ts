import { getCookie, setCookie, deleteCookie } from "@tanstack/react-start/server";
import { verifyAccessToken } from "./supabase.server";

const COOKIE_NAME = "salni_session";
// 30 days in seconds
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

type SessionPayload = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
  orgs?: Array<{ id: string; name: string; slug: string; role: string }>;
};

function encode(payload: SessionPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decode(raw: string): SessionPayload | null {
  try {
    const json = Buffer.from(raw, "base64url").toString("utf8");
    const parsed = JSON.parse(json) as SessionPayload;
    if (
      typeof parsed.access_token === "string" &&
      typeof parsed.refresh_token === "string" &&
      typeof parsed.expires_at === "number"
    ) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

export function setSessionCookie(payload: SessionPayload): void {
  const value = encode(payload);
  setCookie(COOKIE_NAME, value, {
    path: "/",
    httpOnly: true,
    sameSite: "none",
    secure: true,
    partitioned: true,
    maxAge: COOKIE_MAX_AGE,
  });
}

export function addSessionOrg(org: { id: string; name: string; slug: string; role: string }): void {
  const payload = readSessionCookieRaw();
  if (!payload) return;
  const orgs = payload.orgs ?? [];
  setSessionCookie({
    ...payload,
    orgs: [...orgs.filter((item) => item.slug !== org.slug && item.id !== org.id), org],
  });
}

export function getSessionOrgs(): Array<{ id: string; name: string; slug: string; role: string }> {
  const payload = readSessionCookieRaw();
  return payload?.orgs ?? [];
}

export function clearSessionCookie(): void {
  deleteCookie(COOKIE_NAME, { path: "/", sameSite: "none", secure: true, partitioned: true });
}

export function readSessionCookieRaw(): SessionPayload | null {
  const raw = getCookie(COOKIE_NAME);
  if (!raw) return null;
  return decode(raw);
}

export type CurrentUser = {
  userId: string;
  email: string | null;
  accessToken: string;
};

/**
 * Returns the authenticated user for the current request, verifying the access
 * token with Supabase. Returns null when there is no session or the token is
 * expired/invalid.
 */
export async function getCurrentUser(): Promise<CurrentUser | null> {
  const payload = readSessionCookieRaw();
  if (!payload) return null;
  const verified = await verifyAccessToken(payload.access_token);
  if (!verified) return null;
  return { userId: verified.userId, email: verified.email, accessToken: payload.access_token };
}

export async function requireCurrentUser(): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) throw new Error("Unauthorized");
  return user;
}