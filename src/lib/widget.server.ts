import { salniService } from "./supabase.server";

/**
 * SHA-256 hex, using WebCrypto so it works on Cloudflare Workers without
 * pulling in Node's crypto module.
 */
export async function sha256Hex(input: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Extract the caller IP from headers a Worker sees. Falls back to first
 * X-Forwarded-For hop, then to empty string (which the rate-limiter still
 * scopes by end_user_ref + org anyway).
 */
export function extractIp(headers: Headers): string {
  const cf = headers.get("cf-connecting-ip");
  if (cf) return cf.trim();
  const xff = headers.get("x-forwarded-for");
  if (xff) return xff.split(",")[0]?.trim() ?? "";
  const real = headers.get("x-real-ip");
  return real?.trim() ?? "";
}

/** Origin allowlist check: null/empty allowed_domains ⇒ allow all. */
export function originAllowed(originHeader: string | null, allowed: string[] | null): boolean {
  if (!allowed || allowed.length === 0) return true;
  if (!originHeader) return false;
  let host: string;
  try {
    host = new URL(originHeader).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((raw) => {
    const d = raw.trim().toLowerCase();
    if (!d) return false;
    if (d === host) return true;
    // Support "*.example.com" wildcards and bare-suffix "example.com".
    if (d.startsWith("*.")) return host.endsWith(d.slice(1));
    return host === d || host.endsWith("." + d);
  });
}

export type ThrottleReason =
  | "ref_rate"
  | "org_hourly"
  | "ip_rate"
  | "inactive"
  | "origin";

export type GateResult =
  | { ok: true }
  | { ok: false; reason: ThrottleReason; message: string; status: number };

const THROTTLE_MSG =
  "We're experiencing high demand — please try again in a little while.";

/**
 * MANDATORY gate chain before any Gemini spend on the widget path:
 *   is_active → Origin vs allowed_domains → ref rate → org hourly ceiling → ip rate
 * Any failure short-circuits with zero downstream Gemini cost.
 */
export async function runWidgetGates(args: {
  orgId: string;
  isActive: boolean;
  allowedDomains: string[] | null;
  originHeader: string | null;
  endUserRef: string;
  ip: string;
}): Promise<GateResult> {
  if (!args.isActive) {
    return {
      ok: false,
      reason: "inactive",
      status: 503,
      message: "This assistant is currently unavailable.",
    };
  }

  if (!originAllowed(args.originHeader, args.allowedDomains)) {
    return {
      ok: false,
      reason: "origin",
      status: 403,
      message: "This site is not authorized to embed this assistant.",
    };
  }

  const svc = salniService();
  const refKey = `ref:${args.endUserRef}`;
  const { data: refOk, error: refErr } = await svc.rpc("check_rate_limit", {
    p_org: args.orgId,
    p_key: refKey,
    p_limit: 20,
  });
  if (refErr) {
    console.error("[widget-gates] check_rate_limit(ref) failed", refErr);
    return { ok: false, reason: "ref_rate", status: 429, message: THROTTLE_MSG };
  }
  if (refOk === false) {
    return { ok: false, reason: "ref_rate", status: 429, message: THROTTLE_MSG };
  }

  const { data: orgOk, error: orgErr } = await svc.rpc("check_org_hourly_ceiling", {
    p_org: args.orgId,
    p_limit: 300,
  });
  if (orgErr) {
    console.error("[widget-gates] check_org_hourly_ceiling failed", orgErr);
    return { ok: false, reason: "org_hourly", status: 429, message: THROTTLE_MSG };
  }
  if (orgOk === false) {
    return { ok: false, reason: "org_hourly", status: 429, message: THROTTLE_MSG };
  }

  const salt = process.env.IP_HASH_SALT ?? "";
  const ipHash = args.ip ? await sha256Hex(args.ip + salt) : "unknown";
  const { data: ipOk, error: ipErr } = await svc.rpc("check_rate_limit", {
    p_org: args.orgId,
    p_key: `ip:${ipHash}`,
    p_limit: 120,
  });
  if (ipErr) {
    console.error("[widget-gates] check_rate_limit(ip) failed", ipErr);
    return { ok: false, reason: "ip_rate", status: 429, message: THROTTLE_MSG };
  }
  if (ipOk === false) {
    return { ok: false, reason: "ip_rate", status: 429, message: THROTTLE_MSG };
  }

  return { ok: true };
}

/**
 * Sentinel phrase from the widget consent template. Presence of this exact
 * substring in a prior assistant message means the model already asked once
 * this conversation and must not ask again unless the visitor volunteers.
 */
export const CONSENT_SENTINEL = "By sharing it you agree that";