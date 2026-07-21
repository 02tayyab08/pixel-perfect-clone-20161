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
  | "origin"
  | "rpc_error";

export type GateResult =
  | { ok: true }
  | { ok: false; reason: ThrottleReason; message: string; status: number };

const THROTTLE_MSG =
  "We're experiencing high demand — please try again in a little while.";

/**
 * MANDATORY gate chain before any Gemini spend on the widget path:
 *   is_active → Origin vs allowed_domains → ref rate → org hourly ceiling → ip rate
 * Any failure short-circuits with zero downstream Gemini cost.
 *
 * RPC failures are returned as reason:"rpc_error" (status 500) — never as a
 * throttle — so infra mistakes are not masked behind THROTTLE_MSG.
 */
export async function runWidgetGates(args: {
  orgId: string;
  isActive: boolean;
  allowedDomains: string[] | null;
  originHeader: string | null;
  endUserRef: string;
  ip: string;
}): Promise<GateResult> {
  console.log(
    `[widget-gates] start orgId=${args.orgId} endUserRef=${JSON.stringify(args.endUserRef)} ` +
      `endUserRefType=${typeof args.endUserRef} origin=${JSON.stringify(args.originHeader)} ` +
      `allowedDomains=${JSON.stringify(args.allowedDomains)} ip=${JSON.stringify(args.ip)}`,
  );

  // 1. is_active
  const activeOk = args.isActive === true;
  console.log(`[widget-gates] is_active input=${args.isActive} ok=${activeOk}`);
  if (!activeOk) {
    return {
      ok: false,
      reason: "inactive",
      status: 503,
      message: "This assistant is currently unavailable.",
    };
  }

  // 2. allowed_domains / Origin
  const originOk = originAllowed(args.originHeader, args.allowedDomains);
  console.log(
    `[widget-gates] origin check origin=${JSON.stringify(args.originHeader)} ` +
      `allowedDomains=${JSON.stringify(args.allowedDomains)} ok=${originOk}`,
  );
  if (!originOk) {
    return {
      ok: false,
      reason: "origin",
      status: 403,
      message: "This site is not authorized to embed this assistant.",
    };
  }

  const svc = salniService();

  // 3. check_rate_limit(ref)
  const refSubject = `ref:${args.endUserRef}`;
  const { data: refOk, error: refErr } = await svc.rpc("check_rate_limit", {
    p_org: args.orgId,
    p_subject: refSubject,
    p_limit: 20,
  });
  if (refErr) {
    console.error(
      `[widget-gates] check_rate_limit(ref) RPC_ERROR subject=${refSubject} limit=20 ` +
        `err=${refErr.message} code=${(refErr as { code?: string }).code ?? ""} ` +
        `hint=${(refErr as { hint?: string }).hint ?? ""}`,
    );
    return {
      ok: false,
      reason: "rpc_error",
      status: 500,
      message: `Rate-limit check failed (ref): ${refErr.message}`,
    };
  }
  console.log(
    `[widget-gates] check_rate_limit(ref) subject=${refSubject} limit=20 result=${JSON.stringify(refOk)} ok=${refOk !== false}`,
  );
  if (refOk === false) {
    return { ok: false, reason: "ref_rate", status: 429, message: THROTTLE_MSG };
  }

  // 4. check_org_hourly_ceiling
  const { data: orgOk, error: orgErr } = await svc.rpc("check_org_hourly_ceiling", {
    p_org: args.orgId,
    p_limit: 300,
  });
  if (orgErr) {
    console.error(
      `[widget-gates] check_org_hourly_ceiling RPC_ERROR orgId=${args.orgId} limit=300 ` +
        `err=${orgErr.message} code=${(orgErr as { code?: string }).code ?? ""} ` +
        `hint=${(orgErr as { hint?: string }).hint ?? ""}`,
    );
    return {
      ok: false,
      reason: "rpc_error",
      status: 500,
      message: `Hourly ceiling check failed: ${orgErr.message}`,
    };
  }
  console.log(
    `[widget-gates] check_org_hourly_ceiling orgId=${args.orgId} limit=300 result=${JSON.stringify(orgOk)} ok=${orgOk !== false}`,
  );
  if (orgOk === false) {
    return { ok: false, reason: "org_hourly", status: 429, message: THROTTLE_MSG };
  }

  // 5. check_rate_limit(ip)
  const salt = process.env.IP_HASH_SALT ?? "";
  const ipHash = args.ip ? await sha256Hex(args.ip + salt) : "unknown";
  const ipSubject = `ip:${ipHash}`;
  const { data: ipOk, error: ipErr } = await svc.rpc("check_rate_limit", {
    p_org: args.orgId,
    p_subject: ipSubject,
    p_limit: 120,
  });
  if (ipErr) {
    console.error(
      `[widget-gates] check_rate_limit(ip) RPC_ERROR subject=${ipSubject} limit=120 ` +
        `err=${ipErr.message} code=${(ipErr as { code?: string }).code ?? ""} ` +
        `hint=${(ipErr as { hint?: string }).hint ?? ""}`,
    );
    return {
      ok: false,
      reason: "rpc_error",
      status: 500,
      message: `Rate-limit check failed (ip): ${ipErr.message}`,
    };
  }
  console.log(
    `[widget-gates] check_rate_limit(ip) subject=${ipSubject} limit=120 result=${JSON.stringify(ipOk)} ok=${ipOk !== false}`,
  );
  if (ipOk === false) {
    return { ok: false, reason: "ip_rate", status: 429, message: THROTTLE_MSG };
  }

  console.log(`[widget-gates] all gates passed orgId=${args.orgId}`);
  return { ok: true };
}

/**
 * Sentinel phrases from the widget consent templates (EN / AR). Presence of
 * either exact substring in a prior assistant message means the model already
 * asked once this conversation and must not ask again unless the visitor
 * volunteers.
 */
export const CONSENT_SENTINEL = "By sharing it you agree that";
export const CONSENT_SENTINEL_AR = "فإنك توافق على أن تحتفظ";
