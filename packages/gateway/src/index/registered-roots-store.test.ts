import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import {
  addRegisteredRoot,
  canonicalizeRootPath,
  gitAwareRootPaths,
  loadRegisteredRoots,
  mergeRoots,
} from "./registered-roots-store.ts";

function fsRoot(
  path: string,
  extra: Partial<NimbusFilesystemRootToml> = {},
): NimbusFilesystemRootToml {
  return {
    path,
    gitAware: true,
    codeIndex: false,
    dependencyGraph: false,
    mediaIndex: false,
    exclude: [],
    ...extra,
  };
}

describe("addRegisteredRoot + loadRegisteredRoots", () => {
  test("add is idempotent and load round-trips a blame-oriented root", () => {
    const cfg = mkdtempSync(join(tmpdir(), "rr-"));
    expect(addRegisteredRoot(cfg, cfg)).toBe(true);
    expect(addRegisteredRoot(cfg, cfg)).toBe(false); // already present

    const roots = loadRegisteredRoots(cfg);
    expect(roots.map((r) => r.path)).toEqual([cfg]);
    expect(roots[0]?.gitAware).toBe(true);
    expect(roots[0]?.codeIndex).toBe(false);
    expect(roots[0]?.dependencyGraph).toBe(false);
  });

  test("load returns [] when no registered-roots file exists", () => {
    const cfg = mkdtempSync(join(tmpdir(), "rr-"));
    expect(loadRegisteredRoots(cfg)).toEqual([]);
  });

  test("two distinct paths both round-trip", () => {
    const cfg = mkdtempSync(join(tmpdir(), "rr-"));
    const a = mkdtempSync(join(tmpdir(), "rra-"));
    const b = mkdtempSync(join(tmpdir(), "rrb-"));
    expect(addRegisteredRoot(cfg, a)).toBe(true);
    expect(addRegisteredRoot(cfg, b)).toBe(true);
    expect(new Set(loadRegisteredRoots(cfg).map((r) => r.path))).toEqual(new Set([a, b]));
  });
});

describe("loadRegisteredRoots — malformed file handling", () => {
  test("a non-array JSON payload yields no roots", () => {
    const cfg = mkdtempSync(join(tmpdir(), "rr-"));
    writeFileSync(join(cfg, "registered-roots.json"), JSON.stringify({ not: "an array" }), "utf8");
    expect(loadRegisteredRoots(cfg)).toEqual([]);
  });

  test("malformed JSON yields no roots (no throw)", () => {
    const cfg = mkdtempSync(join(tmpdir(), "rr-"));
    writeFileSync(join(cfg, "registered-roots.json"), "not json at all", "utf8");
    expect(loadRegisteredRoots(cfg)).toEqual([]);
  });

  test("non-string array entries are filtered out", () => {
    const cfg = mkdtempSync(join(tmpdir(), "rr-"));
    writeFileSync(join(cfg, "registered-roots.json"), JSON.stringify([1, "/ok", null]), "utf8");
    expect(loadRegisteredRoots(cfg).map((r) => r.path)).toEqual(["/ok"]);
  });
});

describe("mergeRoots", () => {
  test("TOML wins on collision, missing folders skipped", () => {
    const cfg = mkdtempSync(join(tmpdir(), "rr-")); // exists
    const gone = join(tmpdir(), "definitely-not-here-xyz-987654");
    const merged = mergeRoots(
      [fsRoot(cfg, { codeIndex: true })], // TOML: codeIndex true
      [fsRoot(cfg), fsRoot(gone)], // registered: dup + missing
    );
    expect(merged).toHaveLength(1); // dup collapsed, missing skipped
    expect(merged[0]?.codeIndex).toBe(true); // TOML won
  });

  test("keeps distinct existing roots from both sources", () => {
    const t = mkdtempSync(join(tmpdir(), "rr-toml-"));
    const r = mkdtempSync(join(tmpdir(), "rr-reg-"));
    const merged = mergeRoots([fsRoot(t)], [fsRoot(r)]);
    expect(new Set(merged.map((m) => m.path))).toEqual(new Set([t, r]));
  });
});

describe("gitAwareRootPaths", () => {
  test("TOML-only: returns the git-aware TOML roots", () => {
    const t = mkdtempSync(join(tmpdir(), "rr-toml-"));
    expect(gitAwareRootPaths([fsRoot(t)], [])).toEqual([t]);
  });

  test("registered-only: a CLI-registered root is NOT dropped", () => {
    // The regression this guards: deriving the ownership root set from the
    // `[[filesystem.roots]]` TOML alone silently omits every `nimbus index add`
    // root, whose blame rows the pass would then clear and never re-emit.
    const r = mkdtempSync(join(tmpdir(), "rr-reg-"));
    expect(gitAwareRootPaths([], [fsRoot(r)])).toEqual([r]);
  });

  test("both sources are merged", () => {
    const t = mkdtempSync(join(tmpdir(), "rr-toml-"));
    const r = mkdtempSync(join(tmpdir(), "rr-reg-"));
    expect(new Set(gitAwareRootPaths([fsRoot(t)], [fsRoot(r)]))).toEqual(new Set([t, r]));
  });

  test("a same-path registered root collapses into the TOML one", () => {
    const p = mkdtempSync(join(tmpdir(), "rr-dup-"));
    expect(gitAwareRootPaths([fsRoot(p)], [fsRoot(p)])).toEqual([p]);
  });

  test("non-git-aware roots are filtered out of both sources", () => {
    const t = mkdtempSync(join(tmpdir(), "rr-toml-"));
    const r = mkdtempSync(join(tmpdir(), "rr-reg-"));
    expect(
      gitAwareRootPaths([fsRoot(t, { gitAware: false })], [fsRoot(r, { gitAware: false })]),
    ).toEqual([]);
  });

  test("a root whose folder is gone is dropped", () => {
    const gone = join(tmpdir(), "gone-root-xyz-987654");
    expect(gitAwareRootPaths([], [fsRoot(gone)])).toEqual([]);
  });
});

describe("canonicalizeRootPath", () => {
  test("a real directory round-trips without a Windows long-path prefix", () => {
    const dir = mkdtempSync(join(tmpdir(), "rr-canon-"));
    const canon = canonicalizeRootPath(dir);
    expect(canon).not.toBeNull();
    expect(canon?.startsWith("\\\\?\\")).toBe(false);
  });

  test("a non-existent path returns null", () => {
    expect(canonicalizeRootPath(join(tmpdir(), "nope-does-not-resolve-123456"))).toBeNull();
  });
});
