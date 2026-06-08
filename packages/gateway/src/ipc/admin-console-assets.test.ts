import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentTypeFor, resolveConsoleDist, safeAssetPath } from "./admin-console-assets.ts";

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

describe("resolveConsoleDist", () => {
  const KEY = "NIMBUS_ADMIN_CONSOLE_DIST";
  let prev: string | undefined;
  let tmp: string;

  beforeEach(() => {
    prev = process.env[KEY];
    tmp = mkdtempSync(join(tmpdir(), "nimbus-console-"));
  });
  afterEach(() => {
    if (prev === undefined) delete process.env[KEY];
    else process.env[KEY] = prev;
    rmSync(tmp, { recursive: true, force: true });
  });

  test("override present + index.html exists returns the override (line 32 true / line 33 true side)", () => {
    writeFileSync(join(tmp, "index.html"), "<!doctype html>");
    process.env[KEY] = tmp;
    expect(resolveConsoleDist("/whatever/ipc")).toBe(tmp);
  });

  test("override present but no index.html returns undefined (line 33 false side)", () => {
    process.env[KEY] = tmp; // empty dir
    expect(resolveConsoleDist("/whatever/ipc")).toBeUndefined();
  });

  test("blank override is treated as absent → falls to default-dist resolution (line 32 false side)", () => {
    process.env[KEY] = "   ";
    // baseDir points nowhere real → default dist has no index.html → undefined (line 36 false side)
    expect(resolveConsoleDist(join(tmp, "ipc"))).toBeUndefined();
  });

  test("no override + default dist has index.html returns it (line 36 true side)", () => {
    delete process.env[KEY];
    // Layout: baseDir = <root>/a/b/c so ../../../admin-console/dist = <root>/admin-console/dist
    const dist = join(tmp, "admin-console", "dist");
    mkdirSync(dist, { recursive: true });
    writeFileSync(join(dist, "index.html"), "<!doctype html>");
    const baseDir = join(tmp, "a", "b", "c");
    expect(resolveConsoleDist(baseDir)).toBe(dist);
  });
});
