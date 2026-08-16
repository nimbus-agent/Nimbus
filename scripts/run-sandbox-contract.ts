#!/usr/bin/env bun
import { relative, resolve } from "node:path";
/**
 * Run the per-connector sandbox contract suite.
 *
 * Every connector's `test/sandbox.test.ts` (see CONNECTOR_GLOB below) is gated on
 * `describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])`. Before this script that variable
 * was read in 79 places and set in none — no workflow, no script, no documented command —
 * so the suite had no invocation path at all and the exclusion notes that credited it were
 * describing something that never ran.
 *
 * It stays off by default for a real reason, not an oversight: `runSandboxContractTests`
 * forks a probe that opens a REAL connection to the connector's first declared network host
 * (`permissions.network[0]`) to prove the sandbox permits a listed host, and on non-Windows
 * a second probe that proves an unlisted host is refused. That is live outbound traffic to
 * ~79 vendor endpoints, so it belongs behind an explicit opt-in rather than in `bun test`.
 *
 * Consequences worth knowing before reading a red result:
 *   - A host that does not resolve from your network fails as `exit 6` / `exit 2`, which is
 *     an environment result, not a manifest defect. Check the host resolves before filing.
 *   - The unlisted-host probe is skipped on win32 by the SDK, so a Windows-only green run
 *     has proved the positive half of the contract only.
 *
 * Env passthrough is explicit because `NIMBUS_TEST_HARNESS=1 bun test …` is a POSIX-shell
 * idiom that is a parse error in PowerShell (Non-Negotiable 5: platform equality).
 */
import { Glob } from "bun";

const REPO_ROOT = resolve(import.meta.dir, "..");
const CONNECTOR_GLOB = "packages/mcp-connectors/*/test/sandbox.test.ts";

export async function findSandboxTests(root: string = REPO_ROOT): Promise<string[]> {
  const hits: string[] = [];
  for await (const file of new Glob(CONNECTOR_GLOB).scan({ cwd: root })) {
    hits.push(file.replaceAll("\\", "/"));
  }
  return hits.sort();
}

if (import.meta.main) {
  const files = await findSandboxTests();
  if (files.length === 0) {
    console.error(`No sandbox tests matched ${CONNECTOR_GLOB} under ${REPO_ROOT}.`);
    process.exit(1);
  }
  console.error(
    `Running ${String(files.length)} sandbox contract tests. These make real outbound ` +
      `requests to each connector's declared host.`,
  );
  // Forward any extra argv (e.g. a single connector path) so this can be scoped down.
  const extra = process.argv.slice(2);
  const target =
    extra.length > 0 ? extra : files.map((f) => relative(REPO_ROOT, resolve(REPO_ROOT, f)));
  const proc = Bun.spawn(["bun", "test", ...target], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
    env: { ...process.env, NIMBUS_TEST_HARNESS: "1" },
  });
  process.exit(await proc.exited);
}
