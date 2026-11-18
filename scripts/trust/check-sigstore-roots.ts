/**
 * `bun run audit:sigstore-roots`: the baked Sigstore trusted roots module is exactly what the
 * refresh script writes, and its content validates (two roots, one per instance). Offline. With
 * `--live` (the daily drift job) it also compares the baked roots with `gh attestation
 * trusted-root` and fails when they differ, so a rotation is refreshed before the next release.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { BAKED_SIGSTORE_TRUSTED_ROOTS } from "../../packages/gateway/src/extensions/registry/sigstore-trusted-roots.ts";
import { readLiveRoots } from "./refresh-sigstore-roots.ts";
import { ROOTS_MODULE_REL, renderRootsModule, validateTrustedRoots } from "./sigstore-roots-lib.ts";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

export function runCheck(deps: {
  readonly baked: string;
  readonly moduleText: string;
  readonly live?: () => string;
  readonly log: (line: string) => void;
}): number {
  const findings: string[] = [];
  try {
    validateTrustedRoots(deps.baked);
  } catch (e) {
    findings.push(`the baked roots do not validate: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (deps.moduleText !== renderRootsModule(deps.baked)) {
    findings.push(`${ROOTS_MODULE_REL} is not what the refresh script writes (hand-edited?)`);
  }
  if (deps.live !== undefined) {
    try {
      if (deps.live() !== deps.baked) {
        findings.push(
          "the live Sigstore roots differ from the baked ones: run `bun run trust:refresh-sigstore-roots` and open a PR",
        );
      }
    } catch (e) {
      findings.push(`could not read the live roots: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  for (const f of findings) deps.log(`audit:sigstore-roots: ${f}`);
  if (findings.length === 0) deps.log("audit:sigstore-roots: ok");
  return findings.length === 0 ? 0 : 1;
}

if (import.meta.main) {
  process.exitCode = runCheck({
    baked: BAKED_SIGSTORE_TRUSTED_ROOTS,
    moduleText: readFileSync(join(REPO_ROOT, ROOTS_MODULE_REL), "utf8"),
    ...(process.argv.includes("--live") && { live: readLiveRoots }),
    log: (line) => console.log(line),
  });
}
