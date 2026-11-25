import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I10 — Constant-time compare helpers live in util/timing-safe-compare.ts", () => {
  test("extensions/verify-extensions.ts imports sha256HexEqualConstantTime from util/timing-safe-compare", async () => {
    const src = await read("packages/gateway/src/extensions/verify-extensions.ts");
    expect(src).toMatch(
      /import\s*\{\s*sha256HexEqualConstantTime\s*\}\s*from\s*["']\.\.\/util\/timing-safe-compare(?:\.ts)?["']/,
    );
  });

  test("updater/updater.ts imports sha256HexEqualConstantTime from util/timing-safe-compare", async () => {
    const src = await read("packages/gateway/src/updater/updater.ts");
    expect(src).toMatch(
      /import\s*\{\s*sha256HexEqualConstantTime\s*\}\s*from\s*["']\.\.\/util\/timing-safe-compare(?:\.ts)?["']/,
    );
  });

  test("ipc/http-auth.ts imports constantTimeStringEqual from util/timing-safe-compare", async () => {
    const src = await read("packages/gateway/src/ipc/http-auth.ts");
    expect(src).toMatch(
      /import\s*\{[^}]*\bconstantTimeStringEqual\b[^}]*\}\s*from\s*["']\.\.\/util\/timing-safe-compare(?:\.ts)?["']/,
    );
  });

  for (const file of [
    "packages/gateway/src/ipc/connector-rpc-handlers/agent-writes-user-mcp.ts",
    "packages/gateway/src/connectors/connector-writes/agent-door-runtime.ts",
  ]) {
    test(`${file} compares a definition hash with constantTimeStringEqual, never === or !==`, async () => {
      const src = await read(file);
      expect(src).toMatch(
        /import\s*\{[^}]*constantTimeStringEqual[^}]*\}\s*from\s*["']\.\.\/(?:\.\.\/)?util\/timing-safe-compare(?:\.ts)?["']/,
      );
      // The CALL on a definition hash, not the bare name.
      const calls =
        stripComments(src).match(/constantTimeStringEqual\([^)]*\.definitionSha256[^)]*\)/g) ?? [];
      expect(calls).toHaveLength(1);
      expect(src).not.toMatch(/[!=]==\s*\w+(?:\.\w+)*\.definitionSha256/);
      expect(src).not.toMatch(/\.definitionSha256\s*[!=]==/);
    });
  }

  test("connectors/connector-writes/agent-door-definition.ts compares definition hashes with constantTimeStringEqual, never === or !==", async () => {
    const src = await read(
      "packages/gateway/src/connectors/connector-writes/agent-door-definition.ts",
    );
    expect(src).toMatch(
      /import\s*\{[^}]*constantTimeStringEqual[^}]*\}\s*from\s*["']\.\.\/\.\.\/util\/timing-safe-compare(?:\.ts)?["']/,
    );
    // The CALL, at both comparison sites (the re-read approval and the listed hash), not the bare name.
    const calls =
      stripComments(src).match(/constantTimeStringEqual\([^)]*\.definitionSha256[^)]*\)/g) ?? [];
    expect(calls).toHaveLength(2);
    expect(src).not.toMatch(/[!=]==\s*\w+(?:\.\w+)*\.definitionSha256/);
    expect(src).not.toMatch(/\.definitionSha256\s*[!=]==/);
  });

  test("ipc/lan-pairing.ts does NOT define a local timingSafeEqual or constantTimeStringEqual", async () => {
    const src = await read("packages/gateway/src/ipc/lan-pairing.ts");
    expect(src).not.toMatch(/function\s+timingSafeEqual\s*\(/);
    expect(src).not.toMatch(/function\s+constantTimeStringEqual\s*\(/);
  });

  test("ipc/http-auth.ts does NOT define a local constantTimeStringEqual", async () => {
    const src = await read("packages/gateway/src/ipc/http-auth.ts");
    expect(src).not.toMatch(/function\s+constantTimeStringEqual\s*\(/);
  });
});
