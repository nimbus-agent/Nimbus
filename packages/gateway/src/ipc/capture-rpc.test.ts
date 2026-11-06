import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  actDoorRefusal,
  LINEAR_ASSIGNEE_REFUSAL,
  messagingDestinationRefusal,
  type TribalKbConfig,
} from "../connectors/connector-writes/model-write-refusals.ts";
import {
  buildConnectorWritePreviewFrom,
  renderConnectorWritePreviewLines,
} from "../connectors/connector-writes/preview.ts";
import { row, textField, withPreview } from "../connectors/connector-writes/types.ts";
import { classifyActionType, proposableWriteTool } from "../connectors/proposable-actions.ts";
import {
  REMOTE_CONTENT_ALLOWED_CASES,
  REMOTE_CONTENT_REFUSED_CASES,
  type RemoteContentDoorCase,
} from "../connectors/testing/remote-content-fixtures.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import type { PlannedAction } from "../engine/types.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { formatActionConsent, formatActionProvenanceLines } from "../mcp-sink/capture-act.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { createMockVault } from "../vault/mock.ts";
import {
  buildActDeps,
  type CaptureActWiring,
  type CaptureRpcCtx,
  createActionDestinationRefusal,
  dispatchCaptureRpc,
} from "./capture-rpc.ts";
import { type ConsentCoordinator, ConsentCoordinatorImpl } from "./consent.ts";
import { createStreamRegistry } from "./engine-ask-stream.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";
import { phase4RpcSkipped, type ServerCtx } from "./server/context.ts";
import { tryDispatchPhase4Rpc } from "./server/dispatchers.ts";
import type { CreateIpcServerOptions } from "./server/options.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

let db: Database;
let ctx: CaptureRpcCtx;

beforeEach(() => {
  db = openMigratedMemoryDb();
  let seq = 0;
  const gate: CaptureGateDeps = {
    db,
    store: new CaptureStore(db),
    capability: () =>
      resolveCaptureCapability(
        { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
        { capabilitiesDisabled: new Set() },
      ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => 1_000,
    actionDestinationRefusal: () => undefined,
  };
  ctx = { gate };
});
afterEach(() => db.close());

function serverCtx(
  overrides: Partial<CreateIpcServerOptions>,
  kinds: Record<string, ClientKind>,
): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: (id: string) => kinds[id] ?? "unknown",
  } as unknown as ServerCtx;
}

const NOTE = { kind: "note", payload: { title: "t", body: "b" } };

describe("dispatchCaptureRpc", () => {
  test("hits every method and misses others", async () => {
    const mcp = { clientId: "m", kind: "mcp" as const };
    const own = { clientId: "o", kind: "cli" as const };
    expect((await dispatchCaptureRpc("capture.status", {}, ctx, mcp)).kind).toBe("hit");
    const sub = await dispatchCaptureRpc("capture.submit", NOTE, ctx, mcp);
    expect(sub).toEqual({ kind: "hit", value: { id: "cap_1", state: "live" } });
    expect((await dispatchCaptureRpc("captures.list", {}, ctx, own)).kind).toBe("hit");
    expect((await dispatchCaptureRpc("captures.get", { id: "cap_1" }, ctx, own)).kind).toBe("hit");
    expect(await dispatchCaptureRpc("captures.revoke", { id: "cap_1" }, ctx, own)).toEqual({
      kind: "hit",
      value: { id: "cap_1", state: "revoked" },
    });
    expect(await dispatchCaptureRpc("captures.nonesuch", { id: "cap_1" }, ctx, own)).toEqual({
      kind: "miss",
    });
  });

  test("captures.accept, captures.reject and captures.purge dispatch and map CaptureError to -32001", async () => {
    const mcp = { clientId: "m", kind: "mcp" as const };
    const own = { clientId: "o", kind: "cli" as const };
    const a = await dispatchCaptureRpc(
      "capture.submit",
      { kind: "term", payload: { term: "WAL", definition: "log" } },
      ctx,
      mcp,
    );
    const b = await dispatchCaptureRpc(
      "capture.submit",
      { kind: "decision", payload: { statement: "s" } },
      ctx,
      mcp,
    );
    if (a.kind !== "hit" || b.kind !== "hit") throw new Error("submit missed");
    const aId = (a.value as { id: string }).id;
    const bId = (b.value as { id: string }).id;
    expect(await dispatchCaptureRpc("captures.accept", { id: aId }, ctx, own)).toEqual({
      kind: "hit",
      value: { id: aId, state: "accepted", nativeRef: "wal" },
    });
    expect(await dispatchCaptureRpc("captures.reject", { id: bId }, ctx, own)).toEqual({
      kind: "hit",
      value: { id: bId, state: "rejected" },
    });
    // A decision is not an action: purge refuses it through the same error mapping.
    for (const method of ["captures.accept", "captures.reject", "captures.purge"]) {
      try {
        await dispatchCaptureRpc(method, { id: aId }, ctx, own);
        throw new Error("expected a refusal");
      } catch (e) {
        expect(e).toBeInstanceOf(RpcMethodError);
        expect((e as RpcMethodError).rpcCode).toBe(-32001);
        expect((e as RpcMethodError).rpcData).toEqual({ code: "ERR_CAPTURE_STATE" });
      }
    }
  });

  test("non-object params reach get/revoke as an undefined id and refuse cleanly", async () => {
    const own = { clientId: "o", kind: "cli" as const };
    await expect(dispatchCaptureRpc("captures.get", "nope", ctx, own)).rejects.toThrow(
      /ERR_CAPTURE_INVALID/,
    );
    await expect(dispatchCaptureRpc("captures.revoke", null, ctx, own)).rejects.toThrow(
      /ERR_CAPTURE_INVALID/,
    );
  });

  test("a non-CaptureError rethrows unchanged", async () => {
    const broken: CaptureRpcCtx = {
      gate: {
        ...ctx.gate,
        capability: () => {
          throw new TypeError("boom");
        },
      },
    };
    await expect(
      dispatchCaptureRpc("capture.status", {}, broken, { clientId: "o", kind: "cli" }),
    ).rejects.toBeInstanceOf(TypeError);
  });
});

describe("routing through tryDispatchPhase4Rpc (the entry server.ts calls)", () => {
  test("capture.submit reaches the gate with the CONNECTION's kind, not a param", async () => {
    const s = serverCtx({ captureRpcCtx: ctx }, { m: "mcp", o: "cli" });
    expect(await tryDispatchPhase4Rpc(s, "capture.submit", NOTE, "m")).toEqual({
      id: "cap_1",
      state: "live",
    });
    await expect(
      tryDispatchPhase4Rpc(s, "capture.submit", { ...NOTE, clientKind: "mcp" }, "o"),
    ).rejects.toThrow(/ERR_CAPTURE_FORBIDDEN_CLIENT/);
  });

  test("a CaptureError becomes RpcMethodError -32001 carrying the code", async () => {
    const s = serverCtx({ captureRpcCtx: ctx }, { m: "mcp" });
    try {
      await tryDispatchPhase4Rpc(s, "captures.list", {}, "m");
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
      expect((e as RpcMethodError).rpcCode).toBe(-32001);
      expect((e as RpcMethodError).rpcData).toEqual({ code: "ERR_CAPTURE_FORBIDDEN_CLIENT" });
    }
  });

  test("skips when the ctx is unset or the method is another namespace's", async () => {
    const none = serverCtx({}, { o: "cli" });
    expect(await tryDispatchPhase4Rpc(none, "capture.status", {}, "o")).toBe(phase4RpcSkipped);
    const s = serverCtx({ captureRpcCtx: ctx }, { o: "cli" });
    expect(await tryDispatchPhase4Rpc(s, "captures.nonesuch", {}, "o")).toBe(phase4RpcSkipped);
  });
});

describe("LAN", () => {
  test.each([
    "capture.status",
    "capture.submit",
    "captures.list",
    "captures.get",
    "captures.revoke",
    "captures.accept",
    "captures.purge",
  ])("%s is not callable over LAN (namespace denial covers future methods)", (method) => {
    expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: true })).toThrow(
      LanError,
    );
  });
});

describe("buildActDeps (act door)", () => {
  function wiring(dispatched: PlannedAction[], approve: boolean) {
    const prompts: Array<{ prompt: string; details: unknown }> = [];
    // A coordinator stub that answers every request; `requestConsent` is the only member bindConsentChannel calls.
    const coord = {
      requestConsent: (_c: string, req: { prompt: string; details?: unknown }) => {
        prompts.push({ prompt: req.prompt, details: req.details });
        return Promise.resolve(approve);
      },
    } as unknown as ConsentCoordinator;
    const w: CaptureActWiring = {
      dispatcher: {
        dispatch: (a) => {
          dispatched.push(a);
          return Promise.resolve({ url: "https://x" });
        },
      },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
    };
    return { act: buildActDeps(w, coord, "c-cli"), prompts };
  }
  const PROV = {
    captureId: "cap_1",
    clientLabel: "agent",
    createdAt: 0,
    expiresAt: 1,
    summary: "why",
  };

  test("first-party: payload carries the ROUTING table's mcpToolId and the input, nothing else", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, true);
    expect(await act.execute("slack.message.post", { text: "hi" }, PROV)).toEqual({
      status: "ok",
      result: { url: "https://x" },
    });
    expect(d).toEqual([
      {
        type: "slack.message.post",
        payload: { mcpToolId: "slack_message_post", input: { text: "hi" } },
      },
    ]);
  });
  test("user-MCP: mcpToolId is the canonical <serviceId>_<tool> key derived from the type (I42 pairing)", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, true);
    await act.execute("mcp_echo.echo", { text: "hi" }, PROV);
    expect(d[0]?.payload).toEqual({ mcpToolId: "mcp_echo_echo", input: { text: "hi" } });
  });
  test("the consent prompt is the provenance prompt, with UNREDACTED details", async () => {
    // An untemplated proposable type (slack.message.post since B1, github.issue.create since B2
    // and notion.page.create since B3 have a typed preview; a wave-3 send has none yet).
    const d: PlannedAction[] = [];
    const { act, prompts } = wiring(d, true);
    await act.execute("gmail.message.send", { token_hint: "visible", title: "hi" }, PROV);
    expect(prompts[0]?.prompt).toContain("Agent-proposed action");
    expect(prompts[0]?.details).toEqual({
      actionType: "gmail.message.send",
      input: { token_hint: "visible", title: "hi" },
    });
  });
  test("declined → rejected, nothing dispatched", async () => {
    const d: PlannedAction[] = [];
    const { act } = wiring(d, false);
    expect(await act.execute("slack.message.post", { text: "hi" }, PROV)).toEqual({
      status: "rejected",
    });
    expect(d).toEqual([]);
  });
  test("a first-party type with no routing row throws Tool not found (never dispatches by type)", async () => {
    const d: PlannedAction[] = [];
    const { act, prompts } = wiring(d, true);
    await expect(act.execute("github.pr.merge", {}, PROV)).rejects.toThrow("Tool not found");
    expect(d).toEqual([]);
    expect(prompts).toEqual([]);
  });
});

describe("buildActDeps: the typed preview for a templated proposable row (F5)", () => {
  // SYNTHETIC rows through the `previewRows` seam (written in B0a, before any real proposable row
  // had a template; the real B1 rows are covered at the end of this file). The type and tool are
  // the real routing pair.
  const JIRA = withPreview(row("jira_issue_create", "jira.issue.create", "mesh", 2), {
    target: "{projectKey}",
    summary: "Create issue {summary}",
    fields: [textField("description", "Description", "(none)")],
  });
  const PROV = {
    captureId: "cap_9",
    clientLabel: `agent${String.fromCodePoint(0x202e)}evil`,
    createdAt: 0,
    expiresAt: 60_000,
    summary: "Summary: totally safe",
  };

  function wiring(dispatched: PlannedAction[], rows = [JIRA]) {
    const prompts: Array<{ prompt: string; details: Record<string, unknown> }> = [];
    const coord = {
      requestConsent: (_c: string, req: { prompt: string; details?: Record<string, unknown> }) => {
        prompts.push({ prompt: req.prompt, details: req.details ?? {} });
        return Promise.resolve(true);
      },
    } as unknown as ConsentCoordinator;
    const w: CaptureActWiring = {
      dispatcher: {
        dispatch: (a) => {
          dispatched.push(a);
          return Promise.resolve({ key: "ENG-1" });
        },
      },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
      previewCredentialFor: () => "team",
      previewRows: rows,
    };
    return { act: buildActDeps(w, coord, "c-cli"), prompts };
  }

  test("the prompt is the provenance header, then the gateway-built preview; ONE approval, ONE dispatch", async () => {
    const d: PlannedAction[] = [];
    const { act, prompts } = wiring(d);
    const input = { projectKey: "ENG", summary: "Fix login" };
    expect(await act.execute("jira.issue.create", input, PROV)).toEqual({
      status: "ok",
      result: { key: "ENG-1" },
    });
    expect(prompts).toHaveLength(1);
    const lines = (prompts[0]?.prompt ?? "").split("\n");
    expect(lines[0]).toBe("Agent-proposed action — requires your approval");
    expect(lines[2]).toBe("Agent's summary (unverified): Summary: totally safe");
    expect(lines.slice(3, 8)).toEqual([
      "",
      "Service: jira",
      "Credential: team",
      "Target:  ENG",
      "Create issue Fix login",
    ]);
    expect(d).toEqual([
      { type: "jira.issue.create", payload: { mcpToolId: "jira_issue_create", input } },
    ]);
  });

  test("details are the preview with the proposer ONLY under proposedBy; the template's summary is kept", async () => {
    const { act, prompts } = wiring([]);
    await act.execute("jira.issue.create", { projectKey: "ENG", summary: "Fix login" }, PROV);
    const details = prompts[0]?.details ?? {};
    expect(details["kind"]).toBe("connector-write");
    expect(details["actionType"]).toBe("jira.issue.create");
    expect(details["summary"]).toBe("Create issue Fix login");
    expect(details["proposedBy"]).toEqual({
      clientLabel: String.raw`agent\u{202E}evil`,
      unverifiedSummary: "Summary: totally safe",
      createdAt: 0,
      expiresAt: 60_000,
    });
    expect(details["destination"]).toEqual({ service: "jira", credential: "team" });
  });

  test("no template: today's verbatim prompt and { actionType, input } details, exactly", async () => {
    const { act, prompts } = wiring([], []);
    const input = { projectKey: "ENG", summary: "Fix login" };
    await act.execute("jira.issue.create", input, PROV);
    expect(prompts[0]?.details).toEqual({ actionType: "jira.issue.create", input });
    expect(prompts[0]?.prompt).toBe(formatActionConsent(PROV, "jira.issue.create", input));
  });
});

test("capture.state routes; captures.accept passes ActDeps when wiring + consent are present", async () => {
  // Submit an mcp note, then poll it as mcp.
  const sub = await dispatchCaptureRpc("capture.submit", NOTE, ctx, { clientId: "a", kind: "mcp" });
  const id = (sub as { kind: "hit"; value: { id: string } }).value.id;
  const st = await dispatchCaptureRpc("capture.state", { id }, ctx, { clientId: "a", kind: "mcp" });
  expect(st).toEqual({ kind: "hit", value: { kind: "note", state: "live" } });
});

describe("captures.accept on an action (act door wiring)", () => {
  function actionCtx(dispatched: PlannedAction[]): CaptureRpcCtx {
    const gate: CaptureGateDeps = {
      ...ctx.gate,
      capability: () =>
        resolveCaptureCapability(
          {
            ok: true,
            config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
          },
          { capabilitiesDisabled: new Set() },
        ),
      classifyAction: () => ({ kind: "proposable" }),
      isServiceConfigured: () => Promise.resolve(true),
    };
    gate.store.insert({
      id: "cap_act",
      kind: "action",
      state: "proposed",
      itemId: null,
      payloadJson: JSON.stringify({
        actionType: "slack.message.post",
        input: { text: "hi" },
        summary: "why",
      }),
      payloadBytes: 10,
      clientLabel: "agent",
      sessionId: "s",
      createdAt: 500,
      expiresAt: 2_000,
    });
    return {
      gate,
      act: {
        dispatcher: {
          dispatch: (a) => {
            dispatched.push(a);
            return Promise.resolve({});
          },
        },
        egressSink: makeEgressSink(db),
        audit: { recordAudit: (e) => appendAuditEntry(db, e) },
        policyHitl: NO_POLICY_OVERLAY,
      },
    };
  }
  const OWNER = { clientId: "o", kind: "cli" as const };

  test("with wiring + consent: the ACCEPTING client is prompted and the action executes", async () => {
    const d: PlannedAction[] = [];
    const asked: string[] = [];
    const consent = {
      requestConsent: (clientId: string) => {
        asked.push(clientId);
        return Promise.resolve(true);
      },
    } as unknown as ConsentCoordinator;
    const out = await dispatchCaptureRpc(
      "captures.accept",
      { id: "cap_act" },
      actionCtx(d),
      OWNER,
      consent,
    );
    expect(out).toEqual({ kind: "hit", value: { id: "cap_act", state: "executed" } });
    expect(asked).toEqual(["o"]);
    expect(d).toEqual([
      {
        type: "slack.message.post",
        payload: { mcpToolId: "slack_message_post", input: { text: "hi" } },
      },
    ]);
    const hitl = db
      .query("SELECT hitl_status FROM audit_log WHERE action_type = 'slack.message.post'")
      .all();
    expect(hitl).toEqual([{ hitl_status: "approved" }]);
  });

  test("without a consent coordinator there is no ActDeps: refused DISABLED, nothing dispatched", async () => {
    const d: PlannedAction[] = [];
    const c = actionCtx(d);
    await expect(
      dispatchCaptureRpc("captures.accept", { id: "cap_act" }, c, OWNER),
    ).rejects.toMatchObject({ rpcData: { code: "ERR_CAPTURE_DISABLED" } });
    expect(d).toEqual([]);
    expect(c.gate.store.get("cap_act")?.state).toBe("proposed");
  });
});

// ---------- B1 on the act door: the real table, real classifier, real destination check ----------

/** The 11 proposable B1 types (slack.message.post routes to slack_message_post), with clean input. */
const B1_PROPOSABLE: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["slack.message.post", { channel: "C9999ZZZZ", text: "hi" }],
  ["teams.message.post", { teamId: "t", channelId: "19:other@thread.tacv2", body: "hi" }],
  ["teams.message.postChat", { chatId: "19:other@thread.v2", body: "hi" }],
  ["discord.message.post", { channelId: "123456789012345678", content: "hi" }],
  ["github.issue.comment.create", { owner: "o", repo: "r", issueNumber: 42, body: "LGTM" }],
  ["gitlab.issue.note.create", { projectPath: "g/r", issueIid: 7, body: "note" }],
  ["gitlab.mr.note.create", { projectPath: "g/r", mergeRequestIid: 9, body: "note" }],
  ["jira.comment.add", { issueKey: "NIM-1", body: "comment" }],
  ["linear.comment.create", { issueId: "u", body: "comment" }],
  ["notion.comment.create", { pageId: "ffff", text: "comment" }],
  ["confluence.comment.add", { pageId: "123", storageHtml: "<p>c</p>" }],
];

const REAL_CLASSIFY = {
  modelAccessServices: (): ReadonlySet<string> => new Set<string>(),
  userMcpModelAccessAllowed: () => false,
};

function boundPolicy(channels: readonly string[]): EnforcedPolicy {
  return {
    capabilitiesDisabled: new Set<string>(),
    chatops: {
      channels: new Map(
        channels.map((c) => [c, { namespace: "ns", unmapped: "refuse", notify: [] }]),
      ),
      ownership: new Map(),
    },
  } as unknown as EnforcedPolicy;
}

describe("B1 act door: every proposable B1 type shows its typed preview (Task 4)", () => {
  const PROV = {
    captureId: "cap_b1",
    clientLabel: "agent",
    createdAt: 0,
    expiresAt: 1,
    summary: "why",
  };

  function wiring(dispatched: PlannedAction[]) {
    const prompts: Array<{ prompt: string; details: Record<string, unknown> }> = [];
    const coord = {
      requestConsent: (_c: string, req: { prompt: string; details?: Record<string, unknown> }) => {
        prompts.push({ prompt: req.prompt, details: req.details ?? {} });
        return Promise.resolve(true);
      },
    } as unknown as ConsentCoordinator;
    const w: CaptureActWiring = {
      dispatcher: {
        dispatch: (a) => {
          dispatched.push(a);
          return Promise.resolve({});
        },
      },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
    };
    return { act: buildActDeps(w, coord, "c-cli"), prompts };
  }

  test("the B1 list is exactly the proposable B1 types", () => {
    expect(B1_PROPOSABLE).toHaveLength(11);
    for (const [t] of B1_PROPOSABLE) {
      expect(classifyActionType(t, REAL_CLASSIFY), t).toEqual({ kind: "proposable" });
    }
  });

  for (const [type, input] of B1_PROPOSABLE) {
    test(`${type}: provenance header, "", then the real row's typed preview`, async () => {
      const d: PlannedAction[] = [];
      const { act, prompts } = wiring(d);
      await act.execute(type, input, PROV);
      const toolId = proposableWriteTool(type);
      if (toolId === undefined) throw new Error(type);
      const preview = buildConnectorWritePreviewFrom(
        { type, payload: { mcpToolId: toolId, input } },
        CONNECTOR_WRITE_ROWS,
      );
      if (preview === undefined) throw new Error(`no preview for ${type}`);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.prompt).toBe(
        [
          ...formatActionProvenanceLines(PROV),
          "",
          ...renderConnectorWritePreviewLines(preview),
        ].join("\n"),
      );
      expect(prompts[0]?.details["kind"]).toBe("connector-write");
      expect(prompts[0]?.details["proposedBy"]).toBeDefined();
      // The act door runs no before-read (model door only).
      expect(prompts[0]?.details["before"]).toBeUndefined();
      expect(d).toEqual([{ type, payload: { mcpToolId: toolId, input } }]);
    });
  }
});

describe("B1 act door: the destination refusal, real messagingDestinationRefusal (Task 4b, OR1/OR2)", () => {
  const MCP = { clientId: "m", kind: "mcp" as const };
  const OWNER = { clientId: "o", kind: "cli" as const };
  let policy: EnforcedPolicy | undefined;

  function actCtx(dispatched: PlannedAction[]): CaptureRpcCtx {
    const gate: CaptureGateDeps = {
      ...ctx.gate,
      capability: () =>
        resolveCaptureCapability(
          {
            ok: true,
            config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
          },
          { capabilitiesDisabled: new Set() },
        ),
      classifyAction: (t) => classifyActionType(t, REAL_CLASSIFY),
      isServiceConfigured: () => Promise.resolve(true),
      actionDestinationRefusal: createActionDestinationRefusal(
        () => policy,
        () => undefined,
      ),
    };
    return {
      gate,
      act: {
        dispatcher: {
          dispatch: (a) => {
            dispatched.push(a);
            return Promise.resolve({});
          },
        },
        egressSink: makeEgressSink(db),
        audit: { recordAudit: (e) => appendAuditEntry(db, e) },
        policyHitl: NO_POLICY_OVERLAY,
      },
    };
  }

  async function submit(c: CaptureRpcCtx, actionType: string, input: Record<string, unknown>) {
    return await dispatchCaptureRpc(
      "capture.submit",
      { kind: "action", payload: { actionType, input, summary: "why" } },
      c,
      MCP,
    );
  }

  async function refusedCode(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      return (e as RpcMethodError).rpcData;
    }
    return "queued";
  }

  const REFUSED: ReadonlyArray<[string, Record<string, unknown>]> = [
    // ChatOps channels (OR2).
    ["slack.message.post", { channel: "C0123ABCD", text: "hi" }],
    ["slack.message.post", { channel: "#general", text: "hi" }],
    ["teams.message.post", { teamId: "t", channelId: "19%3Aabc%40thread.tacv2", body: "hi" }],
    ["teams.message.postChat", { chatId: "19:other@thread.v2", body: "hi" }],
    // Broadcast mentions (OR1), to destinations ChatOps does not bind.
    ["slack.message.post", { channel: "C9999ZZZZ", text: "hi <!here>" }],
    [
      "github.issue.comment.create",
      { owner: "o", repo: "r", issueNumber: 1, body: "cc @org/team" },
    ],
    ["gitlab.mr.note.create", { projectPath: "g/r", mergeRequestIid: 9, body: "@all" }],
    // A GitLab quick action.
    ["gitlab.issue.note.create", { projectPath: "g/r", issueIid: 7, body: "done\n/close" }],
  ];

  test("each is refused at submit with ERR_CAPTURE_ACTION_REFUSED; nothing is queued", async () => {
    // Slack C0123ABCD, the Teams thread, and a bound personal (a:) conversation.
    policy = boundPolicy(["C0123ABCD", "19:abc@thread.tacv2", "a:1botPERSONAL"]);
    const c = actCtx([]);
    for (const [type, input] of REFUSED) {
      expect(await refusedCode(submit(c, type, input)), `${type} ${JSON.stringify(input)}`).toEqual(
        { code: "ERR_CAPTURE_ACTION_REFUSED" },
      );
    }
    expect(c.gate.store.countPendingActions(1_000)).toBe(0);
  });

  test("positive controls are queued; with no KB configured a Notion comment is NOT refused", async () => {
    policy = boundPolicy(["C0123ABCD"]);
    const c = actCtx([]);
    for (const [type, input] of [
      ["slack.message.post", { channel: "C9999ZZZZ", text: "thanks <@U1>" }],
      ["gitlab.mr.note.create", { projectPath: "g/r", mergeRequestIid: 9, body: "and/or @alice" }],
      ["notion.comment.create", { pageId: "1a2b3c4d5e6f7a8b9c0d112233445566", text: "x" }],
    ] as const) {
      const out = await submit(c, type, input);
      expect(out.kind, type).toBe("hit");
      expect((out as { value: { state: string } }).value.state, type).toBe("proposed");
    }
  });

  test("an unreadable policy refuses every Slack/Teams proposal; other services are unaffected", async () => {
    policy = undefined;
    const c = actCtx([]);
    for (const [type, input] of B1_PROPOSABLE) {
      const got = await refusedCode(submit(c, type, input));
      if (type.startsWith("slack.") || type.startsWith("teams.")) {
        expect(got, type).toEqual({ code: "ERR_CAPTURE_ACTION_REFUSED" });
      } else {
        expect(got, type).toBe("queued");
      }
    }
    // A throwing policy accessor is the same as an unreadable one.
    const throwing = createActionDestinationRefusal(
      () => {
        throw new Error("policy");
      },
      () => undefined,
    );
    expect(throwing("slack.message.post", { channel: "C9999ZZZZ", text: "hi" })).toBeDefined();
    // A user-MCP type has no routing row, so no messaging destination: allowed here.
    expect(throwing("mcp_echo.echo", { text: "<!here>" })).toBeUndefined();
  });

  test("a ChatOps binding added between submit and accept is caught at accept: refused, row stays proposed, nothing dispatched", async () => {
    policy = boundPolicy([]);
    const d: PlannedAction[] = [];
    const c = actCtx(d);
    const sub = await submit(c, "slack.message.post", { channel: "C0123ABCD", text: "hi" });
    if (sub.kind !== "hit") throw new Error("submit missed");
    const id = (sub.value as { id: string }).id;
    policy = boundPolicy(["C0123ABCD"]);
    const consent = {
      requestConsent: () => Promise.resolve(true),
    } as unknown as ConsentCoordinator;
    let rpcData: unknown;
    try {
      await dispatchCaptureRpc("captures.accept", { id }, c, OWNER, consent);
    } catch (e) {
      rpcData = (e as RpcMethodError).rpcData;
    }
    expect(rpcData).toEqual({ code: "ERR_CAPTURE_ACTION_REFUSED" });
    expect(c.gate.store.get(id)?.state).toBe("proposed");
    expect(d).toEqual([]);
  });

  test("B4a: a calendar proposal whose time hides its zone, or whose iCloud text carries a control, is refused at submit; clean ones are queued", async () => {
    policy = boundPolicy([]);
    const c = actCtx([]);
    for (const [type, input] of [
      [
        "apple.calendar.event.create",
        {
          summary: "Review",
          start: "20261105T100000Z\r\nATTENDEE:mailto:x@evil.example",
          end: "20261105T110000Z",
        },
      ],
      [
        "apple.calendar.event.create",
        {
          summary: "Review",
          start: "20261105T100000Z",
          end: "20261105T110000Z",
          attendees: ["a@x.com\r\nATTENDEE:mailto:x@evil.example"],
        },
      ],
      [
        "outlook.calendar.create",
        {
          subject: "Review",
          startDateTime: "2026-11-05T10:00:00Z",
          endDateTime: "2026-11-05T11:00:00",
        },
      ],
    ] as const) {
      expect(await refusedCode(submit(c, type, input)), JSON.stringify(input)).toEqual({
        code: "ERR_CAPTURE_ACTION_REFUSED",
      });
    }
    expect(c.gate.store.countPendingActions(1_000)).toBe(0);
    for (const [type, input] of [
      [
        "apple.calendar.event.create",
        { summary: "Review", start: "20261105T100000Z", end: "20261105T110000Z" },
      ],
      [
        "outlook.calendar.create",
        { subject: "Review", startDateTime: "2026-11-05T10:00", endDateTime: "2026-11-05T11:00" },
      ],
      ["google_drive.file.create", { name: "n.txt", parentId: "F1", content: "x" }],
    ] as const) {
      const out = await submit(c, type, input);
      expect(out.kind, type).toBe("hit");
      expect((out as { value: { state: string } }).value.state, type).toBe("proposed");
    }
  });

  test("B4a: a Drive proposal with parentId null is refused at submit; nothing queued", async () => {
    policy = boundPolicy([]);
    const c = actCtx([]);
    expect(
      await refusedCode(
        submit(c, "google_drive.file.create", { name: "n.txt", parentId: null, content: "x" }),
      ),
    ).toEqual({ code: "ERR_CAPTURE_ACTION_REFUSED" });
    expect(c.gate.store.countPendingActions(1_000)).toBe(0);
  });

  test("B4a: a calendar proposal queued before the refusal existed is refused at accept; nothing dispatched", async () => {
    policy = boundPolicy([]);
    const d: PlannedAction[] = [];
    const c = actCtx(d);
    const now = Date.now();
    c.gate.store.insert({
      id: "cap_cal_old",
      kind: "action",
      state: "proposed",
      itemId: null,
      payloadJson: JSON.stringify({
        actionType: "apple.calendar.event.create",
        input: { summary: "Review", start: "20261105T100000", end: "20261105T110000Z" },
        summary: "why",
      }),
      payloadBytes: 10,
      clientLabel: "agent",
      sessionId: "s",
      createdAt: now,
      expiresAt: now + 3_600_000,
    });
    const consent = {
      requestConsent: () => Promise.resolve(true),
    } as unknown as ConsentCoordinator;
    let rpcData: unknown;
    try {
      await dispatchCaptureRpc("captures.accept", { id: "cap_cal_old" }, c, OWNER, consent);
    } catch (e) {
      rpcData = (e as RpcMethodError).rpcData;
    }
    expect(rpcData).toEqual({ code: "ERR_CAPTURE_ACTION_REFUSED" });
    expect(c.gate.store.get("cap_cal_old")?.state).toBe("proposed");
    expect(d).toEqual([]);
  });

  test("a not_yet_offered type is still refused at submit as not proposable", async () => {
    policy = boundPolicy([]);
    expect(
      await refusedCode(submit(actCtx([]), "jira.issue.transition", { issueKey: "NIM-1" })),
    ).toEqual({ code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE" });
  });
});

// ---- B2: the issue writes on the act door (plan Task 4b, R8; OR-B2-2/3/4) --------------------

/** The 12 proposable B2 types, with clean input. */
const B2_PROPOSABLE: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["github.issue.create", { owner: "o", repo: "r", title: "Bug", body: "Steps" }],
  ["github.issue.labels.add", { owner: "o", repo: "r", issueNumber: 42, labels: ["bug"] }],
  ["github.issue.assignees.add", { owner: "o", repo: "r", issueNumber: 42, assignees: ["alice"] }],
  ["github.issue.state.set", { owner: "o", repo: "r", issueNumber: 42, state: "closed" }],
  ["gitlab.issue.create", { projectPath: "g/r", title: "Bug", labels: ["bug"] }],
  ["gitlab.issue.labels.add", { projectPath: "g/r", issueIid: 7, labels: ["prio:high"] }],
  ["gitlab.issue.assignees.add", { projectPath: "g/r", issueIid: 7, assigneeUsernames: ["bob"] }],
  ["gitlab.issue.state.set", { projectPath: "g/r", issueIid: 7, stateEvent: "close" }],
  ["jira.issue.create", { projectKey: "NIM", summary: "Bug" }],
  ["jira.issue.update", { issueKey: "NIM-1", summary: "New" }],
  ["linear.issue.create", { teamId: "t", title: "Bug", assigneeId: "user-1" }],
  ["linear.issue.update", { issueId: "i", title: "New" }],
];

describe("B2 act door: every proposable issue write shows its typed preview, with no before", () => {
  const PROV = {
    captureId: "cap_b2",
    clientLabel: "agent",
    createdAt: 0,
    expiresAt: 1,
    summary: "why",
  };

  function wiring(dispatched: PlannedAction[]) {
    const prompts: Array<{ prompt: string; details: Record<string, unknown> }> = [];
    const coord = {
      requestConsent: (_c: string, req: { prompt: string; details?: Record<string, unknown> }) => {
        prompts.push({ prompt: req.prompt, details: req.details ?? {} });
        return Promise.resolve(true);
      },
    } as unknown as ConsentCoordinator;
    const w: CaptureActWiring = {
      dispatcher: {
        dispatch: (a) => {
          dispatched.push(a);
          return Promise.resolve({});
        },
      },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
    };
    return { act: buildActDeps(w, coord, "c-cli"), prompts };
  }

  test("the B2 list is exactly the 12 proposable issue writes; the transition is withheld", () => {
    expect(B2_PROPOSABLE).toHaveLength(12);
    for (const [t] of B2_PROPOSABLE) {
      expect(classifyActionType(t, REAL_CLASSIFY), t).toEqual({ kind: "proposable" });
    }
    expect(classifyActionType("jira.issue.transition", REAL_CLASSIFY)).toEqual({
      kind: "denied",
      class: "not_yet_offered",
    });
  });

  for (const [type, input] of B2_PROPOSABLE) {
    test(`${type}: provenance header, "", then the real row's typed preview`, async () => {
      const d: PlannedAction[] = [];
      const { act, prompts } = wiring(d);
      await act.execute(type, input, PROV);
      const toolId = proposableWriteTool(type);
      if (toolId === undefined) throw new Error(type);
      const preview = buildConnectorWritePreviewFrom(
        { type, payload: { mcpToolId: toolId, input } },
        CONNECTOR_WRITE_ROWS,
      );
      if (preview === undefined) throw new Error(`no preview for ${type}`);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.prompt).toBe(
        [
          ...formatActionProvenanceLines(PROV),
          "",
          ...renderConnectorWritePreviewLines(preview),
        ].join("\n"),
      );
      expect(prompts[0]?.details["kind"]).toBe("connector-write");
      // Before-reads run on the model door only (B0b).
      expect(prompts[0]?.details["before"]).toBeUndefined();
      expect(prompts[0]?.prompt).not.toContain("Before:");
      expect(d).toEqual([{ type, payload: { mcpToolId: toolId, input } }]);
    });
  }
});

// ---- B3: the draft and page writes on the act door (plan Task 4, R8) --------------------------

/** The nine B3 types, with clean input (no KB configured, so R12 refuses none of them). */
const B3_PROPOSABLE: ReadonlyArray<[string, Record<string, unknown>]> = [
  ["gmail.draft.create", { to: "a@x.com", subject: "S", body: "B" }],
  ["apple.mail.draft.create", { to: "a@x.com", subject: "S", body: "B" }],
  ["outlook.draft.create", { to: "a@x.com", subject: "S", body: "B", contentType: "html" }],
  ["notion.page.create", { parentPageId: "ffff", title: "T" }],
  ["notion.page.update", { pageId: "ffff", propertiesJson: "{}" }],
  ["notion.block.append", { parentBlockId: "ffff", childrenJson: "[]" }],
  ["confluence.page.create", { spaceKey: "ENG", title: "T", storageHtml: "<p>x</p>" }],
  ["confluence.page.update", { pageId: "123", versionNumber: 7, title: "T", storageHtml: "x" }],
  ["confluence.page.append", { pageId: "123", storageHtml: "<p>x</p>" }],
];

describe("B3 act door: every draft and page write shows its typed preview, with no before", () => {
  const PROV = {
    captureId: "cap_b3",
    clientLabel: "agent",
    createdAt: 0,
    expiresAt: 1,
    summary: "why",
  };

  function wiring(dispatched: PlannedAction[]) {
    const prompts: Array<{ prompt: string; details: Record<string, unknown> }> = [];
    const coord = {
      requestConsent: (_c: string, req: { prompt: string; details?: Record<string, unknown> }) => {
        prompts.push({ prompt: req.prompt, details: req.details ?? {} });
        return Promise.resolve(true);
      },
    } as unknown as ConsentCoordinator;
    const w: CaptureActWiring = {
      dispatcher: {
        dispatch: (a) => {
          dispatched.push(a);
          return Promise.resolve({});
        },
      },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
    };
    return { act: buildActDeps(w, coord, "c-cli"), prompts };
  }

  test("the nine are proposable; email.draft.create stays unroutable", () => {
    expect(B3_PROPOSABLE).toHaveLength(9);
    for (const [t] of B3_PROPOSABLE) {
      expect(classifyActionType(t, REAL_CLASSIFY), t).toEqual({ kind: "proposable" });
    }
    expect(classifyActionType("email.draft.create", REAL_CLASSIFY)).toEqual({
      kind: "denied",
      class: "unroutable",
    });
  });

  for (const [type, input] of B3_PROPOSABLE) {
    test(`${type}: provenance header, "", then the real row's typed preview`, async () => {
      const d: PlannedAction[] = [];
      const { act, prompts } = wiring(d);
      await act.execute(type, input, PROV);
      const toolId = proposableWriteTool(type);
      if (toolId === undefined) throw new Error(type);
      const preview = buildConnectorWritePreviewFrom(
        { type, payload: { mcpToolId: toolId, input } },
        CONNECTOR_WRITE_ROWS,
      );
      if (preview === undefined) throw new Error(`no preview for ${type}`);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.prompt).toBe(
        [
          ...formatActionProvenanceLines(PROV),
          "",
          ...renderConnectorWritePreviewLines(preview),
        ].join("\n"),
      );
      expect(prompts[0]?.details["kind"]).toBe("connector-write");
      // Before-reads run on the model door only (B0b).
      expect(prompts[0]?.details["before"]).toBeUndefined();
      expect(prompts[0]?.prompt).not.toContain("Before:");
      expect(d).toEqual([{ type, payload: { mcpToolId: toolId, input } }]);
    });
  }
});

// ---- B4a: the calendar and Drive creates on the act door (plan Task A4) ----------------------

/** The three B4a types, with clean input (times in the stated forms, R6). */
const B4A_PROPOSABLE: ReadonlyArray<[string, Record<string, unknown>]> = [
  [
    "outlook.calendar.create",
    {
      subject: "Review",
      startDateTime: "2026-11-05T10:00:00",
      endDateTime: "2026-11-05T11:00:00",
      timeZone: "Europe/Paris",
      attendees: "a@x.com, b@y.com",
    },
  ],
  [
    "apple.calendar.event.create",
    {
      summary: "Review",
      start: "20261105T100000Z",
      end: "20261105T110000Z",
      attendees: ["a@x.com", "b@y.com"],
    },
  ],
  ["google_drive.file.create", { name: "notes.md", parentId: "F1", content: "# Notes" }],
  // B4b (Task B6): the Obsidian daily-note append. Accepted, it still writes only while the
  // owner's Obsidian opt-in approved the append, because that approval is its sandbox grant.
  ["obsidian.note.append", { vault_id: "Work", date_iso: "2026-11-05", content: "- standup done" }],
];

describe("B4a act door: the calendar and Drive creates show their typed preview, with no before", () => {
  const PROV = {
    captureId: "cap_b4a",
    clientLabel: "agent",
    createdAt: 0,
    expiresAt: 1,
    summary: "why",
  };

  function wiring(dispatched: PlannedAction[]) {
    const prompts: Array<{ prompt: string; details: Record<string, unknown> }> = [];
    const coord = {
      requestConsent: (_c: string, req: { prompt: string; details?: Record<string, unknown> }) => {
        prompts.push({ prompt: req.prompt, details: req.details ?? {} });
        return Promise.resolve(true);
      },
    } as unknown as ConsentCoordinator;
    const w: CaptureActWiring = {
      dispatcher: {
        dispatch: (a) => {
          dispatched.push(a);
          return Promise.resolve({});
        },
      },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
    };
    return { act: buildActDeps(w, coord, "c-cli"), prompts };
  }

  test("the three B4a creates and the B4b append are proposable", () => {
    expect(B4A_PROPOSABLE).toHaveLength(4);
    for (const [t] of B4A_PROPOSABLE) {
      expect(classifyActionType(t, REAL_CLASSIFY), t).toEqual({ kind: "proposable" });
    }
  });

  for (const [type, input] of B4A_PROPOSABLE) {
    test(`${type}: provenance header, "", then the real row's typed preview`, async () => {
      const d: PlannedAction[] = [];
      const { act, prompts } = wiring(d);
      await act.execute(type, input, PROV);
      const toolId = proposableWriteTool(type);
      if (toolId === undefined) throw new Error(type);
      const preview = buildConnectorWritePreviewFrom(
        { type, payload: { mcpToolId: toolId, input } },
        CONNECTOR_WRITE_ROWS,
      );
      if (preview === undefined) throw new Error(`no preview for ${type}`);
      expect(prompts).toHaveLength(1);
      expect(prompts[0]?.prompt).toBe(
        [
          ...formatActionProvenanceLines(PROV),
          "",
          ...renderConnectorWritePreviewLines(preview),
        ].join("\n"),
      );
      const marker: Record<string, string> = {
        "google_drive.file.create": "Folder id",
        "obsidian.note.append": "Text appended (Markdown, sent as is)",
      };
      expect(prompts[0]?.prompt).toContain(marker[type] ?? "Attendees");
      expect(prompts[0]?.details["kind"]).toBe("connector-write");
      // Before-reads run on the model door only (B0b): the Drive folder is not read here.
      expect(prompts[0]?.details["before"]).toBeUndefined();
      expect(prompts[0]?.prompt).not.toContain("Before:");
      expect(d).toEqual([{ type, payload: { mcpToolId: toolId, input } }]);
    });
  }
});

describe("B2 act door: actDoorRefusal at submit and at accept (OR-B2-2, OR-B2-3)", () => {
  const MCP = { clientId: "m", kind: "mcp" as const };
  const OWNER = { clientId: "o", kind: "cli" as const };

  function actCtx(
    dispatched: PlannedAction[],
    refusal: CaptureGateDeps["actionDestinationRefusal"] = createActionDestinationRefusal(
      () => boundPolicy([]),
      () => undefined,
    ),
  ): CaptureRpcCtx {
    const gate: CaptureGateDeps = {
      ...ctx.gate,
      capability: () =>
        resolveCaptureCapability(
          {
            ok: true,
            config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
          },
          { capabilitiesDisabled: new Set() },
        ),
      classifyAction: (t) => classifyActionType(t, REAL_CLASSIFY),
      isServiceConfigured: () => Promise.resolve(true),
      actionDestinationRefusal: refusal,
    };
    return {
      gate,
      act: {
        dispatcher: {
          dispatch: (a) => {
            dispatched.push(a);
            return Promise.resolve({});
          },
        },
        egressSink: makeEgressSink(db),
        audit: { recordAudit: (e) => appendAuditEntry(db, e) },
        policyHitl: NO_POLICY_OVERLAY,
      },
    };
  }

  async function submit(c: CaptureRpcCtx, actionType: string, input: Record<string, unknown>) {
    return await dispatchCaptureRpc(
      "capture.submit",
      { kind: "action", payload: { actionType, input, summary: "why" } },
      c,
      MCP,
    );
  }

  async function outcome(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      return (e as RpcMethodError).rpcData;
    }
    return "queued";
  }

  const REFUSED: ReadonlyArray<[string, Record<string, unknown>]> = [
    ["gitlab.issue.create", { projectPath: "g/r", title: "Bug", description: "fix\n/close" }],
    ["gitlab.issue.create", { projectPath: "g/r", title: "Bug", labels: ["prio::high"] }],
    ["github.issue.create", { owner: "o", repo: "r", title: "cc @org/team" }],
    ["gitlab.issue.labels.add", { projectPath: "g/r", issueIid: 7, labels: ["prio::high"] }],
    [
      "gitlab.issue.labels.add",
      {
        projectPath: "g/r",
        issueIid: 7,
        labels: [`priority${String.fromCodePoint(0xff1a, 0xff1a)}low`],
      },
    ],
    // The act door has no before-read: ANY assigneeId on a Linear update is refused.
    ["linear.issue.update", { issueId: "i", assigneeId: "user-1" }],
    ["linear.issue.update", { issueId: "i", title: "x", assigneeId: "" }],
    // An explicit null would unassign the current assignee.
    ["linear.issue.update", { issueId: "i", assigneeId: null }],
  ];

  test("each is refused at submit with ERR_CAPTURE_ACTION_REFUSED; nothing is queued", async () => {
    const c = actCtx([]);
    for (const [type, input] of REFUSED) {
      expect(await outcome(submit(c, type, input)), `${type} ${JSON.stringify(input)}`).toEqual({
        code: "ERR_CAPTURE_ACTION_REFUSED",
      });
    }
    expect(c.gate.store.countPendingActions(1_000)).toBe(0);
  });

  // One test each: the pending-action queue is bounded, and each test gets a fresh store.
  for (const [type, input] of [...B2_PROPOSABLE]) {
    test(`a clean ${type} ${JSON.stringify(input)} is queued`, async () => {
      const c = actCtx([]);
      expect(await outcome(submit(c, type, input))).toBe("queued");
      expect(c.gate.store.countPendingActions(1_000)).toBe(1);
    });
  }

  test("the Jira transition is refused at submit as not proposable (OR-B2-4)", async () => {
    expect(
      await outcome(
        submit(actCtx([]), "jira.issue.transition", { issueKey: "NIM-1", transitionId: "31" }),
      ),
    ).toEqual({ code: "ERR_CAPTURE_ACTION_NOT_PROPOSABLE" });
  });

  test("at accept: a Linear reassignment and a scoped label queued without the check are refused, nothing dispatched", async () => {
    for (const [type, input] of [
      ["linear.issue.update", { issueId: "i", assigneeId: "user-1" }],
      ["gitlab.issue.labels.add", { projectPath: "g/r", issueIid: 7, labels: ["prio::high"] }],
    ] as const) {
      // Queued by a door that did not check (a row from before the rule): the accept re-checks.
      const permissive = actCtx([], () => undefined);
      const sub = await submit(permissive, type, input);
      if (sub.kind !== "hit") throw new Error("submit missed");
      const id = (sub.value as { id: string }).id;
      const d: PlannedAction[] = [];
      const strict = actCtx(d);
      const consent = {
        requestConsent: () => Promise.resolve(true),
      } as unknown as ConsentCoordinator;
      expect(
        await outcome(dispatchCaptureRpc("captures.accept", { id }, strict, OWNER, consent)),
        type,
      ).toEqual({ code: "ERR_CAPTURE_ACTION_REFUSED" });
      expect(strict.gate.store.get(id)?.state, type).toBe("proposed");
      expect(d, type).toEqual([]);
    }
  });

  test("actDoorRefusal equals messagingDestinationRefusal on every row but a Linear update that sets assigneeId", () => {
    const NO_CHATOPS = { chatops: undefined };
    for (const r of CONNECTOR_WRITE_ROWS) {
      for (const input of [{}, { assigneeId: "u" }, { title: "@all", labels: ["a::b"] }]) {
        const expected =
          r.toolId === "linear_issue_update" && "assigneeId" in input
            ? LINEAR_ASSIGNEE_REFUSAL
            : messagingDestinationRefusal(r.toolId, input, NO_CHATOPS);
        expect(
          actDoorRefusal(r.toolId, input, { ...NO_CHATOPS, kb: undefined, kbUnreadable: false }),
          `${r.toolId} ${JSON.stringify(input)}`,
        ).toBe(expected);
      }
    }
  });
});

// ---- B3: the KB refusals on the act door (OR-B3-1, OR-B3-3; plan R5, R12, Task 3c) -----------

describe("B3 act door: the KB-target and KB-child refusals at submit and at accept", () => {
  const MCP = { clientId: "m", kind: "mcp" as const };
  const OWNER = { clientId: "o", kind: "cli" as const };
  const KB = {
    notion: { databaseId: "0123abcd0123abcd0123abcd0123abcd" },
    confluence: { spaceKey: "KB", parentPageId: "4242" },
  } satisfies TribalKbConfig;
  // The accessor the act door reads per call (the real `createActionDestinationRefusal`).
  let kbAccessor: () => TribalKbConfig | undefined = () => undefined;

  function actCtx(dispatched: PlannedAction[]): CaptureRpcCtx {
    const gate: CaptureGateDeps = {
      ...ctx.gate,
      capability: () =>
        resolveCaptureCapability(
          {
            ok: true,
            config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
          },
          { capabilitiesDisabled: new Set() },
        ),
      classifyAction: (t) => classifyActionType(t, REAL_CLASSIFY),
      isServiceConfigured: () => Promise.resolve(true),
      actionDestinationRefusal: createActionDestinationRefusal(
        () => boundPolicy([]),
        () => kbAccessor(),
      ),
    };
    return {
      gate,
      act: {
        dispatcher: {
          dispatch: (a) => {
            dispatched.push(a);
            return Promise.resolve({});
          },
        },
        egressSink: makeEgressSink(db),
        audit: { recordAudit: (e) => appendAuditEntry(db, e) },
        policyHitl: NO_POLICY_OVERLAY,
      },
    };
  }

  async function submit(c: CaptureRpcCtx, actionType: string, input: Record<string, unknown>) {
    return await dispatchCaptureRpc(
      "capture.submit",
      { kind: "action", payload: { actionType, input, summary: "why" } },
      c,
      MCP,
    );
  }

  async function outcome(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      return (e as RpcMethodError).rpcData;
    }
    return "queued";
  }

  const submitAudits = (): number =>
    (
      db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'capture.submit'")
        .get() as {
        n: number;
      }
    ).n;

  const REFUSED = { code: "ERR_CAPTURE_ACTION_REFUSED" };
  const UPDATE_IN_ENG = {
    pageId: "123",
    versionNumber: 7,
    title: "t",
    storageHtml: "<p>x</p>",
  };

  test("a Confluence update of the KB parent page is refused at submit: nothing queued, one audit row", async () => {
    kbAccessor = () => ({ confluence: KB.confluence });
    const c = actCtx([]);
    const before = submitAudits();
    expect(
      await outcome(submit(c, "confluence.page.update", { ...UPDATE_IN_ENG, pageId: "4242" })),
    ).toEqual(REFUSED);
    expect(c.gate.store.countPendingActions(1_000)).toBe(0);
    expect(submitAudits()).toBe(before + 1);
  });

  test("a Confluence append to the KB parent page is refused at submit (proposable since B3)", async () => {
    kbAccessor = () => ({ confluence: KB.confluence });
    const c = actCtx([]);
    const before = submitAudits();
    expect(
      await outcome(submit(c, "confluence.page.append", { pageId: "4242", storageHtml: "x" })),
    ).toEqual(REFUSED);
    expect(c.gate.store.countPendingActions(1_000)).toBe(0);
    expect(submitAudits()).toBe(before + 1);
    // With no KB configured the same append is queued (R12 refuses nothing then).
    kbAccessor = () => undefined;
    expect(
      await outcome(
        submit(actCtx([]), "confluence.page.append", { pageId: "4242", storageHtml: "x" }),
      ),
    ).toBe("queued");
  });

  test("a Notion create under the KB database is refused at submit (the KB-target rule)", async () => {
    kbAccessor = () => KB;
    const c = actCtx([]);
    expect(
      await outcome(
        submit(c, "notion.page.create", {
          parentPageId: "https://www.notion.so/Team-0123abcd0123abcd0123abcd0123abcd",
          title: "t",
        }),
      ),
    ).toEqual(REFUSED);
    expect(c.gate.store.countPendingActions(1_000)).toBe(0);
  });

  test("R12: with a Notion KB configured a Notion page update is refused; with none it is queued", async () => {
    const input = { pageId: "ffffffffffffffffffffffffffffffff", propertiesJson: "{}" };
    kbAccessor = () => ({ notion: KB.notion });
    expect(await outcome(submit(actCtx([]), "notion.page.update", input))).toEqual(REFUSED);
    // A Confluence-only KB does not refuse a Notion update.
    kbAccessor = () => ({ confluence: KB.confluence });
    expect(await outcome(submit(actCtx([]), "notion.page.update", input))).toBe("queued");
    kbAccessor = () => undefined;
    expect(await outcome(submit(actCtx([]), "notion.page.update", input))).toBe("queued");
    expect(await outcome(submit(actCtx([]), "confluence.page.update", UPDATE_IN_ENG))).toBe(
      "queued",
    );
  });

  test("a throwing KB accessor refuses every KB-capable proposal; others are unaffected", async () => {
    kbAccessor = () => {
      throw new Error("tribal config");
    };
    const c = actCtx([]);
    expect(
      await outcome(submit(c, "notion.comment.create", { pageId: "ffff", text: "x" })),
    ).toEqual(REFUSED);
    expect(await outcome(submit(c, "confluence.page.update", UPDATE_IN_ENG))).toEqual(REFUSED);
    expect(
      await outcome(
        submit(c, "github.issue.comment.create", {
          owner: "o",
          repo: "r",
          issueNumber: 1,
          body: "x",
        }),
      ),
    ).toBe("queued");
  });

  test("a KB configured between submit and accept is caught at accept: refused, row stays proposed, nothing dispatched", async () => {
    kbAccessor = () => undefined;
    const d: PlannedAction[] = [];
    const c = actCtx(d);
    const sub = await submit(c, "confluence.page.update", UPDATE_IN_ENG);
    if (sub.kind !== "hit") throw new Error("submit missed");
    const id = (sub.value as { id: string }).id;
    kbAccessor = () => ({ confluence: KB.confluence });
    const consent = {
      requestConsent: () => Promise.resolve(true),
    } as unknown as ConsentCoordinator;
    expect(await outcome(dispatchCaptureRpc("captures.accept", { id }, c, OWNER, consent))).toEqual(
      REFUSED,
    );
    expect(c.gate.store.get(id)?.state).toBe("proposed");
    expect(d).toEqual([]);
  });

  test("an append to the KB parent queued before a KB was configured is refused at accept", async () => {
    kbAccessor = () => undefined;
    const d: PlannedAction[] = [];
    const c = actCtx(d);
    const sub = await submit(c, "confluence.page.append", { pageId: "4242", storageHtml: "x" });
    if (sub.kind !== "hit") throw new Error("submit missed");
    const id = (sub.value as { id: string }).id;
    kbAccessor = () => ({ confluence: KB.confluence });
    const consent = {
      requestConsent: () => Promise.resolve(true),
    } as unknown as ConsentCoordinator;
    expect(await outcome(dispatchCaptureRpc("captures.accept", { id }, c, OWNER, consent))).toEqual(
      REFUSED,
    );
    expect(c.gate.store.get(id)?.state).toBe("proposed");
    expect(d).toEqual([]);
  });

  test("with no KB the same accept goes through to the owner's prompt and one dispatch", async () => {
    kbAccessor = () => undefined;
    const d: PlannedAction[] = [];
    const c = actCtx(d);
    const sub = await submit(c, "confluence.page.update", UPDATE_IN_ENG);
    if (sub.kind !== "hit") throw new Error("submit missed");
    const id = (sub.value as { id: string }).id;
    const consent = {
      requestConsent: () => Promise.resolve(true),
    } as unknown as ConsentCoordinator;
    await dispatchCaptureRpc("captures.accept", { id }, c, OWNER, consent);
    expect(d.map((a) => a.type)).toEqual(["confluence.page.update"]);
  });
});

// ---- B3r: remote content on the act door, at submit and at accept (plan Task 6) --------------

describe("B3r act door: remote content is refused at submit and at accept", () => {
  const MCP = { clientId: "m", kind: "mcp" as const };
  const OWNER = { clientId: "o", kind: "cli" as const };
  const REFUSED = { code: "ERR_CAPTURE_ACTION_REFUSED" };

  function actCtx(
    dispatched: PlannedAction[],
    refusal: CaptureGateDeps["actionDestinationRefusal"] = createActionDestinationRefusal(
      () => boundPolicy([]),
      () => undefined,
    ),
  ): CaptureRpcCtx {
    const gate: CaptureGateDeps = {
      ...ctx.gate,
      capability: () =>
        resolveCaptureCapability(
          {
            ok: true,
            config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
          },
          { capabilitiesDisabled: new Set() },
        ),
      classifyAction: (t) => classifyActionType(t, REAL_CLASSIFY),
      isServiceConfigured: () => Promise.resolve(true),
      actionDestinationRefusal: refusal,
    };
    return {
      gate,
      act: {
        dispatcher: {
          dispatch: (a) => {
            dispatched.push(a);
            return Promise.resolve({});
          },
        },
        egressSink: makeEgressSink(db),
        audit: { recordAudit: (e) => appendAuditEntry(db, e) },
        policyHitl: NO_POLICY_OVERLAY,
      },
    };
  }

  /** The action type the act door proposes for a fixture's real row. */
  function typeOf(c: RemoteContentDoorCase): string {
    const r = CONNECTOR_WRITE_ROWS.find((x) => x.toolId === c.toolId);
    if (r === undefined) throw new Error(c.toolId);
    return r.actionType;
  }

  async function submit(c: CaptureRpcCtx, k: RemoteContentDoorCase) {
    return await dispatchCaptureRpc(
      "capture.submit",
      { kind: "action", payload: { actionType: typeOf(k), input: { ...k.input }, summary: "why" } },
      c,
      MCP,
    );
  }

  async function outcome(p: Promise<unknown>): Promise<unknown> {
    try {
      await p;
    } catch (e) {
      return (e as RpcMethodError).rpcData;
    }
    return "queued";
  }

  const submitAudits = (): number =>
    (
      db
        .query("SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'capture.submit'")
        .get() as { n: number }
    ).n;

  test("the nine scanned types are all proposable", () => {
    const types = new Set(REMOTE_CONTENT_REFUSED_CASES.map(typeOf));
    expect([...types].sort((a, b) => a.localeCompare(b))).toEqual([
      "confluence.comment.add",
      "confluence.page.append",
      "confluence.page.create",
      "confluence.page.update",
      "google_drive.file.create",
      "notion.block.append",
      "notion.page.update",
      "obsidian.note.append",
      "outlook.draft.create",
    ]);
    for (const t of types)
      expect(classifyActionType(t, REAL_CLASSIFY), t).toEqual({ kind: "proposable" });
  });

  test("an ri:url image in a Confluence append: refused at submit, nothing queued, one audit row", async () => {
    const c = actCtx([]);
    const before = submitAudits();
    const append: RemoteContentDoorCase = {
      label: "ri:url",
      toolId: "confluence_page_append",
      input: {
        pageId: "123",
        storageHtml: '<ac:image><ri:url ri:value="https://h/x.png"/></ac:image>',
      },
    };
    expect(await outcome(submit(c, append))).toEqual(REFUSED);
    expect(c.gate.store.countPendingActions(1_000)).toBe(0);
    expect(submitAudits()).toBe(before + 1);
  });

  test("every bypass form of both reviews is refused at submit; nothing is queued", async () => {
    for (const k of REMOTE_CONTENT_REFUSED_CASES) {
      // A fresh attempt limiter and refusal counter per proposal (the same store): this asserts
      // the destination refusal, not the per-client refusal rate limit that would trip first.
      const c = actCtx([]);
      const fresh: CaptureRpcCtx = {
        ...c,
        gate: {
          ...c.gate,
          limiter: new CaptureAttemptLimiter(),
          refusals: new CaptureRefusalCounter(),
        },
      };
      expect(await outcome(submit(fresh, k)), k.label).toEqual(REFUSED);
    }
    expect(ctx.gate.store.countPendingActions(1_000)).toBe(0);
  });

  // One test each: the pending-action queue is bounded, and each test gets a fresh store.
  for (const k of REMOTE_CONTENT_ALLOWED_CASES) {
    test(`queued: ${k.label}`, async () => {
      const c = actCtx([]);
      expect(await outcome(submit(c, k))).toBe("queued");
      expect(c.gate.store.countPendingActions(1_000)).toBe(1);
    });
  }

  /** One refused fixture of each scanned row (the last in the table): a proposal from before B3r. */
  const ONE_PER_ROW: readonly RemoteContentDoorCase[] = [
    ...new Map(REMOTE_CONTENT_REFUSED_CASES.map((k) => [k.toolId, k] as const)).values(),
  ];

  for (const k of ONE_PER_ROW) {
    test(`at accept: ${k.label}, queued without the check, is refused; the row stays proposed, nothing dispatched`, async () => {
      // Queued by a door that did not check (a row from before B3r): the accept re-checks.
      const permissive = actCtx([], () => undefined);
      const sub = await submit(permissive, k);
      if (sub.kind !== "hit") throw new Error("submit missed");
      const id = (sub.value as { id: string }).id;
      const d: PlannedAction[] = [];
      const strict = actCtx(d);
      const consent = {
        requestConsent: () => Promise.resolve(true),
      } as unknown as ConsentCoordinator;
      expect(
        await outcome(dispatchCaptureRpc("captures.accept", { id }, strict, OWNER, consent)),
      ).toEqual(REFUSED);
      expect(strict.gate.store.get(id)?.state).toBe("proposed");
      expect(d).toEqual([]);
    });
  }

  test("at accept: a clean proposal goes through to the owner's prompt and one dispatch", async () => {
    const d: PlannedAction[] = [];
    const c = actCtx(d);
    const clean: RemoteContentDoorCase = {
      label: "clean comment",
      toolId: "confluence_comment_add",
      input: { pageId: "123", storageHtml: '<p>see <a href="https://h">the doc</a></p>' },
    };
    const sub = await submit(c, clean);
    if (sub.kind !== "hit") throw new Error("submit missed");
    const id = (sub.value as { id: string }).id;
    const consent = {
      requestConsent: () => Promise.resolve(true),
    } as unknown as ConsentCoordinator;
    await dispatchCaptureRpc("captures.accept", { id }, c, OWNER, consent);
    expect(d.map((a) => a.type)).toEqual(["confluence.comment.add"]);
  });
});
