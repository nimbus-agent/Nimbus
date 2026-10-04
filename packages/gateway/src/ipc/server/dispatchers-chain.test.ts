/**
 * dispatchers-chain.test.ts
 *
 * Every namespace's HIT arm below is driven through `tryDispatchPhase4Rpc` — the entry point
 * `server.ts`'s `dispatchMethod` calls — rather than through its own `tryDispatchXRpc` wrapper.
 * (The skip and non-domain-rethrow arms are called on the wrapper directly: through the chain a
 * skip only falls through to the next namespace, so the arm under test could not be told apart.)
 *
 * That distinction is the point of the file. A method is served only when BOTH halves are wired:
 * the inner handler, and the outer routing that hands the method to it (the group functions and
 * the `PHASE4_PLATFORM_DISPATCHERS` table). A unit test that calls the inner wrapper directly
 * passes whether or not the routing exists, which is exactly how `ask.explainLast` once returned
 * `Method not found` over a real socket with every unit test green. Each test here therefore
 * asserts the VALUE the namespace's own handler produces, so a missing or mis-ordered routing entry
 * — which would surface as `phase4RpcSkipped` or another namespace's answer — fails it.
 *
 * Namespaces covered here are the ones whose hit arm the chain itself never reached before:
 * llm, voice, updater, audit, security, teamvault, identity, metrics, deploy (preflight),
 * deployment, connector.reindex (the terminal arm), exec, toolgen, computer, decisions and clip.
 *
 * Rules: no `mock.module` (DI only); no `any`; real SQLite from a migrated template; no real
 * sleeps — every wait is on a promise the code under test settles.
 */

import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openSeededInMemoryDb } from "../../../test/helpers/migrated-db-seed.ts";
import { PairingWindowController } from "../../clips/pairing-window.ts";
import {
  CuActionConsentBroker,
  CuEnvelopeConsentBroker,
} from "../../computer-use/cu-consent-broker.ts";
import type { DecisionPassSummary } from "../../decisions/decision-extract.ts";
import type { DecisionRefresher } from "../../decisions/decision-refresh.ts";
import { type ExecApprovalInput, ExecConsentBroker } from "../../exec/exec-consent-broker.ts";
import { IdentityStore } from "../../identity/identity-store.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../../index/local-index.ts";
import type { LlmRegistry } from "../../llm/registry.ts";
import {
  type ToolgenApprovalInput,
  ToolgenConsentBroker,
  type ToolgenSaveApprovalInput,
  ToolgenSaveConsentBroker,
} from "../../toolgen/toolgen-consent-broker.ts";
import type { Updater } from "../../updater/updater.ts";
import { createMockVault } from "../../vault/mock.ts";
import type { VoiceService } from "../../voice/service.ts";
import type { ComputerRpcCtx } from "../computer-rpc.ts";
import { ConsentCoordinatorImpl } from "../consent.ts";
import { createStreamRegistry } from "../engine-ask-stream.ts";
import type { ExecRpcCtx } from "../exec-rpc.ts";
import type { ToolgenRpcCtx } from "../toolgen-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "./context.ts";
import {
  tryDispatchComputerRpc,
  tryDispatchDecisionsRpc,
  tryDispatchExecRpc,
  tryDispatchPhase4Rpc,
  tryDispatchToolgenRpc,
} from "./dispatchers.ts";
import type { CreateIpcServerOptions } from "./options.ts";
import { RpcMethodError } from "./rpc-error.ts";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const openDbs: Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A fresh, fully migrated index — a copy of one cached template, not a per-test migration. */
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

/**
 * How the owner answers a HITL prompt. `disconnected` is the production default for a client with
 * no live session (the consent coordinator rejects, so the gate fails closed); `approve`/`deny`
 * answer the prompt the way a connected owner would, through `handleRespond`.
 */
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

/** The `RpcMethodError` a dispatch rejected with; anything else (or a resolve) fails the test. */
async function rpcErrorOf(pending: Promise<unknown>): Promise<RpcMethodError> {
  try {
    await pending;
  } catch (e) {
    if (e instanceof RpcMethodError) return e;
    throw e;
  }
  throw new Error("expected the dispatch to reject with an RpcMethodError");
}

/** Whatever a dispatch rejected with, for the arms that must NOT remap. */
async function rejectionOf(pending: Promise<unknown>): Promise<unknown> {
  try {
    await pending;
  } catch (e) {
    return e;
  }
  throw new Error("expected the dispatch to reject");
}

/** The single requestId a broker broadcast, captured through its own broadcast seam. */
function captureRequestIds(broker: { setBroadcast(fn: (m: string, p: unknown) => void): void }): {
  readonly ids: string[];
  readonly methods: string[];
} {
  const ids: string[] = [];
  const methods: string[] = [];
  broker.setBroadcast((method, params) => {
    methods.push(method);
    const id = (params as Record<string, unknown>)["requestId"];
    if (typeof id !== "string") throw new Error("broker broadcast without a requestId");
    ids.push(id);
  });
  return { ids, methods };
}

// ---------------------------------------------------------------------------
// Core group: llm → agents → voice → updater → audit → security → federation
// ---------------------------------------------------------------------------

describe("phase-4 core group — each namespace is answered by its own handler", () => {
  test("llm.loadModel reaches the llm handler, and its notify lands on broadcastNotification", async () => {
    const loads: Array<readonly [string, string, unknown]> = [];
    const registry = {
      loadModel: async (provider: string, modelName: string, target: unknown) => {
        loads.push([provider, modelName, target]);
      },
    } as unknown as LlmRegistry;
    const { ctx, broadcasts } = harness({ llmRegistry: registry });

    const out = await tryDispatchPhase4Rpc(ctx, "llm.loadModel", { modelName: "qwen3:8b" }, "c1");

    expect(out).toEqual({ isLoaded: true });
    // provider defaults to "ollama"; no routeId means an empty lifecycle target.
    expect(loads).toEqual([["ollama", "qwen3:8b", {}]]);
    expect(broadcasts).toEqual([
      { method: "llm.modelLoaded", params: { provider: "ollama", modelName: "qwen3:8b" } },
    ]);
  });

  test("an LlmRpcError from the llm handler keeps its -32602 through the chain", async () => {
    const registry = {
      loadModel: () => Promise.reject(new Error("must not be reached")),
    } as unknown as LlmRegistry;
    const { ctx, broadcasts } = harness({ llmRegistry: registry });
    const err = await rpcErrorOf(tryDispatchPhase4Rpc(ctx, "llm.loadModel", {}, "c1"));
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("loadModel requires modelName");
    expect(broadcasts).toEqual([]);
  });

  test("voice.getStatus reaches the voice handler; a VoiceRpcError keeps its -32602", async () => {
    const voice = {
      getStatus: async () => ({ mode: "idle", wakeWord: false }),
    } as unknown as VoiceService;
    const { ctx } = harness({ voiceService: voice });

    expect(await tryDispatchPhase4Rpc(ctx, "voice.getStatus", {}, "c1")).toEqual({
      mode: "idle",
      wakeWord: false,
    });

    // `voice.transcribe` without `audioPath` is the voice module's own validation error. It must
    // arrive as invalid-params, not as -32603 or a raw exception.
    const err = await rpcErrorOf(tryDispatchPhase4Rpc(ctx, "voice.transcribe", {}, "c1"));
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("Missing or invalid param: audioPath");
  });

  test("updater.rollback reaches the updater handler through the chain", async () => {
    const { ctx } = harness({ updater: {} as unknown as Updater });
    expect(await tryDispatchPhase4Rpc(ctx, "updater.rollback", {}, "c1")).toEqual({ ok: true });
  });

  test("audit.verify reaches the audit handler and verifies an empty chain", async () => {
    const { ctx } = harness({ localIndex: freshIndex() });
    const out = await tryDispatchPhase4Rpc(ctx, "audit.verify", { full: true }, "c1");
    expect(out).toMatchObject({ ok: true });
  });

  test("security.scanCancel reaches the security handler (an unknown job is not cancelled)", async () => {
    const { ctx } = harness({ localIndex: freshIndex() });
    expect(
      await tryDispatchPhase4Rpc(ctx, "security.scanCancel", { jobId: "no-such-job" }, "c1"),
    ).toEqual({ cancelled: false });
  });
});

// ---------------------------------------------------------------------------
// Team/metrics group: teamvault → hitl → identity → metrics → preflight → deployment → data
// ---------------------------------------------------------------------------

describe("phase-4 team/metrics group — each namespace is answered by its own handler", () => {
  test("teamvault.list reaches the team-vault handler (no entries on a fresh index)", async () => {
    const { ctx } = harness({ localIndex: freshIndex() });
    expect(await tryDispatchPhase4Rpc(ctx, "teamvault.list", {}, "c1")).toEqual({ entries: [] });
  });

  test("hitl.listDelegations reaches the HITL handler (none active on a fresh index)", async () => {
    const { ctx } = harness({ localIndex: freshIndex() });
    expect(await tryDispatchPhase4Rpc(ctx, "hitl.listDelegations", {}, "c1")).toEqual({
      delegations: [],
    });
  });

  test("identity.status reaches the identity handler and reports no session", async () => {
    const index = freshIndex();
    const { ctx } = harness({
      localIndex: index,
      identityStore: new IdentityStore(index.getDatabase()),
      identityIssuer: "https://issuer.test",
    });
    expect(await tryDispatchPhase4Rpc(ctx, "identity.status", {}, "c1")).toEqual({
      loggedIn: false,
    });
  });

  test("metrics.dora reaches the metrics handler for the named service", async () => {
    const { ctx } = harness({ localIndex: freshIndex(), configDir: tempDir("disp-chain-dora-") });
    const out = await tryDispatchPhase4Rpc(
      ctx,
      "metrics.dora",
      { service: "svc-a", since: "7d" },
      "c1",
    );
    expect(out).toMatchObject({ service: "svc-a" });
  });

  test("deploy.preflight reads the service config from configDir — an unconfigured service warns", async () => {
    const { ctx } = harness({ localIndex: freshIndex(), configDir: tempDir("disp-chain-pre-") });
    const out = (await tryDispatchPhase4Rpc(
      ctx,
      "deploy.preflight",
      { service: "api", target_ref: "main" },
      "c1",
    )) as { verdict: string; checks: Record<string, { gap?: string }> };
    expect(out).toMatchObject({ service: "api", target_ref: "main", verdict: "warn" });
    expect(out.checks["active_p1_incidents"]?.gap).toBe("unknown_service");
  });

  test("deploy.preflight evaluates a service the configDir's nimbus.toml DOES configure", async () => {
    // The negative control for the test above: the same call, but `[metrics.dora.api]` exists in
    // the configDir the dispatcher's `loadConfig` closure reads. If that closure read anything
    // other than `ctx.options.configDir`, this would still answer `unknown_service`. Asserted as
    // the exact answer a configured service gets, not merely "not unknown_service" — a negative
    // assertion also passes when the check it reads is missing altogether.
    const configDir = tempDir("disp-chain-pre-cfg-");
    writeFileSync(
      join(configDir, "nimbus.toml"),
      '[metrics.dora.api]\nrepos = ["github:acme/api"]\n',
      "utf8",
    );
    const { ctx } = harness({ localIndex: freshIndex(), configDir });
    const out = (await tryDispatchPhase4Rpc(
      ctx,
      "deploy.preflight",
      { service: "api", target_ref: "main" },
      "c1",
    )) as { service: string; verdict: string; checks: Record<string, { gap?: string | null }> };
    expect(out.service).toBe("api");
    expect(out.verdict).toBe("ok");
    // Configured, but with no PagerDuty binding: the incident check names THAT gap, and the two
    // repo-backed checks run with no gap at all.
    expect(out.checks["active_p1_incidents"]?.gap).toBe("no_pagerduty_mapping");
    expect(out.checks["failing_ci_runs"]?.gap).toBeNull();
    expect(out.checks["merge_conflicts"]?.gap).toBeNull();
  });

  test("deployment.annotate reaches the deployment handler and is idempotent per deploy", async () => {
    const index = freshIndex();
    const { ctx } = harness({ localIndex: index });
    const deploy = {
      service: "api",
      provider: "github-actions",
      environment: "production",
      sha: "ABCDEF1",
      ref: "main",
      status: "success",
      started_at_ms: Date.now() - 60_000,
    };

    const first = (await tryDispatchPhase4Rpc(ctx, "deployment.annotate", deploy, "c1")) as {
      external_id: string;
      service: string;
      is_new: boolean;
    };
    expect(first).toMatchObject({ service: "api", is_new: true });

    const second = (await tryDispatchPhase4Rpc(ctx, "deployment.annotate", deploy, "c1")) as {
      external_id: string;
      is_new: boolean;
    };
    expect(second.is_new).toBe(false);
    expect(second.external_id).toBe(first.external_id);

    const rows = index
      .getDatabase()
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM item WHERE type = 'deployment'")
      .get();
    expect(rows?.n).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// The terminal arm: connector.reindex is tried only after every other group declined
// ---------------------------------------------------------------------------

describe("connector.reindex — the arm after the whole phase-4 chain", () => {
  test("a summary-depth reindex is answered by the reindex handler", async () => {
    const { ctx } = harness({ localIndex: freshIndex() });
    expect(
      await tryDispatchPhase4Rpc(
        ctx,
        "connector.reindex",
        { service: "github", depth: "summary" },
        "c1",
      ),
    ).toEqual({ itemsAffected: 0, depth: "summary", mode: "deepen" });
  });

  test("a full-depth reindex is gated on the caller's channel: approved proceeds", async () => {
    const index = freshIndex();
    const { ctx } = harness({ localIndex: index }, "approve");
    expect(
      await tryDispatchPhase4Rpc(
        ctx,
        "connector.reindex",
        { service: "github", depth: "full" },
        "c1",
      ),
    ).toEqual({ itemsAffected: 0, depth: "full", mode: "deepen" });
    // The answer alone cannot tell "approved" from "never asked": an ungated reindex returns the
    // same value. The gate's own audit row can.
    const audit = index
      .getDatabase()
      .query<{ hitl_status: string }, []>(
        "SELECT hitl_status FROM audit_log WHERE action_type = 'connector.reindex'",
      )
      .all();
    expect(audit).toEqual([{ hitl_status: "approved" }]);
  });

  test("a full-depth reindex the owner denies is refused -32000, nothing reindexed", async () => {
    const index = freshIndex();
    const { ctx } = harness({ localIndex: index }, "deny");
    const err = await rpcErrorOf(
      tryDispatchPhase4Rpc(ctx, "connector.reindex", { service: "github", depth: "full" }, "c1"),
    );
    expect(err.rpcCode).toBe(-32000);
    expect(err.message).toBe("User declined consent gate.");
    // The gate recorded the refusal it made.
    const audit = index
      .getDatabase()
      .query<{ hitl_status: string }, []>(
        "SELECT hitl_status FROM audit_log WHERE action_type = 'connector.reindex'",
      )
      .all();
    expect(audit).toEqual([{ hitl_status: "rejected" }]);
  });
});

// ---------------------------------------------------------------------------
// S2 namespaces: exec (I33), toolgen (I39/I40), computer (I35)
// ---------------------------------------------------------------------------

function execInput(): ExecApprovalInput {
  return {
    executionId: "exec-1",
    runtime: "bun",
    codeBody: "console.log(1)",
    grants: { fsRead: [], fsWrite: [], network: [] },
    wallClockMs: 1000,
    cwd: "/work",
  };
}

describe("exec.* — reached through the chain, answered on the exec broker", () => {
  function execCtx(consent: ExecConsentBroker): ExecRpcCtx {
    return { gateDeps: {} as ExecRpcCtx["gateDeps"], consent };
  }

  test("exec.approvalRespond settles the owner's pending approval", async () => {
    const consent = new ExecConsentBroker();
    const captured = captureRequestIds(consent);
    const decision = consent.request(execInput(), 60_000);
    expect(captured.methods).toEqual(["exec.approvalRequest"]);

    const { ctx } = harness({ execRpcCtx: execCtx(consent) });
    const out = await tryDispatchPhase4Rpc(
      ctx,
      "exec.approvalRespond",
      { requestId: captured.ids[0], approved: true },
      "c1",
    );

    expect(out).toEqual({ matched: true });
    expect(await decision).toBe(true);
  });

  test("a requestId no broker holds does not match", async () => {
    const { ctx } = harness({ execRpcCtx: execCtx(new ExecConsentBroker()) });
    expect(
      await tryDispatchPhase4Rpc(
        ctx,
        "exec.approvalRespond",
        { requestId: "nope", approved: true },
        "c1",
      ),
    ).toEqual({ matched: false });
  });

  test("an ExecRpcError keeps its invalid-params code", async () => {
    const { ctx } = harness({ execRpcCtx: execCtx(new ExecConsentBroker()) });
    const err = await rpcErrorOf(tryDispatchPhase4Rpc(ctx, "exec.approvalRespond", {}, "c1"));
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("ERR_INVALID_PARAMS: requestId (non-empty string) required");
  });

  test("a non-domain error propagates unchanged rather than as an RPC code", async () => {
    const boom = new Error("broker exploded");
    class ThrowingBroker extends ExecConsentBroker {
      override respond(): boolean {
        throw boom;
      }
    }
    const { ctx } = harness({ execRpcCtx: execCtx(new ThrowingBroker()) });
    const thrown = await rejectionOf(
      tryDispatchExecRpc(ctx, "exec.approvalRespond", { requestId: "r", approved: false }),
    );
    expect(thrown).toBe(boom);
  });

  test("an exec.* verb the handler map lacks is skipped, as is any exec.* call with no ctx", async () => {
    const { ctx } = harness({ execRpcCtx: execCtx(new ExecConsentBroker()) });
    expect(await tryDispatchExecRpc(ctx, "exec.notAVerb", {})).toBe(phase4RpcSkipped);

    const { ctx: unwired } = harness();
    expect(await tryDispatchExecRpc(unwired, "exec.approvalRespond", { requestId: "r" })).toBe(
      phase4RpcSkipped,
    );
  });
});

describe("toolgen.* — reached through the chain, answered on the RIGHT broker", () => {
  function toolgenCtx(
    consent: ToolgenConsentBroker,
    saveConsent: ToolgenSaveConsentBroker,
  ): ToolgenRpcCtx {
    return { consent, saveConsent } as unknown as ToolgenRpcCtx;
  }

  test("a SAVE approval is answered by toolgen.saveApprovalRespond and never by toolgen.approvalRespond", async () => {
    const create = new ToolgenConsentBroker();
    const save = new ToolgenSaveConsentBroker();
    captureRequestIds(create);
    const captured = captureRequestIds(save);
    const decision = save.request({} as unknown as ToolgenSaveApprovalInput, 60_000);
    expect(captured.methods).toEqual(["toolgen.saveApprovalRequest"]);
    const requestId = captured.ids[0];

    const { ctx } = harness({ toolgenRpcCtx: toolgenCtx(create, save) });
    // The create broker does not hold a save request: answering there must not settle it.
    expect(
      await tryDispatchPhase4Rpc(
        ctx,
        "toolgen.approvalRespond",
        { requestId, approved: true },
        "c1",
      ),
    ).toEqual({ matched: false });
    expect(
      await tryDispatchPhase4Rpc(
        ctx,
        "toolgen.saveApprovalRespond",
        { requestId, approved: false },
        "c1",
      ),
    ).toEqual({ matched: true });
    expect(await decision).toBe(false);
  });

  test("a CREATE approval is answered by toolgen.approvalRespond", async () => {
    const create = new ToolgenConsentBroker();
    const captured = captureRequestIds(create);
    const decision = create.request({} as unknown as ToolgenApprovalInput, 60_000);

    const { ctx } = harness({ toolgenRpcCtx: toolgenCtx(create, new ToolgenSaveConsentBroker()) });
    expect(
      await tryDispatchPhase4Rpc(
        ctx,
        "toolgen.approvalRespond",
        { requestId: captured.ids[0], approved: true },
        "c1",
      ),
    ).toEqual({ matched: true });
    expect(await decision).toBe(true);
  });

  test("a ToolgenRpcError keeps its code; a non-domain error is not remapped", async () => {
    const { ctx } = harness({
      toolgenRpcCtx: toolgenCtx(new ToolgenConsentBroker(), new ToolgenSaveConsentBroker()),
    });
    const err = await rpcErrorOf(
      tryDispatchPhase4Rpc(ctx, "toolgen.saveApprovalRespond", {}, "c1"),
    );
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("ERR_INVALID_PARAMS: requestId (non-empty string) required");

    const boom = new Error("save broker exploded");
    class ThrowingSaveBroker extends ToolgenSaveConsentBroker {
      override respond(): boolean {
        throw boom;
      }
    }
    const { ctx: throwing } = harness({
      toolgenRpcCtx: toolgenCtx(new ToolgenConsentBroker(), new ThrowingSaveBroker()),
    });
    expect(
      await rejectionOf(
        tryDispatchToolgenRpc(throwing, "toolgen.saveApprovalRespond", { requestId: "r" }),
      ),
    ).toBe(boom);
  });

  test("an unknown toolgen.* verb is skipped, as is any toolgen.* call with no ctx", async () => {
    const { ctx } = harness({
      toolgenRpcCtx: toolgenCtx(new ToolgenConsentBroker(), new ToolgenSaveConsentBroker()),
    });
    expect(await tryDispatchToolgenRpc(ctx, "toolgen.notAVerb", {})).toBe(phase4RpcSkipped);
    const { ctx: unwired } = harness();
    expect(await tryDispatchToolgenRpc(unwired, "toolgen.list", { sessionId: "s" })).toBe(
      phase4RpcSkipped,
    );
  });
});

describe("computer.* — reached through the chain, answered on either broker", () => {
  function computerCtx(
    envelopeConsent: CuEnvelopeConsentBroker,
    actionConsent: CuActionConsentBroker,
  ): ComputerRpcCtx {
    return {
      gateDeps: {} as ComputerRpcCtx["gateDeps"],
      envelopeConsent,
      actionConsent,
    };
  }

  test("a per-ACTION approval is matched after the envelope broker declines it", async () => {
    const envelope = new CuEnvelopeConsentBroker();
    const action = new CuActionConsentBroker();
    captureRequestIds(envelope);
    const captured = captureRequestIds(action);
    const decision = action.request(
      {
        promptKind: "action",
        sessionId: "s1",
        seq: 1,
        kind: "type",
        observedTarget: "input#q",
        classification: "actuating",
        why: "typing into a form",
        actionsUsed: 0,
        maxActions: 5,
        modelDescription: null,
      } as unknown as Parameters<CuActionConsentBroker["request"]>[0],
      60_000,
    );
    expect(captured.methods).toEqual(["computer.actionRequest"]);

    const { ctx } = harness({ computerRpcCtx: computerCtx(envelope, action) });
    expect(
      await tryDispatchPhase4Rpc(
        ctx,
        "computer.approvalRespond",
        { requestId: captured.ids[0], approved: true },
        "c1",
      ),
    ).toEqual({ matched: true });
    expect(await decision).toBe(true);
  });

  test("a ComputerRpcError keeps its code; a non-domain error is not remapped", async () => {
    const { ctx } = harness({
      computerRpcCtx: computerCtx(new CuEnvelopeConsentBroker(), new CuActionConsentBroker()),
    });
    const err = await rpcErrorOf(tryDispatchPhase4Rpc(ctx, "computer.approvalRespond", {}, "c1"));
    expect(err.rpcCode).toBe(-32602);
    expect(err.message).toBe("ERR_INVALID_PARAMS: requestId (non-empty string) required");

    const boom = new Error("envelope broker exploded");
    class ThrowingEnvelope extends CuEnvelopeConsentBroker {
      override respond(): boolean {
        throw boom;
      }
    }
    const { ctx: throwing } = harness({
      computerRpcCtx: computerCtx(new ThrowingEnvelope(), new CuActionConsentBroker()),
    });
    expect(
      await rejectionOf(
        tryDispatchComputerRpc(throwing, "computer.approvalRespond", { requestId: "r" }),
      ),
    ).toBe(boom);
  });

  test("an unknown computer.* verb is skipped, as is any computer.* call with no ctx", async () => {
    const { ctx } = harness({
      computerRpcCtx: computerCtx(new CuEnvelopeConsentBroker(), new CuActionConsentBroker()),
    });
    expect(await tryDispatchComputerRpc(ctx, "computer.notAVerb", {})).toBe(phase4RpcSkipped);
    const { ctx: unwired } = harness();
    expect(await tryDispatchComputerRpc(unwired, "computer.sessionStatus", {})).toBe(
      phase4RpcSkipped,
    );
  });
});

// ---------------------------------------------------------------------------
// decisions.* (long-running job; progress/done notifications go to broadcastNotification)
// ---------------------------------------------------------------------------

describe("decisions.* — reached through the chain, job events broadcast", () => {
  const SUMMARY: DecisionPassSummary = {
    scanned: 3,
    discovered: 2,
    extracted: 1,
    vetoed: 0,
    upgraded: 0,
    failed: 0,
    noModel: 0,
    discoveryComplete: true,
  };

  function refresher(runs: Array<{ rebuild?: boolean } | undefined>): DecisionRefresher {
    return {
      trigger: () => {},
      run: async (opts) => {
        runs.push(opts);
        return SUMMARY;
      },
      stop: () => {},
    };
  }

  /**
   * The first recorded broadcast of `method`, waited for on a BOUNDED number of event-loop turns.
   * The pass runs fire-and-forget after the dispatch returns, so a broadcast that never comes — a
   * dropped `notify` closure — must fail here in milliseconds rather than park the test on a
   * promise nothing will ever settle until the suite timeout ends it.
   */
  async function broadcastOf(
    broadcasts: readonly Broadcast[],
    method: string,
  ): Promise<Record<string, unknown>> {
    for (let i = 0; i < 1_000; i++) {
      const hit = broadcasts.find((b) => b.method === method);
      if (hit !== undefined) return hit.params;
      await new Promise<void>((r) => setImmediate(r));
    }
    throw new Error(`no ${method} broadcast arrived`);
  }

  test("decisions.refresh starts a non-rebuild pass and broadcasts passDone with its summary", async () => {
    const runs: Array<{ rebuild?: boolean } | undefined> = [];
    const { ctx, broadcasts } = harness({ decisionsRefresher: refresher(runs) });

    const out = (await tryDispatchPhase4Rpc(ctx, "decisions.refresh", {}, "c1")) as {
      jobId: string;
    };
    expect(out.jobId).toMatch(/^decisions_refresh_/);

    const payload = await broadcastOf(broadcasts, "decisions.passDone");
    expect(payload).toMatchObject({ jobId: out.jobId, scanned: 3, extracted: 1 });
    expect(runs).toEqual([{ rebuild: false }]);
    expect(broadcasts.map((b) => b.method)).toEqual(["decisions.passDone"]);
  });

  test("decisions.rebuild runs the pass with rebuild: true", async () => {
    const runs: Array<{ rebuild?: boolean } | undefined> = [];
    const { ctx, broadcasts } = harness({ decisionsRefresher: refresher(runs) });

    const out = (await tryDispatchPhase4Rpc(ctx, "decisions.rebuild", {}, "c1")) as {
      jobId: string;
    };
    expect(out.jobId).toMatch(/^decisions_rebuild_/);
    expect(await broadcastOf(broadcasts, "decisions.passDone")).toMatchObject({
      jobId: out.jobId,
    });
    expect(runs).toEqual([{ rebuild: true }]);
    expect(broadcasts.map((b) => b.method)).toEqual(["decisions.passDone"]);
  });

  test("an unknown decisions.* verb is skipped, as is any decisions.* call with no refresher", async () => {
    const runs: Array<{ rebuild?: boolean } | undefined> = [];
    const { ctx } = harness({ decisionsRefresher: refresher(runs) });
    expect(await tryDispatchDecisionsRpc(ctx, "decisions.notAVerb", {})).toBe(phase4RpcSkipped);
    expect(runs).toEqual([]);

    const { ctx: unwired } = harness();
    expect(await tryDispatchDecisionsRpc(unwired, "decisions.refresh", {})).toBe(phase4RpcSkipped);
  });
});

// ---------------------------------------------------------------------------
// clip.* (the platform table's last entry before admin)
// ---------------------------------------------------------------------------

describe("clip.* — reached through the chain with each optional dep forwarded", () => {
  function controller(): PairingWindowController {
    return new PairingWindowController({ nowMs: () => 1_000, genCode: () => "424242" });
  }

  test("clip.status echoes briefsEnabled, defaulting to false when unset", async () => {
    const { ctx: defaulted } = harness({ clipPairingController: controller() });
    expect(await tryDispatchPhase4Rpc(defaulted, "clip.status", {}, "c1")).toEqual({
      devices: [],
      briefsEnabled: false,
    });

    const { ctx: enabled } = harness({ clipPairingController: controller(), briefsEnabled: true });
    expect(await tryDispatchPhase4Rpc(enabled, "clip.status", {}, "c1")).toEqual({
      devices: [],
      briefsEnabled: true,
    });
  });

  test("clip.pair echoes the HTTP base URL only when the sidecar is running", async () => {
    const { ctx: withHttp } = harness({
      clipPairingController: controller(),
      clipHttpBaseUrl: "http://127.0.0.1:7474",
    });
    expect(
      await tryDispatchPhase4Rpc(
        withHttp,
        "clip.pair",
        { label: "chrome", scopes: ["clip"] },
        "c1",
      ),
    ).toEqual({
      code: "424242",
      expiresAtMs: 121_000,
      label: "chrome",
      scopes: ["clip"],
      gatewayUrl: "http://127.0.0.1:7474",
    });

    const { ctx: noHttp } = harness({ clipPairingController: controller() });
    const out = (await tryDispatchPhase4Rpc(
      noHttp,
      "clip.pair",
      { label: "chrome", scopes: ["clip"] },
      "c1",
    )) as Record<string, unknown>;
    expect(out["code"]).toBe("424242");
    expect("gatewayUrl" in out).toBe(false);
  });

  test("clip.list without a local index fails soft to an empty list", async () => {
    const { ctx } = harness({ clipPairingController: controller() });
    expect(await tryDispatchPhase4Rpc(ctx, "clip.list", {}, "c1")).toEqual({ clips: [] });
  });

  test("clip.delete reaches the index when one is wired, and refuses when none is", async () => {
    // `clip.delete` is the clip verb that does NOT fail soft without an index, so it tells the
    // two `db` forwarding cases apart where `clip.list` cannot.
    const { ctx: withIndex } = harness({
      clipPairingController: controller(),
      localIndex: freshIndex(),
    });
    expect(
      await tryDispatchPhase4Rpc(withIndex, "clip.delete", { all: true, dryRun: true }, "c1"),
    ).toEqual({ deleted: 0, matched: 0 });

    const { ctx: noIndex } = harness({ clipPairingController: controller() });
    await expect(
      tryDispatchPhase4Rpc(noIndex, "clip.delete", { all: true, dryRun: true }, "c1"),
    ).rejects.toThrow("Clip index unavailable.");
  });

  test("an unknown clip.* verb is a -32601, not a skip — clip owns its whole namespace", async () => {
    const { ctx } = harness({ clipPairingController: controller() });
    const err = await rpcErrorOf(tryDispatchPhase4Rpc(ctx, "clip.notAVerb", {}, "c1"));
    expect(err.rpcCode).toBe(-32601);
    expect(err.message).toBe("Method not found: clip.notAVerb");
  });
});
