import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { REPO_ROOT, readDirFiles } from "../../test/helpers/security-invariants.ts";

describe("I33 — user code executes only behind the exec gate", () => {
  // The runtime complement to static rule D23. A second caller of `runConfined` would be a second
  // path from user-supplied code to a running process, which is the whole of what I33 forbids.
  test("runConfined is called only from exec-gate.ts (and defined in exec-run.ts)", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const callers = files
      .filter((f) => /\brunConfined\s*\(/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(callers).toEqual([
      "packages/gateway/src/exec/exec-gate.ts",
      "packages/gateway/src/exec/exec-run.ts",
    ]);
  });

  // On Windows `degradedReason()` is non-null even when the runner is fully active -- it reports
  // the accepted per-host-filtering caveat. A gate keyed on it would refuse every Windows
  // execution forever: fail-closed, but total.
  test("the gate keys confinement on canConfine(policy), not a policy-independent probe", async () => {
    const code = stripComments(
      await readFile(resolve(REPO_ROOT, "packages/gateway/src/exec/exec-gate.ts"), "utf8"),
    );
    // Ask "can you confine THIS policy?" -- neither policy-independent probe is correct.
    // `isFullyActive()` is wrong on Linux, where it reports a helper used ONLY for per-host
    // network filtering that a no-network policy never touches; gating on it made the capability
    // unusable on every Linux box lacking that helper, CI included.
    expect(code).toContain("canConfine(policy)");
    expect(code).not.toMatch(/degradedReason\(\)\s*===\s*null/);
    expect(code).not.toMatch(/!\s*deps\.runner\.isFullyActive\(\)/);
  });

  // The Linux relaxation must stay policy-AWARE in the direction that matters: a network-bearing
  // policy still requires the helper. If canConfine collapses to `return null`, "no network needs
  // no helper" has silently become "nothing is ever checked".
  test("Linux still requires the helper for a network-bearing policy", async () => {
    const code = stripComments(
      await readFile(resolve(REPO_ROOT, "packages/gateway/src/platform/sandbox/linux.ts"), "utf8"),
    );
    expect(code).toMatch(/canConfine[\s\S]{0,500}!declaresNetwork\(policy\)/);
    expect(code).toMatch(/canConfine[\s\S]{0,800}helper\.available/);
  });

  // Empty-by-construction is the property; a caller-supplied network list must be REFUSED, not
  // quietly dropped, or "no network" becomes a convention rather than a guarantee.
  test("exec-policy refuses a requested network grant rather than dropping it", async () => {
    const { buildExecPolicy } = await import("../exec/exec-policy.ts");
    const abs = process.platform === "win32" ? "C:\\tmp" : "/tmp";
    expect(() =>
      buildExecPolicy("i33", { fsRead: [abs], fsWrite: [], network: ["x.com"] }),
    ).toThrow();
    expect(buildExecPolicy("i33", { fsRead: [abs], fsWrite: [] }).permissions.network).toEqual([]);
  });

  // `not_required` on a code.execute row would read as "this ran without needing approval".
  test("the gate never records a code.execute row as not_required", async () => {
    const code = stripComments(
      await readFile(resolve(REPO_ROOT, "packages/gateway/src/exec/exec-gate.ts"), "utf8"),
    );
    expect(code).not.toContain('"not_required"');
  });
});
