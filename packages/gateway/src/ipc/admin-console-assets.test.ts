import { describe, expect, test } from "bun:test";
import { contentTypeFor, safeAssetPath } from "./admin-console-assets.ts";

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
