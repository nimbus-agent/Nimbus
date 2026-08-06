import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type ConsoleAssetDeps,
  contentTypeFor,
  resolveConsoleAsset,
  safeAssetPath,
} from "./admin-console-assets.ts";

describe("admin-console-assets", () => {
  test("maps extensions to content types", () => {
    expect(contentTypeFor("index.html")).toContain("text/html");
    expect(contentTypeFor("main.js")).toContain("javascript");
    expect(contentTypeFor("styles.css")).toContain("text/css");
    expect(contentTypeFor("weird.bin")).toBe("application/octet-stream");
  });
  test("rejects path traversal", () => {
    expect(safeAssetPath("/admin/../../etc/passwd")).toBeUndefined();
    expect(safeAssetPath("/admin/..\\..\\win")).toBeUndefined();
    expect(safeAssetPath("/admin/main.js")).toBe("main.js");
    expect(safeAssetPath("/admin")).toBe("index.html");
    expect(safeAssetPath("/admin/")).toBe("index.html");
  });
});

describe("resolveConsoleAsset — compiled binary", () => {
  const deps: ConsoleAssetDeps = {
    compiled: true,
    assets: { "index.html": "/$bunfs/root/index-a.html", "main.js": "/$bunfs/root/main-b.js" },
    distOverride: "/tmp/attacker-controlled",
    exists: () => true,
  };

  test("serves a mapped asset", () => {
    expect(resolveConsoleAsset("index.html", deps)).toEqual({
      kind: "file",
      path: "/$bunfs/root/index-a.html",
    });
  });

  test("an unmapped name misses — there is no directory to walk", () => {
    expect(resolveConsoleAsset("styles.css", deps)).toEqual({ kind: "not-found" });
  });

  test("inherited Object keys are not assets", () => {
    expect(resolveConsoleAsset("constructor", deps)).toEqual({ kind: "not-found" });
    expect(resolveConsoleAsset("__proto__", deps)).toEqual({ kind: "not-found" });
    expect(resolveConsoleAsset("toString", deps)).toEqual({ kind: "not-found" });
  });

  test("the dist override is ignored when compiled", () => {
    expect(resolveConsoleAsset("main.js", deps)).toEqual({
      kind: "file",
      path: "/$bunfs/root/main-b.js",
    });
  });

  test("an own key whose value is undefined is not-found", () => {
    const holey: ConsoleAssetDeps = {
      ...deps,
      assets: Object.assign(Object.create(null) as Record<string, string>, {
        "index.html": undefined as unknown as string,
      }),
    };
    expect(resolveConsoleAsset("index.html", holey)).toEqual({ kind: "not-found" });
  });

  test("never reports not-built when compiled — the assets are in the executable", () => {
    expect(resolveConsoleAsset("index.html", { ...deps, assets: {} })).toEqual({
      kind: "not-found",
    });
  });
});

describe("resolveConsoleAsset — dev tree", () => {
  let tmp: string;
  let dist: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "nimbus-console-"));
    dist = join(tmp, "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    writeFileSync(join(dist, "main.js"), "export {};");
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function devDeps(distOverride: string | undefined): ConsoleAssetDeps {
    return {
      compiled: false,
      assets: { "index.html": join(dist, "index.html") },
      distOverride,
      exists: existsSync,
    };
  }

  test("serves from the dist directory derived from the embedded index.html", () => {
    expect(resolveConsoleAsset("main.js", devDeps(undefined))).toEqual({
      kind: "file",
      path: join(dist, "main.js"),
    });
  });

  test("a missing file in a built dist is not-found", () => {
    expect(resolveConsoleAsset("styles.css", devDeps(undefined))).toEqual({ kind: "not-found" });
  });

  test("an override with an index.html wins over the derived dist", () => {
    const other = join(tmp, "other");
    mkdirSync(other, { recursive: true });
    writeFileSync(join(other, "index.html"), "<!doctype html>");
    expect(resolveConsoleAsset("index.html", devDeps(other))).toEqual({
      kind: "file",
      path: join(other, "index.html"),
    });
  });

  test("an override without an index.html is not-built", () => {
    expect(resolveConsoleAsset("index.html", devDeps(join(tmp, "nothing-here")))).toEqual({
      kind: "not-built",
    });
  });

  test("a blank override is treated as absent", () => {
    expect(resolveConsoleAsset("main.js", devDeps("   "))).toEqual({
      kind: "file",
      path: join(dist, "main.js"),
    });
  });

  test("a dist whose index.html has gone missing is not-built", () => {
    rmSync(join(dist, "index.html"));
    expect(resolveConsoleAsset("main.js", devDeps(undefined))).toEqual({ kind: "not-built" });
  });

  test("an empty asset map with no override is not-built", () => {
    expect(
      resolveConsoleAsset("main.js", {
        compiled: false,
        assets: {},
        distOverride: undefined,
        exists: existsSync,
      }),
    ).toEqual({ kind: "not-built" });
  });
});
