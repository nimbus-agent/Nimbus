import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { spawnCapture } from "../../platform/spawn-capture.ts";

/**
 * Spawn a `gcloud` CLI command with Application Default Credentials pointed at
 * `credPath` (via `GOOGLE_APPLICATION_CREDENTIALS`), capturing stdout. Returns
 * `{ ok: code === 0, text }`, or `{ ok: false, text: "" }` if the spawn throws
 * (gcloud missing, etc.) — never throws past this boundary, so a Syncable caller
 * degrades gracefully. The env is scoped through `extensionProcessEnv` (invariant
 * I1). Byte-equivalent to the per-connector `gcloud…List` spawn wrappers it
 * replaces in cloud-logging-sync and vertex-ai-sync; each connector keeps its own
 * argv builder + credential loader.
 */
export async function runGcloudCommand(
  argv: string[],
  credPath: string,
): Promise<{ ok: boolean; text: string }> {
  try {
    const r = await spawnCapture(argv, {
      env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: credPath }),
    });
    return { ok: r.ok, text: r.stdout };
  } catch {
    return { ok: false, text: "" };
  }
}
