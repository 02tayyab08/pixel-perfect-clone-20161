// Client- and server-safe error shapes used across the app.

export const SETUP_IN_PROGRESS = "setup_in_progress" as const;

export type SetupInProgressPayload = {
  error: typeof SETUP_IN_PROGRESS;
  retry_after_ms: number;
};

export class SetupInProgressError extends Error {
  readonly retryAfterMs: number;
  constructor(retryAfterMs = 2000) {
    super("Workspace is still being set up");
    this.name = "SetupInProgressError";
    this.retryAfterMs = retryAfterMs;
  }
  toPayload(): SetupInProgressPayload {
    return { error: SETUP_IN_PROGRESS, retry_after_ms: this.retryAfterMs };
  }
}

export function isSetupInProgressPayload(value: unknown): value is SetupInProgressPayload {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { error?: unknown }).error === SETUP_IN_PROGRESS
  );
}

// Errors surfaced by the DB trigger on documents insert.
export const DOC_CAP_REACHED = "DOC_CAP_REACHED";
export const DOC_CAP_NO_PLAN = "DOC_CAP_NO_PLAN";

export class DocumentCapReachedError extends Error {
  constructor(readonly planName?: string, readonly cap?: number) {
    super("Document cap reached for current plan");
    this.name = "DocumentCapReachedError";
  }
}

export class DocumentCapNoPlanError extends Error {
  constructor() {
    super("Organization has no active plan");
    this.name = "DocumentCapNoPlanError";
  }
}

export class InactiveOrgError extends Error {
  constructor() {
    super("This assistant is currently unavailable.");
    this.name = "InactiveOrgError";
  }
}

export class RateLimitedError extends Error {
  constructor() {
    super("We're experiencing high demand — please try again in a little while.");
    this.name = "RateLimitedError";
  }
}