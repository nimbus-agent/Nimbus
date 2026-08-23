/**
 * Phase 6 Slice 4 — Policy / Admin / Observability acceptance (integration layer).
 *
 * Composes the Slice 4 modules end-to-end against real SQLite (no DB/crypto mocks):
 *   anchor authors+signs a policy → peer pins the anchor pubkey, refreshes (via servePolicy),
 *   verifies the signature, and enforces the monotonic-stricter result → a tampered bundle is
 *   rejected fail-closed (last-valid kept) → the connector allowlist blocks non-listed connectors
 *   → the read-only HTTP admin surface enforces the I13 bearer on /v1/admin/status + /metrics and
 *   emits Prometheus exposition → the GDPR purge ledger retries an offline peer until all done.
 *
 * The peer-refresh "wire" is the anchor's real servePolicy(anchorStore) injected as the refresh
 * fetch — this faithfully simulates the anchor serving its signed bundle to the peer without a
 * full LAN harness.
 */
import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase64, generateEd25519Keypair } from "@nimbus-dev/sdk";
import { runIndexedSchemaMigrations } from "../../src/index/migrations/runner.ts";
import { startReadOnlyHttpServer } from "../../src/ipc/http-server.ts";
import { partitionByAllowlist } from "../../src/policy/connector-allowlist.ts";
import { retryPendingPurges } from "../../src/policy/gdpr-purge-retry.ts";
import { GdprPurgeStore } from "../../src/policy/gdpr-purge-store.ts";
import { authorPolicy } from "../../src/policy/policy-author.ts";
import { servePolicy } from "../../src/policy/policy-distribution.ts";
import type { LocalBaseline } from "../../src/policy/policy-gate.ts";
import { PolicyGate } from "../../src/policy/policy-gate.ts";
import { refreshPolicy } from "../../src/policy/policy-runtime.ts";
import { PolicyStore } from "../../src/policy/policy-store.ts";

const BASELINE = (retentionDays: number): LocalBaseline => ({
  retentionDays,
  hitlRequired: new Set<string>(),
  quorum: new Map(),
  capabilitiesDisabled: new Set<string>(),
});

const ANCHOR_TOML = [
  "[policy]",
  "version = 1",
  'org = "acme"',
  "",
  "[policy.connectors]",
  'allow = ["github"]',
  "",
  "[policy.retention]",
  "min_days = 30",
  "",
  "[policy.hitl]",
  "require = []",
  "",
  '[policy.hitl.quorum."terraform.destroy"]',
  "approvers = 2",
  "window_seconds = 900",
  "",
].join("\n");

describe("Phase 6 Slice 4 acceptance — policy authoring, peer refresh, allowlist, admin observability, GDPR retry", () => {
  // Shared anchor state: authored once, served to the peer + the HTTP surface.
  const anchorDb = new Database(":memory:");
  runIndexedSchemaMigrations(anchorDb, 37);
  const anchorStore = new PolicyStore(anchorDb);
  const anchorGate = new PolicyGate(anchorStore, BASELINE(7));
  const { privkey: anchorPriv, pubkey: anchorPub } = generateEd25519Keypair();
  const anchorPrivB64 = encodeBase64(anchorPriv);
  const anchorPubB64 = encodeBase64(anchorPub);

  // ---- HTTP admin surface (scenarios 5 + 6): real read-only server on a temp db file ----
  let tmpDir: string;
  let dbPath: string;
  let handle: { port: number; stop: () => void } | undefined;

  beforeAll(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), "nimbus-slice4-"));
    dbPath = join(tmpDir, "index.db");
    const fileDb = new Database(dbPath, { create: true });
    runIndexedSchemaMigrations(fileDb, 37);
    fileDb.close();
  });

  afterAll(() => {
    handle?.stop();
    anchorDb.close();
    peerDb.close();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  test("(1) anchor authors a signed policy and enforces it locally", () => {
    const res = authorPolicy(
      {
        store: anchorStore,
        gate: anchorGate,
        db: anchorDb,
        privkeyB64: anchorPrivB64,
        pubkeyB64: anchorPubB64,
        nowMs: 1_000,
      },
      ANCHOR_TOML,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.org).toBe("acme");
      expect(res.version).toBe(1);
    }
    const enforced = anchorGate.enforced();
    expect(enforced.retentionDays).toBe(30);
    expect(enforced.connectorAllow).toEqual(["github"]);
    expect(enforced.quorum.get("terraform.destroy")).toEqual({
      approvers: 2,
      windowSeconds: 900,
    });
    expect(anchorGate.status().signatureValid).toBe(true);
    // The anchor self-served bundle is the public {toml, sig} — verifiable by the pinned pubkey.
    const served = servePolicy(anchorStore);
    expect(served).not.toBeNull();
  });

  // The peer governed by the anchor — pins the anchor pubkey, refreshes from servePolicy(anchorStore).
  const peerDb = new Database(":memory:");
  runIndexedSchemaMigrations(peerDb, 37);
  const peerStore = new PolicyStore(peerDb);
  const peerGate = new PolicyGate(peerStore, BASELINE(7));

  test("(2) peer pins the anchor pubkey, refreshes over the served bundle, and enforces the tighter policy", async () => {
    peerStore.pinAnchorPubkey(anchorPubB64, "manual", 1);
    const outcome = await refreshPolicy({
      store: peerStore,
      gate: peerGate,
      pinnedPubkey: anchorPubB64,
      nowMs: 2_000,
      fetch: async () => servePolicy(anchorStore),
    });
    expect(outcome.applied).toBe(true);
    const enforced = peerGate.enforced();
    expect(enforced.retentionDays).toBe(30); // tightened from baseline 7
    expect(enforced.connectorAllow).toEqual(["github"]);
    expect(peerGate.status().source).toBe("peer");
  });

  test("(3) a tampered bundle is rejected fail-closed; the last-valid policy is retained", async () => {
    const good = servePolicy(anchorStore);
    expect(good).not.toBeNull();
    if (good === null) return;
    // Flip min_days 30 -> 99 but keep the original signature: verify must fail.
    const tampered = { toml: good.toml.replace("30", "99"), sig: good.sig };
    const outcome = await refreshPolicy({
      store: peerStore,
      gate: peerGate,
      pinnedPubkey: anchorPubB64,
      nowMs: 3_000,
      fetch: async () => tampered,
    });
    expect(outcome.applied).toBe(false);
    expect(outcome.reason).toBe("bad_signature");
    // Unchanged — still the last-valid 30-day policy.
    expect(peerGate.enforced().retentionDays).toBe(30);
    expect(peerGate.enforced().connectorAllow).toEqual(["github"]);
  });

  test("(4) the connector allowlist permits only listed connectors", () => {
    const part = partitionByAllowlist(
      ["github", "slack", "jira"],
      peerGate.enforced().connectorAllow,
    );
    expect(part.permitted).toEqual(["github"]);
    expect(part.blocked).toEqual(["slack", "jira"]);
  });

  test("(5/6) admin status + metrics enforce the bearer and emit Prometheus exposition", async () => {
    handle = startReadOnlyHttpServer(dbPath, 0, {
      resolveAdminToken: async () => "secret",
      statusReaders: {
        // The peer's real, signature-valid policy state drives the snapshot.
        policyState: () => peerGate.status(),
        peers: () => [{ peerId: "peer:anchor", reachable: true }],
        connectors: () => [
          { id: "github", enabled: true, blockedByPolicy: false, health: "ok" },
          { id: "slack", enabled: true, blockedByPolicy: true, health: "ok" },
        ],
        namespaces: () => [],
        audit: () => ({ chainLength: 3, lastHash: "abc", appendRate1h: 0 }),
        hitl: () => ({ pendingApprovals: 0, pendingQuorum: 0 }),
        identity: () => ({ operatorValid: true }),
        syncFreshnessMs: () => 1234,
      },
    });
    const base = `http://127.0.0.1:${handle.port}`;

    // WITHOUT bearer → 401
    const noAuth = await fetch(`${base}/v1/admin/status`);
    expect(noAuth.status).toBe(401);

    // WITH bearer → 200 + JSON carries data.policy
    const ok = await fetch(`${base}/v1/admin/status`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { data: { policy: { signatureValid: boolean } } };
    expect(body.data.policy.signatureValid).toBe(true);

    // /metrics WITHOUT bearer → 401
    const metricsNoAuth = await fetch(`${base}/metrics`);
    expect(metricsNoAuth.status).toBe(401);

    // /metrics WITH bearer → 200 Prometheus text exposing the signature gauge as 1.
    const metrics = await fetch(`${base}/metrics`, {
      headers: { authorization: "Bearer secret" },
    });
    expect(metrics.status).toBe(200);
    const text = await metrics.text();
    expect(text).toContain("nimbus_policy_signature_valid 1");
    expect(text).toContain('nimbus_connector_enabled{connector="slack"} 0');
  });

  test("(7) GDPR purge retry tolerates an offline peer until every request is done", async () => {
    const gdprDb = new Database(":memory:");
    runIndexedSchemaMigrations(gdprDb, 37);
    const store = new GdprPurgeStore(gdprDb);
    store.openJob({
      jobId: "j1",
      externalId: "alice",
      peers: ["peer:on", "peer:off"],
      openedAt: 1,
    });

    // Round 1: only "peer:on" answers; "peer:off" is unreachable (null).
    await retryPendingPurges({
      store,
      requestPurge: async (p) => (p === "peer:on" ? "REC" : null),
      signCompletion: () => "AGG",
      nowMs: () => 10,
    });
    expect(store.pendingRequests("j1").map((r) => r.peerId)).toEqual(["peer:off"]);
    expect(store.allDone("j1")).toBe(false);

    // Round 2: the previously-offline peer now answers → all done, job closes.
    await retryPendingPurges({
      store,
      requestPurge: async () => "REC2",
      signCompletion: () => "AGG",
      nowMs: () => 20,
    });
    expect(store.pendingRequests("j1")).toEqual([]);
    expect(store.allDone("j1")).toBe(true);
    gdprDb.close();
  });
});
