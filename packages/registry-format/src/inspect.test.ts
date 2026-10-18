import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MAX_ENTRY_COUNT, MAX_MANIFEST_BYTES, MAX_UNPACKED_BYTES } from "./caps.ts";
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

interface RawEntry {
  name: string;
  /** ustar typeflag: "0" file, "1" hardlink, "2" symlink, "3" char device, "5" directory. */
  type?: string;
  body?: string;
  /** Size written to the header; defaults to the body length. A larger value truncates the archive. */
  declaredSize?: number;
  linkname?: string;
}

function rawHeader(e: RawEntry, size: number): Buffer {
  const h = Buffer.alloc(512);
  const put = (off: number, len: number, value: string): void => {
    h.write(value.slice(0, len), off, "ascii");
  };
  put(0, 100, e.name);
  put(100, 8, "0000644\0");
  put(108, 8, "0000000\0");
  put(116, 8, "0000000\0");
  put(124, 12, `${size.toString(8).padStart(11, "0")}\0`);
  put(136, 12, "00000000000\0");
  h.fill(" ", 148, 156);
  put(156, 1, e.type ?? "0");
  if (e.linkname !== undefined) put(157, 100, e.linkname);
  put(257, 6, "ustar\0");
  put(263, 2, "00");
  let sum = 0;
  for (const b of h) sum += b;
  put(148, 8, `${sum.toString(8).padStart(6, "0")}\0 `);
  return h;
}

/** Builds an uncompressed ustar archive byte by byte, so link and device entries need no OS privilege. */
function writeRawTar(entries: RawEntry[]): string {
  const parts: Buffer[] = [];
  let truncated = false;
  for (const e of entries) {
    const body = Buffer.from(e.body ?? "", "utf8");
    parts.push(rawHeader(e, e.declaredSize ?? body.length));
    if (e.declaredSize !== undefined && e.declaredSize > body.length) {
      parts.push(body);
      truncated = true;
      break;
    }
    parts.push(body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  if (!truncated) parts.push(Buffer.alloc(1024));
  const tgz = join(tmp, "raw.tar");
  writeFileSync(tgz, Buffer.concat(parts));
  return tgz;
}

function freshWork(): string {
  const work = join(tmp, "work");
  mkdirSync(work);
  return work;
}

const VALID = [
  { name: "nimbus.extension.json", body: JSON.stringify({ id: "a" }) },
  { name: "dist/index.js", body: "export default 1;\n" },
];

describe("inspectPackage refusals before extraction", () => {
  test("a symlink entry is refused and nothing is extracted", async () => {
    const tgz = writeRawTar([...VALID, { name: "evil", type: "2", linkname: "/etc/passwd" }]);
    const work = freshWork();
    await expect(inspectPackage(tgz, work)).rejects.toThrow(
      "package entry evil is a symlink; only files and directories are allowed",
    );
    expect(existsSync(join(work, "x"))).toBe(false);
  });

  test("a hardlink entry is refused", async () => {
    const tgz = writeRawTar([...VALID, { name: "hl", type: "1", linkname: "dist/index.js" }]);
    await expect(inspectPackage(tgz, freshWork())).rejects.toMatchObject({
      code: "ERR_REGISTRY_EXTRACT_FAILED",
      message: expect.stringContaining("package entry hl is a hardlink"),
    });
  });

  test("any other entry type is refused by its tar type name, and only the first is reported", async () => {
    const tgz = writeRawTar([
      ...VALID,
      { name: "dev", type: "3" },
      { name: "later", type: "2", linkname: "x" },
    ]);
    await expect(inspectPackage(tgz, freshWork())).rejects.toThrow(
      "package entry dev is a CharacterDevice entry",
    );
  });

  test("more entries than the cap is refused", async () => {
    const dirs: RawEntry[] = [];
    for (let i = 0; i <= MAX_ENTRY_COUNT; i++) dirs.push({ name: `d${String(i)}/`, type: "5" });
    const tgz = writeRawTar([...VALID, ...dirs]);
    const work = freshWork();
    await expect(inspectPackage(tgz, work)).rejects.toThrow(
      `package has more than ${String(MAX_ENTRY_COUNT)} entries`,
    );
    expect(existsSync(join(work, "x"))).toBe(false);
  });

  test("a declared unpacked size over the cap is refused from the headers alone", async () => {
    const tgz = writeRawTar([
      ...VALID,
      { name: "huge.bin", body: "x", declaredSize: MAX_UNPACKED_BYTES + 1 },
    ]);
    await expect(inspectPackage(tgz, freshWork())).rejects.toThrow(
      "package unpacked size exceeds 200 MiB",
    );
  });
});

describe("inspectPackage refusals after extraction", () => {
  test("a package with no manifest at its root is refused", async () => {
    const tgz = writeRawTar([{ name: "dist/index.js", body: "1" }]);
    await expect(inspectPackage(tgz, freshWork())).rejects.toMatchObject({
      code: "ERR_REGISTRY_MANIFEST_INVALID",
      message: expect.stringContaining("package has no nimbus.extension.json at its root"),
    });
  });

  test("an oversize manifest is refused", async () => {
    const big = JSON.stringify({ id: "a", pad: "p".repeat(MAX_MANIFEST_BYTES) });
    await expect(inspectDir(makeExt(big))).rejects.toThrow("manifest is too large");
  });

  test("an entry that escapes the package is refused even when the target exists", async () => {
    writeFileSync(join(tmp, "outside.js"), "1");
    const tgz = writeRawTar([
      { name: "nimbus.extension.json", body: JSON.stringify({ id: "a", entry: "../outside.js" }) },
    ]);
    await expect(inspectPackage(tgz, freshWork())).rejects.toThrow(
      "extension entry ../outside.js is missing or outside the package",
    );
  });

  test("an empty or non-string entry falls back to the default entry", async () => {
    for (const entry of ["", 7]) {
      rmSync(join(tmp, "work"), { recursive: true, force: true });
      const tgz = writeRawTar([
        { name: "nimbus.extension.json", body: JSON.stringify({ id: "a", entry }) },
        { name: "dist/index.js", body: "z" },
      ]);
      const r = await inspectPackage(tgz, freshWork());
      expect(r.entryHash).toBe(createHash("sha256").update("z").digest("hex"));
    }
  });

  test("a manifest naming its entry only by `entrypoint` hashes that file", async () => {
    const tgz = writeRawTar([
      {
        name: "nimbus.extension.json",
        body: JSON.stringify({ id: "a", entrypoint: "dist/server.js" }),
      },
      { name: "dist/index.js", body: "default" },
      { name: "dist/server.js", body: "server" },
    ]);
    const r = await inspectPackage(tgz, freshWork());
    expect(r.entryHash).toBe(createHash("sha256").update("server").digest("hex"));
  });

  test("a manifest naming neither entry nor entrypoint hashes dist/index.js", async () => {
    const tgz = writeRawTar([
      { name: "nimbus.extension.json", body: JSON.stringify({ id: "a" }) },
      { name: "dist/index.js", body: "default" },
      { name: "dist/server.js", body: "server" },
    ]);
    const r = await inspectPackage(tgz, freshWork());
    expect(r.entryHash).toBe(createHash("sha256").update("default").digest("hex"));
  });

  test("a repeated file name is listed once per archive entry, in sorted order", async () => {
    const tgz = writeRawTar([
      ...VALID,
      { name: "b.txt", body: "1" },
      { name: "a.txt", body: "1" },
      { name: "b.txt", body: "2" },
    ]);
    const r = await inspectPackage(tgz, freshWork());
    expect(r.files).toEqual(["a.txt", "b.txt", "b.txt", "dist/index.js", "nimbus.extension.json"]);
  });
});
