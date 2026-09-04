import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packBundle, unpackBundle } from "./tar-bundle.ts";

const tempDirs: string[] = [];
afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    try {
      rmSync(d, { recursive: true, force: true });
    } catch {
      /* best-effort */
    }
  }
});

describe("tar bundle", () => {
  test("packs and unpacks a directory round-trip", async () => {
    const src = mkdtempSync(join(tmpdir(), "nimbus-bundle-src-"));
    tempDirs.push(src);
    writeFileSync(join(src, "a.txt"), "hello");
    writeFileSync(join(src, "b.json"), '{"x":1}');
    const outDir = mkdtempSync(join(tmpdir(), "nimbus-bundle-out-"));
    tempDirs.push(outDir);
    const out = join(outDir, "bundle.tar.gz");
    await packBundle(src, out);
    expect(existsSync(out)).toBe(true);

    const extractTo = mkdtempSync(join(tmpdir(), "nimbus-bundle-extract-"));
    tempDirs.push(extractTo);
    await unpackBundle(out, extractTo);
    expect(readFileSync(join(extractTo, "a.txt"), "utf8")).toBe("hello");
    expect(readFileSync(join(extractTo, "b.json"), "utf8")).toBe('{"x":1}');
  });
});
