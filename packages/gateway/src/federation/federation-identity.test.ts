import { expect, test } from "bun:test";
import { boxKeypairFromSecretKey } from "../ipc/lan-crypto.ts";
import {
  FEDERATION_IDENTITY_VAULT_KEY,
  loadOrCreateFederationIdentity,
} from "./federation-identity.ts";

function fakeVault() {
  const store = new Map<string, string>();
  return {
    store,
    get: async (k: string) => store.get(k) ?? null,
    set: async (k: string, v: string) => void store.set(k, v),
    delete: async (k: string) => void store.delete(k),
    listKeys: async () => [...store.keys()],
  };
}

test("creates a 32-byte identity on first call and persists it base64", async () => {
  const v = fakeVault();
  const kp = await loadOrCreateFederationIdentity(v);
  expect(kp.secretKey.length).toBe(32);
  const stored = v.store.get(FEDERATION_IDENTITY_VAULT_KEY);
  expect(stored).toBeDefined();
  expect(Buffer.from(stored as string, "base64").length).toBe(32);
});

test("returns the SAME keypair on a second call (load path)", async () => {
  const v = fakeVault();
  const a = await loadOrCreateFederationIdentity(v);
  const b = await loadOrCreateFederationIdentity(v);
  expect(Buffer.from(b.publicKey).toString("hex")).toBe(Buffer.from(a.publicKey).toString("hex"));
});

test("regenerates if the stored secret is corrupt (wrong length)", async () => {
  const v = fakeVault();
  await v.set(FEDERATION_IDENTITY_VAULT_KEY, Buffer.from(new Uint8Array(10)).toString("base64"));
  const kp = await loadOrCreateFederationIdentity(v);
  expect(kp.secretKey.length).toBe(32);
  const again = boxKeypairFromSecretKey(
    new Uint8Array(Buffer.from(v.store.get(FEDERATION_IDENTITY_VAULT_KEY) as string, "base64")),
  );
  expect(Buffer.from(again.publicKey).toString("hex")).toBe(
    Buffer.from(kp.publicKey).toString("hex"),
  );
});
