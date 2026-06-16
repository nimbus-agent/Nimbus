import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import "../../test/helpers/cli-mocks.ts";

const mod = await import("./extension.ts");
const { runExtensionKeygen, runExtensionSign } = mod;

describe("runExtensionKeygen", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("writes the private key to --out and returns 0", async () => {
    const out = join(tmpDir, "publisher-key");
    const code = await runExtensionKeygen(["--out", out]);
    expect(code).toBe(0);
    expect(existsSync(out)).toBe(true);
    expect(readFileSync(out, "utf8").trim().length).toBeGreaterThan(0);
  });

  it("refuses to overwrite an existing key without --force (exit 2)", async () => {
    const out = join(tmpDir, "publisher-key");
    writeFileSync(out, "existing\n", "utf8");
    const code = await runExtensionKeygen(["--out", out]);
    expect(code).toBe(2);
    expect(readFileSync(out, "utf8")).toBe("existing\n");
  });

  it("overwrites with --force and returns 0", async () => {
    const out = join(tmpDir, "publisher-key");
    writeFileSync(out, "existing\n", "utf8");
    const code = await runExtensionKeygen(["--out", out, "--force"]);
    expect(code).toBe(0);
    expect(readFileSync(out, "utf8")).not.toBe("existing\n");
  });
});

describe("runExtensionSign", () => {
  let tmpDir: string;
  let keyPath: string;

  beforeEach(async () => {
    tmpDir = mkdtempSync(join(tmpdir(), "nimbus-ext-"));
    keyPath = join(tmpDir, "publisher-key");
    await runExtensionKeygen(["--out", keyPath]);
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  it("returns 2 when ext dir is missing", async () => {
    expect(await runExtensionSign([])).toBe(2);
  });

  it("returns 2 when first arg is a flag", async () => {
    expect(await runExtensionSign(["--key", keyPath])).toBe(2);
  });

  it("returns 2 when the key file is unreadable", async () => {
    expect(await runExtensionSign([tmpDir, "--key", join(tmpDir, "no-such-key")])).toBe(2);
  });

  it("returns 2 when the key file is not 32 bytes", async () => {
    const shortKey = join(tmpDir, "short-key");
    writeFileSync(shortKey, Buffer.from("too-short").toString("base64"), "utf8");
    expect(await runExtensionSign([tmpDir, "--key", shortKey])).toBe(2);
  });

  it("returns 2 when the manifest is unreadable", async () => {
    expect(await runExtensionSign([tmpDir, "--key", keyPath])).toBe(2);
  });

  it("signs the manifest and returns 0 (writes a signature field)", async () => {
    const manifestPath = join(tmpDir, "nimbus.extension.json");
    writeFileSync(
      manifestPath,
      JSON.stringify({ id: "com.example.ext", version: "0.1.0", permissions: [] }),
      "utf8",
    );
    const code = await runExtensionSign([tmpDir, "--key", keyPath]);
    expect(code).toBe(0);
    const signed = JSON.parse(readFileSync(manifestPath, "utf8")) as { signature?: unknown };
    expect(typeof signed.signature).toBe("string");
  });
});
