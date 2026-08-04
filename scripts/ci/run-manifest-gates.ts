// scripts/ci/run-manifest-gates.ts — runs the PREFLIGHT_GATES manifest, INSIDE the container
// launched by verify-in-docker.sh, at the given tier ("fast" | "full"). Gate commands come
// straight from the manifest's `cmd` arrays: nothing here is retyped, because in #1038
// `audit:any` was run from memory without its `--check` flag and silently exited 0.
import { CI_ONLY_GATES, selectGates } from "../lib/preflight-gates.ts";

const tier = process.argv[2] === "full" ? "full" : "fast";
const skip = new Set(CI_ONLY_GATES);
const failures: string[] = [];
const skipped: string[] = [];

/**
 * Gate ids are NOT uniformly at cmd[2]. The manifest holds both shapes:
 *   ["bun", "run", "audit:any", "--check"]  -> id is cmd[2]
 *   ["bunx", "jscpd", "packages"]           -> id is cmd[1]
 * Reading cmd[2] blindly would yield "packages" for the jscpd gate, so a `bunx` gate could never
 * be matched against CI_ONLY_GATES — and a gate whose third argument happened to collide with a
 * CI_ONLY name would be wrongly skipped, silently reducing coverage.
 */
function gateId(cmd: readonly string[]): string {
  if (cmd[0] === "bunx") return cmd[1] ?? "";
  return cmd[2] ?? "";
}

for (const gate of selectGates(tier)) {
  const id = gateId(gate.cmd) || gate.name;
  if (skip.has(id)) {
    skipped.push(gate.name);
    continue;
  }
  const p = Bun.spawnSync([...gate.cmd], { stdout: "inherit", stderr: "inherit" });
  const ok = p.exitCode === 0;
  console.log(`${ok ? "ok  " : "FAIL"}  ${gate.name}`);
  if (!ok) failures.push(gate.name);
}

if (skipped.length > 0) console.log(`\nskipped (CI_ONLY_GATES): ${skipped.join(", ")}`);
console.log(failures.length === 0 ? "\nALL GATES PASS" : `\nFAILED: ${failures.join(" | ")}`);
process.exit(failures.length === 0 ? 0 : 1);
