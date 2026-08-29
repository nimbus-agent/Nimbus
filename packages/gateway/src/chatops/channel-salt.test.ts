import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { CHATOPS_CHANNEL_SALT, ensureChannelSalt, hashChannelId } from "./channel-salt.ts";

// All FOUR members of NimbusVault (get/set/delete/listKeys) — no `as` cast. A cast here would
// hide a real interface change behind a green test.
function fakeVault(): NimbusVault {
  const store = new Map<string, string>();
  return {
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => {
      store.set(k, v);
    },
    delete: async (k: string) => {
      store.delete(k);
    },
    listKeys: async (prefix?: string) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
}

describe("channel salt", () => {
  test("generates a 32-byte salt on first use and persists it", async () => {
    const vault = fakeVault();
    const first = await ensureChannelSalt(vault);
    expect(Buffer.from(first, "base64").length).toBe(32);
    expect(await vault.get(CHATOPS_CHANNEL_SALT)).toBe(first);
  });

  test("reuses the persisted salt on later calls", async () => {
    const vault = fakeVault();
    expect(await ensureChannelSalt(vault)).toBe(await ensureChannelSalt(vault));
  });

  test("regenerates when the stored value is not a 32-byte base64 salt", async () => {
    const vault = fakeVault();
    await vault.set(CHATOPS_CHANNEL_SALT, "truncated");
    const salt = await ensureChannelSalt(vault);
    expect(Buffer.from(salt, "base64").length).toBe(32);
  });

  test("the hash is deterministic per salt and never contains the channel id", () => {
    const h = hashChannelId("c2FsdA==", "C01ABC2DEF3");
    expect(h).toBe(hashChannelId("c2FsdA==", "C01ABC2DEF3"));
    expect(h).not.toContain("C01ABC2DEF3");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });

  test("a DIFFERENT salt yields a different hash for the same channel — the dictionary defence", () => {
    // This is the whole point: without the salt, an attacker who can enumerate channel ids can
    // hash each candidate and match. With a per-install secret salt they cannot.
    expect(hashChannelId("c2FsdEE=", "C01ABC2DEF3")).not.toBe(
      hashChannelId("c2FsdEI=", "C01ABC2DEF3"),
    );
  });

  test("a Vault write failure rejects, names the key, says the GATEWAY (not just ChatOps) will not start, and never leaks the salt", async () => {
    const vault: NimbusVault = {
      get: async () => null,
      set: async () => {
        throw new Error("DPAPI: access denied");
      },
      delete: async () => {},
      listKeys: async () => [],
    };
    let caught: unknown;
    try {
      await ensureChannelSalt(vault);
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    const message = caught instanceof Error ? caught.message : "";
    expect(message).toContain(CHATOPS_CHANNEL_SALT);
    expect(message).toContain("GATEWAY will not start");
    // The security-relevant assertion: a Vault-write-failure diagnostic must never carry the
    // (freshly generated, about-to-be-discarded) salt value itself — the message names the KEY,
    // never the base64 secret it failed to persist.
    expect(message).not.toMatch(/[A-Za-z0-9+/]{40,}={0,2}/);
    expect(caught instanceof Error ? caught.cause : undefined).toBeInstanceOf(Error);
  });
});
