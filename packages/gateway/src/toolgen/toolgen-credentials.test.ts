import { describe, expect, test } from "bun:test";
import type { VaultDeleter, VaultLister, VaultReader, VaultWriter } from "../vault/nimbus-vault.ts";
import {
  deleteCredentialsForTool,
  deleteToolCredential,
  readToolCredential,
  toolCredentialKey,
  writeToolCredential,
} from "./toolgen-credentials.ts";
import { TOOLGEN_SIGNING_PRIVKEY, TOOLGEN_SIGNING_PUBKEY } from "./toolgen-keypair.ts";

function memoryVault(): VaultReader & VaultWriter & VaultDeleter & VaultLister {
  const store = new Map<string, string>();
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async (prefix) => [...store.keys()].filter((k) => !prefix || k.startsWith(prefix)),
  };
}

describe("toolCredentialKey", () => {
  test("is namespaced per tool AND per host", () => {
    expect(toolCredentialKey("tg_a", "api.example.com")).toBe("toolgen.tg_a.api_pexample_pcom");
    expect(toolCredentialKey("tg_a", "other.example.com")).not.toBe(
      toolCredentialKey("tg_a", "api.example.com"),
    );
    expect(toolCredentialKey("tg_b", "api.example.com")).not.toBe(
      toolCredentialKey("tg_a", "api.example.com"),
    );
  });

  test("hosts differing only by a separator do not collide", () => {
    expect(toolCredentialKey("tg_a", "a.b-c.com")).not.toBe(toolCredentialKey("tg_a", "a-b.c.com"));
  });

  test("hosts that differ only by a dotted single-letter label vs a dash do NOT collide", () => {
    expect(toolCredentialKey("tg_a", "api.d.example.com")).not.toBe(
      toolCredentialKey("tg_a", "api-example.com"),
    );
    expect(toolCredentialKey("tg_a", "a.d.b.com")).not.toBe(toolCredentialKey("tg_a", "a-b.com"));
  });

  test("a host containing the escape character is still distinct", () => {
    expect(toolCredentialKey("tg_a", "a_b.com")).not.toBe(toolCredentialKey("tg_a", "a.b.com"));
  });
});

describe("round-trip", () => {
  test("a bearer binding survives", async () => {
    const v = memoryVault();
    await writeToolCredential(v, "tg_a", "api.example.com", { type: "bearer", token: "s3cret" });
    expect(await readToolCredential(v, "tg_a", "api.example.com")).toEqual({
      type: "bearer",
      token: "s3cret",
    });
  });

  test("a missing binding reads as null, not a throw", async () => {
    expect(await readToolCredential(memoryVault(), "tg_a", "nope.example.com")).toBeNull();
  });

  test("a malformed stored value reads as null — external data is guarded, never asserted", async () => {
    const v = memoryVault();
    await v.set(toolCredentialKey("tg_a", "api.example.com"), '{"type":"wat"}');
    expect(await readToolCredential(v, "tg_a", "api.example.com")).toBeNull();
  });

  test("credentials are NOT shared across tools", async () => {
    const v = memoryVault();
    await writeToolCredential(v, "tg_a", "api.example.com", { type: "bearer", token: "s3cret" });
    expect(await readToolCredential(v, "tg_b", "api.example.com")).toBeNull();
  });

  test("a credential written for host A is not readable for host B", async () => {
    const v = memoryVault();
    await writeToolCredential(v, "tg_a", "a.example.com", { type: "bearer", token: "A-ONLY" });
    expect(await readToolCredential(v, "tg_a", "b.example.com")).toBeNull();
  });

  test("a same-type binding missing a required field reads as null, never partially applied", async () => {
    const v = memoryVault();
    await v.set(toolCredentialKey("tg_a", "api.example.com"), '{"type":"bearer"}');
    expect(await readToolCredential(v, "tg_a", "api.example.com")).toBeNull();

    const v2 = memoryVault();
    await v2.set(
      toolCredentialKey("tg_a", "api.example.com"),
      '{"type":"header","headerName":"X"}',
    );
    expect(await readToolCredential(v2, "tg_a", "api.example.com")).toBeNull();
  });
});

describe("every binding shape survives a real write/read round trip", () => {
  // `applyCredential` in the broker switches on `type`, so a shape that writes but fails to parse
  // back would leave the request UNAUTHENTICATED rather than erroring — the tool would see a 401
  // from the upstream and the owner would have no signal the binding was the problem.
  test("a header binding round-trips with its name and value intact", async () => {
    const vault = memoryVault();
    await writeToolCredential(vault, "tg_a", "api.example.com", {
      type: "header",
      headerName: "X-Api-Key",
      value: "k1",
    });
    expect(await readToolCredential(vault, "tg_a", "api.example.com")).toEqual({
      type: "header",
      headerName: "X-Api-Key",
      value: "k1",
    });
  });

  test("a basic binding round-trips with its username and password intact", async () => {
    const vault = memoryVault();
    await writeToolCredential(vault, "tg_a", "api.example.com", {
      type: "basic",
      username: "u",
      password: "p",
    });
    expect(await readToolCredential(vault, "tg_a", "api.example.com")).toEqual({
      type: "basic",
      username: "u",
      password: "p",
    });
  });
});

describe("a credential that cannot be parsed reads as ABSENT, never half-applied", () => {
  async function readRaw(raw: string): Promise<unknown> {
    const vault = memoryVault();
    await vault.set(toolCredentialKey("tg_a", "api.example.com"), raw);
    return readToolCredential(vault, "tg_a", "api.example.com");
  }

  // The distinction that matters: `null` means the broker attaches NOTHING and the request goes
  // out unauthenticated, which is visible upstream. A partially-applied binding — a `basic` with
  // a username and no password, say — would put a half-formed secret on the wire instead.
  test.each([
    ["not JSON at all", "}{"],
    ["a JSON null", "null"],
    ["a JSON array", '["bearer"]'],
    ["a JSON scalar", "42"],
    ["an unknown type", '{"type":"mtls","cert":"c"}'],
    ["bearer with a non-string token", '{"type":"bearer","token":123}'],
    ["header missing its value", '{"type":"header","headerName":"X-Api-Key"}'],
    ["header with a non-string name", '{"type":"header","headerName":1,"value":"v"}'],
    ["basic missing its password", '{"type":"basic","username":"u"}'],
    ["basic with a non-string username", '{"type":"basic","username":1,"password":"p"}'],
  ])("%s reads as null", async (_label, raw) => {
    expect(await readRaw(raw)).toBeNull();
  });
});

describe("deleteToolCredential", () => {
  test("removes the per-host key and tolerates an absent one", async () => {
    const vault = memoryVault();
    await writeToolCredential(vault, "t1", "api.github.com", { type: "bearer", token: "x" });
    await deleteToolCredential(vault, "t1", "api.github.com");
    expect(await readToolCredential(vault, "t1", "api.github.com")).toBeNull();
    // Idempotent -- called on a host that never had a binding, or one already deleted.
    await deleteToolCredential(vault, "t1", "api.github.com");
    expect(await readToolCredential(vault, "t1", "api.github.com")).toBeNull();
  });

  test("deleting one tool's credential does not touch another tool's under the same host", async () => {
    const vault = memoryVault();
    await writeToolCredential(vault, "t1", "api.github.com", { type: "bearer", token: "a" });
    await writeToolCredential(vault, "t2", "api.github.com", { type: "bearer", token: "b" });
    await deleteToolCredential(vault, "t1", "api.github.com");
    expect(await readToolCredential(vault, "t1", "api.github.com")).toBeNull();
    expect(await readToolCredential(vault, "t2", "api.github.com")).toEqual({
      type: "bearer",
      token: "b",
    });
  });
});

describe("deleteCredentialsForTool", () => {
  test("removes every host bound to the tool, by prefix, without a host list", async () => {
    const vault = memoryVault();
    await writeToolCredential(vault, "t1", "api.example.com", { type: "bearer", token: "a" });
    await writeToolCredential(vault, "t1", "other.example.com", { type: "bearer", token: "b" });
    await deleteCredentialsForTool(vault, "t1");
    expect(await readToolCredential(vault, "t1", "api.example.com")).toBeNull();
    expect(await readToolCredential(vault, "t1", "other.example.com")).toBeNull();
  });

  test("leaves another tool's credentials untouched, even under the same host", async () => {
    const vault = memoryVault();
    await writeToolCredential(vault, "t1", "api.example.com", { type: "bearer", token: "a" });
    await writeToolCredential(vault, "t2", "api.example.com", { type: "bearer", token: "b" });
    await deleteCredentialsForTool(vault, "t1");
    expect(await readToolCredential(vault, "t2", "api.example.com")).toEqual({
      type: "bearer",
      token: "b",
    });
  });

  test("also catches a credential for a host no longer in the tool's current envelope", async () => {
    // A host-list delete (resolve `credentialHosts` from the envelope, then delete each) would
    // strand this one in the keychain forever, since it isn't in any host list a caller could
    // supply. The prefix-based approach has no such blind spot.
    const vault = memoryVault();
    await writeToolCredential(vault, "t1", "stale.example.com", { type: "bearer", token: "old" });
    await deleteCredentialsForTool(vault, "t1");
    expect(await readToolCredential(vault, "t1", "stale.example.com")).toBeNull();
  });

  test("tolerates a tool with no credentials at all", async () => {
    const vault = memoryVault();
    await expect(deleteCredentialsForTool(vault, "never-had-one")).resolves.toBeUndefined();
  });

  test("a tool id that is a prefix of another tool id does not collide (trailing dot disambiguates)", async () => {
    const vault = memoryVault();
    await writeToolCredential(vault, "abc", "api.example.com", { type: "bearer", token: "short" });
    await writeToolCredential(vault, "abcd", "api.example.com", { type: "bearer", token: "long" });
    await deleteCredentialsForTool(vault, "abc");
    expect(await readToolCredential(vault, "abc", "api.example.com")).toBeNull();
    expect(await readToolCredential(vault, "abcd", "api.example.com")).toEqual({
      type: "bearer",
      token: "long",
    });
  });

  test("the RESERVED tool id `signing` cannot delete the artifact-signing keypair", async () => {
    // `signing` satisfies `assertSafeToolId`'s `^[A-Za-z0-9_-]{1,64}$` perfectly, and
    // `toolgen.${"signing"}.` is byte-for-byte the prefix the Ed25519 signing keypair lives under.
    // Before the exclusion, `nimbus tool revoke signing` -- a caller-supplied id over
    // `toolgen.revoke` -- deleted both Vault entries, after which EVERY saved tool on the machine
    // reported `pubkey_unavailable` at the next boot and could never verify again: the seed lives
    // only in the OS keychain, so nothing else holds a copy.
    const vault = memoryVault();
    await vault.set(TOOLGEN_SIGNING_PRIVKEY, "priv-seed");
    await vault.set(TOOLGEN_SIGNING_PUBKEY, "pub-key");

    await deleteCredentialsForTool(vault, "signing");

    expect(await vault.get(TOOLGEN_SIGNING_PRIVKEY)).toBe("priv-seed");
    expect(await vault.get(TOOLGEN_SIGNING_PUBKEY)).toBe("pub-key");
  });

  test("the signing exclusion is by PREFIX, so it survives a third signing key being added", async () => {
    // Keyed on `TOOLGEN_SIGNING_KEY_PREFIX`, not on the two key names -- a future
    // `toolgen.signing.<anything>` is protected without this test or that function changing.
    const vault = memoryVault();
    await vault.set("toolgen.signing.future_key", "whatever");
    await deleteCredentialsForTool(vault, "signing");
    expect(await vault.get("toolgen.signing.future_key")).toBe("whatever");
  });

  test("excluding `signing` does not exempt a genuine credential under a DIFFERENT tool id", async () => {
    // The exclusion must be exactly as narrow as the signing prefix -- a `startsWith("toolgen.s")`
    // style over-match would silently strand real credentials in the keychain.
    const vault = memoryVault();
    await writeToolCredential(vault, "signing_tool", "api.example.com", {
      type: "bearer",
      token: "t",
    });
    await deleteCredentialsForTool(vault, "signing_tool");
    expect(await readToolCredential(vault, "signing_tool", "api.example.com")).toBeNull();
  });
});
