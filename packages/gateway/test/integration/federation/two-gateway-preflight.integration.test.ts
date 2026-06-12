/**
 * Phase 6 Slice 6b — blast-radius preflight over-the-wire acceptance (I24).
 *
 * Two in-process gateways (upstream A, downstream B = service owner) over a REAL loopback NaCl-box
 * socket: pair → publish+grant a namespace on B → A sends federation.preflight over the wire → B
 * runs it through the I24 gate (grant → local config command → LOCAL owner HITL approval → sandbox
 * run) and returns ONLY { passed, summary }. We assert: approved → pass; the caller-supplied
 * `command` field is ignored (only B's configured command runs); owner-denied → declined; an
 * ungranted namespace → no_grant. `runCommand` is injected (the real sandbox spawn is I/O glue).
 */
import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { bytesToHex } from "@noble/hashes/utils.js";
import { buildFederationRuntime } from "../../../src/federation/federation-runtime.ts";
import { buildFederationLanServer } from "../../../src/federation/federation-server.ts";
import { NamespaceStore } from "../../../src/federation/namespace-store.ts";
import { appendPreflightAudit } from "../../../src/federation/preflight-gate.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { sendFederatedOverWire } from "../../../src/ipc/lan-client.ts";
import { generateBoxKeypair } from "../../../src/ipc/lan-crypto.ts";
import { generatePairingCode } from "../../../src/ipc/lan-pairing.ts";

const peerIdFor = (pub: Uint8Array): string => `peer:${bytesToHex(pub.subarray(0, 8))}`;

type WirePreflight =
  | { kind: "ok"; passed: boolean; summary: string }
  | { kind: "error"; error: string };

test("payoff: upstream sends a preflight to a downstream owner over the wire — grant + approve → pass (only the local command runs); deny → declined; ungranted → no_grant", async () => {
  // --- Downstream B: real LanServer with the I24 preflight gate deps. ---
  const bDb = new Database(":memory:");
  runIndexedSchemaMigrations(bDb, 38);
  const bIndex = new LocalIndex(bDb);
  const bIdentity = generateBoxKeypair();
  const bNs = new NamespaceStore(bDb);

  const askerKp = generateBoxKeypair();
  const askerPeerId = peerIdFor(askerKp.publicKey);
  bNs.publish("project:zurich", [{ kind: "service", value: "github" }]);
  bNs.grant("project:zurich", askerPeerId, "viewer", true);

  let approve = true;
  let commandRan = "";
  let runs = 0;
  const bBuilt = buildFederationLanServer({
    db: bDb,
    index: bIndex,
    identity: bIdentity,
    lan: {
      bind: "127.0.0.1",
      port: 0,
      pairingWindowSeconds: 60,
      maxFailedAttempts: 3,
      lockoutSeconds: 60,
    },
    consentTimeoutMs: 100,
    notify: () => {},
    preflight: {
      isPeerGranted: (ns, peerId) => bNs.getActiveGrant(ns, peerId) !== undefined,
      resolveCommand: (ns) =>
        ns === "project:zurich"
          ? { command: "bun", args: ["test"], cwd: "/srv/zurich", timeoutSeconds: 60 }
          : undefined,
      requestApproval: async () => approve,
      runCommand: async (cfg) => {
        runs += 1;
        commandRan = cfg.command;
        return { passed: true, summary: "42 passed, 0 failed", durationMs: 7 };
      },
      audit: (e) => appendPreflightAudit(bDb, e),
    },
  });
  await bBuilt.lanServer.start();
  const bPort = bBuilt.lanServer.listenAddr()?.port as number;

  // --- Upstream A: real runtime (production outbound handshake). ---
  const aDb = new Database(":memory:");
  runIndexedSchemaMigrations(aDb, 38);
  const aIndex = new LocalIndex(aDb);
  const aRuntime = buildFederationRuntime(
    { enabled: true, consentTimeoutSeconds: 30, mdnsEnabled: false, mdnsBind: "127.0.0.1" },
    aIndex,
    askerKp,
  );
  if (aRuntime === undefined) throw new Error("federation runtime should be enabled");

  try {
    const code = generatePairingCode();
    bBuilt.pairingWindow.open(code);
    await aRuntime.pairing.initiatePair("127.0.0.1", bPort, code);

    const preflight = (body: Record<string, unknown>) =>
      sendFederatedOverWire(
        "127.0.0.1",
        bPort,
        askerKp,
        bIdentity.publicKey,
        "federation.preflight",
        body,
      ) as Promise<WirePreflight>;

    // 1. granted + approved → pass; the caller's injected `command` is ignored (only B's runs).
    const ok = await preflight({
      namespace: "project:zurich",
      ref: "HEAD~1..HEAD",
      changedSurface: ["api.ts"],
      purpose: "merge",
      command: "rm -rf /",
    });
    expect(ok).toEqual({ kind: "ok", passed: true, summary: "42 passed, 0 failed" });
    expect(commandRan).toBe("bun");
    expect(runs).toBe(1);

    // 2. owner denies → declined (error), command NOT run again.
    approve = false;
    const denied = await preflight({
      namespace: "project:zurich",
      ref: "HEAD",
      changedSurface: [],
      purpose: "merge",
    });
    expect(denied).toEqual({ kind: "error", error: "denied" });
    expect(runs).toBe(1);

    // 3. ungranted namespace → opaque no_grant (approval never requested).
    approve = true;
    const ungranted = await preflight({
      namespace: "project:other",
      ref: "HEAD",
      changedSurface: [],
      purpose: "merge",
    });
    expect(ungranted).toEqual({ kind: "error", error: "no_grant" });
    expect(runs).toBe(1);

    // 4. every decision was audited on the downstream.
    const audited = bDb
      .query(`SELECT COUNT(*) AS n FROM audit_log WHERE action_type LIKE 'federation.preflight.%'`)
      .get() as { n: number };
    expect(audited.n).toBeGreaterThanOrEqual(3);
  } finally {
    await bBuilt.lanServer.stop();
    bIndex.close();
    aIndex.close();
    bDb.close();
    aDb.close();
  }
});
