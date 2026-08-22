import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { type LocalBaseline, PolicyGate } from "./policy-gate.ts";
import { refreshPolicy } from "./policy-runtime.ts";
import { signPolicy } from "./policy-signing.ts";
import { PolicyStore } from "./policy-store.ts";

const baseline: LocalBaseline = {
  retentionDays: 7,
  hitlRequired: new Set(),
  quorum: new Map(),
  capabilitiesDisabled: new Set(),
};

function setup() {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  const store = new PolicyStore(db);
  const gate = new PolicyGate(store, baseline);
  return { db, store, gate };
}

describe("refreshPolicy (peer side)", () => {
  test("a validly-signed fetched policy is persisted and applied", async () => {
    const kp = generateEd25519Keypair();
    const pub = encodeBase64(kp.pubkey);
    const { store, gate } = setup();
    store.pinAnchorPubkey(pub, "manual", 1);
    const toml = `[policy]\nversion=2\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const out = await refreshPolicy({
      store,
      gate,
      pinnedPubkey: pub,
      nowMs: 1000,
      fetch: async () => ({ toml, sig: signPolicy(toml, encodeBase64(kp.privkey)) }),
    });
    expect(out.applied).toBe(true);
    expect(gate.enforced().retentionDays).toBe(30);
    expect(gate.status().version).toBe(2);
  });

  test("a tampered fetched policy is rejected; the prior enforced view is unchanged", async () => {
    const kp = generateEd25519Keypair();
    const pub = encodeBase64(kp.pubkey);
    const { store, gate } = setup();
    store.pinAnchorPubkey(pub, "manual", 1);
    const toml = `[policy]\nversion=2\norg="acme"\n[policy.retention]\nmin_days=30\n`;
    const sig = signPolicy(toml, encodeBase64(kp.privkey));
    const out = await refreshPolicy({
      store,
      gate,
      pinnedPubkey: pub,
      nowMs: 1000,
      fetch: async () => ({ toml: toml.replace("30", "99"), sig }),
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("bad_signature");
    expect(gate.enforced().retentionDays).toBe(7); // baseline, not 99
  });

  test("a null fetch (anchor has no policy) is a no-op", async () => {
    const kp = generateEd25519Keypair();
    const pub = encodeBase64(kp.pubkey);
    const { store, gate } = setup();
    store.pinAnchorPubkey(pub, "manual", 1);
    const out = await refreshPolicy({
      store,
      gate,
      pinnedPubkey: pub,
      nowMs: 1,
      fetch: async () => null,
    });
    expect(out.applied).toBe(false);
    expect(out.reason).toBe("no_bundle");
  });

  test("a fetch() that throws propagates and leaves the store untouched (no partial write)", async () => {
    const kp = generateEd25519Keypair();
    const pub = encodeBase64(kp.pubkey);
    const { store, gate } = setup();
    store.pinAnchorPubkey(pub, "manual", 1);
    await expect(
      refreshPolicy({
        store,
        gate,
        pinnedPubkey: pub,
        nowMs: 1,
        fetch: async () => {
          throw new Error("LAN down");
        },
      }),
    ).rejects.toThrow("LAN down");
    expect(store.load()).toBeUndefined(); // nothing persisted
    expect(gate.status().signatureValid).toBe(false);
  });

  test("pendingRestart fires only when the connector allowlist changes", async () => {
    const kp = generateEd25519Keypair();
    const pub = encodeBase64(kp.pubkey);
    const { store, gate } = setup();
    store.pinAnchorPubkey(pub, "manual", 1);
    let restarts = 0;
    const onConnectorAllowChanged = () => {
      restarts++;
    };
    const v1 = `[policy]\nversion=1\norg="acme"\n[policy.connectors]\nallow=["github"]\n`;
    await refreshPolicy({
      store,
      gate,
      pinnedPubkey: pub,
      nowMs: 1,
      onConnectorAllowChanged,
      fetch: async () => ({ toml: v1, sig: signPolicy(v1, encodeBase64(kp.privkey)) }),
    });
    // change ONLY retention -> connector allow unchanged -> no restart
    const v2 = `[policy]\nversion=2\norg="acme"\n[policy.connectors]\nallow=["github"]\n[policy.retention]\nmin_days=30\n`;
    await refreshPolicy({
      store,
      gate,
      pinnedPubkey: pub,
      nowMs: 2,
      onConnectorAllowChanged,
      fetch: async () => ({ toml: v2, sig: signPolicy(v2, encodeBase64(kp.privkey)) }),
    });
    // change connector allow -> restart
    const v3 = `[policy]\nversion=3\norg="acme"\n[policy.connectors]\nallow=["github","slack"]\n[policy.retention]\nmin_days=30\n`;
    await refreshPolicy({
      store,
      gate,
      pinnedPubkey: pub,
      nowMs: 3,
      onConnectorAllowChanged,
      fetch: async () => ({ toml: v3, sig: signPolicy(v3, encodeBase64(kp.privkey)) }),
    });
    expect(restarts).toBe(2); // v1 (undefined->["github"]) and v3 (["github"]->["github","slack"]); v2 no change
  });
});
