import { describe, expect, test } from "bun:test";
import { read } from "../../test/helpers/security-invariants.ts";

describe("I12 — DPAPI calls pass per-installation optional entropy (win32)", () => {
  test("vault/win32.ts loads entropy from <configDir>/vault/.entropy", async () => {
    const src = await read("packages/gateway/src/vault/win32.ts");
    expect(src).toMatch(/ENTROPY_FILENAME\s*=\s*"\.entropy"/);
    expect(src).toMatch(/function loadOrCreateEntropy\(/);
  });

  test("entropy flows into both the encrypt and decrypt DPAPI paths", async () => {
    const src = await read("packages/gateway/src/vault/win32.ts");
    // Encrypt path consumes the cached entropy; decrypt tries with-entropy before the legacy null fallback.
    expect(src).toMatch(/loadOrCreateEntropy\(this\.vaultDir\)/);
    expect(src).toMatch(/dpapiDecrypt\(encrypted, entropy\)/);
    // The pOptionalEntropy DATA_BLOB pointer is only built when entropy is present, never dropped unconditionally.
    expect(src).toMatch(/entropyArg = ptr\(entropyBlob\)/);
  });
});
