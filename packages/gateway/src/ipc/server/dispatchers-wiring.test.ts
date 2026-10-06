/**
 * dispatchers-wiring.test.ts
 *
 * `dispatchers.ts` is mostly plumbing: each wrapper builds the inner dispatcher's context out of
 * `ctx.options` — forwarding optional deps, wrapping callbacks in closures, and binding HITL gates
 * to the calling client's consent channel. A forwarding line that is silently dropped fails
 * NOTHING at the type level when the inner field is optional, and nothing at the result level when
 * the inner handler has a default — it only shows up as a feature that quietly stops working.
 *
 * Every test here therefore proves a dep ARRIVES by observing its effect: the closure ran (a row
 * was audited, a broadcast was sent, a fake recorded the call), or the inner handler took the
 * branch only that dep enables — usually beside a negative control showing the other branch.
 *
 * Covered: the I24 federation-preflight closures, the I18 identity-guard closure, share-forward
 * deps, the federation identity handed to agents (observed in the greeting a stand-in peer
 * receives), the tribal (I25) approved-capture path, connector notify + mesh, the extension mesh /
 * publisher-key fetcher / air-gap flag, the auto-update HITL gate closure, profile notify, the
 * media guards, LAN pairing expiry, diag embedding readiness and an owner-approved egress prune.
 *
 * Rules: no `mock.module`; no `any`; real SQLite (migrated template); real consent coordinator,
 * answered through `handleRespond` exactly as a connected owner's client would. The only socket is
 * the stand-in peer's, on 127.0.0.1 with an OS-assigned port.
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSeededInMemoryDb } from "../../../test/helpers/migrated-db-seed.ts";
import { insertExtensionRow } from "../../automation/extension-store.ts";
import { ProfileManager } from "../../config/profiles.ts";
import type { LazyConnectorMesh } from "../../connectors/lazy-mesh/index.ts";
import { appendEgressEntry } from "../../egress/egress-ledger.ts";
import type { EmbeddingReadiness } from "../../embedding/embedding-readiness.ts";
import type { ConnectorDispatcher } from "../../engine/types.ts";
import { AutoUpdateCache } from "../../extensions/auto-update-cache.ts";
import type { AvailableUpdate } from "../../extensions/auto-update-types.ts";
import type { PublisherKeyFetcher } from "../../extensions/registry-client.ts";
import { InMemoryDiscoveryProvider } from "../../federation/discovery.ts";
import { NamespaceStore } from "../../federation/namespace-store.ts";
import { PeerPairing } from "../../federation/peer-pairing.ts";
import { preflightConsent } from "../../federation/preflight-consent-broker.ts";
import { IdentityStore } from "../../identity/identity-store.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import { createGrant, listActiveGrants } from "../../multimodal/media-grant-store.ts";
import type { ForwardShareDeps } from "../../share/share-forward.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import { createMockVault } from "../../vault/mock.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import type { EgressRpcCtx } from "../egress-rpc.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import { makeFrameReader } from "../lan-client.ts";
import { PairingWindow } from "../lan-pairing.ts";
import type { TribalRpcCtx } from "../tribal-rpc.ts";
import type { ServerCtx } from "./context.ts";
import {
  tryDispatchAutomationRpc,
  tryDispatchConnectorRpc,
  tryDispatchDiagnosticsRpc,
  tryDispatchFederationRpc,
  tryDispatchPhase4Rpc,
  tryDispatchTribalRpc,
} from "./dispatchers.ts";
import type { CreateIpcServerOptions } from "./options.ts";
import { RpcMethodError } from "./rpc-error.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const openDbs: Database[] = [];
const tempDirs: string[] = [];
const peerListeners: Array<{ stop(closeActiveConnections?: boolean): void }> = [];

afterEach(() => {
  for (const listener of peerListeners.splice(0)) listener.stop(true);
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function freshIndex(): LocalIndex {
  const db = openSeededInMemoryDb(CURRENT_SCHEMA_VERSION);
  openDbs.push(db);
  return new LocalIndex(db);
}

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type OwnerAnswer = "disconnected" | "approve" | "deny";

function consentFor(answer: OwnerAnswer): ConsentCoordinatorImpl {
  if (answer === "disconnected") return new ConsentCoordinatorImpl(() => undefined);
  const impl: ConsentCoordinatorImpl = new ConsentCoordinatorImpl((clientId) => (notification) => {
    const params = notification.params as Record<string, unknown> | undefined;
    const requestId = params?.["requestId"];
    if (typeof requestId !== "string") throw new Error("consent.request without a requestId");
    queueMicrotask(() => {
      impl.handleRespond(clientId, { requestId, approved: answer === "approve" });
    });
  });
  return impl;
}

type Broadcast = { readonly method: string; readonly params: Record<string, unknown> };

function harness(
  overrides: Partial<CreateIpcServerOptions> = {},
  answer: OwnerAnswer = "disconnected",
): { ctx: ServerCtx; broadcasts: Broadcast[] } {
  const broadcasts: Broadcast[] = [];
  const ctx: ServerCtx = {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl: consentFor(answer),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: (method, params) => {
      broadcasts.push({ method, params });
    },
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: () => "unknown",
  };
  return { ctx, broadcasts };
}

async function rpcErrorOf(pending: Promise<unknown>): Promise<RpcMethodError> {
  try {
    await pending;
  } catch (e) {
    if (e instanceof RpcMethodError) return e;
    throw e;
  }
  throw new Error("expected the dispatch to reject with an RpcMethodError");
}

function auditRows(
  db: Database,
  likePattern: string,
): Array<{ action_type: string; hitl_status: string }> {
  return db
    .query<{ action_type: string; hitl_status: string }, [string]>(
      "SELECT action_type, hitl_status FROM audit_log WHERE action_type LIKE ? ORDER BY id",
    )
    .all(likePattern);
}

// ---------------------------------------------------------------------------
// Federation: I24 preflight closures, I18 identity guard, share-forward deps
// ---------------------------------------------------------------------------

describe("federation — the closures tryDispatchFederationRpc builds from local state", () => {
  const PEER = "peer:remote-1";
  const NAMESPACE = "team-a";
  const PREFLIGHT = {
    peerId: PEER,
    namespace: NAMESPACE,
    ref: "main",
    purpose: "pre-merge blast radius",
    changedSurface: ["src/api.ts"],
  };

  function fedCtx(
    opts: { grant: boolean; configured: boolean; defaultTimeout?: boolean },
    extra: Partial<CreateIpcServerOptions> = {},
  ): { ctx: ServerCtx; db: Database } {
    const index = freshIndex();
    const db = index.getDatabase();
    const configDir = tempDir("disp-wiring-fed-");
    if (opts.configured) {
      writeFileSync(
        join(configDir, "nimbus.toml"),
        `[federation.preflight."${NAMESPACE}"]\ncommand = "bun"\nargs = ["--version"]\n`,
        "utf8",
      );
    }
    if (opts.grant) {
      const store = new NamespaceStore(db);
      store.publish(NAMESPACE, [{ kind: "service", value: "github" }]);
      store.grant(NAMESPACE, PEER, "viewer", false);
    }
    const { ctx } = harness({
      localIndex: index,
      federationDiscovery: new InMemoryDiscoveryProvider(),
      federationPairing: new PeerPairing(index),
      configDir,
      ...(opts.defaultTimeout === true ? {} : { federationConsentTimeoutSeconds: 1 }),
      ...extra,
    });
    return { ctx, db };
  }

  test("an ungranted peer is refused no_grant, and the refusal is audited through the db closure", async () => {
    const { ctx, db } = fedCtx({ grant: false, configured: true });
    expect(await tryDispatchFederationRpc(ctx, "federation.preflight", PREFLIGHT)).toEqual({
      kind: "error",
      error: "no_grant",
    });
    expect(auditRows(db, "federation.preflight.%")).toEqual([
      { action_type: "federation.preflight.no_grant", hitl_status: "not_required" },
    ]);
  });

  test("a granted peer whose namespace has no LOCAL command is refused not_configured", async () => {
    const { ctx, db } = fedCtx({ grant: true, configured: false });
    expect(await tryDispatchFederationRpc(ctx, "federation.preflight", PREFLIGHT)).toEqual({
      kind: "error",
      error: "not_configured",
    });
    expect(auditRows(db, "federation.preflight.%")).toEqual([
      { action_type: "federation.preflight.not_configured", hitl_status: "not_required" },
    ]);
  });

  test.each([
    ["an explicit consent timeout", false],
    ["the default consent timeout", true],
  ] as const)(
    "a granted, configured preflight asks the LOCAL owner first — a denial runs nothing (%s)",
    async (_label, defaultTimeout) => {
      const { ctx, db } = fedCtx({ grant: true, configured: true, defaultTimeout });
      const before = new Set(preflightConsent.pendingIds());
      const pending = tryDispatchFederationRpc(ctx, "federation.preflight", PREFLIGHT);

      // The approval request lands on the shared broker; answer it the way
      // `federation.preflightRespond` would. Bounded wait, so a regression fails instead of hanging.
      let requestId: string | undefined;
      for (let i = 0; i < 100 && requestId === undefined; i++) {
        requestId = preflightConsent.pendingIds().find((id) => !before.has(id));
        if (requestId === undefined) await new Promise<void>((r) => setImmediate(r));
      }
      expect(requestId).toBeDefined();
      expect(preflightConsent.respond(requestId as string, false)).toBe(true);

      expect(await pending).toEqual({ kind: "error", error: "denied" });
      expect(auditRows(db, "federation.preflight.%")).toEqual([
        { action_type: "federation.preflight.denied", hitl_status: "rejected" },
      ]);
    },
  );

  test("federation.query consults the LIVE identity store on each call (I18)", async () => {
    const index = freshIndex();
    const identityStore = new IdentityStore(index.getDatabase());
    const { ctx } = harness({
      localIndex: index,
      federationDiscovery: new InMemoryDiscoveryProvider(),
      federationPairing: new PeerPairing(index),
      identityStore,
      identityIssuer: "https://issuer.test",
    });
    const query = { peerId: PEER, namespace: "never-published", purpose: "status" };

    // No operator session: the guard refuses before the namespace is even looked up.
    expect(await tryDispatchFederationRpc(ctx, "federation.query", query)).toEqual({
      kind: "error",
      error: "no_grant",
    });

    // A valid session, no restart: the SAME ctx now passes the guard and reaches the namespace
    // check — proving the closure reads the store per call rather than a captured verdict.
    identityStore.upsertSession({
      issuer: "https://issuer.test",
      externalId: "op-1",
      email: "owner@example.com",
      validatedAt: Date.now(),
      expiresAt: Date.now() + 3_600_000,
      status: "active",
    });
    expect(await tryDispatchFederationRpc(ctx, "federation.query", query)).toEqual({
      kind: "error",
      error: "namespace_unknown",
    });
  });

  test("federation.shareForward receives BOTH asker-side deps and consults the resolver", async () => {
    const resolved: string[] = [];
    const { ctx } = fedCtx(
      { grant: false, configured: false },
      {
        federationForwardShareDeps: {} as ForwardShareDeps,
        federationResolvePeerPubkey: (peerOrKey) => {
          resolved.push(peerOrKey);
          return undefined;
        },
      },
    );
    const err = await rpcErrorOf(
      tryDispatchFederationRpc(ctx, "federation.shareForward", {
        contentHash: "abc123",
        recipient: "peer:bob",
      }),
    );
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("ERR_UNKNOWN_RECIPIENT: no pubkey for recipient");
    expect(resolved).toEqual(["peer:bob"]);
  });

  test("federation.shareForward without the deps fails closed (negative control)", async () => {
    const { ctx } = fedCtx({ grant: false, configured: false });
    const err = await rpcErrorOf(
      tryDispatchFederationRpc(ctx, "federation.shareForward", {
        contentHash: "abc123",
        recipient: "peer:bob",
      }),
    );
    expect(err.rpcCode).toBe(-32603);
    expect(err.message).toBe("ERR_SHARE_FORWARD_UNAVAILABLE: federation forwarding not configured");
  });
});

// ---------------------------------------------------------------------------
// agents: the federation identity rides into the agents context
// ---------------------------------------------------------------------------

describe("agents.* — the federation identity is the one a peer fan-out presents", () => {
  // `selfIdentity` is consumed only on the wire to a paired peer: its public key is the
  // `client_pubkey` of the `hello` frame, its secret key seals the request that would follow.
  // Nothing else in a brief depends on it, so a brief alone cannot show the identity arrived —
  // `agents-rpc.ts` silently falls back to an all-zero keypair. A stand-in peer on loopback
  // records the key it is greeted with, then hangs up, so the wire call ends at once as a
  // per-peer gap rather than waiting out the client's timeout.
  const PEER_PUBKEY = new Uint8Array(32).fill(9);
  const ZERO_KEY_B64 = Buffer.from(new Uint8Array(32)).toString("base64");

  /** A loopback listener that records each greeting's `client_pubkey` and closes the connection. */
  function fakePeer(): { readonly port: number; readonly helloKeys: string[] } {
    const helloKeys: string[] = [];
    // One frame reader PER connection, so two greetings could never splice into one frame.
    const listener = Bun.listen<{ reader: ReturnType<typeof makeFrameReader> }>({
      hostname: "127.0.0.1",
      port: 0,
      socket: {
        open(socket) {
          socket.data = { reader: makeFrameReader(64 * 1024) };
        },
        data(socket, chunk) {
          socket.data.reader.push(chunk);
          const frame = socket.data.reader.next();
          if (frame === undefined) return;
          const hello = JSON.parse(new TextDecoder().decode(frame)) as { client_pubkey?: unknown };
          helloKeys.push(String(hello.client_pubkey));
          socket.end();
        },
      },
    });
    peerListeners.push(listener);
    return { port: listener.port, helloKeys };
  }

  async function huddleOverOnePeer(
    identity: CreateIpcServerOptions["federationIdentity"],
  ): Promise<{
    readonly sessionId: string;
    readonly broadcasts: Broadcast[];
    readonly helloKeys: string[];
  }> {
    const peer = fakePeer();
    const index = freshIndex();
    index.addLanPeer({
      peerId: "peer:stand-in",
      peerPubkey: PEER_PUBKEY,
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: peer.port,
    });
    const { ctx, broadcasts } = harness({
      localIndex: index,
      ...(identity === undefined ? {} : { federationIdentity: identity }),
    });
    // The brief is built fire-and-forget after the call returns, so wait on the broadcast itself.
    // It comes promptly: the stand-in hangs up after the greeting, and lan-client bounds the call.
    const settled = new Promise<void>((resolve) => {
      const record = ctx.broadcastNotification.bind(ctx);
      ctx.broadcastNotification = (method, params) => {
        record(method, params);
        if (method.startsWith("huddle.brief")) resolve();
      };
    });
    const out = (await tryDispatchPhase4Rpc(
      ctx,
      "agents.huddle",
      { namespaces: ["team-a"] },
      "c1",
    )) as { sessionId: string };
    await settled;
    return { sessionId: out.sessionId, broadcasts, helloKeys: peer.helloKeys };
  }

  test("a federated agent answers through the chain, greeting the peer with the WIRED identity", async () => {
    const identity = { publicKey: new Uint8Array(32).fill(7), secretKey: new Uint8Array(32) };
    const { sessionId, broadcasts, helloKeys } = await huddleOverOnePeer(identity);

    expect(typeof sessionId).toBe("string");
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.method).toBe("huddle.briefReady");
    expect(broadcasts[0]?.params["sessionId"]).toBe(sessionId);
    expect(typeof broadcasts[0]?.params["brief"]).toBe("string");
    expect(helloKeys).toEqual([Buffer.from(identity.publicKey).toString("base64")]);
  });

  test("negative control: with no identity wired the same fan-out greets with the zero key", async () => {
    const { broadcasts, helloKeys } = await huddleOverOnePeer(undefined);
    expect(broadcasts.map((b) => b.method)).toEqual(["huddle.briefReady"]);
    expect(helloKeys).toEqual([ZERO_KEY_B64]);
  });
});

// ---------------------------------------------------------------------------
// Tribal (I25): an approved capture returns the page the connector created
// ---------------------------------------------------------------------------

describe("tribal.capture — the submitAction closure the dispatcher builds", () => {
  function tribalCtx(capture: TribalRpcCtx["capture"]): TribalRpcCtx {
    return {
      status: () => ({ enabled: true, clusters: 0 }),
      start: async () => {},
      stop: async () => {},
      list: () => [],
      dismiss: async () => {},
      scan: async () => ({ scanned: 0, fired: 0 }),
      capture,
    };
  }

  test("an owner-approved KB write dispatches once, is ledgered, and yields the page ref", async () => {
    const index = freshIndex();
    const dispatched: unknown[] = [];
    const dispatcher: ConnectorDispatcher = {
      dispatch: async (action) => {
        dispatched.push(action);
        // The MCP tool envelope: a non-text block first (skipped), then the JSON page.
        return {
          content: [
            { type: "image", data: "…" },
            { type: "text", text: JSON.stringify({ id: "page-42", url: "https://notion.so/x" }) },
          ],
        };
      },
    };
    let submitted: unknown;
    const rpc = tribalCtx(async (clusterId, target, submit) => {
      expect(clusterId).toBe("cluster-9");
      expect(target).toBe("notion");
      submitted = await submit({ type: "notion.knowledge.write", payload: { title: "Runbook" } });
      return { ok: true, pageRef: "from-capture" };
    });
    const { ctx } = harness(
      { localIndex: index, tribalRpcCtx: rpc, tribalConnectorDispatcher: dispatcher },
      "approve",
    );

    const out = await tryDispatchTribalRpc(
      ctx,
      "tribal.capture",
      { clusterId: "cluster-9", target: "notion" },
      "c1",
    );

    expect(out).toEqual({ ok: true, pageRef: "from-capture" });
    expect(submitted).toEqual({ status: "approved", result: { pageRef: "notion:page-42" } });
    expect(dispatched).toEqual([{ type: "notion.knowledge.write", payload: { title: "Runbook" } }]);
    // I29: the executor carries the egress sink — one authorized row, appended before dispatch.
    const ledger = index
      .getDatabase()
      .query<{ destination: string; result_status: string }, []>(
        "SELECT destination, result_status FROM egress_ledger",
      )
      .all();
    expect(ledger).toEqual([{ destination: "notion", result_status: "authorized" }]);
  });

  test("a non-object params payload has no clusterId and is refused -32602", async () => {
    let captures = 0;
    const rpc = tribalCtx(async () => {
      captures++;
      return { ok: false, error: "capture_unavailable" };
    });
    const { ctx } = harness({ tribalRpcCtx: rpc });
    const err = await rpcErrorOf(tryDispatchTribalRpc(ctx, "tribal.capture", "cluster-9", "c1"));
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("ERR_INVALID_PARAMS: clusterId (string) required");
    expect(captures).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// connector.*: notify + mesh are forwarded
// ---------------------------------------------------------------------------

describe("connector.* — forwarded notify and connector mesh", () => {
  test("connector.pause emits connector.configChanged through broadcastNotification", async () => {
    const index = freshIndex();
    index.ensureConnectorSchedulerRegistration("github", 60_000, Date.now());
    const { ctx, broadcasts } = harness({ localIndex: index });

    expect(
      await tryDispatchConnectorRpc(ctx, "connector.pause", { serviceId: "github" }, "c1"),
    ).toEqual({ ok: true });
    expect(broadcasts).toHaveLength(1);
    expect(broadcasts[0]?.method).toBe("connector.configChanged");
    expect(broadcasts[0]?.params).toMatchObject({ service: "github", enabled: false });
  });

  test("connector.addMcp reaches the mesh only when one is wired (owner-approved)", async () => {
    const registered: unknown[] = [];
    const scheduler = {
      register: (syncable: unknown) => {
        registered.push(syncable);
      },
    } as unknown as SyncScheduler;
    const mesh = {
      ensureUserMcpRunning: async () => {},
      userMcpProtectedRoots: () => [],
    } as unknown as LazyConnectorMesh;
    // An absolute command that exists on every runner: the production `which`/`realpath`
    // defaults resolve it for real (no PATH dependency on `node`).
    const request = { serviceId: "mcp_wiring_demo", argv: [process.execPath, "server.js"] };

    const { ctx: withoutMesh } = harness(
      { localIndex: freshIndex(), syncScheduler: scheduler },
      "approve",
    );
    const err = await rpcErrorOf(
      tryDispatchConnectorRpc(withoutMesh, "connector.addMcp", request, "c1"),
    );
    expect(err.rpcCode).toBe(-32603);
    expect(err.message).toBe("User MCP registration requires sync and connector mesh");
    expect(registered).toEqual([]);

    const { ctx: withMesh } = harness(
      { localIndex: freshIndex(), syncScheduler: scheduler, connectorMesh: mesh },
      "approve",
    );
    expect(await tryDispatchConnectorRpc(withMesh, "connector.addMcp", request, "c1")).toEqual({
      ok: true,
      serviceId: "mcp_wiring_demo",
    });
    expect(registered).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Extensions: mesh, publisher-key fetcher, air-gap flag, and the auto-update HITL gate
// ---------------------------------------------------------------------------

describe("watcher/workflow/extension — forwarded extension deps", () => {
  const session = {} as Parameters<typeof tryDispatchAutomationRpc>[2];

  function fetcher(calls: string[]): PublisherKeyFetcher {
    return {
      fetch: (publisherId: string) => {
        calls.push(publisherId);
        return Promise.reject(new Error("no publisher should be fetched"));
      },
    };
  }

  test("extension.disable stops the running extension client through the forwarded mesh", async () => {
    const index = freshIndex();
    insertExtensionRow(index.getDatabase(), {
      id: "ext.wiring",
      version: "1.0.0",
      install_path: join(tmpdir(), "ext.wiring"),
      manifest_hash: "m".repeat(64),
      entry_hash: "e".repeat(64),
      installed_at: 1,
      last_verified_at: 1,
    });
    const stopped: string[] = [];
    const mesh = {
      stopExtensionClient: async (id: string) => {
        stopped.push(id);
      },
    } as unknown as LazyConnectorMesh;
    const { ctx } = harness({ localIndex: index, connectorMesh: mesh });

    expect(
      await tryDispatchAutomationRpc(ctx, "c1", session, "extension.disable", { id: "ext.wiring" }),
    ).toEqual({ ok: true });
    expect(stopped).toEqual(["ext.wiring"]);
  });

  test("extension.sync uses the forwarded publisher-key fetcher (none installed → nothing fetched)", async () => {
    const calls: string[] = [];
    const { ctx } = harness({
      localIndex: freshIndex(),
      extensionsPublisherKeyFetcher: fetcher(calls),
    });
    expect(await tryDispatchAutomationRpc(ctx, "c1", session, "extension.sync", {})).toEqual({
      publishersChecked: 0,
      publishersUnchanged: 0,
      publishersUpdated: [],
      publishersEvicted: [],
      failures: [],
    });
    expect(calls).toEqual([]);

    // Negative control: without the fetcher the handler refuses rather than syncing.
    const { ctx: unwired } = harness({ localIndex: freshIndex() });
    const err = await rpcErrorOf(
      tryDispatchAutomationRpc(unwired, "c1", session, "extension.sync", {}),
    );
    expect(err.rpcCode).toBe(-32603);
    expect(err.message).toBe("Gateway is not configured with a publisher key fetcher");
  });

  test("extension.sync honours the forwarded air-gap flag and refuses", async () => {
    const calls: string[] = [];
    const { ctx } = harness({
      localIndex: freshIndex(),
      extensionsPublisherKeyFetcher: fetcher(calls),
      extensionsEnforceAirGap: true,
    });
    const err = await rpcErrorOf(
      tryDispatchAutomationRpc(ctx, "c1", session, "extension.sync", {}),
    );
    expect(err.rpcCode).toBe(-32603);
    expect(err.message).toBe("air-gap is enforced; nimbus extension sync refused");
    expect(calls).toEqual([]);
  });

  function cachedUpdate(): AvailableUpdate {
    return {
      id: "ext.auto",
      displayName: "Auto",
      fromVersion: "1.0.0",
      toVersion: "1.1.0",
      channel: "stable",
      changelog: "fixes",
      publisherStatus: "verified",
      manifestHash: "abcdef0123456789".repeat(4),
      signatureB64: "",
      entryHash: "e".repeat(64),
      tarballUrl: "https://registry.invalid/ext.auto-1.1.0.tgz",
      permissionDiff: {
        network: { added: [], removed: [] },
        filesystem: { read: { added: [], removed: [] }, write: { added: [], removed: [] } },
      },
      verificationStatus: "verified",
      detectedAt: 1,
    };
  }

  function autoUpdateBag(
    upgrades: string[],
  ): NonNullable<CreateIpcServerOptions["extensionsAutoUpdate"]> {
    const cache = new AutoUpdateCache();
    cache.upsert(cachedUpdate());
    return {
      cache,
      forcePoll: async () => {},
      performUpgrade: async (u) => {
        upgrades.push(`${u.id}@${u.toVersion}`);
      },
      performDowngrade: async () => {},
      appendAudit: async () => {},
      getInstalledVersion: async () => "1.0.0",
      hasPrevVersion: async () => false,
    };
  }

  test("extension.update applies only after the owner approves the auto-update gate", async () => {
    const upgrades: string[] = [];
    const index = freshIndex();
    const { ctx } = harness(
      { localIndex: index, extensionsAutoUpdate: autoUpdateBag(upgrades) },
      "approve",
    );
    expect(
      await tryDispatchAutomationRpc(ctx, "c1", session, "extension.update", {
        id: "ext.auto",
        toVersion: "1.1.0",
      }),
    ).toEqual({ applied: true, jobId: "abcdef0123456789" });
    expect(upgrades).toEqual(["ext.auto@1.1.0"]);
    expect(auditRows(index.getDatabase(), "extension.autoUpdate")).toEqual([
      { action_type: "extension.autoUpdate", hitl_status: "approved" },
    ]);
  });

  test("extension.update the owner denies performs no upgrade", async () => {
    const upgrades: string[] = [];
    const { ctx } = harness(
      { localIndex: freshIndex(), extensionsAutoUpdate: autoUpdateBag(upgrades) },
      "deny",
    );
    expect(
      await tryDispatchAutomationRpc(ctx, "c1", session, "extension.update", {
        id: "ext.auto",
        toVersion: "1.1.0",
      }),
    ).toEqual({ applied: false, reason: "user_rejected" });
    expect(upgrades).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// profile / media / lan / diagnostics / egress — through the phase-4 chain where they live
// ---------------------------------------------------------------------------

describe("profile.switch — the profile notify closure", () => {
  test("switching profiles broadcasts profile.switched with the new name", async () => {
    const { ctx, broadcasts } = harness({
      profileManager: new ProfileManager(tempDir("disp-wiring-profile-")),
    });
    expect(await tryDispatchPhase4Rpc(ctx, "profile.create", { name: "work" }, "c1")).toEqual({
      name: "work",
    });
    expect(broadcasts).toEqual([]);
    expect(await tryDispatchPhase4Rpc(ctx, "profile.switch", { name: "work" }, "c1")).toEqual({
      active: "work",
    });
    expect(broadcasts).toEqual([{ method: "profile.switched", params: { name: "work" } }]);
  });
});

describe("media.* — guards and the vendor-scoped revoke", () => {
  test("media.understand refuses without a dataDir, before anything else is consulted", async () => {
    const { ctx } = harness({ localIndex: freshIndex() });
    const err = await rpcErrorOf(tryDispatchPhase4Rpc(ctx, "media.understand", {}, "c1"));
    expect(err.rpcCode).toBe(-32603);
    expect(err.message).toBe("media.understand requires dataDir");
  });

  test("media.understand refuses without the org-policy accessor (I22 fail-closed)", async () => {
    const { ctx } = harness({ localIndex: freshIndex(), dataDir: tempDir("disp-wiring-media-") });
    const err = await rpcErrorOf(tryDispatchPhase4Rpc(ctx, "media.understand", {}, "c1"));
    expect(err.rpcCode).toBe(-32603);
    expect(err.message).toBe("media.understand requires mediaRpcCtx (the org-policy accessor)");
  });

  test("media.grants.revoke with a modelVendor revokes only that vendor's grant", async () => {
    const index = freshIndex();
    const db = index.getDatabase();
    createGrant(db, { itemId: "item-1", modality: "image", modelVendor: "openai", nowMs: 1 });
    createGrant(db, { itemId: "item-1", modality: "image", modelVendor: "gemini", nowMs: 2 });
    const { ctx } = harness({ localIndex: index });

    expect(
      await tryDispatchPhase4Rpc(
        ctx,
        "media.grants.revoke",
        { itemId: "item-1", modelVendor: "gemini" },
        "c1",
      ),
    ).toEqual({ revoked: 1 });
    expect(listActiveGrants(db).map((g) => g.modelVendor)).toEqual(["openai"]);
  });
});

describe("lan.openPairingWindow — expiry fallback", () => {
  test("a window that cannot report its expiry yields 'now' rather than null", async () => {
    class NoExpiryWindow extends PairingWindow {
      override getExpiresAt(): number | null {
        return null;
      }
    }
    const window = new NoExpiryWindow(60_000);
    const { ctx } = harness({ lanPairingWindow: window });
    const before = Date.now();
    const out = (await tryDispatchPhase4Rpc(ctx, "lan.openPairingWindow", {}, "c1")) as {
      pairingCode: string;
      expiresAt: number;
    };
    const after = Date.now();
    expect(out.pairingCode).toHaveLength(20);
    expect(out.expiresAt).toBeGreaterThanOrEqual(before);
    expect(out.expiresAt).toBeLessThanOrEqual(after);
    expect(window.isOpen()).toBe(true);
  });
});

describe("diag.snapshot — embedding readiness is forwarded", () => {
  test("the snapshot carries the readiness the gateway reported", async () => {
    const readiness: EmbeddingReadiness = {
      state: "warming",
      elapsedMs: 1234,
      model: "all-MiniLM-L6-v2",
      dims: 384,
      download: null,
      reason: null,
    };
    const { ctx } = harness({
      localIndex: freshIndex(),
      dataDir: tempDir("disp-wiring-diag-"),
      embeddingReadiness: () => readiness,
    });
    const out = (await tryDispatchDiagnosticsRpc(ctx, "diag.snapshot", {})) as Record<
      string,
      unknown
    >;
    expect(out["embedding"]).toEqual(readiness);
  });
});

describe("egress.prune — the owner-approved path of the I2 gate", () => {
  test("an approved prune removes the rows before the cutoff, through the caller's channel", async () => {
    const index = freshIndex();
    const db = index.getDatabase();
    for (const timestamp of [10, 20]) {
      appendEgressEntry(db, {
        timestamp,
        sourceType: "task",
        sourceId: "s",
        destination: "email",
        method: "email.send",
        payloadSummary: "{}",
        hitlStatus: "approved",
        resultStatus: "authorized",
      });
    }
    const egressRpcCtx: EgressRpcCtx = {
      db,
      vault: createMockVault(),
      now: () => 100,
      // Would DENY — the dispatcher must replace it with the gate bound to the caller.
      requestPruneApproval: async () => false,
    };
    const { ctx } = harness({ localIndex: index, egressRpcCtx }, "approve");

    expect(await tryDispatchPhase4Rpc(ctx, "egress.prune", { beforeTs: 15 }, "c1")).toEqual({
      approved: true,
      prunedCount: 1,
    });
    expect(auditRows(db, "egress.prune")).toEqual([
      { action_type: "egress.prune", hitl_status: "approved" },
    ]);
  });
});
