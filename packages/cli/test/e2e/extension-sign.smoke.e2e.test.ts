import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";

import { runCli } from "./helpers.ts";

describe("nimbus extension sign", () => {
  test("signs a manifest in place; resulting signature has correct shape", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-sign-"));
    const extDir = join(dir, "my-ext");
    mkdirSync(join(extDir, "dist"), { recursive: true });
    const { privkey, pubkey } = generateEd25519Keypair();
    const keyPath = join(dir, "priv.key");
    writeFileSync(keyPath, `${encodeBase64(privkey)}\n`);
    writeFileSync(
      join(extDir, "nimbus.extension.json"),
      JSON.stringify({
        id: "my-ext",
        version: "0.1.0",
        permissions: {},
        publisher: { id: "test-pub", key: encodeBase64(pubkey) },
      }),
    );
    writeFileSync(join(extDir, "dist", "index.js"), "export default {};");
    try {
      const { exitCode } = await runCli(["extension", "sign", extDir, "--key", keyPath]);
      expect(exitCode).toBe(0);
      const text = readFileSync(join(extDir, "nimbus.extension.json"), "utf8");
      const m = JSON.parse(text) as { signature?: string };
      expect(m.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("overwrites an existing signature field", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-sign-"));
    const extDir = join(dir, "my-ext");
    mkdirSync(extDir, { recursive: true });
    const { privkey, pubkey } = generateEd25519Keypair();
    const keyPath = join(dir, "priv.key");
    writeFileSync(keyPath, `${encodeBase64(privkey)}\n`);
    const placeholder = `${"A".repeat(86)}==`;
    writeFileSync(
      join(extDir, "nimbus.extension.json"),
      JSON.stringify({
        id: "my-ext",
        version: "0.1.0",
        permissions: {},
        publisher: { id: "test-pub", key: encodeBase64(pubkey) },
        signature: placeholder,
      }),
    );
    try {
      const { exitCode } = await runCli(["extension", "sign", extDir, "--key", keyPath]);
      expect(exitCode).toBe(0);
      const m = JSON.parse(readFileSync(join(extDir, "nimbus.extension.json"), "utf8")) as {
        signature: string;
      };
      expect(m.signature).not.toBe(placeholder);
      expect(m.signature).toMatch(/^[A-Za-z0-9+/]{86}==$/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
