import { describe, expect, test } from "bun:test";

import { EXCLUSIONS, isExempt, NEVER_EXEMPT } from "./exclusions.ts";

describe("isExempt — platform-specific PAL files", () => {
  test("vault/win32.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/vault/win32.ts")).toBe(true);
  });
  test("vault/darwin.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/vault/darwin.ts")).toBe(true);
  });
  test("vault/linux.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/vault/linux.ts")).toBe(true);
  });
  test("platform/{win32,darwin,browser}.ts are exempt", () => {
    for (const f of ["win32", "darwin", "browser"]) {
      expect(isExempt(`packages/gateway/src/platform/${f}.ts`)).toBe(true);
    }
  });
  test("platform/linux.ts is NOT exempt — it is the ACTIVE arm on the CI-Linux runner", () => {
    // The block's rationale is "a single CI-Linux runner takes one branch per OS". linux.ts is the
    // branch that runner TAKES, so the rationale never applied to it (retired 2026-08-01).
    expect(isExempt("packages/gateway/src/platform/linux.ts")).toBe(false);
  });
  test("sandbox/{win32,orphan-reap}.ts are NOT exempt — no FFI, no OS call, gated normally", () => {
    // Both are pure string/array helpers plus a fail-closed stub; `describe.skipIf(platform)` in
    // their tests, not the code, was what made them read 0% on Linux (retired 2026-08-01).
    expect(isExempt("packages/gateway/src/platform/sandbox/win32.ts")).toBe(false);
    expect(isExempt("packages/gateway/src/platform/sandbox/orphan-reap.ts")).toBe(false);
  });
  test("sandbox/{linux,darwin}.ts stay exempt (bwrap / sandbox-exec are foreign-OS binaries)", () => {
    expect(isExempt("packages/gateway/src/platform/sandbox/linux.ts")).toBe(true);
    expect(isExempt("packages/gateway/src/platform/sandbox/darwin.ts")).toBe(true);
  });
  test("vault/factory.ts IS exempt (async per-OS dispatcher; only one switch arm reachable per CI run)", () => {
    expect(isExempt("packages/gateway/src/vault/factory.ts")).toBe(true);
  });
  test("platform/index.ts IS exempt (async per-OS dispatcher; only one switch arm reachable per CI run)", () => {
    expect(isExempt("packages/gateway/src/platform/index.ts")).toBe(true);
  });
});

describe("isExempt — perf bench harness", () => {
  test("perf/bench-cli.ts is exempt (named individually, not by directory)", () => {
    expect(isExempt("packages/gateway/src/perf/bench-cli.ts")).toBe(true);
  });
  test("nested perf/surfaces/* are exempt", () => {
    expect(isExempt("packages/gateway/src/perf/surfaces/bench-query-latency.ts")).toBe(true);
  });
  test("perf/fixtures/synthetic-*-trace.ts are exempt", () => {
    expect(isExempt("packages/gateway/src/perf/fixtures/synthetic-drive-trace.ts")).toBe(true);
  });
  test("the perf analysis modules that clear the floor are NOT exempt", () => {
    // The old blanket `packages/gateway/src/perf/` dirPrefix was strictly broader than the two
    // Sonar perf patterns and hid these from the gate. Narrowed 2026-08-01.
    for (const f of [
      "baseline-median",
      "bencher-bmf",
      "pr-comment-formatter",
      "process-spawn-bench",
      "slo-thresholds",
      "threshold-comparator",
      "worker-bench",
    ]) {
      expect(isExempt(`packages/gateway/src/perf/${f}.ts`)).toBe(false);
    }
  });
  test("a NEW file dropped under perf/ is gated by default (no directory-wide escape hatch)", () => {
    expect(isExempt("packages/gateway/src/perf/some-new-analysis-module.ts")).toBe(false);
    expect(isExempt("packages/gateway/src/perf/fixtures/some-new-fixture.ts")).toBe(false);
  });
  test("a non-perf file under gateway/src is NOT exempt", () => {
    expect(isExempt("packages/gateway/src/engine/router.ts")).toBe(false);
  });
});

describe("isExempt — SQL migration constants (exemption retired 2026-08-01)", () => {
  // All 43 `-v<N>-sql.ts` files read 100% line / 100% branch: the migration runner imports every
  // one unconditionally. Gating them means a new SQL constant no migration ever imports fails as
  // `missing_from_lcov` instead of shipping as dead SQL.
  test("vec-items-1536-v30-sql.ts is NOT exempt", () => {
    expect(isExempt("packages/gateway/src/index/vec-items-1536-v30-sql.ts")).toBe(false);
  });
  test("audit-session-v24-sql.ts is NOT exempt", () => {
    expect(isExempt("packages/gateway/src/index/audit-session-v24-sql.ts")).toBe(false);
  });
  test("a non-migration file under index/ is NOT exempt", () => {
    expect(isExempt("packages/gateway/src/index/local-index.ts")).toBe(false);
  });
});

describe("isExempt — type-only declaration files", () => {
  test("basename types.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/engine/types.ts")).toBe(true);
  });
  test("basename ending in -types.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/search/hybrid-types.ts")).toBe(true);
  });
  test("a file that merely contains 'type' in its name is NOT exempt", () => {
    expect(isExempt("packages/gateway/src/metrics/dora-config.ts")).toBe(false);
  });
});

describe("NEVER_EXEMPT — a name-shaped exemption cannot swallow real runtime logic", () => {
  // The `types.ts` basename regex is a claim about a FILENAME, not about a file's contents. These
  // two are named `types.ts` but carry executable logic — `identity/types.ts` holds the OIDC
  // `parseTokenResponse` / `parseDeviceAuthResponse` wire parsers that feed the I18 token verifier,
  // and `sync/types.ts` holds `retryAfterDateFromHeader` + `RateLimitError`. Both clear 85/80
  // today, so the carve-out costs nothing and keeps the regression guard.
  test("identity/types.ts is NOT exempt despite matching /^types\\.ts$/", () => {
    expect(isExempt("packages/gateway/src/identity/types.ts")).toBe(false);
  });
  test("sync/types.ts is NOT exempt despite matching /^types\\.ts$/", () => {
    expect(isExempt("packages/gateway/src/sync/types.ts")).toBe(false);
  });
  test("the carve-out is exact-path, not directory- or basename-shaped", () => {
    // Real files elsewhere that still match the same two regexes keep their exemption — proving
    // the carve-out did not silently widen into "every types.ts" or "every -types.ts".
    expect(isExempt("packages/gateway/src/federation/types.ts")).toBe(true);
    expect(isExempt("packages/gateway/src/people/person-types.ts")).toBe(true);
  });
  test("the carve-out survives Windows backslash paths", () => {
    expect(isExempt(String.raw`packages\gateway\src\identity\types.ts`)).toBe(false);
  });
  test("NEVER_EXEMPT is frozen and every entry is a forward-slash relative path", () => {
    expect(Object.isFrozen(NEVER_EXEMPT)).toBe(true);
    expect(NEVER_EXEMPT.size).toBeGreaterThan(0);
    for (const p of NEVER_EXEMPT) {
      expect(p).not.toContain("\\");
      expect(p.startsWith("packages/")).toBe(true);
    }
  });

  test("the carve-out is immutable at RUNTIME, not merely in the type system", () => {
    // `Object.freeze(new Set(...))` is not enough on its own: a Set's contents sit in internal
    // slots rather than own properties, so add/delete/clear keep working on a frozen Set and
    // `ReadonlySet` is a compile-time promise only. Casting back to `Set<string>` is exactly how a
    // caller would defeat that, so drive each mutator through the cast and prove it throws.
    const asMutable = NEVER_EXEMPT as unknown as Set<string>;
    const before = [...NEVER_EXEMPT];
    expect(() => asMutable.add("packages/gateway/src/engine/executor.ts")).toThrow(TypeError);
    expect(() => asMutable.delete("packages/gateway/src/identity/types.ts")).toThrow(TypeError);
    expect(() => asMutable.clear()).toThrow(TypeError);
    expect([...NEVER_EXEMPT]).toEqual(before);
    // …and isExempt still answers exactly as it did before the attempted mutation: the carve-out
    // entry stays gated, and a path that was never in the list did not sneak in.
    expect(isExempt("packages/gateway/src/identity/types.ts")).toBe(false);
    expect(NEVER_EXEMPT.has("packages/gateway/src/engine/executor.ts")).toBe(false);
  });

  test("the read surface still behaves like a Set", () => {
    // The mutator overrides must not cost the read paths isExempt and the audit script rely on.
    expect([...NEVER_EXEMPT.keys()]).toEqual([...NEVER_EXEMPT.values()]);
    expect([...NEVER_EXEMPT.entries()]).toEqual([...NEVER_EXEMPT].map((p) => [p, p]));
    const seen: string[] = [];
    // biome-ignore lint/complexity/noForEach: forEach IS the read-surface method under test here
    NEVER_EXEMPT.forEach((v) => {
      seen.push(v);
    });
    expect(seen).toEqual([...NEVER_EXEMPT]);
    expect(NEVER_EXEMPT.size).toBe(seen.length);
  });
});

describe("isExempt — retired CLI / env-gated exemptions stay retired", () => {
  test("cli/commands/share.ts is NOT exempt (it has the ShareIpc dispatcher seam now)", () => {
    expect(isExempt("packages/cli/src/commands/share.ts")).toBe(false);
  });
  test("cli/commands/telemetry.ts is NOT exempt (the disable arm is reachable)", () => {
    expect(isExempt("packages/cli/src/commands/telemetry.ts")).toBe(false);
  });
  test("chatops-tool-runner-e2e-sink.ts is NOT exempt (the env var IS the seam)", () => {
    expect(isExempt("packages/gateway/src/chatops/chatops-tool-runner-e2e-sink.ts")).toBe(false);
  });
  test("their still-shell-shaped siblings stay exempt", () => {
    expect(isExempt("packages/cli/src/commands/tribal.ts")).toBe(true);
    expect(isExempt("packages/cli/src/commands/chatops.ts")).toBe(true);
    expect(isExempt("packages/cli/src/commands/policy.ts")).toBe(true);
  });
});

describe("isExempt — github-actions entry points", () => {
  test("annotate-action/src/main.ts is exempt", () => {
    expect(isExempt("packages/github-actions/annotate-action/src/main.ts")).toBe(true);
  });
  test("preflight-query/src/main.ts is exempt", () => {
    expect(isExempt("packages/github-actions/preflight-query/src/main.ts")).toBe(true);
  });
  test("annotate-action/src/output.ts is NOT exempt (extracted helper)", () => {
    expect(isExempt("packages/github-actions/annotate-action/src/output.ts")).toBe(false);
  });
});

describe("isExempt — path-separator normalization", () => {
  test("backslash-separated paths (Windows) are normalized", () => {
    expect(isExempt(String.raw`packages\gateway\src\vault\win32.ts`)).toBe(true);
  });
});

describe("EXCLUSIONS — registry shape", () => {
  test("registry is frozen", () => {
    expect(() => {
      (EXCLUSIONS as unknown as { push: (x: unknown) => void }).push({});
    }).toThrow();
  });
});

describe("isExempt — production files are never exempt", () => {
  // The former test-helper files (tui/context, cli-test-helpers, identity-test-helpers,
  // updater-test-fixtures) were relocated under `testing/` dirs; their exemption is now
  // structural (the `discoverSourceFiles` `/testing/` skip — covered in check.test.ts),
  // NOT an `isExempt`/EXCLUSIONS entry. A real production file stays non-exempt.
  test("ipc-context.ts (production) is NOT exempt", () => {
    expect(isExempt("packages/cli/src/tui/ipc-context.ts")).toBe(false);
  });
});
