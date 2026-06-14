import { describe, expect, test } from "bun:test";

import { EXCLUSIONS, isExempt } from "./exclusions.ts";

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
  test("platform/{win32,darwin,linux,browser}.ts are exempt", () => {
    for (const f of ["win32", "darwin", "linux", "browser"]) {
      expect(isExempt(`packages/gateway/src/platform/${f}.ts`)).toBe(true);
    }
  });
  test("vault/factory.ts IS exempt (async per-OS dispatcher; only one switch arm reachable per CI run)", () => {
    expect(isExempt("packages/gateway/src/vault/factory.ts")).toBe(true);
  });
  test("platform/index.ts IS exempt (async per-OS dispatcher; only one switch arm reachable per CI run)", () => {
    expect(isExempt("packages/gateway/src/platform/index.ts")).toBe(true);
  });
});

describe("isExempt — perf bench harness", () => {
  test("perf/bench-cli.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/perf/bench-cli.ts")).toBe(true);
  });
  test("nested perf/surfaces/* are exempt", () => {
    expect(isExempt("packages/gateway/src/perf/surfaces/bench-query-latency.ts")).toBe(true);
  });
  test("a non-perf file under gateway/src is NOT exempt", () => {
    expect(isExempt("packages/gateway/src/engine/router.ts")).toBe(false);
  });
});

describe("isExempt — SQL migration constants", () => {
  test("vec-items-1536-v30-sql.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/index/vec-items-1536-v30-sql.ts")).toBe(true);
  });
  test("audit-session-v24-sql.ts is exempt", () => {
    expect(isExempt("packages/gateway/src/index/audit-session-v24-sql.ts")).toBe(true);
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
