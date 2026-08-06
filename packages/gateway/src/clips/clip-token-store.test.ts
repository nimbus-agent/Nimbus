import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { LEGACY_SCOPES } from "./api-scopes.ts";
import {
  addApiToken,
  CLIP_TOKENS_VAULT_KEY,
  generateClipToken,
  listApiTokens,
  loadApiTokens,
  revokeClipToken,
  setApiTokenScopes,
  verifyApiToken,
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
    expect(await loadApiTokens(fakeVault())).toEqual({});
  });

  test("add → load round-trips under the label", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome-work", "tok-abc", ["clip"]);
    expect(await loadApiTokens(v)).toEqual({
      "chrome-work": { token: "tok-abc", scopes: ["clip"] },
    });
    expect(await v.get(CLIP_TOKENS_VAULT_KEY)).toContain("chrome-work");
  });

  test("re-add same label replaces (rotation); new label adds (concurrent)", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "tok-1", ["clip"]);
    await addApiToken(v, "chrome", "tok-2", ["clip"]); // rotation
    await addApiToken(v, "firefox", "tok-3", ["clip"]); // concurrent
    expect(await loadApiTokens(v)).toEqual({
      chrome: { token: "tok-2", scopes: ["clip"] },
      firefox: { token: "tok-3", scopes: ["clip"] },
    });
  });

  test("verifyApiToken matches a stored token and returns its label", async () => {
    const v = fakeVault();
    await addApiToken(v, "firefox", "tok-3", ["clip"]);
    expect(await verifyApiToken(v, "tok-3")).toEqual({ label: "firefox", scopes: ["clip"] });
    expect(await verifyApiToken(v, "wrong")).toBeNull();
  });

  test("verify against empty map is null (no throw)", async () => {
    expect(await verifyApiToken(fakeVault(), "anything")).toBeNull();
  });

  test("revoke one label removes only it; returns 1", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "t1", ["clip"]);
    await addApiToken(v, "firefox", "t2", ["clip"]);
    expect(await revokeClipToken(v, "chrome")).toBe(1);
    expect(await loadApiTokens(v)).toEqual({ firefox: { token: "t2", scopes: ["clip"] } });
  });

  test("revoke '*' clears all; returns count", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "t1", ["clip"]);
    await addApiToken(v, "firefox", "t2", ["clip"]);
    expect(await revokeClipToken(v, "*")).toBe(2);
    expect(await loadApiTokens(v)).toEqual({});
  });

  test("revoke missing label returns 0", async () => {
    expect(await revokeClipToken(fakeVault(), "nope")).toBe(0);
  });

  test("listApiTokens returns label + 8-hex fingerprint, never the raw token", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "tok-secret", ["clip"]);
    const out = await listApiTokens(v);
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
    ["empty object (no entries to parse)", "{}"],
    ["non-object JSON (number)", "42"],
    ["JSON array (Array rejected)", '["a","b"]'],
    ["null JSON", "null"],
    ["object with a non-string value (every→false)", '{"chrome":5}'],
    ["empty string", ""],
  ])("stored %s → empty map", async (_label, stored) => {
    const v = fakeVault();
    await v.set(CLIP_TOKENS_VAULT_KEY, stored);
    expect(await loadApiTokens(v)).toEqual({});
  });

  test("a legacy bare-string entry parses as a record with LEGACY_SCOPES only", async () => {
    const v = fakeVault();
    // Exactly the on-disk shape written by every gateway before this change.
    await v.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify({ chrome: "tok-legacy" }));
    expect(await loadApiTokens(v)).toEqual({
      chrome: { token: "tok-legacy", scopes: LEGACY_SCOPES },
    });
  });

  test("a legacy token is REJECTED for a scope this design adds", async () => {
    const v = fakeVault();
    await v.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify({ chrome: "tok-legacy" }));
    const verified = await verifyApiToken(v, "tok-legacy");
    expect(verified).not.toBeNull();
    expect(verified?.scopes).toEqual(LEGACY_SCOPES);
    expect(verified?.scopes).not.toContain("agents");
  });

  test("addApiToken round-trips the scope list", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "tok-1", ["clip", "agents"]);
    expect(await loadApiTokens(v)).toEqual({
      chrome: { token: "tok-1", scopes: ["clip", "agents"] },
    });
  });

  test("unknown scopes in a stored record are dropped, not carried", async () => {
    const v = fakeVault();
    // A record written by a NEWER binary that knows a scope this one does not.
    await v.set(
      CLIP_TOKENS_VAULT_KEY,
      JSON.stringify({ chrome: { token: "t", scopes: ["clip", "telepathy"] } }),
    );
    const loaded = await loadApiTokens(v);
    // Dropped rather than preserved: an unrecognised scope this binary cannot enforce must not
    // be treated as granting anything. Fail closed.
    expect(loaded["chrome"]?.scopes).toEqual(["clip"]);
  });

  test("a malformed entry is dropped entirely rather than defaulting to a grant", async () => {
    const v = fakeVault();
    await v.set(
      CLIP_TOKENS_VAULT_KEY,
      JSON.stringify({ good: "tok-ok", bad: { scopes: ["clip"] }, alsoBad: 7 }),
    );
    const loaded = await loadApiTokens(v);
    expect(Object.keys(loaded)).toEqual(["good"]);
  });

  test("verifyApiToken returns label AND scopes for a scoped record", async () => {
    const v = fakeVault();
    await addApiToken(v, "firefox", "tok-3", ["clip", "briefs", "agents"]);
    expect(await verifyApiToken(v, "tok-3")).toEqual({
      label: "firefox",
      scopes: ["clip", "briefs", "agents"],
    });
    expect(await verifyApiToken(v, "wrong")).toBeNull();
  });

  test("listApiTokens reports scopes and a fingerprint, never the token value", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "tok-secret", ["clip"]);
    const out = await listApiTokens(v);
    expect(out).toEqual([{ label: "chrome", fingerprint: expect.any(String), scopes: ["clip"] }]);
    expect(JSON.stringify(out)).not.toContain("tok-secret");
  });

  test("setApiTokenScopes rewrites scopes in place and leaves the token value untouched", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "tok-keep", ["clip"]);
    expect(await setApiTokenScopes(v, "chrome", ["clip", "agents"])).toBe(true);
    expect(await loadApiTokens(v)).toEqual({
      chrome: { token: "tok-keep", scopes: ["clip", "agents"] },
    });
    // A paired client must keep working across a scope edit.
    expect(await verifyApiToken(v, "tok-keep")).not.toBeNull();
  });

  test("setApiTokenScopes can NARROW, and reports false for an unknown label", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "t", ["clip", "agents"]);
    expect(await setApiTokenScopes(v, "chrome", ["clip"])).toBe(true);
    expect((await loadApiTokens(v))["chrome"]?.scopes).toEqual(["clip"]);
    expect(await setApiTokenScopes(v, "nope", ["clip"])).toBe(false);
  });
});
