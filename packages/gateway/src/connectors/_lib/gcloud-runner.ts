import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { spawnCapture } from "../../platform/spawn-capture.ts";

/**
 * Spawn a `gcloud` CLI command with Application Default Credentials pointed at
 * `credPath` (via `GOOGLE_APPLICATION_CREDENTIALS`), capturing stdout. Returns
 * `{ ok, text }`; a missing `gcloud`, a non-zero exit and a spawn failure all come back as
 * `ok: false`, so a Syncable caller degrades gracefully. The env is scoped through
 * `extensionProcessEnv` (invariant I1). Each connector keeps its own argv builder +
 * credential loader.
 *
 * There is deliberately NO try/catch here. It had one while this spawned through `Bun.spawn`,
 * which throws on a missing executable; `spawnCapture` never rejects — a synchronous throw, an
 * `error` event and a non-zero exit all resolve to `ok: false`, and that is its documented
 * contract with its own tests. Keeping the catch would leave a branch no test can reach, which
 * is how dead code survives a coverage gate by being excluded rather than deleted.
 */
export async function runGcloudCommand(
  argv: string[],
  credPath: string,
): Promise<{ ok: boolean; text: string }> {
  const r = await spawnCapture(argv, {
    env: extensionProcessEnv({ GOOGLE_APPLICATION_CREDENTIALS: credPath }),
  });
  return { ok: r.ok, text: r.stdout };
}
