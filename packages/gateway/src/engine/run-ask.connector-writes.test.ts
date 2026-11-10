/**
 * The model's connector-write door (Phase 9.7): `runAsk` puts a DELEGATION-FREE executor into the
 * request context only when the caller decided this is the local owner's `cli`/`ui` turn
 * (`offerConnectorWriteTools === true`) and the gateway is not demo-rooted. Review Focus 2 (an
 * active in-scope delegate during an owner turn: the owner, not the delegate, is asked) and 4
 * (ChatOps / demo / non-owner turns carry no door executor) are pinned here.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@mastra/core/agent";

import type { EgressSink } from "../egress/egress-ledger.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import {
  agentRequestContext,
  getAgentRequestConnectorWriteExecutor,
  getAgentRequestUserMcpExecutor,
} from "./agent-request-context.ts";
import type { ExecutorDelegationDep, ToolExecutor } from "./executor.ts";
import { type RunAskParams, runAsk } from "./run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "./types.ts";

const stubBase = join(tmpdir(), "nimbus-run-ask-connector-writes-test");
const stubPaths: PlatformPaths = {
  configDir: join(stubBase, "cfg"),
  dataDir: join(stubBase, "data"),
  logDir: join(stubBase, "logs"),
  socketPath: join(stubBase, "gateway.sock"),
  extensionsDir: join(stubBase, "ext"),
  tempDir: join(stubBase, "tmp"),
  sandboxDir: join(stubBase, "sandbox"),
};

type EgressEntry = Parameters<EgressSink["append"]>[0];

type Harness = {
  params: RunAskParams;
  seen: {
    executor: ToolExecutor | undefined;
    userMcpExecutor: ToolExecutor | undefined;
    agentRan: boolean;
  };
  consentClientIds: string[];
  egress: EgressEntry[];
  dispatched: string[];
  close: () => void;
};

function harness(over: Partial<RunAskParams> = {}): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES ('x:1', 'x', 'note', '1', 't', 1, 1)",
  );
  const localIndex = new LocalIndex(db);
  const seen: Harness["seen"] = {
    executor: undefined,
    userMcpExecutor: undefined,
    agentRan: false,
  };
  const consentClientIds: string[] = [];
  const egress: EgressEntry[] = [];
  const dispatched: string[] = [];
  const consentCoordinator: ConsentCoordinator = {
    async requestConsent(clientId: string): Promise<{ approved: boolean; answerSource: "human" }> {
      consentClientIds.push(clientId);
      return { approved: true, answerSource: "human" as const };
    },
    requestConfirmedConsent: async () => ({
      approved: false,
      typed: "",
      answerSource: "human" as const,
    }),
    rejectAllPending(): void {},
    pendingCount(): number {
      return 0;
    },
  };
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action): Promise<unknown> {
      dispatched.push(action.type);
      return { ok: true };
    },
  };
  // The agent records what the request context held AT THE MOMENT IT RAN — the property that
  // matters, since `engine/agent.ts` resolves its tool list per request from that store.
  const agent = {
    generate: async () => {
      seen.agentRan = true;
      seen.executor = getAgentRequestConnectorWriteExecutor();
      seen.userMcpExecutor = getAgentRequestUserMcpExecutor();
      return { text: "agent reply" };
    },
  } as unknown as Agent;
  const params: RunAskParams = {
    input: "sync the web app",
    stream: false,
    clientId: "owner-client-7",
    paths: stubPaths,
    consentCoordinator,
    localIndex,
    dispatcher,
    egressSink: { append: (e) => egress.push(e) },
    getTribalKbConfig: () => undefined,
    sendChunk: () => {},
    conversationalAgent: agent,
    classify: async () => ({ intent: "unknown", entities: {}, requiresHITL: false, confidence: 0 }),
    ...over,
  };
  return { params, seen, consentClientIds, egress, dispatched, close: () => localIndex.close() };
}

/** An active, in-scope, identity-valid delegate for every action, who would approve anything. */
function activeDelegate(): { dep: ExecutorDelegationDep; remoteAsks: string[] } {
  const remoteAsks: string[] = [];
  const dep: ExecutorDelegationDep = {
    store: {
      activeDelegateePeer: () => "peer-delegate",
      activeDelegateFor: () => true,
    },
    isOperatorValid: () => true,
    requestRemote: async (actionType: string) => {
      remoteAsks.push(actionType);
      return { kind: "answered", peerId: "peer-delegate", approved: true };
    },
  };
  return { dep, remoteAsks };
}

const MODEL_WRITE: PlannedAction = {
  type: "looker.datagroup.trigger",
  origin: "model",
  payload: { mcpToolId: "looker_looker_datagroup_trigger", input: { datagroupId: "dg1" } },
};

const NO_ORIGIN_WRITE: PlannedAction = {
  type: "looker.datagroup.trigger",
  payload: { mcpToolId: "looker_looker_datagroup_trigger", input: { datagroupId: "dg1" } },
};

async function turn(h: Harness): Promise<void> {
  await agentRequestContext.run({}, () => runAsk(h.params));
  expect(h.seen.agentRan).toBe(true);
}

describe("runAsk — the connector-write door executor in the request context", () => {
  test("flag true on a non-demo gateway: the door executor is set, bound to this client's consent", async () => {
    const h = harness({ offerConnectorWriteTools: true });
    await turn(h);
    const ex = h.seen.executor;
    if (ex === undefined) throw new Error("expected a door executor");
    expect((await ex.execute(MODEL_WRITE)).status).toBe("ok");
    expect(h.consentClientIds).toEqual(["owner-client-7"]);
    expect(h.egress).toHaveLength(1);
    expect(h.dispatched).toEqual(["looker.datagroup.trigger"]);
    h.close();
  });

  test("flag false, flag absent, ChatOps-shaped: no door executor", async () => {
    const cases: Partial<RunAskParams>[] = [
      { offerConnectorWriteTools: false },
      {},
      { clientId: "chatops", offerConnectorWriteTools: false, offerUserMcpTools: false },
    ];
    for (const over of cases) {
      const h = harness(over);
      await turn(h);
      expect(h.seen.executor).toBeUndefined();
      h.close();
    }
  });

  test("a demo-rooted gateway never gets the door, even with the flag true (control: non-demo does)", async () => {
    const demo = harness({ offerConnectorWriteTools: true, paths: { ...stubPaths, demo: true } });
    await turn(demo);
    expect(demo.seen.executor).toBeUndefined();
    demo.close();
    const real = harness({ offerConnectorWriteTools: true });
    await turn(real);
    expect(real.seen.executor).toBeDefined();
    real.close();
  });

  test("a reused store never carries an earlier owner turn's door executor into a non-owner turn", async () => {
    const owner = harness({ offerConnectorWriteTools: true });
    const store = {};
    await agentRequestContext.run(store, () => runAsk(owner.params));
    expect(owner.seen.executor).toBeDefined();
    const other = harness({ offerConnectorWriteTools: false });
    await agentRequestContext.run(store, () => runAsk(other.params));
    expect(other.seen.executor).toBeUndefined();
    owner.close();
    other.close();
  });

  test("independent of the user-MCP flag: each executor follows its own flag", async () => {
    const onlyWrites = harness({ offerConnectorWriteTools: true, offerUserMcpTools: false });
    await turn(onlyWrites);
    expect(onlyWrites.seen.executor).toBeDefined();
    expect(onlyWrites.seen.userMcpExecutor).toBeUndefined();
    onlyWrites.close();
    const onlyUserMcp = harness({ offerConnectorWriteTools: false, offerUserMcpTools: true });
    await turn(onlyUserMcp);
    expect(onlyUserMcp.seen.executor).toBeUndefined();
    expect(onlyUserMcp.seen.userMcpExecutor).toBeDefined();
    onlyUserMcp.close();
  });
});

describe("Review Focus 2: an active in-scope delegate during an owner turn", () => {
  test("the door executor asks the OWNER, never the delegate", async () => {
    const del = activeDelegate();
    const h = harness({ offerConnectorWriteTools: true, delegation: del.dep });
    await turn(h);
    const ex = h.seen.executor;
    if (ex === undefined) throw new Error("expected a door executor");
    expect((await ex.execute(MODEL_WRITE)).status).toBe("ok");
    expect(h.consentClientIds).toEqual(["owner-client-7"]);
    expect(del.remoteAsks).toEqual([]);
    h.close();
  });

  test("the door executor has no delegation at all: even an action WITHOUT origin goes to the owner", async () => {
    const del = activeDelegate();
    const h = harness({ offerConnectorWriteTools: true, delegation: del.dep });
    await turn(h);
    const ex = h.seen.executor;
    if (ex === undefined) throw new Error("expected a door executor");
    expect((await ex.execute(NO_ORIGIN_WRITE)).status).toBe("ok");
    expect(h.consentClientIds).toEqual(["owner-client-7"]);
    expect(del.remoteAsks).toEqual([]);
    h.close();
  });

  test("control: the unchanged ask executor (user-MCP's) DOES route that action to the delegate", async () => {
    const del = activeDelegate();
    const h = harness({ offerUserMcpTools: true, delegation: del.dep });
    await turn(h);
    const ex = h.seen.userMcpExecutor;
    if (ex === undefined) throw new Error("expected the user-MCP executor");
    expect((await ex.execute(NO_ORIGIN_WRITE)).status).toBe("ok");
    expect(del.remoteAsks).toEqual(["looker.datagroup.trigger"]);
    expect(h.consentClientIds).toEqual([]);
    h.close();
  });
});
