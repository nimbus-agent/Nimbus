import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { NimbusIdentityToml, NimbusScimToml } from "../../config/nimbus-toml.ts";
import { CONNECTOR_SERVICE_IDS } from "../../connectors/connector-catalog.ts";
import { transitionHealth } from "../../connectors/health.ts";
import { delegatedApprovalBroker } from "../../engine/delegated-approval-broker.ts";
import { buildIdentityBoot } from "../../identity/identity-boot.ts";
import { fakeVault } from "../../identity/testing/identity-test-helpers.ts";
import { LocalIndex } from "../../index/local-index.ts";
import type { PolicyGate } from "../../policy/policy-gate.ts";
import type { PolicyState } from "../../policy/types.ts";
import { buildStatusReaders } from "./status-readers.ts";

const ISSUER = "https://acme.example";
const IDENTITY_CFG: NimbusIdentityToml = {
  enabled: true,
  issuer: ISSUER,
  clientId: "c1",
  flow: "device_code",
  scopes: ["openid"],
  sessionGraceSeconds: 100,
  revalidateIntervalSeconds: 3600,
  tokenRefreshSkewSeconds: 300,
  jwksMaxAgeSeconds: 86400,
};
const SCIM_CFG: NimbusScimToml = { enabled: false };

const POLICY_STATE: PolicyState = {
  signatureValid: true,
  pendingRestart: false,
  source: "none",
} as PolicyState;

const opened: Database[] = [];
function freshIndex(): LocalIndex {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  opened.push(db);
  return new LocalIndex(db);
}
afterEach(() => {
  for (const d of opened.splice(0)) d.close();
});

function readersFor(
  index: LocalIndex,
  isConnectorAllowed: (id: string) => boolean = () => true,
  identityBoot?: ReturnType<typeof buildIdentityBoot>,
) {
  const policyGate = { status: () => POLICY_STATE } as unknown as PolicyGate;
  return buildStatusReaders({
    db: index.getDatabase(),
    policyGate,
    localIndex: index,
    isConnectorAllowed,
    ...(identityBoot === undefined ? {} : { identityBoot }),
  });
}

describe("buildStatusReaders", () => {
  test("policyState returns exactly what the policy gate reports", () => {
    expect(readersFor(freshIndex()).policyState()).toBe(POLICY_STATE);
  });

  test("peers maps last_seen_at to reachability and a millisecond timestamp", () => {
    const index = freshIndex();
    index.addLanPeer({
      peerId: "never",
      peerPubkey: new Uint8Array(32).fill(1),
      direction: "outbound",
    });
    index.addLanPeer({
      peerId: "seen",
      peerPubkey: new Uint8Array(32).fill(2),
      direction: "inbound",
    });
    const seenAt = "2026-01-02T03:04:05.000Z";
    index
      .getDatabase()
      .run(`UPDATE lan_peers SET last_seen_at = ? WHERE peer_id = 'seen'`, [seenAt]);
    const peers = readersFor(index).peers();
    const never = peers.find((p) => p.peerId === "never");
    const seen = peers.find((p) => p.peerId === "seen");
    expect(never).toEqual({ peerId: "never", reachable: false });
    expect(never).not.toHaveProperty("lastSeenMs");
    expect(seen).toEqual({ peerId: "seen", reachable: true, lastSeenMs: Date.parse(seenAt) });
  });

  test("connectors lists every catalogue id, flags policy blocks and reads live health", () => {
    const index = freshIndex();
    const blocked = CONNECTOR_SERVICE_IDS[0] as string;
    const degraded = CONNECTOR_SERVICE_IDS[1] as string;
    transitionHealth(index.getDatabase(), degraded, { type: "persistent_error", error: "boom" });
    const rows = readersFor(index, (id) => id !== blocked).connectors();
    expect(rows).toHaveLength(CONNECTOR_SERVICE_IDS.length);
    expect(rows.find((r) => r.id === blocked)).toMatchObject({
      enabled: false,
      blockedByPolicy: true,
      health: "unknown",
    });
    const d = rows.find((r) => r.id === degraded);
    expect(d).toMatchObject({ enabled: true, blockedByPolicy: false });
    expect(d?.health).toBe("error");
  });

  test("namespaces is the documented empty stub", () => {
    expect(readersFor(freshIndex()).namespaces()).toEqual([]);
  });

  test("audit is zeroed on an empty log, then counts rows, the newest hash and the last hour", () => {
    const index = freshIndex();
    const readers = readersFor(index);
    expect(readers.audit()).toEqual({ chainLength: 0, lastHash: "", appendRate1h: 0 });

    const now = Date.now();
    index.recordAudit({
      actionType: "a",
      hitlStatus: "approved",
      actionJson: "{}",
      timestamp: now - 7_200_000,
    });
    index.recordAudit({
      actionType: "b",
      hitlStatus: "approved",
      actionJson: "{}",
      timestamp: now - 1000,
    });
    const newestHash = index
      .getDatabase()
      .query(`SELECT row_hash FROM audit_log ORDER BY id DESC LIMIT 1`)
      .get() as {
      row_hash: string;
    };
    const status = readers.audit();
    expect(status.chainLength).toBe(2);
    expect(status.appendRate1h).toBe(1);
    expect(status.lastHash).toBe(newestHash.row_hash);
    expect(status.lastHash).not.toBe("");
  });

  test("an audit row with no stored hash reads as an empty last hash, not null", () => {
    const index = freshIndex();
    index
      .getDatabase()
      .run(
        `INSERT INTO audit_log (action_type, hitl_status, action_json, timestamp) VALUES ('legacy', 'approved', '{}', ?)`,
        [Date.now()],
      );
    const status = readersFor(index).audit();
    expect(status.chainLength).toBe(1);
    expect(status.lastHash).toBe("");
    expect(status.appendRate1h).toBe(1);
  });

  test("an audit query that yields no row at all reads as zeros rather than throwing", () => {
    const index = freshIndex();
    const noRows = { query: () => ({ get: () => null }) } as unknown as Database;
    const readers = buildStatusReaders({
      db: noRows,
      policyGate: { status: () => POLICY_STATE } as unknown as PolicyGate,
      localIndex: index,
      isConnectorAllowed: () => true,
    });
    expect(readers.audit()).toEqual({ chainLength: 0, lastHash: "", appendRate1h: 0 });
  });

  test("hitl counts the delegated broker's open requests and stubs quorum at zero", () => {
    const readers = readersFor(freshIndex());
    const before = readers.hitl();
    expect(before.pendingQuorum).toBe(0);
    const pending = delegatedApprovalBroker.request({ prompt: "status-readers test" }, 60_000);
    try {
      expect(readers.hitl().pendingApprovals).toBe(before.pendingApprovals + 1);
    } finally {
      const id = delegatedApprovalBroker
        .listPending()
        .find((p) => p.prompt === "status-readers test")?.requestId;
      if (id !== undefined) delegatedApprovalBroker.respond(id, "peer", false);
    }
    return pending.then(() => {
      expect(readers.hitl().pendingApprovals).toBe(before.pendingApprovals);
    });
  });

  describe("identity", () => {
    test("is valid when no identity boot is wired", () => {
      expect(readersFor(freshIndex()).identity()).toEqual({ operatorValid: true });
    });

    test("follows the stored session: none or expired is invalid, active inside grace is valid", () => {
      const index = freshIndex();
      const boot = buildIdentityBoot(IDENTITY_CFG, SCIM_CFG, index, fakeVault().vault);
      const readers = readersFor(index, () => true, boot);
      expect(readers.identity()).toEqual({ operatorValid: false });

      const base = { issuer: ISSUER, externalId: "u1", email: null, validatedAt: 1 } as const;
      boot.store.upsertSession({ ...base, expiresAt: Date.now() + 60_000, status: "active" });
      expect(readers.identity()).toEqual({ operatorValid: true });

      // Expired 50 s ago, grace is 100 s: still valid. Expired 500 s ago: not.
      boot.store.upsertSession({ ...base, expiresAt: Date.now() - 50_000, status: "active" });
      expect(readers.identity()).toEqual({ operatorValid: true });
      boot.store.upsertSession({ ...base, expiresAt: Date.now() - 500_000, status: "active" });
      expect(readers.identity()).toEqual({ operatorValid: false });

      boot.store.upsertSession({
        ...base,
        expiresAt: Date.now() + 60_000,
        status: "deprovisioned",
      });
      expect(readers.identity()).toEqual({ operatorValid: false });
    });
  });

  test("an identity boot that carries no grace period is judged with zero grace", () => {
    const index = freshIndex();
    const boot = buildIdentityBoot(IDENTITY_CFG, SCIM_CFG, index, fakeVault().vault);
    const noGrace = { store: boot.store, issuer: boot.issuer } as unknown as typeof boot;
    boot.store.upsertSession({
      issuer: ISSUER,
      externalId: "u1",
      email: null,
      validatedAt: 1,
      expiresAt: Date.now() - 1000,
      status: "active",
    });
    // Expired one second ago: valid under the configured 100 s grace, invalid with none.
    expect(readersFor(index, () => true, boot).identity()).toEqual({ operatorValid: true });
    expect(readersFor(index, () => true, noGrace).identity()).toEqual({ operatorValid: false });
  });

  describe("syncFreshnessMs", () => {
    test("is 0 when no connector has ever synced", () => {
      expect(readersFor(freshIndex()).syncFreshnessMs()).toBe(0);
    });

    test("is the age of the newest successful sync", () => {
      const index = freshIndex();
      const db = index.getDatabase();
      transitionHealth(db, CONNECTOR_SERVICE_IDS[0] as string, { type: "sync_success" });
      transitionHealth(db, CONNECTOR_SERVICE_IDS[1] as string, { type: "sync_success" });
      const set = db.prepare(`UPDATE sync_state SET last_sync_at = ? WHERE connector_id = ?`);
      set.run(Date.now() - 600_000, CONNECTOR_SERVICE_IDS[0] as string);
      set.run(Date.now() - 5_000, CONNECTOR_SERVICE_IDS[1] as string);
      // A connector that has a health row but never synced does not count as the newest.
      transitionHealth(db, CONNECTOR_SERVICE_IDS[2] as string, {
        type: "persistent_error",
        error: "never synced",
      });
      const age = readersFor(index).syncFreshnessMs();
      // The newer row (5 s old) wins over the 10-minute-old one.
      expect(age).toBeGreaterThanOrEqual(5_000);
      expect(age).toBeLessThan(60_000);
    });
  });
});
