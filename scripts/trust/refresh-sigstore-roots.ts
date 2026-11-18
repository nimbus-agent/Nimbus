/**
 * `bun run trust:refresh-sigstore-roots` refreshes the Sigstore trusted roots baked into the
 * release from `gh attestation trusted-root` (OR-PROV-5). Run it before cutting a release when the
 * daily drift job reports that the live roots moved, then commit the regenerated module in a PR.
 * Output that does not validate is refused and nothing is written.
 */
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { ROOTS_MODULE_REL, renderRootsModule, validateTrustedRoots } from "./sigstore-roots-lib.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function runRefresh(deps: {
  readonly readLive: () => string;
  readonly modulePath: string;
  readonly write: (path: string, text: string) => void;
  readonly log: (line: string) => void;
}): number {
  try {
    const live = deps.readLive();
    const instances = validateTrustedRoots(live);
    deps.write(deps.modulePath, renderRootsModule(live));
    deps.log(
      `sigstore roots refreshed (${instances.join(", ")}). Commit ${ROOTS_MODULE_REL} in a PR.`,
    );
    return 0;
  } catch (e) {
    deps.log(`sigstore roots NOT refreshed: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}

/** `gh attestation trusted-root` output (`gh` on PATH: a maintainer tool the gateway never runs). */
export function readLiveRoots(): string {
  return execFileSync("gh", ["attestation", "trusted-root"], {
    encoding: "utf8",
    timeout: 60_000,
    windowsHide: true,
  });
}

if (import.meta.main) {
  process.exitCode = runRefresh({
    readLive: readLiveRoots,
    modulePath: join(REPO_ROOT, ROOTS_MODULE_REL),
    write: (p, t) => writeFileSync(p, t),
    log: (line) => console.log(line),
  });
}
