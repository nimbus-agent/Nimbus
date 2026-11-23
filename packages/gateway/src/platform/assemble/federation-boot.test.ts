import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import os, { tmpdir } from "node:os";
import { join } from "node:path";
import { makeInMemoryVault } from "../../../test/helpers/in-memory-vault.ts";
import { rmDirWithRetry } from "../../../test/helpers/rm-dir-with-retry.ts";
import { delegatedApprovalBroker } from "../../engine/delegated-approval-broker.ts";
import { quorumCoordinator } from "../../engine/quorum/quorum-singleton.ts";
import { federationConsent } from "../../federation/consent-broker.ts";
import { loadOrCreateFederationIdentity } from "../../federation/federation-identity.ts";
import { preflightConsent } from "../../federation/preflight-consent-broker.ts";
import type { buildIdentityBoot } from "../../identity/identity-boot.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { createIpcServer } from "../../ipc/index.ts";
import type { PolicyGate } from "../../policy/policy-gate.ts";
import type { ShareFile } from "../../share/share-format.ts";
import { drainPending } from "../../share/share-inbox-store.ts";
import { insertShareRecord } from "../../share/share-store.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { processEnvGet, processEnvSet } from "../env-access.ts";
import { createLinuxPaths } from "../paths.ts";
import {
  asBroadcastParams,
  bindFederationBroadcasts,
  bootFederationIntoIpcOpts,
  teamListErrorMessage,
} from "./federation-boot.ts";

type IpcOpts = Parameters<typeof createIpcServer>[0];
type BootOpts = Parameters<typeof bootFederationIntoIpcOpts>[0];

describe("asBroadcastParams", () => {
  test("an object is passed through as the same reference", () => {
    const o = { a: 1 };
    expect(asBroadcastParams(o)).toBe(o);
  });

  test("anything that is not an object becomes an empty record", () => {
    for (const v of [null, undefined, "s", 7, true]) expect(asBroadcastParams(v)).toEqual({});
  });
});

describe("teamListErrorMessage", () => {
  const req = { entry: "shared", service: "snowflake" };

  test("an invalid identity points at the device-code login and names the service", () => {
    const m = teamListErrorMessage("identity_invalid", req);
    expect(m).toContain("team-credential sync for snowflake blocked");
    expect(m).toContain("nimbus identity login");
  });

  test("a missing grant names the entry and the exact command that adds it", () => {
    const m = teamListErrorMessage("no_grant", req);
    expect(m).toContain('team-vault entry "shared" not found or service mismatch');
    expect(m).toContain("nimbus team vault put shared snowflake --secret <key>=<value>");
  });
});

describe("bindFederationBroadcasts", () => {
  afterEach(() => {
    federationConsent.setBroadcast(() => {});
    preflightConsent.setBroadcast(() => {});
    quorumCoordinator.setBroadcast(() => {});
    delegatedApprovalBroker.setBroadcast(() => {});
  });

  function recorder() {
    const sent: Array<{ method: string; params: Record<string, unknown> }> = [];
    return {
      sent,
      ipc: {
        broadcast: (method: string, params?: Record<string, unknown>) =>
          sent.push({ method, params: params ?? {} }),
      },
    };
  }

  test("a federation that did not boot binds nothing", () => {
    const { sent, ipc } = recorder();
    bindFederationBroadcasts(ipc, undefined);
    void federationConsent.request(
      { peerId: "p", namespace: "n", purpose: "x", role: "viewer" },
      1,
    );
    expect(sent).toEqual([]);
  });

  test("a booted federation reaches the owner through all five request channels", async () => {
    const { sent, ipc } = recorder();
    bindFederationBroadcasts(ipc, {} as never);

    const consent = federationConsent.request(
      { peerId: "p", namespace: "eng", purpose: "q", role: "viewer" },
      5_000,
    );
    const preflight = preflightConsent.request(
      { peerId: "p", namespace: "eng", ref: "r", purpose: "q" },
      5_000,
    );
    const quorum = quorumCoordinator.collect({ approvers: 1, windowMs: 5_000 });
    const delegated = delegatedApprovalBroker.request({ prompt: "approve?" }, 5_000);

    expect(sent.map((s) => s.method)).toEqual([
      "federation.consentRequest",
      "federation.preflightRequest",
      "federation.quorumRequest",
      "federation.approvalRequest",
    ]);
    expect(sent[0]?.params).toMatchObject({ namespace: "eng" });
    expect(sent[3]?.params).toMatchObject({ prompt: "approve?" });
    // Each request id travels in the broadcast, and answering it settles the request.
    expect(federationConsent.respond(String(sent[0]?.params["requestId"]), true)).toBe(true);
    expect(preflightConsent.respond(String(sent[1]?.params["requestId"]), true)).toBe(true);
    expect(quorumCoordinator.respond(String(sent[2]?.params["requestId"]), "peer:a", true)).toBe(
      true,
    );
    expect(
      delegatedApprovalBroker.respond(String(sent[3]?.params["requestId"]), "peer:a", true),
    ).toBe(true);
    expect(await consent).toBe("approved");
    expect(await preflight).toBe(true);
    expect((await quorum).outcome).toBe("approved");
    expect(await delegated).toEqual({ kind: "answered", peerId: "peer:a", approved: true });
  });
});

describe("bootFederationIntoIpcOpts", () => {
  const ENABLED = {
    enabled: true,
    consentTimeoutSeconds: 45,
    mdnsEnabled: false,
    mdnsBind: "127.0.0.1",
  };

  let root: string;
  let db: Database;
  let vault: NimbusVault;
  let localIndex: LocalIndex;
  let ipcOpts: IpcOpts;
  let stops: Array<() => void>;
  let savedPort: string | undefined;

  const policyGate = {
    enforced: () => ({
      retentionDays: 30,
      retentionMinDays: 0,
      hitlRequired: new Set<string>(),
      quorum: new Map([["slack.message.post", { approvers: 2, windowSeconds: 60 }]]),
      capabilitiesDisabled: new Set<string>(),
      chatops: { channels: new Map(), ownership: new Map() },
    }),
  } as unknown as PolicyGate;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "assemble-fed-"));
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    vault = makeInMemoryVault();
    localIndex = new LocalIndex(db);
    ipcOpts = {} as unknown as IpcOpts;
    stops = [];
    // Port 0: the OS picks a free port, so no reserve-then-release race.
    savedPort = processEnvGet("NIMBUS_LAN_PORT");
    processEnvSet("NIMBUS_LAN_PORT", "0");
    writeFileSync(
      join(root, "nimbus.toml"),
      ["[lan]", 'bind = "127.0.0.1"', "min_protocol = 2"].join("\n"),
    );
  });

  afterEach(async () => {
    for (const s of stops.splice(0).reverse()) s();
    await new Promise((r) => setTimeout(r, 20));
    processEnvSet("NIMBUS_LAN_PORT", savedPort);
    db.close();
    rmDirWithRetry(root);
  });

  function opts(over: Partial<BootOpts> = {}): BootOpts {
    return {
      federationCfg: ENABLED,
      paths: { ...createLinuxPaths(), configDir: root, sandboxDir: join(root, "sandbox") },
      vault,
      db,
      localIndex,
      ipcOpts,
      sidecarStops: stops,
      policyGate,
      isConnectorAllowed: (id) => id !== "blocked",
      identityEnabled: false,
      identityBootRefHolder: {
        current: undefined as ReturnType<typeof buildIdentityBoot> | undefined,
      },
      ...over,
    };
  }

  test("federation disabled: nothing is built, bound or started", async () => {
    const dep = await bootFederationIntoIpcOpts(
      opts({ federationCfg: { ...ENABLED, enabled: false } }),
    );
    expect(dep).toBeUndefined();
    expect(Object.keys(ipcOpts)).toEqual([]);
    expect(stops).toEqual([]);
  });

  test("enabled: the LAN server listens on loopback, the IPC options are wired and two stops are registered", async () => {
    const dep = await bootFederationIntoIpcOpts(opts());
    expect(dep).toBeDefined();
    expect(stops).toHaveLength(2);

    const identity = await loadOrCreateFederationIdentity(vault);
    expect(
      Buffer.from(ipcOpts.federationIdentity?.publicKey ?? []).equals(
        Buffer.from(identity.publicKey),
      ),
    ).toBe(true);
    expect(ipcOpts.federationConsentTimeoutSeconds).toBe(45);
    expect(ipcOpts.federationDiscovery).toBeDefined();
    expect(ipcOpts.federationPairing).toBeDefined();
    expect(ipcOpts.lanPairingWindow).toBeDefined();
    const addr = ipcOpts.lanServer?.listenAddr();
    expect(addr?.host).toBe("127.0.0.1");
    expect(addr?.port ?? 0).toBeGreaterThan(0);
    // `[lan] min_protocol` reaches the client side of the wire through the index.
    expect(localIndex.lanMinProtocol()).toBe(2);

    // Stopping releases the listener.
    for (const s of stops.splice(0).reverse()) s();
    await new Promise((r) => setTimeout(r, 20));
    expect(ipcOpts.lanServer?.listenAddr()).toBeUndefined();
  });

  test("the delegation dependency is the DB-backed store; as the owner this operator is always valid", async () => {
    const dep = await bootFederationIntoIpcOpts(opts());
    expect(dep?.isOperatorValid()).toBe(true);
    expect(typeof dep?.requestRemote).toBe("function");
    expect(dep?.store).toBeDefined();
  });

  test("the team vault resolves quorum from the enforced policy and honours the live connector allowlist", async () => {
    await bootFederationIntoIpcOpts(opts());
    const tv = ipcOpts.teamVault;
    expect(tv?.quorumFor("slack.message.post")).toEqual({ approvers: 2, windowSeconds: 60 });
    expect(tv?.quorumFor("anything.else")).toBeUndefined();
    expect(tv?.isConnectorAllowed("github")).toBe(true);
    expect(tv?.isConnectorAllowed("blocked")).toBe(false);
  });

  test("a team invoke without the entry's secrets is refused before any connector is spawned (I19)", async () => {
    await bootFederationIntoIpcOpts(opts());
    await expect(
      ipcOpts.teamVault?.runTool({ entry: "shared", service: "snowflake", toolId: "t", args: {} }),
    ).rejects.toThrow('entry "shared" is missing required secret for snowflake');
    await expect(
      ipcOpts.teamVault?.runTool({
        entry: "shared",
        service: "no-such-service",
        toolId: "t",
        args: {},
      }),
    ).rejects.toThrow("no team-injectable secret keys");
  });

  describe("peer resolution (no caller-supplied destination)", () => {
    const PUB = new Uint8Array(32).map((_, i) => i + 1);

    function pair(host?: { ip: string; port: number }): string {
      localIndex.addLanPeer({
        peerId: "peer:row",
        peerPubkey: PUB,
        direction: "outbound",
        ...(host === undefined ? {} : { hostIp: host.ip, hostPort: host.port }),
      });
      return Buffer.from(PUB).toString("base64");
    }
    const peerIdOf = (): string => `peer:${Buffer.from(PUB.subarray(0, 8)).toString("hex")}`;

    test("a paired peer's id resolves to its base64 pubkey", async () => {
      await bootFederationIntoIpcOpts(opts());
      const b64 = pair();
      expect(ipcOpts.federationResolvePeerPubkey?.(peerIdOf())).toBe(b64);
    });

    test("a canonical 32-byte base64 pubkey passes through, so a not-yet-paired recipient can be queued", async () => {
      await bootFederationIntoIpcOpts(opts());
      const b64 = Buffer.from(new Uint8Array(32).fill(9)).toString("base64");
      expect(ipcOpts.federationResolvePeerPubkey?.(b64)).toBe(b64);
    });

    test("an unknown peer id, a short key and a non-canonical spelling all resolve to nothing", async () => {
      await bootFederationIntoIpcOpts(opts());
      const r = ipcOpts.federationResolvePeerPubkey;
      expect(r?.("peer:deadbeefdeadbeef")).toBeUndefined();
      expect(r?.(Buffer.from(new Uint8Array(31)).toString("base64"))).toBeUndefined();
      expect(r?.("not base64 at all !!")).toBeUndefined();
      // Same bytes, but not the canonical re-encoding (padding stripped).
      expect(
        r?.(Buffer.from(new Uint8Array(32).fill(9)).toString("base64").replace(/=+$/, "")),
      ).toBeUndefined();
    });

    test("delivering a share to an unknown peer reports false, and to an unreachable one reports false without throwing", async () => {
      await bootFederationIntoIpcOpts(opts());
      const share = {} as ShareFile;
      expect(await ipcOpts.shareDeliverToPeer?.(share, "peer:deadbeefdeadbeef")).toBe(false);
      pair(); // paired but with no host or port: not reachable
      expect(await ipcOpts.shareDeliverToPeer?.(share, peerIdOf())).toBe(false);
    });

    test("a paired peer on a closed port: the transport failure is swallowed and reported as not delivered", async () => {
      await bootFederationIntoIpcOpts(opts());
      const probe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("") });
      const closedPort = probe.port ?? 1;
      probe.stop(true);
      pair({ ip: "127.0.0.1", port: closedPort });
      expect(await ipcOpts.shareDeliverToPeer?.({} as ShareFile, peerIdOf())).toBe(false);
    });

    test("forward delivery to a recipient that is no longer paired is refused", async () => {
      await bootFederationIntoIpcOpts(opts());
      await expect(
        ipcOpts.federationForwardShareDeps?.deliver({} as ShareFile, {
          host: "127.0.0.1",
          port: 1,
          pubkey: Buffer.from(new Uint8Array(32).fill(5)).toString("base64"),
        }),
      ).rejects.toThrow("recipient is no longer a paired peer");
    });

    test("lookupPeer returns a reachable peer only when host and port are both recorded", async () => {
      await bootFederationIntoIpcOpts(opts());
      const noHost = pair();
      expect(ipcOpts.federationForwardShareDeps?.lookupPeer(noHost)).toBeUndefined();
      localIndex.addLanPeer({
        peerId: "peer:row",
        peerPubkey: PUB,
        direction: "outbound",
        hostIp: "10.0.0.5",
        hostPort: 7475,
      });
      expect(ipcOpts.federationForwardShareDeps?.lookupPeer(noHost)).toEqual({
        host: "10.0.0.5",
        port: 7475,
        pubkey: noHost,
      });
      expect(
        ipcOpts.federationForwardShareDeps?.lookupPeer(
          Buffer.from(new Uint8Array(32).fill(1)).toString("base64"),
        ),
      ).toBeUndefined();
    });
  });

  describe("forwarding a share (the second I27 chokepoint's dependencies)", () => {
    const SHARE_BODY = { kind: "transcript", origin: { label: "me" }, messages: [] };
    const SIG = { alg: "ed25519", pubkey: "pk", signature: "sig" };
    const PROVENANCE = { hops: 1, chain: [] };

    test("loadShare rebuilds the signed ShareFile from its stored record, and nothing for an unknown hash", async () => {
      await bootFederationIntoIpcOpts(opts());
      insertShareRecord(db, {
        contentHash: "h1",
        kind: "transcript",
        sessionId: null,
        createdAt: 1,
        expiresAt: null,
        redactionSet: [],
        provenance: PROVENANCE,
        bodyJson: JSON.stringify(SHARE_BODY),
        sigJson: JSON.stringify(SIG),
        sink: "file",
      });
      const deps = ipcOpts.federationForwardShareDeps;
      expect(deps?.loadShare("h1")).toEqual({
        format: "nimbus-share/v1",
        contentHash: "h1",
        body: SHARE_BODY,
        sig: SIG,
        forwarding: PROVENANCE,
      } as unknown as ShareFile);
      expect(deps?.loadShare("nope")).toBeUndefined();
    });

    test("the label is this host's name and the signing key is the Vault-held share key, stable across calls", async () => {
      await bootFederationIntoIpcOpts(opts());
      const deps = ipcOpts.federationForwardShareDeps;
      expect(deps?.label).toBe(os.hostname());
      const a = await deps?.shareKeypair();
      const b = await deps?.shareKeypair();
      expect(a).toBeDefined();
      expect(a).toEqual(b);
    });

    test("a share for a recipient that is not paired yet is queued by pubkey and drains in order", async () => {
      await bootFederationIntoIpcOpts(opts());
      const recipient = Buffer.from(new Uint8Array(32).fill(3)).toString("base64");
      const share = (n: string) =>
        ({
          contentHash: n,
          body: { origin: { label: "me" } },
          forwarding: { hops: 0, chain: [] },
        }) as unknown as ShareFile;
      ipcOpts.federationForwardShareDeps?.queuePending(recipient, share("a"));
      ipcOpts.federationForwardShareDeps?.queuePending(recipient, share("b"));
      expect(drainPending(db, recipient).map((r) => r.share.contentHash)).toEqual(["a", "b"]);
    });

    test("recordAudit appends to the tamper-evident audit chain", async () => {
      await bootFederationIntoIpcOpts(opts());
      ipcOpts.federationForwardShareDeps?.recordAudit({
        actionType: "share.forward",
        hitlStatus: "approved",
        actionJson: "{}",
        timestamp: 1,
      });
      const n = (
        db
          .query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'share.forward'")
          .get() as { n: number }
      ).n;
      expect(n).toBe(1);
    });
  });
});
