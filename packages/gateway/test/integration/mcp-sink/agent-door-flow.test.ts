/**
 * Agent door AD3a-2a (invariant I58), end to end: the owner's per-door approval list decides what an
 * outside agent can propose, with a one-release deprecation window for what the earlier door accepted.
 *
 * Everything between the agent's `capture.submit` and the connector call is the PRODUCTION chain: the
 * real dispatch entry (`tryDispatchPhase4Rpc`), the real capture gate and store over migrated SQLite,
 * the real agent door (`createAgentDoor`, injected exactly as `platform/assemble.ts` injects it), a real
 * `ConsentCoordinatorImpl` whose "owner connection" answers `consent.request` notifications, a real
 * `ToolExecutor` (via `buildActDeps`), the real egress ledger and audit chain. Only the connector side
 * is fake: a mesh listing and a dispatcher. No model, no router, no embedding runtime.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { toStandardSchema } from "@mastra/core/schema";

import { DEFAULT_MCP_SINK_CONFIG } from "../../../src/config/mcp-sink-toml.ts";
import {
  AGENT_DOOR_MAIL_SEND_TOOL_IDS,
  agentDoorRow,
} from "../../../src/connectors/connector-writes/agent-door.ts";
import {
  LEGACY_LIST_HEADER,
  legacyNoticeFor,
} from "../../../src/connectors/connector-writes/agent-door-legacy.ts";
import { createAgentDoor } from "../../../src/connectors/connector-writes/agent-door-runtime.ts";
import { definitionSha256 } from "../../../src/connectors/connector-writes/definition-hash.ts";
import {
  getDoorApproval,
  upsertDoorApprovals,
} from "../../../src/connectors/connector-writes/door-approval-store.ts";
import {
  raiseWriteEnablementWave,
  setModelWriteEnablement,
} from "../../../src/connectors/connector-writes/enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "../../../src/connectors/connector-writes/index.ts";
import { MODEL_NEVER_OFFERED_TOOL_IDS } from "../../../src/connectors/connector-writes/model-offerable.ts";
import { previewTemplateKeys } from "../../../src/connectors/connector-writes/types.ts";
import { mcpClientToolKey } from "../../../src/connectors/lazy-mesh/tool-map.ts";
import {
  classifyActionType,
  PROPOSABLE_WRITE_TOOLS,
} from "../../../src/connectors/proposable-actions.ts";
import { appendAuditEntry } from "../../../src/db/audit-chain.ts";
import { makeEgressSink } from "../../../src/egress/egress-ledger.ts";
import { isBeforeReadActionType } from "../../../src/engine/before-state.ts";
import { NO_POLICY_OVERLAY } from "../../../src/engine/executor.ts";
import { isPrepareActionType } from "../../../src/engine/prepare-step.ts";
import { serviceOf } from "../../../src/engine/service-of.ts";
import type { AnswerSource, PlannedAction } from "../../../src/engine/types.ts";
import { openMigratedMemoryDb } from "../../../src/index/migrated-db-template.ts";
import type { CaptureActWiring, CaptureRpcCtx } from "../../../src/ipc/capture-rpc.ts";
import { ConsentCoordinatorImpl } from "../../../src/ipc/consent.ts";
import { createStreamRegistry } from "../../../src/ipc/engine-ask-stream.ts";
import type { JsonRpcNotification } from "../../../src/ipc/jsonrpc.ts";
import { createActionDestinationRefusal } from "../../../src/ipc/legacy-refusal.test-helpers.ts";
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

type JsonSchemaInput = Parameters<typeof toStandardSchema>[0];

const OWNER = "owner";
const OWNER_UI = "owner-ui";
const AGENT = "agent";
const UNDECLARED = "undeclared";
const HEAD = "0123456789abcdef0123456789abcdef01234567";
const NOT_PROPOSABLE = "ERR_CAPTURE_ACTION_NOT_PROPOSABLE";
const SUSPENDED = "ERR_AGENT_TOOL_SUSPENDED";

const PR_REPLY = {
  title: "Add the thing",
  state: "open",
  head: { ref: "feat/x", sha: HEAD },
  base: { ref: "main" },
  user: { login: "octo" },
};
const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

interface Seen {
  readonly clientId: string;
  readonly requestId: string;
  readonly prompt: string;
  readonly confirmText: string | undefined;
}
interface Answer {
  readonly approved: boolean;
  readonly typed?: string;
  readonly answerSource?: AnswerSource;
}

let db: Database;
let store: CaptureStore;
let coordinator: ConsentCoordinatorImpl;
let clock: number;
let seq: number;
let dispatched: PlannedAction[];
let seen: Seen[];
let listCalls: string[];
let describeTool: (toolId: string) => string;
let disabledCaps: Set<string>;
let answer: (req: Seen) => Answer;
let beforeFails: boolean;
let rpcCtx: CaptureRpcCtx;
const kinds: Record<string, ClientKind> = {
  [OWNER]: "cli",
  [OWNER_UI]: "ui",
  [AGENT]: "mcp",
  [UNDECLARED]: "unknown",
};

/** Every write row of `service`, as a connector would list it, plus the tools its rows read or prepare with. */
function listing(service: string): Record<string, unknown> {
  const schema = (keys: readonly string[]) =>
    toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, { type: "string" }])),
    } as JsonSchemaInput);
  const out: Record<string, unknown> = {};
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (serviceOf(r.actionType) !== service) continue;
    const keys = r.preview === undefined ? [] : [...previewTemplateKeys(r.preview)];
    out[mcpClientToolKey(service, r.toolId)] = {
      description: describeTool(r.toolId),
      inputSchema: schema(keys),
    };
    for (const t of [
      r.before?.tool,
      r.before?.also?.tool,
      r.bound?.prepare.tool,
      r.bound?.prepare.settleTool,
    ]) {
      if (t !== undefined) {
        out[mcpClientToolKey(service, t)] ??= { description: `read ${t}`, inputSchema: schema([]) };
      }
    }
  }
  return out;
}

const enforced = () =>
  ({
    capabilitiesDisabled: disabledCaps,
    chatops: { channels: new Map(), ownership: new Map() },
  }) as never;

function door() {
  return createAgentDoor({
    db,
    enforcedPolicy: enforced,
    listServerTools: async (service) => {
      listCalls.push(service);
      return listing(service);
    },
    tribalKbConfig: () => undefined,
    classifyContext: {
      userMcpModelAccessAllowed: () => false,
      modelAccessServices: () => new Set<string>(),
    },
    isServiceConfigured: async () => true,
    now: () => clock,
  });
}

function gateDeps(d: ReturnType<typeof door>): CaptureGateDeps {
  return {
    db,
    store,
    capability: () =>
      resolveCaptureCapability(
        {
          ok: true,
          config: {
            ...DEFAULT_MCP_SINK_CONFIG,
            enabled: true,
            kinds: ["note", "action"],
            maxPerHour: 1000,
          },
        },
        enforced(),
      ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => clock,
    classifyAction: d.verdict,
    isServiceConfigured: () => Promise.resolve(true),
    listProposableActionTypes: d.acceptedTypes,
    actionDestinationRefusal: d.refusal,
    verifyActionDefinition: d.verifyDefinition,
  };
}

function actWiring(d: ReturnType<typeof door>): CaptureActWiring {
  return {
    dispatcher: {
      dispatch: (a) => {
        dispatched.push(a);
        if (isBeforeReadActionType(a.type)) {
          if (beforeFails) return Promise.reject(new Error("reader exploded"));
          return Promise.resolve(PR_REPLY);
        }
        if (isPrepareActionType(a.type)) {
          return Promise.resolve(
            mcp({
              headSha: HEAD,
              files: [{ path: "src/a.ts", exists: true, mode: "100644", oldContent: "old\n" }],
            }),
          );
        }
        return Promise.resolve({ url: "https://example.test/x" });
      },
    },
    egressSink: makeEgressSink(db),
    audit: { recordAudit: (e) => appendAuditEntry(db, e) },
    policyHitl: NO_POLICY_OVERLAY,
    getTribalKbConfig: () => undefined,
    previewCredentialFor: () => "team",
    agentDoor: {
      listServerTools: async (service) => {
        listCalls.push(service);
        return listing(service);
      },
      verifyDefinition: d.verifyDefinition,
    },
  };
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  store = new CaptureStore(db);
  clock = 1_000;
  seq = 0;
  dispatched = [];
  seen = [];
  listCalls = [];
  describeTool = (t) => `d ${t}`;
  disabledCaps = new Set<string>();
  beforeFails = false;
  answer = (r) => ({
    approved: true,
    ...(r.confirmText === undefined ? {} : { typed: r.confirmText }),
    answerSource: "human",
  });
  coordinator = new ConsentCoordinatorImpl((clientId) => (n: JsonRpcNotification) => {
    const p = n.params as Record<string, unknown>;
    const req: Seen = {
      clientId,
      requestId: String(p["requestId"]),
      prompt: String(p["prompt"]),
      confirmText: typeof p["confirmText"] === "string" ? p["confirmText"] : undefined,
    };
    seen.push(req);
    const a = answer(req);
    queueMicrotask(() => {
      coordinator.handleRespond(clientId, {
        requestId: req.requestId,
        approved: a.approved,
        ...(a.typed === undefined ? {} : { typed: a.typed }),
        ...(a.answerSource === undefined ? {} : { answerSource: a.answerSource }),
      });
    });
  });
  const d = door();
  rpcCtx = {
    gate: gateDeps(d),
    act: actWiring(d),
    describe: { limiter: new CaptureAttemptLimiter(), actions: d.describe },
  };
});
afterEach(() => db.close());

function serverCtx(): ServerCtx {
  const options: CreateIpcServerOptions = {
    listenPath: "",
    vault: createMockVault(),
    version: "test",
    captureRpcCtx: {
      gate: rpcCtx.gate,
      ...(rpcCtx.act === undefined ? {} : { act: rpcCtx.act }),
      ...(rpcCtx.describe === undefined ? {} : { describe: rpcCtx.describe }),
    },
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

const rpc = (client: string, method: string, params: unknown = {}): Promise<unknown> =>
  tryDispatchPhase4Rpc(serverCtx(), method, params, client);

async function code(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (e) {
    const err = e as { rpcData?: { code?: string }; message?: string };
    return err.rpcData?.code ?? err.message;
  }
  throw new Error("expected a rejection");
}

interface Submitted {
  readonly id: string;
  readonly state: string;
  readonly legacy?: boolean;
  readonly deprecation?: string;
}
/** Inputs the structural scans of the destination refusal accept (an empty input fails closed). */
const INPUT_OVERRIDES: Record<string, Record<string, unknown>> = {
  "outlook.calendar.create": {
    startDateTime: "2026-01-01T10:00:00",
    endDateTime: "2026-01-01T11:00:00",
    timeZone: "UTC",
    attendees: ["a@b.c"],
  },
  "apple.calendar.event.create": {
    start: "20260101T100000Z",
    end: "20260101T110000Z",
    attendees: ["a@b.c"],
  },
  "gitlab.issue.labels.add": { labels: ["bug"] },
  "gitlab.issue.create": { labels: ["bug"], assigneeIds: [1] },
  "notion.page.update": { propertiesJson: "{}" },
  "notion.block.append": { childrenJson: "[]" },
};
function inputFor(actionType: string): Record<string, unknown> {
  const row = agentDoorRow(actionType);
  const keys = row?.preview === undefined ? [] : [...previewTemplateKeys(row.preview)];
  const input: Record<string, unknown> = Object.fromEntries(keys.map((k) => [k, "plain"]));
  for (const [k, v] of Object.entries(INPUT_OVERRIDES[actionType] ?? {})) input[k] = v;
  if (actionType === "linear.issue.update") delete input["assigneeId"];
  return input;
}
const submit = (
  actionType: string,
  input: Record<string, unknown> = inputFor(actionType),
): Promise<Submitted> =>
  rpc(AGENT, "capture.submit", {
    kind: "action",
    payload: { actionType, input, summary: "why" },
    clientLabel: "claude-code",
  }) as Promise<Submitted>;

interface Approved {
  readonly state: string;
  readonly reason?: string;
  readonly errorCode?: string;
}
const approve = (id: string): Promise<Approved> =>
  rpc(OWNER, "approvals.approve", { id }) as Promise<Approved>;
const decline = (id: string) => rpc(OWNER, "approvals.decline", { id });

const writes = (): PlannedAction[] =>
  dispatched.filter((a) => !isBeforeReadActionType(a.type) && !isPrepareActionType(a.type));

/** The owner approves `toolIds` of `service` for agents, at `wave`, at the CURRENT listing's hashes. */
function approveForAgents(service: string, wave: 2 | 3 | 4, toolIds: readonly string[]): void {
  raiseWriteEnablementWave(db, service, wave, clock);
  const l = listing(service);
  upsertDoorApprovals(
    db,
    "agent",
    service,
    toolIds.map((toolId) => ({
      toolId,
      definitionSha256: definitionSha256(toolId, l[mcpClientToolKey(service, toolId)]) as string,
    })),
    clock,
  );
}

const auditStatuses = (type: string): string[] =>
  (
    db.query("SELECT hitl_status FROM audit_log WHERE action_type = ? ORDER BY id").all(type) as {
      hitl_status: string;
    }[]
  ).map((r) => r.hitl_status);
const suspendAuditCount = (): number =>
  (
    db
      .query(
        "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'connector.writes.agent.suspend'",
      )
      .get() as { n: number }
  ).n;

const LEGACY_TYPES = Object.keys(PROPOSABLE_WRITE_TOOLS);
const MAIL_SEND_TYPES = CONNECTOR_WRITE_ROWS.filter((r) =>
  AGENT_DOOR_MAIL_SEND_TOOL_IDS.has(r.toolId),
).map((r) => r.actionType);

describe("the window: with an empty door table every earlier use still works, warned", () => {
  test("the legacy table is the 47 types the earlier door accepted", () => {
    expect(LEGACY_TYPES).toHaveLength(47);
    expect(MAIL_SEND_TYPES).toHaveLength(7);
    for (const t of MAIL_SEND_TYPES) expect(LEGACY_TYPES).toContain(t);
  });

  test("each of the 47 types is accepted, stored legacy, warned, listed with the header, declined without a listing call", async () => {
    for (const type of LEGACY_TYPES) {
      const out = await submit(type);
      expect(out.state, type).toBe("proposed");
      expect(out.legacy, type).toBe(true);
      expect(out.deprecation, type).toBe(legacyNoticeFor(type));
      const stored = db.query("SELECT legacy FROM capture WHERE id = ?").get(out.id) as {
        legacy: number;
      };
      expect(stored.legacy, type).toBe(1);
      await decline(out.id);
    }
    // No listing: a legacy proposal makes no connector read at submit.
    expect(listCalls).toEqual([]);
  });

  test("the seven mail sends carry the mail-send warning, the others the unapproved-type one", () => {
    for (const type of LEGACY_TYPES) {
      const mail = MAIL_SEND_TYPES.includes(type);
      expect(legacyNoticeFor(type).includes("mail sends"), type).toBe(mail);
    }
  });

  test("the list view carries the deprecation header and a per-proposal flag, only while a legacy proposal waits", async () => {
    const approved = (await rpc(OWNER, "approvals.list")) as { deprecation?: string };
    expect(approved.deprecation).toBeUndefined();
    const out = await submit("github.issue.create");
    const list = (await rpc(OWNER, "approvals.list")) as {
      deprecation?: string;
      proposals: Array<{ id: string; legacy?: boolean }>;
    };
    expect(list.deprecation).toBe(LEGACY_LIST_HEADER);
    expect(list.proposals.find((p) => p.id === out.id)?.legacy).toBe(true);
  });

  test("a legacy proposal is approved through the same prompt, carrying the warning, and dispatched once", async () => {
    const out = await submit("github.issue.create", { owner: "o", repo: "r", title: "t" });
    const res = await approve(out.id);
    expect(res.state).toBe("executed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.clientId).toBe(OWNER);
    expect(seen[0]?.prompt).toContain(legacyNoticeFor("github.issue.create"));
    expect(writes()).toHaveLength(1);
    expect(listCalls).toEqual([]);
  });

  test("the refusals of the earlier door are byte-equal on a legacy basis", () => {
    const earlier = createActionDestinationRefusal(
      () =>
        ({
          capabilitiesDisabled: new Set<string>(),
          chatops: { channels: new Map(), ownership: new Map() },
        }) as never,
      () => undefined,
    );
    const d = door();
    const cases: Array<[string, Record<string, unknown>]> = [
      ["github.issue.comment.create", { body: "hi <!here>" }],
      ["gitlab.issue.note.create", { body: "/close" }],
      ["gitlab.issue.labels.add", { labels: ["a::b"] }],
      ["slack.message.post", { channel: "C1", text: "<!channel> hi" }],
      ["linear.issue.update", { assigneeId: "u1" }],
      ["github.issue.create", { title: "plain" }],
      ["gmail.draft.create", { to: "a@b.c" }],
    ];
    for (const [type, input] of cases) {
      expect(d.refusal(type, input, "legacy_unapproved"), type).toBe(earlier(type, input));
    }
    // At least one case really is a refusal, or the comparison proves nothing.
    expect(
      cases.some(([t, i]) => earlier(t, i) !== undefined),
      "the fixture refuses nothing",
    ).toBe(true);
  });
});

describe("opt-in: approved by name, on the shared wave, with an unchanged definition", () => {
  test("github.pr.merge is refused without the enable, at wave 3, and enabled-but-unapproved; accepted once approved, with no warning", async () => {
    expect(await code(submit("github.pr.merge"))).toBe(NOT_PROPOSABLE);
    approveForAgents("github", 3, ["github_pr_close"]);
    expect(await code(submit("github.pr.merge"))).toBe(NOT_PROPOSABLE);
    approveForAgents("github", 4, ["github_pr_close"]);
    expect(await code(submit("github.pr.merge"))).toBe(NOT_PROPOSABLE);
    approveForAgents("github", 4, ["github_pr_merge"]);
    const out = await submit("github.pr.merge", {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      sha: HEAD,
    });
    expect(out.state).toBe("proposed");
    expect(out).not.toHaveProperty("legacy");
    expect(out).not.toHaveProperty("deprecation");
    expect(listCalls).toContain("github");
  });

  test("a type not approved and not one of the 47 is never accepted: Wave 4 with no approval, a never-offered row, a bound row", async () => {
    expect(LEGACY_TYPES).not.toContain("github.pr.merge");
    expect(await code(submit("github.pr.merge"))).toBe(NOT_PROPOSABLE);
    expect(await code(submit("github.file.commit"))).toBe(NOT_PROPOSABLE);
    const neverOffered = CONNECTOR_WRITE_ROWS.find(
      (r) =>
        MODEL_NEVER_OFFERED_TOOL_IDS.has(r.toolId) && !AGENT_DOOR_MAIL_SEND_TOOL_IDS.has(r.toolId),
    );
    expect(neverOffered).toBeDefined();
    expect(await code(submit((neverOffered as { actionType: string }).actionType))).toBe(
      NOT_PROPOSABLE,
    );
  });

  test("a suspended tool of one of the 47 types is refused, not accepted as legacy", async () => {
    approveForAgents("github", 2, ["github_issue_create"]);
    describeTool = (t) => (t === "github_issue_create" ? "changed" : `d ${t}`);
    expect(await code(submit("github.issue.create"))).toBe(SUSPENDED);
    // The sibling that was never approved is still a legacy case.
    expect((await submit("github.issue.comment.create")).legacy).toBe(true);
  });

  test("a bound Terraform apply with no approved directory is refused at submit", async () => {
    approveForAgents("iac", 4, ["iac_terraform_apply"]);
    expect(await code(submit("iac.terraform.apply", { workdir: "/x" }))).toBe(NOT_PROPOSABLE);
  });
});

describe("A2 on a real Wave 4 type: github.pr.merge asks for the typed text", () => {
  const INPUT = { owner: "o", repo: "r", pullNumber: 1, sha: HEAD };
  beforeEach(() => approveForAgents("github", 4, ["github_pr_merge"]));

  async function approveWith(a: (r: Seen) => Answer) {
    answer = a;
    const { id } = await submit("github.pr.merge", INPUT);
    return { id, out: await approve(id) };
  }

  test("only the exact text approves; the prompt carries the before-state and the proposer block", async () => {
    const { out } = await approveWith((r) => ({
      approved: true,
      typed: r.confirmText as string,
      answerSource: "human",
    }));
    expect(out.state).toBe("executed");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.confirmText).toBe("github/merge o/r#1");
    expect(seen[0]?.prompt).toContain("Add the thing");
    expect(seen[0]?.prompt).toContain("Proposed by an outside agent (UNVERIFIED");
    expect(seen[0]?.prompt).not.toContain(legacyNoticeFor("github.pr.merge"));
    expect(seen[0]?.clientId).toBe(OWNER);
    expect(writes()).toHaveLength(1);
  });

  test.each([
    ["an empty answer", () => ""],
    ["a wrong-case answer", () => "GITHUB/MERGE O/R#1"],
    ["a trimmed-away answer (spaces around the text)", () => " github/merge o/r#1 "],
    ["an echo of the prompt", (r: Seen) => r.prompt.slice(0, 400)],
    ["another pull request", () => "github/merge o/r#2"],
  ])("%s is denied and nothing is dispatched", async (_n, typed) => {
    const { out } = await approveWith((r) => ({
      approved: true,
      typed: typed(r),
      answerSource: "human",
    }));
    expect(out.state).toBe("rejected");
    expect(writes()).toEqual([]);
  });

  test.each(["auto", "script"] as const)(
    "the exact text from a %s answer is still denied",
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

  test("an unreadable before-state is refused before any prompt", async () => {
    beforeFails = true;
    const { out } = await approveWith(() => ({ approved: true, answerSource: "human" }));
    expect(out.state).toBe("rejected");
    expect(seen).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("a head that is not the one the agent named is refused by the row's guard before any prompt", async () => {
    answer = () => ({ approved: true, answerSource: "human" });
    const { id } = await submit("github.pr.merge", { ...INPUT, sha: "f".repeat(40) });
    const out = await approve(id);
    expect(out.state).toBe("rejected");
    expect(seen).toEqual([]);
    expect(writes()).toEqual([]);
  });
});

describe("bound rows: github.file.commit with its prepare step", () => {
  const BODY = "line of new text\n".repeat(1_800);
  const INPUT = {
    owner: "acme",
    repo: "api",
    branch: "feat/x",
    message: "Update a",
    files: [{ path: "src/a.ts", content: BODY }],
  };
  beforeEach(() => approveForAgents("github", 4, ["github_file_commit"]));

  test("accepted, the prompt carries the gateway-rendered diff, the head is injected, the typed text is the commit's", async () => {
    const { id, state } = await submit("github.file.commit", INPUT);
    expect(state).toBe("proposed");
    const out = await approve(id);
    expect(out.state).toBe("executed");
    expect(seen[0]?.confirmText).toBe("github/commit acme/api@feat/x");
    expect(seen[0]?.prompt).toContain("+line of new text");
    expect(seen[0]?.prompt).toContain("-old");
    const order = dispatched.map((a) => (isPrepareActionType(a.type) ? "prepare" : a.type));
    expect(order.indexOf("prepare")).toBeGreaterThanOrEqual(0);
    expect(order.indexOf("prepare")).toBeLessThan(order.indexOf("github.file.commit"));
    const write = writes()[0] as PlannedAction;
    expect((write.payload as { input: Record<string, unknown> }).input["expectedHeadSha"]).toBe(
      HEAD,
    );
  });

  test("a caller-supplied bound field is refused before any read or prompt", async () => {
    const { id } = await submit("github.file.commit", { ...INPUT, expectedHeadSha: HEAD });
    const out = await approve(id);
    expect(out.state).toBe("rejected");
    expect(dispatched.filter((a) => isPrepareActionType(a.type))).toEqual([]);
    expect(seen).toEqual([]);
    expect(writes()).toEqual([]);
  });
});

describe("suspension: a changed definition stops the tool at all three points", () => {
  beforeEach(() => approveForAgents("github", 2, ["github_issue_create"]));
  const INPUT = { owner: "o", repo: "r", title: "t" };

  test("refused at submit, and stays refused after the definition changes back; a re-approval by name clears it", async () => {
    describeTool = (t) => (t === "github_issue_create" ? "changed" : `d ${t}`);
    expect(await code(submit("github.issue.create", INPUT))).toBe(SUSPENDED);
    expect(
      getDoorApproval(db, "agent", "github", "github_issue_create")?.suspendedAt,
    ).not.toBeNull();
    describeTool = (t) => `d ${t}`;
    expect(await code(submit("github.issue.create", INPUT))).toBe(SUSPENDED);
    approveForAgents("github", 2, ["github_issue_create"]);
    expect((await submit("github.issue.create", INPUT)).state).toBe("proposed");
  });

  test("changed after submit: refused at approval with the stored row still proposed", async () => {
    const { id } = await submit("github.issue.create", INPUT);
    describeTool = (t) => (t === "github_issue_create" ? "changed" : `d ${t}`);
    expect(await code(approve(id))).toBe(SUSPENDED);
    expect(store.get(id)?.state).toBe("proposed");
    expect(seen).toEqual([]);
    expect(writes()).toEqual([]);
  });

  test("changed while the prompt is open: vetoed after the answer, audited rejected, ledgered blocked, marked once, nothing dispatched", async () => {
    const { id } = await submit("github.issue.create", INPUT);
    answer = (r) => {
      describeTool = (t) => (t === "github_issue_create" ? "changed under you" : `d ${t}`);
      return {
        approved: true,
        ...(r.confirmText === undefined ? {} : { typed: r.confirmText }),
        answerSource: "human",
      };
    };
    const out = await approve(id);
    expect(out.state).toBe("rejected");
    expect(out.errorCode).toBe(SUSPENDED);
    expect(writes()).toEqual([]);
    expect(auditStatuses("github.issue.create")).toEqual(["rejected"]);
    const ledger = db
      .query("SELECT result_status FROM egress_ledger WHERE method = 'github.issue.create'")
      .all() as { result_status: string }[];
    expect(ledger.map((r) => r.result_status)).toEqual(["blocked"]);
    expect(
      getDoorApproval(db, "agent", "github", "github_issue_create")?.suspendedAt,
    ).not.toBeNull();
    expect(suspendAuditCount()).toBe(1);
    const state = (await rpc(AGENT, "capture.state", { id })) as {
      state: string;
      errorCode?: string;
    };
    expect(state).toMatchObject({ state: "rejected", errorCode: SUSPENDED });
  });

  test("a tool the listing omits is refused while missing, with no mark and no audit row, and works when it returns", async () => {
    const real = listing;
    const { id } = await submit("github.issue.create", INPUT);
    const original = rpcCtx.act as CaptureActWiring;
    expect(original.agentDoor).toBeDefined();
    describeTool = (t) => `d ${t}`;
    // A door whose listing omits the tool.
    const omitting = createAgentDoor({
      db,
      enforcedPolicy: enforced,
      listServerTools: async (service) => {
        const l = real(service);
        delete l[mcpClientToolKey(service, "github_issue_create")];
        return l;
      },
      tribalKbConfig: () => undefined,
      classifyContext: {
        userMcpModelAccessAllowed: () => false,
        modelAccessServices: () => new Set<string>(),
      },
      isServiceConfigured: async () => true,
      now: () => clock,
    });
    const res = await omitting.verifyDefinition("github.issue.create");
    expect(res.ok).toBe(false);
    expect(getDoorApproval(db, "agent", "github", "github_issue_create")?.suspendedAt).toBeNull();
    expect(suspendAuditCount()).toBe(0);
    expect((await approve(id)).state).toBe("executed");
  });
});

describe("policy: both capabilities for an approved type, mcp_action alone for the window", () => {
  test("connector_write_model_access off refuses an approved Wave 4 type and still accepts one of the 47 as legacy", async () => {
    approveForAgents("github", 4, ["github_pr_merge", "github_issue_create"]);
    disabledCaps = new Set(["connector_write_model_access"]);
    expect(await code(submit("github.pr.merge"))).toBe(NOT_PROPOSABLE);
    const out = await submit("github.issue.create");
    expect(out.legacy).toBe(true);
  });

  test("mcp_action off refuses everything", async () => {
    approveForAgents("github", 4, ["github_pr_merge"]);
    disabledCaps = new Set(["mcp_action"]);
    expect(await code(submit("github.pr.merge"))).toBeDefined();
    expect(await code(submit("github.issue.create"))).toBeDefined();
    expect(store.listBySession(AGENT, 10)).toEqual([]);
  });

  test("a lockoff that lands between submit and approval stops the approval", async () => {
    approveForAgents("github", 4, ["github_pr_merge"]);
    const { id } = await submit("github.pr.merge", {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      sha: HEAD,
    });
    disabledCaps = new Set(["connector_write_model_access"]);
    expect(await code(approve(id))).toBe(NOT_PROPOSABLE);
    expect(store.get(id)?.state).toBe("proposed");
    expect(writes()).toEqual([]);
  });
});

describe("the owner's facts are re-read between submit and approval", () => {
  test("a wave lowered after submit refuses the approval", async () => {
    approveForAgents("github", 4, ["github_pr_merge"]);
    const { id } = await submit("github.pr.merge", {
      owner: "o",
      repo: "r",
      pullNumber: 1,
      sha: HEAD,
    });
    setModelWriteEnablement(db, "github", 3, clock, []);
    expect(await code(approve(id))).toBe(NOT_PROPOSABLE);
    expect(writes()).toEqual([]);
  });

  test("the Obsidian append is an approved proposal only while its model-door approval stands (OR-AD-12)", async () => {
    setModelWriteEnablement(db, "obsidian", 2, clock, ["obsidian_append_to_daily_note"]);
    approveForAgents("obsidian", 2, ["obsidian_append_to_daily_note"]);
    const out = await submit("obsidian.note.append", { content: "x" });
    expect(out).not.toHaveProperty("legacy");
    setModelWriteEnablement(db, "obsidian", 2, clock, []);
    // One of the 47: with the grant withdrawn it is a deprecation-window case again, not a hole.
    const again = await submit("obsidian.note.append", { content: "y" });
    expect(again.legacy).toBe(true);
  });
});

describe("the approval path", () => {
  test("an approved proposal cannot be approved through the raw captures.accept RPC; the same call still approves a legacy one", async () => {
    approveForAgents("github", 2, ["github_issue_create"]);
    const approvedRow = await submit("github.issue.create", { owner: "o", repo: "r", title: "t" });
    expect(await code(rpc(UNDECLARED, "captures.accept", { id: approvedRow.id }))).toBe(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
    );
    expect(store.get(approvedRow.id)?.state).toBe("proposed");
    const legacyRow = await submit("github.issue.comment.create");
    const out = (await rpc(UNDECLARED, "captures.accept", { id: legacyRow.id })) as {
      state: string;
    };
    expect(out.state).toBe("executed");
  });

  test("a non-human answer to an approved proposal dispatches nothing", async () => {
    approveForAgents("github", 2, ["github_issue_create"]);
    answer = () => ({ approved: true, answerSource: "script" });
    const { id } = await submit("github.issue.create", { owner: "o", repo: "r", title: "t" });
    const out = await approve(id);
    expect(out.state).toBe("rejected");
    expect(writes()).toEqual([]);
  });

  test("the verdict agrees with the earlier table for every legacy type when nothing is approved", () => {
    const d = door();
    for (const type of LEGACY_TYPES) {
      const earlier = classifyActionType(type, {
        userMcpModelAccessAllowed: () => false,
        modelAccessServices: () => new Set<string>(),
      });
      expect(earlier.kind, type).toBe("proposable");
      const v = d.verdict(type);
      expect(v.kind, type).toBe("proposable");
      expect(
        agentDoorRow(type) !== undefined && "basis" in v && String(v.basis).startsWith("legacy"),
        type,
      ).toBe(true);
    }
  });
});

describe("capture.describe, end to end (AD3a-2b)", () => {
  interface Described {
    readonly actions: ReadonlyArray<{
      readonly actionType: string;
      readonly state: string;
      readonly description?: string;
      readonly inputSchema?: { readonly properties?: Record<string, unknown> };
      readonly reason?: string;
    }>;
    readonly truncated: boolean;
  }
  const describeTypes = (types?: string[]): Promise<Described> =>
    rpc(AGENT, "capture.describe", types === undefined ? {} : { actionTypes: types }) as Promise<Described>;

  test("an approved agent describes github.pr.merge, builds an input from the returned schema, submits it and sees it queued", async () => {
    approveForAgents("github", 4, ["github_pr_merge"]);
    const summary = await describeTypes();
    expect(listCalls).toEqual([]);
    expect(summary.actions.find((a) => a.actionType === "github.pr.merge")).toMatchObject({
      state: "approved",
      wave: 4,
      typedConfirm: true,
    });
    const detail = await describeTypes(["github.pr.merge"]);
    const entry = detail.actions[0];
    expect(entry?.state).toBe("approved");
    expect(entry?.description).toContain("<tool_description");
    const props = Object.keys(entry?.inputSchema?.properties ?? {});
    expect(props.length).toBeGreaterThan(0);
    // Build an input from the schema alone: the key names it returned, a plain value each, the
    // head the owner will later see as the pull request head.
    const input = Object.fromEntries(props.map((k) => [k, k === "sha" ? HEAD : "plain"]));
    const queued = await submit("github.pr.merge", input);
    expect(queued.state).toBe("proposed");
    expect(queued).not.toHaveProperty("legacy");
  });

  test("the reply never carries a hash, a reason from the owner side or a listing key", async () => {
    approveForAgents("github", 4, ["github_pr_merge"]);
    const row = getDoorApproval(db, "agent", "github", "github_pr_merge");
    const text = JSON.stringify(await describeTypes(["github.pr.merge", "slack.message.post"]));
    expect(text).not.toContain((row?.definitionSha256 ?? "x").slice(0, 12));
    expect(text).not.toMatch(/[0-9a-f]{20,}/);
    expect(text).not.toContain(mcpClientToolKey("github", "github_pr_merge"));
  });

  test("a changed listing is suspended by describe, which records one audit row, and the submit then refuses", async () => {
    approveForAgents("github", 4, ["github_pr_merge"]);
    describeTool = (t) => (t === "github_pr_merge" ? "changed under you" : `d ${t}`);
    const out = await describeTypes(["github.pr.merge"]);
    expect(out.actions[0]).toMatchObject({ state: "suspended" });
    expect(out.actions[0]).not.toHaveProperty("description");
    expect(out.actions[0]).not.toHaveProperty("inputSchema");
    expect(suspendAuditCount()).toBe(1);
    expect(
      await code(submit("github.pr.merge", { owner: "o", repo: "r", pullNumber: 1, sha: HEAD })),
    ).toBe(SUSPENDED);
    expect(suspendAuditCount()).toBe(1);
  });

  test("only an mcp connection may describe, and a legacy type is reported with no listing", async () => {
    for (const client of [OWNER, OWNER_UI, UNDECLARED]) {
      expect(await code(rpc(client, "capture.describe", {}))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    }
    const out = await describeTypes(["slack.message.post"]);
    expect(out.actions[0]).toMatchObject({ state: "legacy" });
    expect(listCalls).toEqual([]);
  });
});
