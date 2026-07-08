import { getRequestHeader, setResponseHeader } from "@tanstack/react-start/server";
import { verifyAccessToken } from "./supabase.server";

const COOKIE_NAME = "salni_session";
// 30 days in seconds
const COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

type SessionPayload = {
  access_token: string;
  refresh_token: string;
  expires_at: number; // unix seconds
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
  const cookie = [
    `${COOKIE_NAME}=${value}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Secure",
    `Max-Age=${COOKIE_MAX_AGE}`,
  ].join("; ");
  setResponseHeader("Set-Cookie", cookie);
}

export function clearSessionCookie(): void {
  setResponseHeader(
    "Set-Cookie",
    `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=0`,
  );
}

function readCookieHeader(): string | null {
  return getRequestHeader("cookie") ?? null;
}

export function readSessionCookieRaw(): SessionPayload | null {
  const header = readCookieHeader();
  if (!header) return null;
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf("=");
    if (eq < 0) continue;
    if (part.slice(0, eq) === COOKIE_NAME) {
      return decode(part.slice(eq + 1));
    }
  }
  return null;
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