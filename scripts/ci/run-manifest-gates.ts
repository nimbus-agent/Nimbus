// scripts/ci/run-manifest-gates.ts — runs the PREFLIGHT_GATES manifest, INSIDE the container
// launched by verify-in-docker.sh, at the given tier ("fast" | "full"). Gate commands come
// straight from the manifest's `cmd` arrays: nothing here is retyped, because in #1038
// `audit:any` was run from memory without its `--check` flag and silently exited 0.
//
// Every gate in the selected tier runs here. CI_ONLY_GATES is deliberately NOT used as a
// skip-list: that list means "runs in a CI *workflow*, not one of the local preflight tiers"
// (mostly network-/gh-auth-only org-drift-sweep audits, which never appear in PREFLIGHT_GATES
// anyway). This container IS Linux CI — treating CI_ONLY_GATES as a skip-list here was a
// category error that silently disabled the one gate this script most needs to run:
// `coverage-floor: build lcov` shares its underlying script id
// (`audit:coverage-floor:build-lcov`) with a CI_ONLY_GATES entry that exists for an unrelated
// reason (it's composed into the FULL-tier `audit:coverage-floor` gate on the *host* preflight,
// where Docker isn't available), so it was being skipped here too — leaving
// `audit:coverage-floor` unable to ever pass (`lcov not found at coverage/lcov.info`).
import { selectGates } from "../lib/preflight-gates.ts";

const tier = process.argv[2] === "full" ? "full" : "fast";
const failures: string[] = [];

for (const gate of selectGates(tier)) {
  const p = Bun.spawnSync([...gate.cmd], { stdout: "inherit", stderr: "inherit" });
  const ok = p.exitCode === 0;
  console.log(`${ok ? "ok  " : "FAIL"}  ${gate.name}`);
  if (!ok) failures.push(gate.name);
}

console.log(failures.length === 0 ? "\nALL GATES PASS" : `\nFAILED: ${failures.join(" | ")}`);
process.exit(failures.length === 0 ? 0 : 1);
