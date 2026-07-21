import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { COVERAGE_GATES } from "./ci-tests.ts";
import { REPO_ROOT } from "./root.ts";

/**
 * `test:ci` drives the per-subsystem coverage gates from its own list, which is
 * separate from the `test:coverage:*` scripts in `package.json`. Nothing forced
 * the two to agree, and they drifted in BOTH directions at once:
 *
 *   - `test:coverage:client` stayed in the gate list after `packages/client`
 *     was extracted to `@nimbus-dev/client` (#758) and the script was deleted.
 *   - `test:coverage:sandbox` was added to `package.json` but never wired in,
 *     so `test:ci` silently skipped the sandbox gate entirely.
 *
 * The second is the dangerous one: a missing gate does not fail, it just
 * quietly stops checking. These tests make either direction a hard failure.
 */
describe("ci-tests coverage gate manifest", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    scripts: Record<string, string>;
  };

  const declared = Object.keys(pkg.scripts)
    .filter((s) => s.startsWith("test:coverage:"))
    .sort();
  const wired = COVERAGE_GATES.map((g) => g.script).sort();

  test("every test:coverage:* script in package.json is wired into test:ci", () => {
    const missing = declared.filter((s) => !wired.includes(s));
    expect(missing).toEqual([]);
  });

  test("every wired gate resolves to a real package.json script", () => {
    const dangling = wired.filter((s) => !declared.includes(s));
    expect(dangling).toEqual([]);
  });

  test("gate scripts are unique", () => {
    expect(new Set(wired).size).toBe(wired.length);
  });

  test("the vault gate keeps its dbus wrapper", () => {
    // Vault coverage needs libsecret on Linux; losing this flag would not fail
    // the run, it would just make the gate flaky/red on CI for the wrong reason.
    const vault = COVERAGE_GATES.find((g) => g.script === "test:coverage:vault");
    expect(vault?.dbus).toBe(true);
  });
});
