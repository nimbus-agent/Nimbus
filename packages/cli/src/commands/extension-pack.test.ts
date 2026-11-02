/**
 * `nimbus extension pack` over real temp directories: the bytes are the packer's, the hash it prints
 * is the one `maintain add` records for that file, and each refusal leaves what was there untouched.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packExtensionDir } from "@nimbus-dev/registry-format";
import { encodeBase64, generateEd25519Keypair, signManifest } from "../lib/extension-signing.ts";
import { readIndexFile } from "../lib/registry-index.ts";
import { runExtensionPack } from "./extension-pack.ts";
import { runRegistryMaintain } from "./registry-maintain.ts";

const sha = (b: Uint8Array): string => createHash("sha256").update(b).digest("hex");

let tmp: string;
let logged: string;
let errors: string;
const deps = {
  log: (s: string) => {
    logged += s;
  },
  err: (s: string) => {
    errors += s;
  },
};

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nimbus-extension-pack-test-"));
  logged = "";
  errors = "";
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
});

async function signedExtension(): Promise<string> {
  const dir = join(tmp, "ext");
  mkdirSync(join(dir, "dist"), { recursive: true });
  writeFileSync(join(dir, "dist", "index.js"), "export default 1;\n");
  const { privkey, pubkey } = generateEd25519Keypair();
  const manifest: Record<string, unknown> = {
    id: "com.example.tool",
    name: "Example Tool",
    version: "1.0.0",
    entry: "dist/index.js",
    permissions: {},
    publisher: { id: "example", key: encodeBase64(pubkey) },
  };
  manifest["signature"] = await signManifest(manifest, privkey);
  writeFileSync(join(dir, "nimbus.extension.json"), JSON.stringify(manifest, null, 2));
  return dir;
}

describe("nimbus extension pack", () => {
  test("writes what packExtensionDir writes, and prints the path and the SHA-256 of those bytes", async () => {
    const dir = await signedExtension();
    const out = join(tmp, "package.tgz");
    expect(await runExtensionPack([dir, "--out", out], deps)).toBe(0);
    const reference = join(tmp, "reference.tgz");
    await packExtensionDir(dir, reference);
    const bytes = readFileSync(out);
    expect(sha(bytes)).toBe(sha(readFileSync(reference)));
    expect(logged).toBe(`wrote ${out}\nsha256 ${sha(bytes)}\n`);
    expect(errors).toBe("");
  });

  test("maintain add, given that file, records that SHA-256 as packageSha256", async () => {
    const dir = await signedExtension();
    const out = join(tmp, "package.tgz");
    expect(await runExtensionPack([dir, "--out", out], deps)).toBe(0);
    const reg = join(tmp, "reg");
    const key = join(tmp, "reg-key");
    const io = { stdout: () => {}, stderr: () => {} };
    expect(await runRegistryMaintain(["init", reg, "--key", key], io)).toBe(0);
    expect(await runRegistryMaintain(["add", reg, out, "--key", key], io)).toBe(0);
    const entry = readIndexFile(join(reg, "index.json")).extensions["com.example.tool"]?.versions[
      "1.0.0"
    ];
    expect(entry?.packageSha256).toBe(sha(readFileSync(out)));
  });

  test("an existing --out is refused and left untouched", async () => {
    const dir = await signedExtension();
    const out = join(tmp, "package.tgz");
    writeFileSync(out, "already here");
    expect(await runExtensionPack([dir, "--out", out], deps)).toBe(2);
    expect(errors).toContain("refusing to overwrite");
    expect(readFileSync(out, "utf8")).toBe("already here");
    expect(logged).toBe("");
  });

  test("a missing directory is refused and writes nothing", async () => {
    const out = join(tmp, "package.tgz");
    expect(await runExtensionPack([join(tmp, "absent"), "--out", out], deps)).toBe(2);
    expect(errors).toContain("does not exist");
    expect(existsSync(out)).toBe(false);
  });

  test("a file in place of the directory is refused and writes nothing", async () => {
    const file = join(tmp, "a-file");
    writeFileSync(file, "x");
    const out = join(tmp, "package.tgz");
    expect(await runExtensionPack([file, "--out", out], deps)).toBe(2);
    expect(errors).toContain("is not a directory");
    expect(existsSync(out)).toBe(false);
  });

  test("a directory with no manifest is refused and writes nothing", async () => {
    const dir = join(tmp, "bare");
    mkdirSync(dir);
    const out = join(tmp, "package.tgz");
    expect(await runExtensionPack([dir, "--out", out], deps)).toBe(2);
    expect(errors).toContain("nimbus.extension.json");
    expect(existsSync(out)).toBe(false);
  });

  test.each([
    ["no --out", (dir: string): string[] => [dir]],
    ["no directory", (): string[] => ["--out", "x.tgz"]],
    ["two directories", (dir: string): string[] => [dir, dir, "--out", "x.tgz"]],
  ])("%s is a usage error", async (_label, argv) => {
    const dir = await signedExtension();
    expect(await runExtensionPack(argv(dir), deps)).toBe(2);
    expect(errors).toContain("usage: nimbus extension pack");
    expect(logged).toBe("");
  });

  test("--out with no value and an unknown option are refused", async () => {
    const dir = await signedExtension();
    expect(await runExtensionPack([dir, "--out"], deps)).toBe(2);
    expect(errors).toContain("--out needs a value");
    errors = "";
    expect(await runExtensionPack([dir, "--out", "x.tgz", "--force"], deps)).toBe(2);
    expect(errors).toContain("unknown option --force");
  });

  test("a symlink-free tree the packer refuses is a refusal, not a crash", async () => {
    const dir = await signedExtension();
    // `dist` must be a directory: the packer refuses it as a file.
    rmSync(join(dir, "dist"), { recursive: true });
    writeFileSync(join(dir, "dist"), "not a directory");
    const out = join(tmp, "package.tgz");
    expect(await runExtensionPack([dir, "--out", out], deps)).toBe(2);
    expect(errors).toContain("refusing to pack dist");
    expect(existsSync(out)).toBe(false);
  });
});
