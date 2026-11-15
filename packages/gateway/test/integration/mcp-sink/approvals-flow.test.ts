/**
 * Agent door AD2, acceptance A1-A4 (spec § 10): the owner's queue and the one-step approval, end to
 * end through the REAL dispatch table (`tryDispatchPhase4Rpc`, the entry `server.ts` calls) over a
 * migrated SQLite, a REAL `ConsentCoordinatorImpl` whose "owner connection" answers
 * `consent.request` notifications, a REAL `ToolExecutor` (via `buildActDeps`), a REAL egress ledger
 * and audit chain, and a FAKE connector dispatcher. No model, no router, no embedding runtime.
 *
 * A2 (typed confirmation) uses a SYNTHETIC Wave 4 row through the `beforeStateRows` seam; the same table runs
 * on the real `github.pr.merge` in agent-door-flow.test.ts (AD3a-2a), where the gate is the real agent door.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { DEFAULT_MCP_SINK_CONFIG } from "../../../src/config/mcp-sink-toml.ts";
import {
  type ConnectorWriteRow,
  row as makeRow,
  withBefore,
  withConfirm,
  withPreview,
} from "../../../src/connectors/connector-writes/types.ts";
import { appendAuditEntry } from "../../../src/db/audit-chain.ts";
import { makeEgressSink, NULL_EGRESS_SINK } from "../../../src/egress/egress-ledger.ts";
import { isBeforeReadActionType, WAVE4_BEFORE_REFUSAL } from "../../../src/engine/before-state.ts";
import { NO_POLICY_OVERLAY } from "../../../src/engine/executor.ts";
import { buildModelWriteExecutor } from "../../../src/engine/run-ask.ts";
import type { AnswerSource, AuditSink, PlannedAction } from "../../../src/engine/types.ts";
import { openMigratedMemoryDb } from "../../../src/index/migrated-db-template.ts";
import { APPROVALS_METHODS } from "../../../src/ipc/approvals-rpc.ts";
import type { CaptureActWiring, CaptureRpcCtx } from "../../../src/ipc/capture-rpc.ts";
import { ConsentCoordinatorImpl } from "../../../src/ipc/consent.ts";
import { createStreamRegistry } from "../../../src/ipc/engine-ask-stream.ts";
import type { JsonRpcNotification } from "../../../src/ipc/jsonrpc.ts";
import type { ClientKind } from "../../../src/ipc/server/client-kind.ts";
import type { ServerCtx } from "../../../src/ipc/server/context.ts";
import { tryDispatchPhase4Rpc } from "../../../src/ipc/server/dispatchers.ts";
import type { CreateIpcServerOptions } from "../../../src/ipc/server/options.ts";
import { resolveCaptureCapability } from "../../../src/mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../../../src/mcp-sink/capture-gate.ts";
import {
  CaptureAttemptLimiter,
  CaptureRefusalCounter,
} from "../../../src/mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../../../src/mcp-sink/capture-store.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

const OWNER_A = "owner-a";
const OWNER_B = "owner-b";
const AGENT_1 = "agent-1";
const AGENT_2 = "agent-2";

const JIRA_REPLY = {
  key: "NIM-1",
  fields: { summary: "Fix login", status: { name: "In Progress" }, issuetype: { name: "Bug" } },
};

/** A consent request as the owner's connection receives it. */
interface SeenRequest {
  readonly clientId: string;
  readonly requestId: string;
  readonly prompt: string;
  readonly confirmText: string | undefined;
}

interface OwnerAnswer {
  readonly approved: boolean;
  readonly typed?: string;
  readonly answerSource?: AnswerSource;
}

let db: Database;
let store: CaptureStore;
let clock: number;
let seq: number;
let dispatched: PlannedAction[];
let seen: SeenRequest[];
let held: SeenRequest[];
let answer: (req: SeenRequest) => OwnerAnswer | "hold";
let beforeReply: () => unknown;
let writeStateSeen: string[];
let sinkConfig: "off" | "on";
let kinds: Record<string, ClientKind>;
let rows: readonly ConnectorWriteRow[] | undefined;
let coordinator: ConsentCoordinatorImpl;
let rpcCtx: CaptureRpcCtx;
let ownerRequests: Array<{ clientId: string; method: string }>;

function gateDeps(): CaptureGateDeps {
  return {
    db,
    store,
    capability: () =>
      sinkConfig === "on"
        ? resolveCaptureCapability(
            {
              ok: true,
              config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
            },
            { capabilitiesDisabled: new Set() },
          )
        : resolveCaptureCapability(
            { ok: true, config: DEFAULT_MCP_SINK_CONFIG },
            { capabilitiesDisabled: new Set() },
          ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq).padStart(32, "0")}`,
    now: () => clock,
    classifyAction: () => ({ kind: "proposable", basis: "legacy_user_mcp" }),
    isServiceConfigured: () => Promise.resolve(true),
    actionDestinationRefusal: () => undefined,
  };
}

function actWiring(): CaptureActWiring {
  return {
    dispatcher: {
      dispatch: (a) => {
        dispatched.push(a);
        if (isBeforeReadActionType(a.type)) return Promise.resolve(beforeReply());
        // What the capture row says at the instant the write is dispatched.
        const r = db.query("SELECT state FROM capture ORDER BY created_at DESC, id DESC").all() as {
          state: string;
        }[];
        writeStateSeen.push(r.map((x) => x.state).join(","));
        return Promise.resolve({ url: "https://example.test/x" });
      },
    },
    egressSink: makeEgressSink(db),
    audit: { recordAudit: (e) => appendAuditEntry(db, e) },
    policyHitl: NO_POLICY_OVERLAY,
    getTribalKbConfig: () => undefined,
    previewCredentialFor: () => "team",
    ...(rows === undefined ? {} : { beforeStateRows: rows }),
  };
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  store = new CaptureStore(db);
  clock = 1_000;
  seq = 0;
  dispatched = [];
  seen = [];
  held = [];
  writeStateSeen = [];
  ownerRequests = [];
  sinkConfig = "on";
  rows = undefined;
  beforeReply = () => JIRA_REPLY;
  answer = () => ({ approved: true, answerSource: "human" });
  kinds = {
    [OWNER_A]: "cli",
    [OWNER_B]: "ui",
    [AGENT_1]: "mcp",
    [AGENT_2]: "mcp",
    unk: "unknown",
    web: "http",
    chat: "chatops",
  };
  const respond = (clientId: string, req: SeenRequest, a: OwnerAnswer): void => {
    queueMicrotask(() => {
      coordinator.handleRespond(clientId, {
        requestId: req.requestId,
        approved: a.approved,
        ...(a.typed === undefined ? {} : { typed: a.typed }),
        ...(a.answerSource === undefined ? {} : { answerSource: a.answerSource }),
      });
    });
  };
  coordinator = new ConsentCoordinatorImpl((clientId) => (n: JsonRpcNotification) => {
    const p = n.params as Record<string, unknown>;
    const req: SeenRequest = {
      clientId,
      requestId: String(p["requestId"]),
      prompt: String(p["prompt"]),
      confirmText: typeof p["confirmText"] === "string" ? p["confirmText"] : undefined,
    };
    seen.push(req);
    const a = answer(req);
    if (a === "hold") held.push(req);
    else respond(clientId, req, a);
  });
  rpcCtx = { gate: gateDeps(), act: actWiring() };
});
afterEach(() => db.close());

function serverCtx(): ServerCtx {
  const options: CreateIpcServerOptions = {
    listenPath: "",
    vault: createMockVault(),
    version: "test",
    captureRpcCtx: { gate: rpcCtx.gate, ...(rpcCtx.act === undefined ? {} : { act: rpcCtx.act }) },
  };
  return {
    options,
    consentImpl: coordinator,
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: (id: string) => kinds[id] ?? "unknown",
  } as unknown as ServerCtx;
}

/** One request through the real table, as the named connection; the request log is the wire. */
async function rpc(clientId: string, method: string, params: unknown = {}): Promise<unknown> {
  ownerRequests.push({ clientId, method });
  return await tryDispatchPhase4Rpc(serverCtx(), method, params, clientId);
}

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    return (e as { rpcData?: { code?: string } }).rpcData?.code;
  }
  throw new Error("expected a rejection");
}

const COMMENT = {
  actionType: "jira.comment.add",
  input: { issueKey: "NIM-1", body: "hello" },
  summary: "comment on NIM-1",
};

async function propose(
  agent: string = AGENT_1,
  payload: Record<string, unknown> = COMMENT,
): Promise<string> {
  const out = (await rpc(agent, "capture.submit", {
    kind: "action",
    payload,
    clientLabel: "claude-code",
  })) as { id: string };
  return out.id;
}

const writes = (): PlannedAction[] => dispatched.filter((a) => !isBeforeReadActionType(a.type));

/** Between the `Type:` line and the proposer block, without the `Requested by:` line. */
function previewRegion(prompt: string): string {
  const afterType = prompt.slice(prompt.indexOf("Type: "));
  return afterType
    .split("\n\nProposed by an outside agent")[0]
    ?.split("\n")
    .filter((l) => !l.startsWith("Requested by: "))
    .join("\n") as string;
}

describe("A1: the same prompt the model door shows", () => {
  test("the verified preview region equals the model door's for the same input and reader reply; the proposer block is last", async () => {
    const id = await propose();
    const out = (await rpc(OWNER_A, "approvals.approve", { id })) as { state: string };
    expect(out.state).toBe("executed");
    expect(seen).toHaveLength(1);
    const agentPrompt = seen[0]?.prompt as string;

    // The model door, built from the same maker, the same canned reader reply, the same credential.
    const modelPrompts: string[] = [];
    const modelCoordinator: ConsentCoordinatorImpl = new ConsentCoordinatorImpl(
      () => (n: JsonRpcNotification) => {
        const p = n.params as Record<string, unknown>;
        modelPrompts.push(String(p["prompt"]));
        queueMicrotask(() =>
          modelCoordinator.handleRespond("m", {
            requestId: String(p["requestId"]),
            approved: true,
            answerSource: "human",
          }),
        );
      },
    );
    const audit: AuditSink = { recordAudit: () => {} };
    const model = buildModelWriteExecutor({
      clientId: "m",
      consentCoordinator: modelCoordinator,
      dispatcher: {
        dispatch: async (a: PlannedAction) =>
          isBeforeReadActionType(a.type) ? JIRA_REPLY : { url: "https://x" },
      },
      egressSink: NULL_EGRESS_SINK,
      policyHitl: NO_POLICY_OVERLAY,
      previewCredentialFor: () => "team" as const,
      getTribalKbConfig: () => undefined,
      localIndex: audit,
    });
    const res = await model.execute({
      type: COMMENT.actionType,
      origin: "model",
      payload: { mcpToolId: "jira_comment_add", input: COMMENT.input },
    });
    expect(res.status).toBe("ok");
    expect(previewRegion(agentPrompt)).toBe(previewRegion(modelPrompts[0] as string));
    expect(agentPrompt).toContain("Fix login");
    expect(agentPrompt).toContain("Requested by: an outside agent (unverified)");

    const lines = agentPrompt.split("\n");
    // The fixture's verdict basis is legacy_user_mcp (AD5a), so the block ends with the fixed
    // deprecation line: who and when, the agent's summary, then the warning.
    expect(lines.at(-3)).toStartWith(
      'Proposed by an outside agent (UNVERIFIED label "claude-code"',
    );
    expect(lines.at(-2)).toStartWith("Agent's summary (UNVERIFIED): ");
    expect(lines.at(-1)).toStartWith("Deprecated: ");
    // The prompt reached the OWNER's connection (the one that issued approvals.approve).
    expect(seen[0]?.clientId).toBe(OWNER_A);
  });

  test("a user-MCP type shows the input verbatim, escaped, on the owner's prompt", async () => {
    const RLO = String.fromCodePoint(0x202e);
    const id = await propose(AGENT_1, {
      actionType: "mcp_echo.echo",
      input: { text: `a${RLO}b` },
      summary: "echo",
    });
    await rpc(OWNER_A, "approvals.approve", { id });
    const prompt = seen[0]?.prompt as string;
    expect(prompt).toContain("Input (verbatim, exactly what will be sent):");
    expect(prompt).not.toContain(RLO);
  });
});

describe("A2: typed confirmation, on a synthetic Wave 4 row (the real `github.pr.merge` runs in agent-door-flow.test.ts)", () => {
  const READER = {
    tool: "slack_get",
    argKeys: ["channel"],
    args: (input: Record<string, unknown>) => ({ channel: input["channel"] }),
    select: () => [{ label: "Current", value: "the old topic" }],
  };
  const WAVE4 = withConfirm(
    withBefore(
      withPreview(makeRow("slack_message_post", "slack.message.post", "write", 4), {
        target: "{channel}",
        summary: "Post to {channel}",
        fields: [{ key: "text", label: "Text", kind: "text" }],
      }),
      READER,
    ),
    { template: "{channel}" },
  );
  const POST = {
    actionType: "slack.message.post",
    input: { channel: "C9999ZZZZ", text: "hi" },
    summary: "tell them",
  };
  const TEXT = "slack/C9999ZZZZ";

  beforeEach(() => {
    rows = [WAVE4];
    rpcCtx = { gate: gateDeps(), act: actWiring() };
  });

  async function approveWith(a: (r: SeenRequest) => OwnerAnswer) {
    answer = a;
    const id = await propose(AGENT_1, POST);
    const out = (await rpc(OWNER_A, "approvals.approve", { id })) as {
      state: string;
      reason?: string;
    };
    return { id, out };
  }

  test("the owner is asked only for the typed text; the prompt carries the before-state and the proposer block", async () => {
    const { out } = await approveWith((r) => ({
      approved: true,
      typed: r.confirmText as string,
      answerSource: "human",
    }));
    expect(out.state).toBe("executed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.confirmText).toBe(TEXT);
    expect(seen[0]?.prompt).toContain("the old topic");
    expect(seen[0]?.prompt).toContain("Proposed by an outside agent (UNVERIFIED");
    expect(seen[0]?.prompt.split("\n").at(-1)).toBe(`To approve, type exactly: ${TEXT}`);
    expect(writes()).toHaveLength(1);
  });

  test.each([
    ["an empty answer", () => ""],
    ["a wrong-case answer", () => TEXT.toUpperCase()],
    ["a trimmed-away answer (spaces around the text)", () => ` ${TEXT} `],
    // The echo is cut to the longest answer the wire accepts (512): with the legacy fixture's
    // deprecation line the whole prompt is longer, and `consent.respond` would refuse it.
    ["an echo of the prompt", (r: SeenRequest) => r.prompt.slice(0, 512)],
    ["a different channel", () => "slack/C1"],
  ])("%s is denied and nothing is dispatched", async (_n, typed) => {
    const { out } = await approveWith((r) => ({
      approved: true,
      typed: typed(r),
      answerSource: "human",
    }));
    expect(out.state).toBe("rejected");
    expect(writes()).toEqual([]);
    expect(store.get(`cap_${"1".padStart(32, "0")}`)?.state).toBe("rejected");
  });

  test.each(["auto", "script"] as const)(
    "the exact text from a %s answer (--yes-shaped) is still denied",
    async (source) => {
      const { out } = await approveWith((r) => ({
        approved: true,
        typed: r.confirmText as string,
        answerSource: source,
      }));
      expect(out.state).toBe("rejected");
      expect(out.reason).toContain("did not come from a person");
      expect(writes()).toEqual([]);
    },
  );

  test("an unreadable before-state is refused before any prompt, with the fixed refusal", async () => {
    beforeReply = () => {
      throw new Error("reader exploded");
    };
    const { out } = await approveWith(() => ({ approved: true, answerSource: "human" }));
    expect(out.state).toBe("rejected");
    expect(out.reason).toBe(WAVE4_BEFORE_REFUSAL);
    expect(seen).toEqual([]);
    expect(writes()).toEqual([]);
  });
});

describe("A3: one owner action", () => {
  test("between the agent's submit and the dispatch the owner issues exactly one request and answers one prompt", async () => {
    const id = await propose();
    expect(store.get(id)?.state).toBe("proposed");
    const before = ownerRequests.filter((r) => r.clientId === OWNER_A).length;
    await rpc(OWNER_A, "approvals.approve", { id });
    const ownerLog = ownerRequests.filter((r) => r.clientId === OWNER_A);
    expect(ownerLog.length - before).toBe(1);
    expect(ownerLog.map((r) => r.method)).toEqual(["approvals.approve"]);
    expect(ownerRequests.some((r) => r.method === "captures.accept")).toBe(false);
    expect(seen).toHaveLength(1);
    expect(writes()).toHaveLength(1);
    // proposed -> executing (at the dispatch) -> executed
    expect(writeStateSeen).toEqual(["executing"]);
    expect(store.get(id)?.state).toBe("executed");
  });

  test("approvals.decline leaves no dispatch and no prompt", async () => {
    const id = await propose();
    expect(await rpc(OWNER_A, "approvals.decline", { id })).toEqual({ id, state: "rejected" });
    expect(dispatched).toEqual([]);
    expect(seen).toEqual([]);
    expect(store.get(id)?.state).toBe("rejected");
  });

  test("the queue lists what waits, escaped, oldest first, and a decided row leaves it", async () => {
    const a = await propose();
    clock += 10;
    const b = await propose(AGENT_2);
    const list = (await rpc(OWNER_A, "approvals.list")) as { proposals: Array<{ id: string }> };
    expect(list.proposals.map((p) => p.id)).toEqual([a, b]);
    await rpc(OWNER_A, "approvals.decline", { id: a });
    const after = (await rpc(OWNER_B, "approvals.list")) as { proposals: Array<{ id: string }> };
    expect(after.proposals.map((p) => p.id)).toEqual([b]);
  });
});

describe("A4: no model", () => {
  test("the whole flow ran with no router; the approvals modules import nothing from llm/", () => {
    const here = import.meta.dir;
    const gateway = readFileSync(join(here, "../../../src/ipc/approvals-rpc.ts"), "utf8");
    const cli = readFileSync(join(here, "../../../../cli/src/commands/approvals.ts"), "utf8");
    for (const src of [gateway, cli]) {
      expect(src).not.toMatch(/from ["'][^"']*\/llm\//);
    }
    // Stated: a DIRECT-import pin. The behavioural proof is this file (no model wiring anywhere).
  });
});

describe("who may use the queue, and who can see a capture", () => {
  test.each(["unk", "web", "chat", AGENT_1])(
    "%s is refused on all four approvals methods",
    async (client) => {
      const id = await propose(AGENT_2);
      for (const m of APPROVALS_METHODS) {
        expect(await code(rpc(client, m, { id })), `${client} ${m}`).toBe(
          "ERR_CAPTURE_FORBIDDEN_CLIENT",
        );
      }
      expect(store.get(id)?.state).toBe("proposed");
      expect(dispatched).toEqual([]);
    },
  );

  test("capture.state and capture.mine answer the submitting connection only", async () => {
    const id = await propose(AGENT_1);
    expect(await rpc(AGENT_1, "capture.state", { id })).toMatchObject({
      state: "proposed",
      kind: "action",
    });
    const mine = (await rpc(AGENT_1, "capture.mine")) as { captures: Array<{ id: string }> };
    expect(mine.captures.map((c) => c.id)).toEqual([id]);

    // Another agent connection cannot tell this id from an absent one.
    const other = await rpc(AGENT_2, "capture.mine");
    expect(other).toEqual({ captures: [] });
    let foreign = "";
    let absent = "";
    try {
      await rpc(AGENT_2, "capture.state", { id });
    } catch (e) {
      foreign = (e as Error).message;
    }
    try {
      await rpc(AGENT_2, "capture.state", { id: "cap_00000000000000000000000000000000" });
    } catch (e) {
      absent = (e as Error).message;
    }
    expect(foreign).not.toBe("");
    expect(foreign.replace(id, "ID")).toBe(
      absent.replace("cap_00000000000000000000000000000000", "ID"),
    );
  });

  test("one connection holds at most 3 proposed actions; another can still propose; a decided one frees a slot", async () => {
    const ids = [await propose(), await propose(), await propose()];
    expect(await code(propose())).toBe("ERR_CAPTURE_QUEUE_FULL");
    expect(await propose(AGENT_2)).toMatch(/^cap_/);
    await rpc(OWNER_A, "approvals.decline", { id: ids[0] as string });
    expect(await propose()).toMatch(/^cap_/);
  });

  test("two owners approving the same id: the second is ERR_CAPTURE_STATE and the action runs once", async () => {
    const id = await propose();
    answer = () => "hold";
    const first = rpc(OWNER_A, "approvals.approve", { id });
    // Let the first reach its prompt (the row is claimed, `executing`).
    while (held.length === 0) await new Promise((r) => setTimeout(r, 1));
    expect(await code(rpc(OWNER_B, "approvals.approve", { id }))).toBe("ERR_CAPTURE_STATE");
    const req = held[0] as SeenRequest;
    coordinator.handleRespond(OWNER_A, {
      requestId: req.requestId,
      approved: true,
      answerSource: "human",
    });
    expect(await first).toMatchObject({ id, state: "executed" });
    expect(writes()).toHaveLength(1);
    // And after it finished, a third approval is refused too.
    expect(await code(rpc(OWNER_B, "approvals.approve", { id }))).toBe("ERR_CAPTURE_STATE");
  });

  test("captures.* still serves an undeclared connection, including accepting an action (D-AD-16, unchanged)", async () => {
    const id = await propose();
    const listed = (await rpc("unk", "captures.list", { kind: "action" })) as {
      captures: Array<{ id: string }>;
    };
    expect(listed.captures.map((c) => c.id)).toEqual([id]);
    // The gateway's captures.accept is not human-only (correction 3, a stated bound): an answer that
    // reports no source (an older client, the sandboxed user-MCP e2e) still approves it. The CLI
    // alias and approvals.approve are the human-only paths.
    answer = () => ({ approved: true });
    expect(((await rpc("unk", "captures.accept", { id })) as { state: string }).state).toBe(
      "executed",
    );
    const id2 = await propose();
    const viaApprovals = (await rpc(OWNER_A, "approvals.approve", { id: id2 })) as {
      state: string;
    };
    expect(viaApprovals.state).toBe("rejected");
  });
});

describe("the sink off", () => {
  test("approve is ERR_CAPTURE_DISABLED and decline still drains the queue", async () => {
    const id = await propose();
    sinkConfig = "off";
    expect(await code(rpc(OWNER_A, "approvals.approve", { id }))).toBe("ERR_CAPTURE_DISABLED");
    expect(dispatched).toEqual([]);
    expect(seen).toEqual([]);
    expect(await rpc(OWNER_A, "approvals.decline", { id })).toEqual({ id, state: "rejected" });
  });
});
