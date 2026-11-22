import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  checkStandingApprovals,
  RULE_ANCHORS,
} from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { agentDoorRow } from "../connectors/connector-writes/agent-door.ts";
import {
  archiveAction as i55ArchiveAction,
  freshDb as i55FreshDb,
  NOW as i55Now,
  seedWorkflow as i55SeedWorkflow,
} from "../connectors/connector-writes/standing-fixtures.test-helpers.ts";
import {
  BREAKERS as I55_BREAKERS,
  type Scenario as I55Scenario,
  aimAtRow as i55AimAtRow,
  baseScenario as i55BaseScenario,
  ruleCounters as i55Counters,
  openDeps as i55OpenDeps,
  setRuleColumn as i55SetRuleColumn,
} from "../connectors/connector-writes/standing-scenarios.test-helpers.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { verifyAuditChain } from "../db/audit-verify.ts";
import { makeEgressSink, NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { verifyEgressChain } from "../egress/egress-verify.ts";
import {
  type ExecutorPolicyDep,
  HITL_REQUIRED,
  NO_POLICY_OVERLAY,
  ToolExecutor,
} from "../engine/executor.ts";
import { CURRENT_SCHEMA_VERSION, LocalIndex } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { createStandingOwnerAsk, dispatchStandingRpc } from "../ipc/standing-rpc.ts";
import { createStandingRuleDeps } from "../standing/standing-rule-capability.ts";
import {
  getRule as i55GetRule,
  listFires as i55ListFires,
} from "../standing/standing-rule-store.ts";

// ---------------------------------------------------------------------------------------------
// I55 — the standing-approval taint barrier (Phase 10 SA3)
// ---------------------------------------------------------------------------------------------
describe("I55 — a standing rule approves a write only inside approvalPhase, for an exactly matching owner-workflow action", () => {
  type Seen = {
    prompts: number;
    confirmPrompts: number;
    dispatched: string[];
    auditAtDispatch: number;
    egressAtDispatch: number;
  };

  /** A real executor, a real audit chain and a real egress ledger over the scenario's database. */
  function liveExecutor(
    s: I55Scenario,
    opts: {
      readonly answer?: { approved: boolean; answerSource: "human" | "auto" };
      readonly withRules?: boolean;
      readonly failAudit?: boolean;
      readonly writeTable?: ConstructorParameters<typeof ToolExecutor>[8];
      readonly policy?: ExecutorPolicyDep;
    } = {},
  ): { exec: ToolExecutor; seen: Seen } {
    const seen: Seen = {
      prompts: 0,
      confirmPrompts: 0,
      dispatched: [],
      auditAtDispatch: -1,
      egressAtDispatch: -1,
    };
    const answer = opts.answer ?? { approved: false, answerSource: "human" as const };
    const countRows = (table: string): number =>
      (s.db.query(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          seen.prompts += 1;
          return answer;
        },
        requestConfirmedApproval: async () => {
          seen.confirmPrompts += 1;
          return { approved: false, typed: "", answerSource: "human" as const };
        },
      },
      {
        recordAudit: (e) => {
          if (opts.failAudit === true) throw new Error("audit append failed");
          appendAuditEntry(s.db, e);
        },
      },
      {
        dispatch: async (a) => {
          seen.dispatched.push(a.type);
          seen.auditAtDispatch = countRows("audit_log");
          seen.egressAtDispatch = countRows("egress_ledger");
          return { ok: true };
        },
      },
      undefined,
      makeEgressSink(s.db),
      opts.policy ?? NO_POLICY_OVERLAY,
      undefined,
      opts.withRules === false ? {} : { standingRules: s.deps },
      opts.writeTable,
    );
    return { exec, seen };
  }

  const auditRows = (db: Database): Array<{ hitl_status: string; action_json: string }> =>
    db.query("SELECT hitl_status, action_json FROM audit_log ORDER BY id").all() as Array<{
      hitl_status: string;
      action_json: string;
    }>;

  test("a matching action dispatches with ZERO consent calls and one standing_approved audit row and egress row carrying the fire id", async () => {
    const s = i55BaseScenario();
    const { exec, seen } = liveExecutor(s);
    const out = await exec.execute(s.action);
    expect(out).toEqual({ status: "ok", result: { ok: true } });
    expect(seen.prompts).toBe(0);
    expect(seen.confirmPrompts).toBe(0);
    expect(seen.dispatched).toEqual(["gmail.thread.archive"]);
    // I29: the audit row and the egress row were appended BEFORE the dispatch.
    expect(seen.auditAtDispatch).toBe(1);
    expect(seen.egressAtDispatch).toBe(1);
    const rows = auditRows(s.db);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.hitl_status).toBe("standing_approved");
    const fires = i55ListFires(s.db, s.rule.id);
    expect(fires).toHaveLength(1);
    const fireId = fires[0]?.fireId as string;
    const audited = JSON.parse(rows[0]?.action_json ?? "{}") as {
      standingRule: { ruleId: string; fireId: string; matchedScopeSha256: string };
      action: { provenance?: { fieldSources?: unknown } };
    };
    expect(audited.standingRule).toEqual({
      ruleId: s.rule.id,
      fireId,
      matchedScopeSha256: fires[0]?.matchedScopeSha256 as string,
    });
    // The row names the workflow run, never the field sources the check reads.
    expect(audited.action.provenance?.fieldSources).toBeUndefined();
    const egress = s.db
      .query("SELECT hitl_status, result_status, payload_summary FROM egress_ledger")
      .all() as Array<{ hitl_status: string; result_status: string; payload_summary: string }>;
    expect(egress).toHaveLength(1);
    expect(egress[0]?.hitl_status).toBe("standing_approved");
    expect(egress[0]?.result_status).toBe("authorized");
    expect(egress[0]?.payload_summary).toContain(fireId);
    expect(i55GetRule(s.db, s.rule.id)?.actionsUsed).toBe(1);
    // Both hash chains verify with the new status in them.
    expect(verifyAuditChain(new LocalIndex(s.db), { fromId: 0 }).ok).toBe(true);
    expect(verifyEgressChain(s.db, 0).ok).toBe(true);
  });

  test("every independent clause, broken alone on an otherwise matching action, ends in the owner's prompt and claims nothing", async () => {
    // The wave 4 breaker is the one prompt the executor makes a typed confirmation of.
    for (const breaker of I55_BREAKERS) {
      if (breaker.name === "HITL only by an org policy require") continue; // its own test below
      const s = i55BaseScenario();
      breaker.apply(s);
      const before = i55Counters(s);
      const { exec, seen } = liveExecutor(s);
      const out = await exec.execute(s.action);
      expect(out.status, breaker.name).toBe("rejected");
      // A bound row (I54) and a tool named under another row's type (I53) are refused at the gate
      // before anyone is asked; every other clause ends in the owner's prompt (the wave 4 row's is
      // the typed confirmation).
      const refusedBeforePrompt = ["a bound row", "mcpToolId names another row's tool"];
      if (!refusedBeforePrompt.includes(breaker.name)) {
        expect(seen.prompts + seen.confirmPrompts, breaker.name).toBeGreaterThanOrEqual(1);
      }
      expect(seen.dispatched, breaker.name).toEqual([]);
      expect(
        auditRows(s.db).map((r) => r.hitl_status),
        breaker.name,
      ).not.toContain("standing_approved");
      if (breaker.name !== "an exhausted ceiling")
        expect(i55Counters(s), breaker.name).toEqual(before);
    }
  });

  test("a type that is HITL only because org policy requires it is not standing-approved", async () => {
    const s = i55BaseScenario();
    const synthetic = {
      toolId: "synthetic_write",
      actionType: "synthetic.thing.write",
      transport: "mesh",
      wave: 2,
    } as const;
    i55AimAtRow(s, synthetic, { a: "b" });
    const { exec, seen } = liveExecutor(s, {
      writeTable: { rows: [synthetic], prepareToolIds: new Set<string>() },
      policy: { isHitlRequiredByPolicy: (t: string) => t === "synthetic.thing.write" },
    });
    expect((await exec.execute(s.action)).status).toBe("rejected");
    expect(seen.prompts).toBe(1);
    expect(seen.dispatched).toEqual([]);
  });

  test("outside the rule's window, by hour and by weekday, the owner is asked", async () => {
    const window = { days: [1, 2, 3, 4, 5], from: "09:00", to: "10:00", tz: "UTC" };
    for (const at of [Date.UTC(2026, 10, 11, 10, 0), Date.UTC(2026, 10, 14, 9, 30)]) {
      const s = i55BaseScenario({ window });
      s.deps = i55OpenDeps(s.db, { now: () => at });
      const { exec, seen } = liveExecutor(s);
      expect((await exec.execute(s.action)).status).toBe("rejected");
      expect(seen.prompts).toBe(1);
      expect(i55Counters(s)).toEqual({ used: 0, fires: 0 });
    }
    const s = i55BaseScenario({ window });
    s.deps = i55OpenDeps(s.db, { now: () => Date.UTC(2026, 10, 11, 9, 30) });
    const { exec, seen } = liveExecutor(s);
    expect((await exec.execute(s.action)).status).toBe("ok");
    expect(seen.prompts).toBe(0);
  });

  test("a constant whose dispatched value differs from the rule's constant asks the owner; key order is irrelevant", async () => {
    const s = i55BaseScenario({ variant: "const" });
    s.action = {
      ...s.action,
      payload: { mcpToolId: "gmail_thread_archive", input: { threadId: "T-other" } },
    };
    const { exec, seen } = liveExecutor(s);
    expect((await exec.execute(s.action)).status).toBe("rejected");
    expect(seen.prompts).toBe(1);
    const t = i55BaseScenario({ variant: "const" });
    i55SetRuleColumn(t, "scope_json", JSON.stringify({ threadId: { const: { a: 1, b: 2 } } }));
    t.action = {
      ...t.action,
      payload: { mcpToolId: "gmail_thread_archive", input: { threadId: { b: 2, a: 1 } } },
    };
    const again = liveExecutor(t);
    expect((await again.exec.execute(t.action)).status).toBe("ok");
    expect(again.seen.prompts).toBe(0);
  });

  test("a door refusal on the actual input (a null optional field, a calendar time without its zone) asks the owner", async () => {
    for (const bad of [{ timeZone: null }, { startDateTime: "tomorrow at ten" }]) {
      const s = i55BaseScenario({ variant: "calendar" });
      s.deps = createStandingRuleDeps({
        db: s.db,
        enforcedPolicy: () => ({ capabilitiesDisabled: new Set(), chatops: [] }) as never,
        getTribalKbConfig: () => undefined,
        now: () => i55Now,
      });
      const payload = s.action.payload as { input: Record<string, unknown> };
      const input = { ...payload.input, ...bad };
      const scope = Object.fromEntries(Object.entries(input).map(([k, v]) => [k, { const: v }]));
      i55SetRuleColumn(s, "scope_json", JSON.stringify(scope));
      s.action = { ...s.action, payload: { ...payload, input } };
      const { exec, seen } = liveExecutor(s);
      expect((await exec.execute(s.action)).status, JSON.stringify(bad)).toBe("rejected");
      expect(seen.prompts).toBe(1);
      expect(i55Counters(s)).toEqual({ used: 0, fires: 0 });
    }
  });

  test("a policy with standing approvals locked off, or no policy accessor at all, never fires a rule", async () => {
    for (const enforced of [
      undefined,
      () => undefined,
      () => ({ capabilitiesDisabled: new Set(["standing_approvals"]) }),
    ]) {
      const s = i55BaseScenario();
      s.deps = createStandingRuleDeps({
        db: s.db,
        enforcedPolicy: enforced as never,
        getTribalKbConfig: () => undefined,
        now: () => i55Now,
      });
      const { exec, seen } = liveExecutor(s);
      expect((await exec.execute(s.action)).status).toBe("rejected");
      expect(seen.prompts).toBe(1);
    }
  });

  test("two concurrent claims with one action left: exactly one standing_approved, the other is asked", async () => {
    const s = i55BaseScenario();
    i55SetRuleColumn(s, "max_actions", 1);
    const a = liveExecutor(s, { answer: { approved: true, answerSource: "human" } });
    const b = liveExecutor(s, { answer: { approved: true, answerSource: "human" } });
    const second = i55ArchiveAction(s.wf, { threadId: "thread-2" });
    const [r1, r2] = await Promise.all([a.exec.execute(s.action), b.exec.execute(second)]);
    expect(r1.status).toBe("ok");
    expect(r2.status).toBe("ok");
    const statuses = auditRows(s.db)
      .map((r) => r.hitl_status)
      .sort();
    expect(statuses).toEqual(["approved", "standing_approved"]);
    expect(a.seen.prompts + b.seen.prompts).toBe(1);
    expect(i55Counters(s)).toEqual({ used: 1, fires: 1 });
  });

  test("a failed audit append dispatches nothing and the claim stays consumed (stated bound)", async () => {
    const s = i55BaseScenario();
    const { exec, seen } = liveExecutor(s, { failAudit: true });
    await expect(exec.execute(s.action)).rejects.toThrow("audit append failed");
    expect(seen.dispatched).toEqual([]);
    expect(i55Counters(s)).toEqual({ used: 1, fires: 1 });
  });

  test("an executor built WITHOUT the standing-rule dependencies never standing-approves a perfectly matching action", async () => {
    const s = i55BaseScenario();
    const { exec, seen } = liveExecutor(s, { withRules: false });
    expect((await exec.execute(s.action)).status).toBe("rejected");
    expect(seen.prompts).toBe(1);
    expect(i55Counters(s)).toEqual({ used: 0, fires: 0 });
  });

  test("census: no production `new ToolExecutor(` site is handed standing-rule dependencies, except through buildWorkflowWriteExecutor", async () => {
    const sites: string[] = [];
    for (const f of await readDirFiles("packages/gateway/src")) {
      if (f.rel.endsWith(".test-helpers.ts")) continue;
      const code = stripComments(f.contents);
      let at = code.indexOf("new ToolExecutor(");
      while (at !== -1) {
        // The argument list: up to the matching close paren.
        let depth = 0;
        let end = at + "new ToolExecutor".length;
        for (; end < code.length; end++) {
          if (code[end] === "(") depth++;
          else if (code[end] === ")" && --depth === 0) break;
        }
        const args = code.slice(at, end);
        sites.push(f.rel);
        expect(args, `${f.rel} passes standing rules to a ToolExecutor directly`).not.toMatch(
          /standingRules/,
        );
        at = code.indexOf("new ToolExecutor(", end);
      }
    }
    expect(sites.length).toBeGreaterThan(5);
    // The one place the dependencies are given: run-ask's private workflow maker (SA4), which both the
    // attended and the unattended builder call.
    const askSrc = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    const at = askSrc.indexOf("function newWorkflowWriteExecutor(");
    const body = askSrc.slice(at, askSrc.indexOf("\n}\n", at));
    expect(body).toMatch(/standingRules:\s*createStandingRuleDeps\(/);
    expect(askSrc.match(/standingRules\s*:/g) ?? []).toHaveLength(1);
    // The model door's and the ask turn's executors have none.
    const door = askSrc.slice(
      askSrc.indexOf("export function buildModelWriteExecutor("),
      askSrc.indexOf("export function buildWorkflowWriteExecutor("),
    );
    expect(door).not.toContain("standingRules");
  });

  test("gateway-main hands the workflow executor the LIVE policy accessor, and nothing else the check reads", async () => {
    const src = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    const at = src.indexOf("buildWorkflowWriteExecutor({");
    const body = src.slice(at, src.indexOf("\n          }),", at));
    expect(body).toMatch(/enforcedPolicy:\s*platform\.enforcedPolicy/);
  });

  test("the HITL set holds both standing action types and no write row routes to them (never an MCP proposal)", async () => {
    for (const t of ["standing.rule.create", "standing.rule.resume"]) {
      expect(HITL_REQUIRED.has(t), t).toBe(true);
      expect(agentDoorRow(t), t).toBeUndefined();
    }
  });

  test("I20: an active delegate is never asked to approve standing.rule.create or standing.rule.resume", async () => {
    for (const type of ["standing.rule.create", "standing.rule.resume"]) {
      let asked = 0;
      let prompts = 0;
      const exec = new ToolExecutor(
        {
          requestApproval: async () => {
            prompts += 1;
            return { approved: false, answerSource: "human" as const };
          },
        },
        { recordAudit: () => {} },
        { dispatch: async () => ({}) },
        {
          store: {
            activeDelegateePeer: () => "peer:delegate",
            activeDelegateFor: () => true,
          } as never,
          requestRemote: async () => {
            asked += 1;
            return { kind: "answered", approved: true, peerId: "peer:delegate" } as never;
          },
          isOperatorValid: () => true,
        } as never,
        NULL_EGRESS_SINK,
      );
      const out = await exec.gate({ type, payload: { promptText: "x" } });
      expect(out, type).toEqual({ status: "rejected", reason: "User declined consent gate." });
      expect(asked, type).toBe(0);
      expect(prompts, type).toBe(1);
    }
    const src = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    // The delegation fallback is the one owner-only predicate, which names both standing types.
    expect(src).toMatch(/isOwnerOnlyActionType\(action\.type\)/);
    expect(src).toMatch(/function isOwnerOnlyActionType[\s\S]*?isStandingRuleActionType\(type\)/);
  });

  test("a standing.create answered by --yes (auto), a script or an old client (unknown) is refused; only a human counts", async () => {
    for (const answerSource of ["auto", "script", "unknown"] as const) {
      const s = i55BaseScenario();
      const ask = createStandingOwnerAsk({
        consent: { requestApproval: async () => ({ approved: true, answerSource }) },
        audit: { recordAudit: (e) => appendAuditEntry(s.db, e) },
      });
      const out = await dispatchStandingRpc(
        "standing.create",
        { workflow: "weekly-mail-clean", step: "archive" },
        {
          db: s.db,
          callerKind: "cli",
          policyAllows: () => true,
          askOwner: ask,
          recordNarrowing: () => {},
          frozenHitl: (t) => HITL_REQUIRED.has(t),
          now: () => i55Now,
        },
      ).then(
        () => "created",
        (e: unknown) => (e as { rpcData?: { code?: string } }).rpcData?.code,
      );
      expect(out, answerSource).toBe("ERR_STANDING_NEEDS_HUMAN");
    }
  });

  test("standing.* is refused over LAN for every method, a write-permitted peer included", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    for (const m of ["list", "show", "fires", "create", "pause", "resume", "revoke", "anything"]) {
      expect(
        () => checkLanMethodAllowed(`standing.${m}`, { peerId: "peer:x", writeAllowed: true }),
        m,
      ).toThrow(/ERR_METHOD_NOT_ALLOWED/);
    }
  });

  test("the renderer allowlist names standing list/show/fires/pause/revoke and neither create nor resume", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of ["fires", "list", "pause", "revoke", "show"]) {
      expect(rust).toMatch(new RegExp(`^\\s*"standing\\.${m}",\\s*$`, "m"));
    }
    for (const m of ["create", "resume"]) {
      expect(rust).not.toMatch(new RegExp(`^\\s*"standing\\.${m}",\\s*$`, "m"));
      expect(rust).toContain(`assert!(!is_method_allowed("standing.${m}"));`);
    }
  });

  test("workflow.run derives the trigger from the connection: LAN, mcp, unknown and http runs carry no provenance", async () => {
    const { workflowTriggerOf } = await import("../ipc/server/inline-handlers.ts");
    expect(workflowTriggerOf("cli")).toBe("owner_cli");
    expect(workflowTriggerOf("ui")).toBe("owner_ui");
    for (const kind of ["unknown", "mcp", "http", "chatops", "fleet", "push"] as const) {
      expect(workflowTriggerOf(kind), kind).toBeUndefined();
    }
  });

  test("D44 exists with its clauses, run() calls it, and the production tree has no violation", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    for (const id of [
      "standing-provenance-confined",
      "standing-tables-confined",
      "standing-step-order-pinned",
      "standing-outcome-confined",
      "standing-rules-dep-confined",
      "standing-unattended-confined",
      "standing-learning-confined",
    ]) {
      expect(audit).toContain(id);
    }
    const runAt = audit.indexOf("async function run(");
    expect(audit.slice(runAt)).toContain("checkStandingApprovals(files)");
    const files = (await readDirFiles("packages/gateway/src")).map((f) => ({
      relPath: `packages/gateway/src/${f.rel}`,
      contents: f.contents,
    }));
    expect(checkStandingApprovals(files)).toEqual([]);
    for (const anchor of [
      "packages/gateway/src/standing/standing-rule-store.ts",
      "packages/gateway/src/engine/standing-rule-step.ts",
      "packages/gateway/src/automation/workflow-write-step.ts",
    ]) {
      expect(RULE_ANCHORS).toContain(anchor);
    }
  });
});

describe("I55 SA4 — a scheduled run is unattended: a rule or a block, never a prompt", () => {
  test("no client kind can produce the trigger `schedule`: only the scheduler module writes it", async () => {
    const { workflowTriggerOf } = await import("../ipc/server/inline-handlers.ts");
    for (const kind of [
      "cli",
      "mcp",
      "ui",
      "http",
      "chatops",
      "fleet",
      "push",
      "unknown",
    ] as const) {
      expect(workflowTriggerOf(kind), kind).not.toBe("schedule");
    }
    const sched = stripComments(
      await read("packages/gateway/src/automation/workflow-scheduler.ts"),
    );
    expect(sched.match(/trigger\s*:\s*"schedule"/g) ?? []).toHaveLength(1);
    // The scheduler can ask nobody: it names no consent coordinator, no client id and no builder.
    for (const forbidden of [
      /consent/i,
      /clientId/,
      /buildUnattendedWorkflowWriteExecutor/,
      /delegat/i,
    ]) {
      expect(sched, String(forbidden)).not.toMatch(forbidden);
    }
  });

  test("the unattended builder takes no client and no consent coordinator, and uses a channel that denies", async () => {
    const src = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    expect(src).toMatch(
      /export type UnattendedWorkflowWriteExecutorParams = Omit<\s*WorkflowWriteExecutorParams,\s*"clientId" \| "consentCoordinator"\s*>/,
    );
    const at = src.indexOf("export function buildUnattendedWorkflowWriteExecutor(");
    const body = src.slice(at, src.indexOf("\n}\n", at));
    expect(body).toContain("NEVER_ASKED_CONSENT");
    expect(body).not.toContain("bindConsentChannel");
    const from = src.indexOf("const NEVER_ASKED_CONSENT");
    const channel = src.slice(from, src.indexOf("\n};\n", from));
    expect(channel).toContain("approved: false");
  });

  test("gateway-main builds the scheduler from a factory, behind the demo check, and retires it on shutdown", async () => {
    const src = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    const at = src.indexOf("const workflowScheduler =");
    expect(at).toBeGreaterThan(-1);
    const body = src.slice(at, src.indexOf("\n        });\n", at));
    expect(body).toMatch(/platform\.paths\.demo === true\s*\?\s*undefined/);
    expect(body).toMatch(/makeExecutor:\s*\(\)\s*=>\s*buildUnattendedWorkflowWriteExecutor\(/);
    expect(body).not.toContain("consentCoordinator");
    expect(body).not.toContain("clientId");
    expect(body).toMatch(/enforcedPolicy:\s*platform\.enforcedPolicy/);
    // Retired on shutdown and its drain AWAITED (started together with the briefing scheduler's, MB5,
    // so neither timer keeps ticking while the other drains).
    expect(src).toMatch(/const workflowsRetired = workflowScheduler\?\.retire\(\)/);
    expect(src).toMatch(/await Promise\.all\(\[briefingRetired, workflowsRetired\]\)/);
    // Started only after the socket is serving.
    expect(src.indexOf("workflowScheduler?.start()")).toBeGreaterThan(
      src.indexOf("await platform.ipc.start()"),
    );
  });

  test("workflow.resume is local-only and beyond any peer's write grant; unscheduling is a write method", async () => {
    const { checkLanMethodAllowed } = await import("../ipc/lan-rpc.ts");
    const peer = { peerId: "p", writeAllowed: true };
    expect(() => checkLanMethodAllowed("workflow.resume", peer)).toThrow(/not callable over LAN/);
    expect(() =>
      checkLanMethodAllowed("workflow.unschedule", { ...peer, writeAllowed: false }),
    ).toThrow(/ERR_LAN_WRITE_FORBIDDEN/);
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).toMatch(/^\s*"workflow\.scheduleList",\s*$/m);
    expect(rust).not.toMatch(/^\s*"workflow\.resume",\s*$/m);
    expect(rust).not.toMatch(/^\s*"workflow\.unschedule",\s*$/m);
  });

  test("a schedule is set only through workflow.save from a cli or ui connection (the kind comes from the server)", async () => {
    const dispatch = await read("packages/gateway/src/ipc/server/dispatchers.ts");
    expect(dispatch).toMatch(/clientKind:\s*ctx\.getClientKind\(clientId\)/);
    const sched = stripComments(await read("packages/gateway/src/automation/workflow-schedule.ts"));
    expect(sched).toMatch(/new Set<ClientKind>\(\["cli", "ui"\]\)/);
  });
});

describe("I55 SA5 — approval learning only suggests: it never creates, widens or approves a rule", () => {
  test("the learning pass and its store name no rule writer, no owner prompt and no executor", async () => {
    for (const rel of [
      "packages/gateway/src/standing/approval-learning.ts",
      "packages/gateway/src/standing/standing-suggestion-store.ts",
    ]) {
      const src = stripComments(await read(rel));
      for (const forbidden of [
        /\binsertRule\b/,
        /\bresumeRule\b/,
        /\bclaimFire\b/,
        /\bToolExecutor\b/,
        /\baskOwner\b/,
        /standing\.rule\.create/,
        /\bstanding_rule\b/,
      ]) {
        expect(src, `${rel} ${String(forbidden)}`).not.toMatch(forbidden);
      }
    }
  });

  test("reaching the threshold with hand approvals leaves no rule; a --yes or scripted answer earns nothing", async () => {
    const { appendAuditEntry } = await import("../db/audit-chain.ts");
    const { learnFromStepRun } = await import("../standing/approval-learning.ts");
    const { listSuggestions } = await import("../standing/standing-suggestion-store.ts");
    const { listRules } = await import("../standing/standing-rule-store.ts");
    const run = async (source: string): Promise<{ suggestions: number; rules: number }> => {
      const db = new Database(":memory:");
      runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
      for (let i = 0; i < 5; i += 1) {
        const r = {
          runId: `r${String(i)}`,
          workflowId: "wf",
          workflowSha256: "a".repeat(64),
          stepIndex: 1,
          actionType: "gmail.thread.archive",
          workflowName: "w",
          stepLabel: "s",
          ruleEligibleGuard: true,
          trigger: "owner_cli" as const,
          startedAt: 1,
        };
        appendAuditEntry(db, {
          actionType: r.actionType,
          hitlStatus: "approved",
          actionJson: JSON.stringify({
            action: {
              type: r.actionType,
              provenance: {
                kind: "owner_workflow",
                workflowId: r.workflowId,
                workflowSha256: r.workflowSha256,
                stepIndex: r.stepIndex,
                runId: r.runId,
              },
            },
            answerSource: source,
          }),
          timestamp: 2,
        });
        learnFromStepRun(db, r, {
          enabled: () => true,
          suggestAfter: () => 5,
          currentSha: () => r.workflowSha256,
        });
      }
      return { suggestions: listSuggestions(db, "open").length, rules: listRules(db).length };
    };
    expect(await run("human")).toEqual({ suggestions: 1, rules: 0 });
    for (const source of ["auto", "script", "unknown", "delegate", "remote"]) {
      expect(await run(source), source).toEqual({ suggestions: 0, rules: 0 });
    }
  });

  test("accepting a suggestion is the same owner approval: a non-human answer or a decline creates no rule", async () => {
    const { openSuggestion, getSuggestion } = await import(
      "../standing/standing-suggestion-store.ts"
    );
    const { listRules } = await import("../standing/standing-rule-store.ts");
    for (const reason of ["not_human", "declined"] as const) {
      const db = i55FreshDb();
      const wf = i55SeedWorkflow(db);
      const s = openSuggestion(
        db,
        { workflowId: wf.id, workflowSha256: wf.sha, stepIndex: 1 },
        5,
        i55Now,
      );
      const ctx = {
        db,
        callerKind: "cli" as const,
        policyAllows: () => true,
        askOwner: async () => ({ approved: false as const, reason }),
        recordNarrowing: () => {},
        frozenHitl: (t: string) => HITL_REQUIRED.has(t),
        now: () => i55Now,
      };
      await expect(
        dispatchStandingRpc("standing.create", { fromSuggestion: s?.id }, ctx),
      ).rejects.toBeInstanceOf(Error);
      expect(listRules(db)).toHaveLength(0);
      expect(getSuggestion(db, s?.id ?? "")?.status).toBe("open");
    }
  });

  test("the renderer allowlist names suggestions and dismissSuggestion, and still not create", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    for (const m of ["suggestions", "dismissSuggestion"]) {
      expect(rust).toMatch(new RegExp(`^\\s*"standing\\.${m}",\\s*$`, "m"));
    }
    expect(rust).not.toMatch(/^\s*"standing\.create",\s*$/m);
  });

  test("the runner reaches the pass only through the optional learning config; gateway-main builds it behind the demo flag", async () => {
    const runner = stripComments(await read("packages/gateway/src/automation/workflow-runner.ts"));
    expect(runner).toMatch(/p\.learning === undefined/);
    const main = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    expect(main).toMatch(
      /learning:\s*buildLearningConfig\(\{\s*demo:\s*platform\.paths\.demo === true/,
    );
    const cfg = stripComments(await read("packages/gateway/src/standing/learning-config.ts"));
    expect(cfg).toMatch(/if \(src\.demo\) return false/);
    expect(cfg).toContain("isStandingApprovalsEnabled(");
  });

  test("the two learning tables exist at V90 and the lockoff default is the SA3 accessor (absent = off)", async () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(90);
    const { buildLearningConfig } = await import("../standing/learning-config.ts");
    expect(buildLearningConfig({ demo: false, configDir: "x" }).enabled()).toBe(false);
  });
});

describe("I55 — a workflow `when` guard only removes runs and can never widen a rule (workflow conditionals)", () => {
  // The behavioural proofs (a not-taken rule-covered write dispatches, asks and claims nothing; an
  // edited guard changes the hash; every absence-satisfiable guard is refused at rule creation,
  // resume and learning; a resume whose guard lapsed stops) are in
  // `automation/workflow-runner-guards.test.ts` and `ipc/standing-rpc-guard.test.ts`, through the
  // real runner, executor, ledger and store. These are the structural pins.
  test("the approval check never reads a guard and the guard module imports only types and the sanitiser", async () => {
    const step = await read("packages/gateway/src/engine/standing-rule-step.ts");
    expect(/\.\s*when\b|\bwhen\s*[:,}]|workflow-guard|\bguardRequiresPresence\b/.test(step)).toBe(
      false,
    );
    const guard = await read("packages/gateway/src/automation/workflow-guard.ts");
    const specs = [...guard.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1]);
    expect(specs.sort()).toEqual(
      ["../connectors/connector-writes/sanitise.ts", "./workflow-steps.ts"].sort(),
    );
  });

  test("rule creation, rule resume and the learner all consult the one presence definition", async () => {
    const derive = await read("packages/gateway/src/standing/standing-rule-derive.ts");
    expect(derive).toContain("guardRequiresPresence(step.when)");
    const rpc = await read("packages/gateway/src/ipc/standing-rpc.ts");
    expect(rpc).toContain("guardRequiresPresence(step.when)");
    const runner = await read("packages/gateway/src/automation/workflow-runner.ts");
    expect(runner).toContain("ruleEligibleGuard: guardRequiresPresence(step.when)");
    const learning = await read("packages/gateway/src/standing/approval-learning.ts");
    expect(learning).toContain('if (!run.ruleEligibleGuard) return { kind: "off" };');
  });

  test("a guard is decided before an action exists: the runner evaluates it ahead of the write step and the model step", async () => {
    const runner = await read("packages/gateway/src/automation/workflow-runner.ts");
    const at = (needle: string): number => runner.indexOf(needle);
    expect(at("decideGuard(p, runId, stepIndex, step, state)")).toBeGreaterThan(-1);
    expect(at("decideGuard(p, runId, stepIndex, step, state)")).toBeLessThan(
      at("executeRunStep(p, runId, stepIndex, step, state.outputs)"),
    );
    expect(at("decideGuard(p, runId, stepIndex, step, state)")).toBeLessThan(
      at("await executeWriteStep(p, runId, stepIndex, step, state, decided.evaluation)"),
    );
  });

  test("a guarded write step is built only from a guard that held (fail closed in depth)", async () => {
    const ws = await read("packages/gateway/src/automation/workflow-write-step.ts");
    expect(ws).toContain("run.guard?.holds !== true");
  });
});
