import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  addClipToken,
  CLIP_TOKENS_VAULT_KEY,
  generateClipToken,
  listClipFingerprints,
  loadClipTokens,
  revokeClipToken,
  verifyClipToken,
} from "./clip-token-store.ts";

/** Minimal in-memory vault fake (get/set/delete/listKeys). */
function fakeVault(): NimbusVault {
  const store = new Map<string, string>();
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async (prefix) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
}

describe("clip-token-store", () => {
  test("empty vault → empty map", async () => {
    expect(await loadClipTokens(fakeVault())).toEqual({});
  });

  test("add → load round-trips under the label", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome-work", "tok-abc");
    expect(await loadClipTokens(v)).toEqual({ "chrome-work": "tok-abc" });
    expect(await v.get(CLIP_TOKENS_VAULT_KEY)).toContain("chrome-work");
  });

  test("re-add same label replaces (rotation); new label adds (concurrent)", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome", "tok-1");
    await addClipToken(v, "chrome", "tok-2"); // rotation
    await addClipToken(v, "firefox", "tok-3"); // concurrent
    expect(await loadClipTokens(v)).toEqual({ chrome: "tok-2", firefox: "tok-3" });
  });

  test("verifyClipToken matches a stored token and returns its label", async () => {
    const v = fakeVault();
    await addClipToken(v, "firefox", "tok-3");
    expect(await verifyClipToken(v, "tok-3")).toEqual({ label: "firefox" });
    expect(await verifyClipToken(v, "wrong")).toBeNull();
  });

  test("verify against empty map is null (no throw)", async () => {
    expect(await verifyClipToken(fakeVault(), "anything")).toBeNull();
  });

  test("revoke one label removes only it; returns 1", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome", "t1");
    await addClipToken(v, "firefox", "t2");
    expect(await revokeClipToken(v, "chrome")).toBe(1);
    expect(await loadClipTokens(v)).toEqual({ firefox: "t2" });
  });

  test("revoke '*' clears all; returns count", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome", "t1");
    await addClipToken(v, "firefox", "t2");
    expect(await revokeClipToken(v, "*")).toBe(2);
    expect(await loadClipTokens(v)).toEqual({});
  });

  test("revoke missing label returns 0", async () => {
    expect(await revokeClipToken(fakeVault(), "nope")).toBe(0);
  });

  test("listClipFingerprints returns label + 8-hex fingerprint, never the raw token", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome", "tok-secret");
    const out = await listClipFingerprints(v);
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe("chrome");
    expect(out[0]?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(out)).not.toContain("tok-secret");
  });

  test("generateClipToken yields distinct 64-hex strings", () => {
    const a = generateClipToken();
    const b = generateClipToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  // Every non-conforming vault payload is fail-safe: an empty map, never a throw.
  test.each([
    ["corrupt JSON", "{not json"],
    ["empty object (isStringMap vacuous-true)", "{}"],
    ["non-object JSON (number)", "42"],
    ["JSON array (Array rejected)", '["a","b"]'],
    ["null JSON", "null"],
    ["object with a non-string value (every→false)", '{"chrome":5}'],
    ["empty string", ""],
  ])("stored %s → empty map", async (_label, stored) => {
    const v = fakeVault();
    await v.set(CLIP_TOKENS_VAULT_KEY, stored);
    expect(await loadClipTokens(v)).toEqual({});
  });
});
