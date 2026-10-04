import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { quorumCoordinator } from "../engine/quorum/quorum-singleton.ts";
import { PeerPairing } from "../federation/peer-pairing.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { dispatchFederationRpc, type FederationRpcContext } from "./federation-rpc.ts";
import { type BoxKeypair, generateBoxKeypair } from "./lan-crypto.ts";
import { LanServer } from "./lan-server.ts";

/**
 * `federation-rpc.ts` paths the other federation suites do not reach:
 *   - the three asker methods with no DI seam (`askExpertise`, `askInvoke`, `team.auditMerged`),
 *     driven against a real in-process `LanServer` peer on loopback;
 *   - `team.auditMerged` SKIPPING a peer whose slice is malformed, shape by shape;
 *   - the `types` narrowing on both sides of a query (`federation.ask`, `federation.query`);
 *   - the identity guard reaching the preflight and invoke gates, and `changedSurface` coercion;
 *   - the invoke gate's quorum, completed through `federation.quorumRespond`;
 *   - a successful `federation.pair`.
 */

const openDbs: Database[] = [];
const servers: LanServer[] = [];
afterEach(async () => {
  quorumCoordinator.setBroadcast(() => {});
  for (const s of servers.splice(0)) await s.stop();
  for (const db of openDbs.splice(0)) db.close();
});

function freshIndex(): { db: Database; index: LocalIndex } {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  openDbs.push(db);
  return { db, index: new LocalIndex(db) };
}

function baseCtx(db: Database, index: LocalIndex): FederationRpcContext {
  return {
    db,
    consentTimeoutMs: 1000,
    notify: () => {},
    discovery: { list: async () => [] } as unknown as FederationRpcContext["discovery"],
    pairing: new PeerPairing(index),
  };
}

type Answer = (params: unknown) => unknown;

/**
 * A paired peer on loopback: a real `LanServer` that knows every client and answers each method
 * with `answers[method]`, recording what it was asked. Returns the asker-side context with that
 * peer paired as `peer:resp`.
 */
async function askerWithPeer(answers: Record<string, Answer>): Promise<{
  ctx: FederationRpcContext;
  calls: Array<{ method: string; params: unknown }>;
}> {
  const calls: Array<{ method: string; params: unknown }> = [];
  const host: BoxKeypair = generateBoxKeypair();
  const server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: host,
    onMessage: async (method, params) => {
      calls.push({ method, params });
      const answer = answers[method];
      if (answer === undefined) throw new Error(`unexpected method ${method}`);
      return answer(params);
    },
    isKnownPeer: () => ({ peerId: "asker", writeAllowed: false }),
    registerPeer: () => "asker",
    rateLimit: { checkAllowed: () => true, recordFailure: () => {}, recordSuccess: () => {} },
    pairing: {
      isOpen: () => false,
      consume: () => false,
      open: () => {},
      close: () => {},
      getExpiresAt: () => undefined,
    },
  });
  await server.start();
  servers.push(server);
  const port = server.listenAddr()?.port;
  if (port === undefined) throw new Error("peer did not start");

  const { db, index } = freshIndex();
  index.addLanPeer({
    peerId: "peer:resp",
    peerPubkey: host.publicKey,
    direction: "outbound",
    hostIp: "127.0.0.1",
    hostPort: port,
  });
  return {
    calls,
    ctx: { ...baseCtx(db, index), index, selfIdentity: generateBoxKeypair() },
  };
}

function hitValue<T>(out: { kind: string }): T {
  expect(out.kind).toBe("hit");
  return (out as unknown as { value: T }).value;
}

describe("asker methods over the real wire", () => {
  test("askExpertise sends the content-free probe and relays the peer's rank", async () => {
    const { ctx, calls } = await askerWithPeer({ "federation.expertise": () => ({ rank: 0.42 }) });
    const out = await dispatchFederationRpc(
      "federation.askExpertise",
      { peerId: "peer:resp", query: "auth bug", purpose: "who-knows", extra: "dropped" },
      ctx,
    );
    expect(hitValue<unknown>(out)).toEqual({ rank: 0.42 });
    expect(calls).toEqual([
      { method: "federation.expertise", params: { query: "auth bug", purpose: "who-knows" } },
    ]);
  });

  test("askInvoke forwards exactly entry, toolId, purpose and args to federation.invoke", async () => {
    const { ctx, calls } = await askerWithPeer({
      "federation.invoke": () => ({ kind: "ok", result: { stopped: true } }),
    });
    const out = await dispatchFederationRpc(
      "federation.askInvoke",
      {
        peerId: "peer:resp",
        entry: "prod-aws",
        toolId: "aws.ec2.instance.stop",
        purpose: "drill",
        args: { instanceId: "i-1" },
      },
      ctx,
    );
    expect(hitValue<unknown>(out)).toEqual({ kind: "ok", result: { stopped: true } });
    expect(calls).toEqual([
      {
        method: "federation.invoke",
        params: {
          entry: "prod-aws",
          toolId: "aws.ec2.instance.stop",
          purpose: "drill",
          args: { instanceId: "i-1" },
        },
      },
    ]);
  });
});

describe("team.auditMerged — a peer's slice is merged only when it is well-formed", () => {
  const GOOD_ENTRY = {
    actionType: "federation.query",
    hitlStatus: "approved",
    hash: "h",
    timestamp: 5,
  };

  test.each([
    ["a null result", null],
    ["a non-object result", "ok"],
    ["a refusal instead of a slice", { kind: "error", error: "no_grant" }],
    // Well-formed entries do not rescue a reply that is not `kind: "ok"`: the kind is checked
    // on its own, not inferred from the entries being present.
    [
      "a refusal that still carries well-formed entries",
      { kind: "error", error: "no_grant", entries: [GOOD_ENTRY] },
    ],
    ["entries that are not an array", { kind: "ok", entries: "none" }],
    ["a null entry", { kind: "ok", entries: [GOOD_ENTRY, null] }],
    [
      "an entry with a non-numeric timestamp",
      { kind: "ok", entries: [{ ...GOOD_ENTRY, timestamp: "5" }] },
    ],
    ["an entry missing its hash", { kind: "ok", entries: [{ ...GOOD_ENTRY, hash: undefined }] }],
  ])("%s is skipped whole — local entries only", async (_label, slice) => {
    const { ctx, calls } = await askerWithPeer({ "federation.auditExport": () => slice });
    const out = await dispatchFederationRpc("team.auditMerged", { namespace: "ns" }, ctx);
    const { entries } = hitValue<{ entries: Array<{ peerId: string }> }>(out);
    expect(entries.every((e) => e.peerId === "local")).toBe(true);
    expect(calls.map((c) => c.method)).toEqual(["federation.auditExport"]);
  });

  test("control: a well-formed slice IS merged under the peer's id", async () => {
    const { ctx, calls } = await askerWithPeer({
      "federation.auditExport": () => ({ kind: "ok", entries: [GOOD_ENTRY] }),
    });
    const out = await dispatchFederationRpc(
      "team.auditMerged",
      { namespace: "ns", sinceMs: 3, purpose: "quarterly" },
      ctx,
    );
    const { entries } = hitValue<{ entries: Array<{ peerId: string; timestamp: number }> }>(out);
    expect(entries.filter((e) => e.peerId === "peer:resp")).toEqual([
      expect.objectContaining({ peerId: "peer:resp", timestamp: 5 }),
    ]);
    expect(calls[0]?.params).toEqual({ namespace: "ns", purpose: "quarterly", sinceMs: 3 });
  });
});

describe("types narrowing", () => {
  test("federation.ask forwards only the string members of types", async () => {
    const { db, index } = freshIndex();
    index.addLanPeer({
      peerId: "peer:b",
      peerPubkey: generateBoxKeypair().publicKey,
      direction: "outbound",
      hostIp: "127.0.0.1",
      hostPort: 7475,
    });
    const sent: unknown[] = [];
    const ctx: FederationRpcContext = {
      ...baseCtx(db, index),
      index,
      selfIdentity: generateBoxKeypair(),
      sendOverWire: async (_h, _p, _kp, _pub, method, params) => {
        sent.push({ method, params });
        return { kind: "ok", response: { items: [] } };
      },
    };
    await dispatchFederationRpc(
      "federation.ask",
      { peerId: "peer:b", namespace: "ns", purpose: "p", types: ["pr", 7, null, "issue"] },
      ctx,
    );
    expect(sent).toEqual([
      {
        method: "federation.query",
        params: { namespace: "ns", purpose: "p", types: ["pr", "issue"] },
      },
    ]);
  });

  test("federation.query narrows a type-unrestricted namespace to the requested types", async () => {
    const { db, index } = freshIndex();
    const ctx = baseCtx(db, index);
    for (const [type, id] of [
      ["pr", "P1"],
      ["issue", "I1"],
    ] as const) {
      upsertIndexedItem(db, {
        service: "github",
        type,
        externalId: id,
        title: id,
        modifiedAt: 1,
        syncedAt: 1,
      });
    }
    await dispatchFederationRpc(
      "federation.namespace.publish",
      { name: "gh", filters: [{ kind: "service", value: "github" }] },
      ctx,
    );
    await dispatchFederationRpc(
      "federation.namespace.grant",
      { namespace: "gh", peerId: "peer:q", role: "viewer", standingConsent: true },
      ctx,
    );
    const titles = async (extra: Record<string, unknown>) => {
      const out = await dispatchFederationRpc(
        "federation.query",
        { peerId: "peer:q", namespace: "gh", purpose: "p", ...extra },
        ctx,
      );
      const v = hitValue<{ kind: string; response: { items: Array<{ title: string }> } }>(out);
      expect(v.kind).toBe("ok");
      return v.response.items.map((i) => i.title).sort();
    };
    expect(await titles({})).toEqual(["I1", "P1"]);
    expect(await titles({ types: ["issue", 7] })).toEqual(["I1"]);
  });
});

describe("the identity guard reaches the answering gates", () => {
  const INVALID_OPERATOR = { enabled: true, isOperatorValid: () => false };

  test("preflight: an invalid operator refuses before approval or any command runs", async () => {
    const { db, index } = freshIndex();
    const ran: unknown[] = [];
    let approvals = 0;
    const preflight = {
      isPeerGranted: () => true,
      resolveCommand: () => ({ command: "bun", args: ["test"], cwd: "/x", timeoutSeconds: 60 }),
      requestApproval: async () => {
        approvals++;
        return true;
      },
      runCommand: async (_cfg: unknown, run: unknown) => {
        ran.push(run);
        return { passed: true, summary: "ok", durationMs: 1 };
      },
      audit: () => {},
    };
    const params = { namespace: "n", ref: "HEAD", purpose: "x", peerId: "peer:a" };

    const refused = await dispatchFederationRpc("federation.preflight", params, {
      ...baseCtx(db, index),
      preflight,
      identityGuard: INVALID_OPERATOR,
    });
    expect(hitValue<unknown>(refused)).toEqual({ kind: "error", error: "no_grant" });
    expect(approvals).toBe(0);
    expect(ran).toEqual([]);

    // Control, same deps without the guard: it runs — and a non-array changedSurface became [].
    const served = await dispatchFederationRpc(
      "federation.preflight",
      { ...params, changedSurface: "src/a.ts" },
      { ...baseCtx(db, index), preflight },
    );
    expect(hitValue<{ kind: string }>(served).kind).toBe("ok");
    expect(ran).toEqual([{ ref: "HEAD", changedSurface: [] }]);
  });

  test("invoke: an invalid operator is refused (audited as identity_invalid) though the grant exists", async () => {
    const { db, index } = freshIndex();
    const store = new TeamVaultStore(db);
    store.createEntry("prod-aws", "aws", "owner", 1);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1);
    let runs = 0;
    const out = await dispatchFederationRpc(
      "federation.invoke",
      { peerId: "peer:abc", entry: "prod-aws", toolId: "aws.ec2.instance.stop", purpose: "x" },
      {
        ...baseCtx(db, index),
        identityGuard: INVALID_OPERATOR,
        teamVault: {
          quorumFor: () => undefined,
          runTool: async () => {
            runs++;
            return {};
          },
        },
      },
    );
    expect(hitValue<unknown>(out)).toEqual({ kind: "error", error: "no_grant" });
    expect(runs).toBe(0);
    const decisions = db
      .query("SELECT action_type FROM audit_log WHERE action_type LIKE 'teamvault.invoke.%'")
      .all() as Array<{ action_type: string }>;
    expect(decisions.map((d) => d.action_type)).toEqual(["teamvault.invoke.identity_invalid"]);
  });
});

describe("federation.invoke — the quorum a rule demands", () => {
  async function invokeWithQuorum(approve: boolean): Promise<{ value: unknown; runs: number }> {
    const { db, index } = freshIndex();
    const store = new TeamVaultStore(db);
    store.createEntry("prod-aws", "aws", "owner", 1);
    store.grant("prod-aws", "peer:abc", "aws.ec2.instance.stop", 1);
    let runs = 0;
    const ctx: FederationRpcContext = {
      ...baseCtx(db, index),
      teamVault: {
        quorumFor: () => ({ approvers: 1, windowSeconds: 30 }),
        runTool: async () => {
          runs++;
          return { stopped: true };
        },
      },
    };
    // The coordinator broadcasts each request; answer it the way an approver's gateway would.
    quorumCoordinator.setBroadcast((requestId) => {
      queueMicrotask(() => {
        void dispatchFederationRpc(
          "federation.quorumRespond",
          { requestId, peerId: "peer:approver", approved: approve },
          ctx,
        );
      });
    });
    const out = await dispatchFederationRpc(
      "federation.invoke",
      { peerId: "peer:abc", entry: "prod-aws", toolId: "aws.ec2.instance.stop", purpose: "x" },
      ctx,
    );
    return { value: hitValue<unknown>(out), runs };
  }

  test("an approving quorum lets the tool run", async () => {
    const { value, runs } = await invokeWithQuorum(true);
    expect(value).toEqual({ kind: "ok", result: { stopped: true } });
    expect(runs).toBe(1);
  });

  test("a denying approver aborts it before the tool runs", async () => {
    const { value, runs } = await invokeWithQuorum(false);
    expect(value).toEqual({ kind: "error", error: "quorum_denied" });
    expect(runs).toBe(0);
  });
});

describe("federation.pair", () => {
  test("a completed handshake persists the peer and returns its id", async () => {
    const { db, index } = freshIndex();
    const peerKey = generateBoxKeypair().publicKey;
    const handshakes: Array<[string, number, string]> = [];
    const ctx: FederationRpcContext = {
      ...baseCtx(db, index),
      pairing: new PeerPairing(index, async (host, port, code) => {
        handshakes.push([host, port, code]);
        return peerKey;
      }),
    };
    const out = await dispatchFederationRpc(
      "federation.pair",
      { host: "gateway-b.test", port: 9000, code: "123456" },
      ctx,
    );
    const { peerId } = hitValue<{ peerId: string }>(out);
    expect(peerId).toMatch(/^peer:[0-9a-f]{16}$/);
    expect(handshakes).toEqual([["gateway-b.test", 9000, "123456"]]);
    expect(index.listLanPeers().map((p) => [p.peer_id, p.host_ip, p.host_port])).toEqual([
      [peerId, "gateway-b.test", 9000],
    ]);
  });
});
