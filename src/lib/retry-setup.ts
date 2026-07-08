import { isSetupInProgressPayload } from "./errors";

/**
 * Client helper: runs `fn`, and when it returns a `setup_in_progress` payload
 * OR resolves to a Response with 409 JSON body of the same shape, retries with
 * jittered backoff up to ~30 seconds total. Reports a "settingUp" callback so
 * the UI can render a "Setting up your workspace…" state instead of erroring.
 */
export async function retryWhileSetup<T>(
  fn: () => Promise<T>,
  opts: { onSettingUp?: (attempt: number) => void; maxTotalMs?: number } = {},
): Promise<T | { error: "setup_in_progress" }> {
  const maxTotal = opts.maxTotalMs ?? 30_000;
  const started = Date.now();
  let attempt = 0;
  while (true) {
    attempt++;
    const result = await fn();
    const asAny = result as unknown as {
      ok?: boolean;
      error?: string;
      retryAfterMs?: number;
    };
    const isSetup =
      isSetupInProgressPayload(result as never) ||
      (asAny && asAny.ok === false && asAny.error === "setup_in_progress");
    if (!isSetup) return result;

    const elapsed = Date.now() - started;
    if (elapsed >= maxTotal) return { error: "setup_in_progress" };

    opts.onSettingUp?.(attempt);
    const base = asAny?.retryAfterMs ?? 2000;
    const jitter = Math.floor(Math.random() * 500);
    await new Promise((r) => setTimeout(r, Math.min(base + jitter, maxTotal - elapsed)));
  }
}