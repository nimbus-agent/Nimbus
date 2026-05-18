import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "./helpers.ts";

describe("nimbus extension keygen", () => {
  test("writes a 44-char base64 pubkey + 0600 privkey file", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-keygen-"));
    const outPath = join(dir, "pub.key");
    try {
      const { stdout, exitCode } = await runCli(["extension", "keygen", "--out", outPath]);
      expect(exitCode).toBe(0);
      expect(stdout.trim()).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      const priv = readFileSync(outPath, "utf8").trim();
      expect(priv).toMatch(/^[A-Za-z0-9+/]{43}=$/);
      if (process.platform !== "win32") {
        const mode = statSync(outPath).mode & 0o777;
        expect(mode).toBe(0o600);
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("refuses to overwrite existing file without --force", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-keygen-"));
    const outPath = join(dir, "pub.key");
    try {
      await runCli(["extension", "keygen", "--out", outPath]);
      const second = await runCli(["extension", "keygen", "--out", outPath]);
      expect(second.exitCode).not.toBe(0);
      expect(second.stderr).toContain("--force");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
