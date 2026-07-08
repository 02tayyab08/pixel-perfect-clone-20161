import { SetupInProgressError } from "./errors";
import { gemini, SHARED_STORE_DISPLAY_NAME, sleep } from "./gemini.server";
import { salniService } from "./supabase.server";

type ClaimResult =
  | { status: "ready"; store_name: string }
  | { status: "claimed" }
  | { status: "wait" };

async function callClaim(): Promise<ClaimResult> {
  const svc = salniService();
  const { data, error } = await svc.rpc("claim_store_bootstrap");
  if (error) throw new Error(`claim_store_bootstrap failed: ${error.message}`);
  // The RPC returns a row/JSON like { status, store_name }.
  const row = Array.isArray(data) ? data[0] : data;
  if (!row || typeof row !== "object" || !("status" in row)) {
    throw new Error("claim_store_bootstrap returned unexpected shape");
  }
  return row as ClaimResult;
}

async function createSharedStoreAndFinalize(): Promise<string> {
  const ai = gemini();
  // Create a File Search store on the shared project.
  const created = await ai.fileSearchStores.create({
    config: { displayName: SHARED_STORE_DISPLAY_NAME },
  });
  const storeName = created?.name;
  if (!storeName) throw new Error("Gemini fileSearchStores.create returned no name");

  const svc = salniService();
  const { error } = await svc.rpc("finalize_store_bootstrap", { p_store_name: storeName });
  if (error) {
    // Best-effort cleanup: try to remove the store we just created to avoid orphans.
    try {
      await ai.fileSearchStores.delete({ name: storeName, config: { force: true } });
    } catch {
      // Ignore cleanup failure; surfacing the original error is more useful.
    }
    throw new Error(`finalize_store_bootstrap failed: ${error.message}`);
  }
  return storeName;
}

/**
 * Returns the File Search store name to use for the given org.
 *
 * Behavior:
 *   - If `orgStoreOverride` is provided (org has a dedicated store) it is used verbatim.
 *   - Otherwise the shared bootstrap RPC decides:
 *     - `ready`   → returns the store name
 *     - `claimed` → this worker creates the store, finalizes, returns the name
 *     - `wait`    → sleep 1s and try once more; if still not ready, throw
 *                   SetupInProgressError so the caller returns 409 to the client.
 */
export async function bootstrapStore(orgStoreOverride?: string | null): Promise<string> {
  if (orgStoreOverride && orgStoreOverride.length > 0) return orgStoreOverride;

  const first = await callClaim();
  if (first.status === "ready") return first.store_name;
  if (first.status === "claimed") return await createSharedStoreAndFinalize();

  // wait: single retry per spec, then 409 to the caller
  await sleep(1000);
  const second = await callClaim();
  if (second.status === "ready") return second.store_name;
  if (second.status === "claimed") return await createSharedStoreAndFinalize();
  throw new SetupInProgressError(2000);
}