import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inspectPackage } from "./inspect.ts";
import { packExtensionDir } from "./pack.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-inspect-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeExt(manifest: Record<string, unknown> | string, withEntry = true): string {
  const dir = join(tmp, "ext");
  mkdirSync(join(dir, "dist"), { recursive: true });
  if (withEntry) writeFileSync(join(dir, "dist", "index.js"), "export default 1;\n");
  writeFileSync(join(dir, "README.md"), "hi");
  writeFileSync(
    join(dir, "nimbus.extension.json"),
    typeof manifest === "string" ? manifest : JSON.stringify(manifest),
  );
  return dir;
}

async function inspectDir(dir: string) {
  const tgz = join(tmp, "p.tgz");
  await packExtensionDir(dir, tgz);
  const work = join(tmp, "work");
  mkdirSync(work);
  return inspectPackage(tgz, work);
}

describe("inspectPackage", () => {
  test("returns manifest bytes, entry hash and the sorted file list", async () => {
    const r = await inspectDir(makeExt({ id: "a", entry: "dist/index.js" }));
    expect(r.manifest["id"]).toBe("a");
    expect(r.entryHash).toBe(createHash("sha256").update("export default 1;\n").digest("hex"));
    expect(r.files).toEqual(["README.md", "dist/index.js", "nimbus.extension.json"]);
    expect(r.manifestBytes.length).toBeGreaterThan(0);
  });

  test("a missing entry is refused", async () => {
    await expect(inspectDir(makeExt({ id: "a" }, false))).rejects.toThrow(
      "extension entry dist/index.js is missing or outside the package",
    );
  });

  test("a non-JSON manifest is refused", async () => {
    await expect(inspectDir(makeExt("{nope"))).rejects.toThrow("manifest is not valid JSON");
  });

  test("a non-object manifest is refused", async () => {
    await expect(inspectDir(makeExt("[1]"))).rejects.toThrow("manifest is not a JSON object");
  });
});
