import { describe, expect, test } from "bun:test";
import { stripComments, stripStringLiterals } from "../../../../scripts/structure-audit/lib.ts";
import { grepRepo, read, readDirFiles } from "../../test/helpers/security-invariants.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";

describe("Phase 28 AD3a-1 - the agent door's approval list (the owner's enable, status and store)", () => {
  test("AD3a-1: the dispatcher wraps the consent in humanOnlyConsent for the agent enable alone, before the executor is built", async () => {
    const src = stripStringLiterals(
      stripComments(await read("packages/gateway/src/ipc/server/dispatchers.ts")),
    );
    const rawSrc = stripComments(await read("packages/gateway/src/ipc/server/dispatchers.ts"));
    const fn = rawSrc.slice(rawSrc.indexOf("export async function tryDispatchConnectorRpc("));
    const body = fn.slice(0, fn.indexOf("\nexport "));
    const iCond = body.indexOf('method === "connector.writesEnable"');
    const iDoor = body.indexOf('"door"] === "agent"');
    const iWrap = body.indexOf("humanOnlyConsent(");
    const iExec = body.indexOf("new ToolExecutor(");
    expect(iCond).toBeGreaterThan(-1);
    expect(iDoor).toBeGreaterThan(iCond);
    expect(iWrap).toBeGreaterThan(iDoor);
    expect(iExec).toBeGreaterThan(iWrap);
    // the connection's kind is the connection's, never a param
    expect(body).toMatch(/clientKind:\s*ctx\.getClientKind\(clientId\)/);
    expect(src).toContain("humanOnlyConsent");
  });

  test("AD3a-1: handleAgentWritesEnable checks the caller, then lists once, then asks the owner, then writes in one transaction", async () => {
    const src = stripComments(
      await read("packages/gateway/src/ipc/connector-rpc-handlers/agent-writes.ts"),
    );
    const start = src.indexOf("export async function handleAgentWritesEnable(");
    const body = src.slice(start, src.indexOf("\n}\n", start));
    const order = [
      "requireAgentEnableCaller(",
      "parseWave(",
      "requireEligibleService(",
      "refuseScopeParams(",
      "requireAgentPolicy(",
      "deps.listServerTools",
      "agentApprovableRows(",
      "requireOwnerApproval(",
      "deps.db.transaction(",
      "raiseWriteEnablementWave(",
      "replaceDoorApprovals(",
    ].map((m) => body.indexOf(m));
    for (const i of order) expect(i).toBeGreaterThan(-1);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(body.match(/deps\.listServerTools/g)).toHaveLength(1);
    // the gate is reached only inside requireOwnerApproval, and is the type the frozen set holds
    expect(src).toContain('executor.gate({ type: "connector.writes.enable", payload })');
  });

  test("AD3a-1: the approval table is named only by its store and its DDL file in production source", async () => {
    const files = await grepRepo(/connector_write_door_approval/);
    expect(files).toEqual([
      "packages/gateway/src/connectors/connector-writes/door-approval-store.ts",
      "packages/gateway/src/index/agent-door-v97-sql.ts",
    ]);
  });

  test("AD3a-1: no connector.writes* method is renderer-callable, and the three stay off the LAN", async () => {
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    const listed = rust
      .split("\n")
      .filter((l) => !/^\s*\/\//.test(l) && !/assert!|fn |#\[/.test(l))
      .filter((l) => l.includes('"connector.writes'));
    expect(listed).toEqual([]);
    // Behaviour, not text: enable and disable also sit in WRITE_METHODS, so a source match would pass
    // after one left FORBIDDEN_OVER_LAN. A peer WITH write permission must still be refused outright.
    const { checkLanMethodAllowed, LanError } = await import("../ipc/lan-rpc.ts");
    for (const m of [
      "connector.writesEnable",
      "connector.writesDisable",
      "connector.writesStatus",
    ]) {
      const call = () => checkLanMethodAllowed(m, { peerId: "peer:x", writeAllowed: true });
      expect(call, m).toThrow(LanError);
      expect(call, m).toThrow(/ERR_METHOD_NOT_ALLOWED/);
    }
  });

  test("AD3a-2a: the capture gate and the act path never name the approval store; the list reaches them only by injection (D32(f))", async () => {
    for (const rel of [
      "packages/gateway/src/mcp-sink/capture-gate.ts",
      "packages/gateway/src/mcp-sink/capture-act.ts",
      "packages/gateway/src/mcp-sink/capture-types.ts",
      "packages/gateway/src/mcp-sink/capture-store.ts",
    ]) {
      const src = stripComments(await read(rel));
      expect(src, rel).not.toMatch(/door-approval-store|listDoorApprovals|getDoorApproval/);
    }
    // `mcp-sink/` imports nothing from `connectors/`: the verdict, the refusal and the definition
    // check are injected functions.
    for (const rel of [
      "packages/gateway/src/mcp-sink/capture-gate.ts",
      "packages/gateway/src/mcp-sink/capture-act.ts",
      "packages/gateway/src/mcp-sink/capture-types.ts",
    ]) {
      expect(stripComments(await read(rel)), rel).not.toMatch(/from "\.\.\/connectors\//);
    }
  });
});

describe("I58 - an outside agent proposes only what the owner approved for agents by name, re-derived at submit, at approval and after the owner's answer", () => {
  const OWNER = { clientId: "c-cli", kind: "cli" as const };
  const AGENT = { clientId: "c-mcp", kind: "mcp" as const };
  const HEAD = "0123456789abcdef0123456789abcdef01234567";

  /** A real door over a migrated in-memory database, with a mutable fake mesh listing. */
  async function i58Harness() {
    const { openMigratedMemoryDb } = await import("../index/migrated-db-template.ts");
    const { createAgentDoor } = await import(
      "../connectors/connector-writes/agent-door-runtime.ts"
    );
    const { definitionSha256 } = await import("../connectors/connector-writes/definition-hash.ts");
    const { upsertDoorApprovals } = await import(
      "../connectors/connector-writes/door-approval-store.ts"
    );
    const { raiseWriteEnablementWave } = await import(
      "../connectors/connector-writes/enablement-store.ts"
    );
    const { previewTemplateKeys } = await import("../connectors/connector-writes/types.ts");
    const { mcpClientToolKey } = await import("../connectors/lazy-mesh/tool-map.ts");
    const { toStandardSchema } = await import("@mastra/core/schema");
    const { DEFAULT_MCP_SINK_CONFIG } = await import("../config/mcp-sink-toml.ts");
    const { resolveCaptureCapability } = await import("../mcp-sink/capture-capability.ts");
    const { CaptureAttemptLimiter, CaptureRefusalCounter } = await import(
      "../mcp-sink/capture-rate-limit.ts"
    );
    const { CaptureStore } = await import("../mcp-sink/capture-store.ts");
    const db = openMigratedMemoryDb();
    const state = {
      disabled: new Set<string>(),
      description: (t: string) => `d ${t}`,
      mesh: "bound" as "bound" | "unbound",
      clock: 1_000,
      seq: 0,
    };
    const enforced = () =>
      ({
        capabilitiesDisabled: state.disabled,
        chatops: { channels: new Map(), ownership: new Map() },
      }) as never;
    const listing = (service: string): Record<string, unknown> => {
      const out: Record<string, unknown> = {};
      for (const r of CONNECTOR_WRITE_ROWS) {
        if (r.actionType.split(".")[0] !== service) continue;
        const keys = r.preview === undefined ? [] : [...previewTemplateKeys(r.preview)];
        const schema = (ks: readonly string[]) =>
          toStandardSchema({
            type: "object",
            properties: Object.fromEntries(ks.map((k) => [k, { type: "string" }])),
          } as Parameters<typeof toStandardSchema>[0]);
        out[mcpClientToolKey(service, r.toolId)] = {
          description: state.description(r.toolId),
          inputSchema: schema(keys),
        };
        for (const t of [r.before?.tool, r.before?.also?.tool]) {
          if (t !== undefined) {
            out[mcpClientToolKey(service, t)] ??= { description: "read", inputSchema: schema([]) };
          }
        }
      }
      return out;
    };
    const door = createAgentDoor({
      db,
      enforcedPolicy: enforced,
      listServerTools: async (s) => (state.mesh === "bound" ? listing(s) : undefined),
      tribalKbConfig: () => undefined,
      userMcpPolicy: { userMcpModelAccessAllowed: () => false },
      isServiceConfigured: async () => true,
      now: () => state.clock,
    });
    const store = new CaptureStore(db);
    const gate = {
      db,
      store,
      capability: () =>
        resolveCaptureCapability(
          {
            ok: true,
            config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
          },
          enforced(),
        ),
      limiter: new CaptureAttemptLimiter(),
      refusals: new CaptureRefusalCounter(),
      newId: () => `cap_${String(++state.seq)}`,
      now: () => state.clock,
      classifyAction: door.verdict,
      isServiceConfigured: async () => true,
      actionDestinationRefusal: door.refusal,
      verifyActionDefinition: door.verifyDefinition,
    };
    const approve = (service: string, wave: 2 | 3 | 4, toolIds: readonly string[]) => {
      raiseWriteEnablementWave(db, service, wave, state.clock);
      const l = listing(service);
      upsertDoorApprovals(
        db,
        "agent",
        service,
        toolIds.map((toolId) => ({
          toolId,
          definitionSha256: definitionSha256(
            toolId,
            l[mcpClientToolKey(service, toolId)],
          ) as string,
        })),
        state.clock,
      );
    };
    return { db, state, door, gate, store, approve, listing };
  }

  const submitAction = async (
    h: Awaited<ReturnType<typeof i58Harness>>,
    actionType: string,
    input: Record<string, unknown>,
  ) => {
    const { submitCapture } = await import("../mcp-sink/capture-gate.ts");
    return submitCapture(h.gate as never, AGENT, {
      kind: "action",
      payload: { actionType, input, summary: "why" },
    });
  };
  const codeOf = async (p: Promise<unknown>): Promise<string | undefined> => {
    try {
      await p;
    } catch (e) {
      return (e as { code?: string }).code;
    }
    return undefined;
  };
  const MERGE = { owner: "o", repo: "r", pullNumber: 1, sha: HEAD };

  test("the wiring: assemble builds the agent door over the live policy, injects its verdict, refusal, definition check and accepted types into the capture gate and its definition check into the act wiring, and binds the mesh listing after the mesh exists", async () => {
    const a = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    for (const needle of [
      "const agentDoor = createAgentDoor({",
      "classifyAction: agentDoor.verdict,",
      "actionDestinationRefusal: agentDoor.refusal,",
      "verifyActionDefinition: agentDoor.verifyDefinition,",
      "listProposableActionTypes: agentDoor.acceptedTypes,",
      "verifyDefinition: agentDoor.verifyDefinition,",
      "actions: agentDoor.describe",
      "listServerTools: async (service) => agentDoorMesh.current?.listFirstPartyServerTools(service),",
      "agentDoorMesh.current = connectorMesh;",
    ]) {
      expect(a, needle).toContain(needle);
    }
    // The listing holder starts unbound (fail closed) and is built before the gate that uses it.
    expect(a).toMatch(/agentDoorMesh:[^=]*= \{\s*current: undefined,\s*\};/);
    const holder = a.indexOf("const agentDoorMesh");
    const door = a.indexOf("const agentDoor = createAgentDoor({");
    const gate = a.indexOf("const captureGate: CaptureGateDeps = {");
    const mesh = a.indexOf("} = await createSchedulerWithMesh({");
    const bind = a.indexOf("agentDoorMesh.current = connectorMesh;");
    expect(holder).toBeGreaterThan(0);
    expect(door).toBeGreaterThan(holder);
    expect(gate).toBeGreaterThan(door);
    expect(mesh).toBeGreaterThan(gate);
    expect(bind).toBeGreaterThan(mesh);
    // The earlier table is gone (static D49(a)).
    expect(a).not.toMatch(
      /classifyActionType|ACTION_PROPOSABILITY|PROPOSABLE_WRITE_TOOLS|createActionDestinationRefusal/,
    );
  });

  test("the order of the three check points on the real files (static D49(e))", async () => {
    const at = (s: string, ...needles: string[]) => {
      const idx = needles.map((n) => s.indexOf(n));
      expect(
        idx.every((i) => i >= 0),
        needles.join(" < "),
      ).toBe(true);
      expect([...idx].sort((x, y) => x - y)).toEqual(idx);
    };
    const gate = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    const submit = gate.slice(gate.indexOf("export async function submitCapture("));
    at(
      submit,
      "deps.classifyAction?.(v.payload.actionType)",
      "requireDestinationAllowed(ctx, v, basis)",
      "await requireDefinitionVerified(ctx, v, basis)",
      "writeSubmittedCapture(ctx, v, cap, now, basis)",
    );
    const act = stripComments(await read("packages/gateway/src/mcp-sink/capture-act.ts"));
    const accept = act.slice(act.indexOf("export async function acceptAction("));
    at(
      accept,
      "requireVerdictAtApproval(deps, stored.actionType)",
      "actionDestinationVerdict(deps, stored.actionType, stored.input, basis)",
      "await requireDefinitionAtApproval(deps, stored.actionType, basis)",
      "deps.store.claimAction(",
    );
    const rpc = stripComments(await read("packages/gateway/src/ipc/capture-rpc.ts"));
    const build = rpc.slice(rpc.indexOf("export function buildActDeps("));
    at(build, "const channel =", "vetoingConsent(", "buildAgentWriteExecutor({");
    expect(build).toMatch(/consentCoordinator: channel,/);
    // The veto covers every proposal (the only basis is `approved`, AD3b): a proposal with no
    // approved basis or no door runtime is refused before the executor is built. The check
    // receives what the prompt showed.
    expect(build).toMatch(/provenance\.basis !== "approved" \|\| door === undefined/);
    expect(build).toMatch(/door !== undefined\s*\? vetoingConsent\(/);
    expect(build).toMatch(/door\.verifyDefinition\(actionType, provenance\.createdAt, shown\)/);
    // Its one user is the act deps (the wrapper lives in ipc/consent.ts for static D41(a)).
    const users = (await grepRepo(/\bvetoingConsent\b/)).filter(
      (p) => !p.endsWith("/ipc/consent.ts"),
    );
    expect(users).toEqual(["packages/gateway/src/ipc/capture-rpc.ts"]);
  });

  test("the earlier proposability table, the act door's own refusal and the legacy basis exist in no production file (static D49(a))", async () => {
    const names =
      /\b(?:ACTION_PROPOSABILITY|classifyActionType|proposableWriteTool|PROPOSABLE_WRITE_TOOLS|actDoorRefusal|isLegacyBasis|agentDoorLegacy|legacyActionTypesSince|legacy_unapproved|legacy_mail_send|legacy_user_mcp)\b/;
    const files: string[] = [];
    for (const rel of await grepRepo(names)) {
      if (rel.endsWith(".test.ts") || rel.endsWith(".test-helpers.ts")) continue;
      if (rel.startsWith("scripts/") || rel.startsWith("docs/")) continue;
      if (names.test(stripComments(await read(rel)))) files.push(rel);
    }
    expect(files).toEqual([]);
    expect(
      await grepRepo(/AGENT_DOOR_NOT_ENFORCED_NOTICE|takes effect in a later release/),
    ).toEqual([]);
  });

  test("an approved Wave 4 type is accepted at submit; one the owner did not approve, and a bound one, are not", async () => {
    const h = await i58Harness();
    try {
      expect(await codeOf(submitAction(h, "github.pr.merge", MERGE))).toBe(
        "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      );
      expect(await codeOf(submitAction(h, "github.file.commit", {}))).toBe(
        "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      );
      h.approve("github", 4, ["github_pr_merge"]);
      const out = await submitAction(h, "github.pr.merge", MERGE);
      expect(out.state).toBe("proposed");
      expect(out).not.toHaveProperty("legacy");
      // The sibling Wave 4 tool the owner did not name is still refused.
      expect(await codeOf(submitAction(h, "github.branch.delete", {}))).toBe(
        "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      );
    } finally {
      h.db.close();
    }
  });

  test("the listing holder fails closed: before the mesh is bound no approved proposal is accepted and nothing is marked", async () => {
    const h = await i58Harness();
    try {
      h.approve("github", 4, ["github_pr_merge"]);
      h.state.mesh = "unbound";
      expect(await codeOf(submitAction(h, "github.pr.merge", MERGE))).toBe(
        "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      );
      const { getDoorApproval } = await import(
        "../connectors/connector-writes/door-approval-store.ts"
      );
      expect(getDoorApproval(h.db, "agent", "github", "github_pr_merge")?.suspendedAt).toBeNull();
      h.state.mesh = "bound";
      expect((await submitAction(h, "github.pr.merge", MERGE)).state).toBe("proposed");
    } finally {
      h.db.close();
    }
  });

  test("a changed definition suspends the tool at submit and at approval", async () => {
    const { acceptCapture } = await import("../mcp-sink/capture-gate.ts");
    const h = await i58Harness();
    try {
      h.approve("github", 4, ["github_pr_merge"]);
      const queued = await submitAction(h, "github.pr.merge", MERGE);
      let executed = 0;
      const act = {
        humanOnly: true,
        execute: async () => {
          executed++;
          return { status: "ok" as const, result: {} };
        },
      };
      h.state.description = (t) => (t === "github_pr_merge" ? "changed" : `d ${t}`);
      // At approval: refused, the row stays proposed, nothing executes.
      expect(
        await codeOf(Promise.resolve(acceptCapture(h.gate as never, OWNER, queued.id, act))),
      ).toBe("ERR_AGENT_TOOL_SUSPENDED");
      expect(h.store.get(queued.id)?.state).toBe("proposed");
      expect(executed).toBe(0);
      // At submit: the same code, and the tool stays suspended after the text changes back.
      h.state.description = (t) => `d ${t}`;
      expect(await codeOf(submitAction(h, "github.pr.merge", MERGE))).toBe(
        "ERR_AGENT_TOOL_SUSPENDED",
      );
    } finally {
      h.db.close();
    }
  });

  test("a definition changed after the owner answered is vetoed before the executor records the answer: rejected, blocked, nothing dispatched, tool marked", async () => {
    const { buildActDeps } = await import("../ipc/capture-rpc.ts");
    const { makeEgressSink } = await import("../egress/egress-ledger.ts");
    const { appendAuditEntry } = await import("../db/audit-chain.ts");
    const { NO_POLICY_OVERLAY } = await import("../engine/executor.ts");
    const { isBeforeReadActionType } = await import("../engine/before-state.ts");
    const { getDoorApproval } = await import(
      "../connectors/connector-writes/door-approval-store.ts"
    );
    const h = await i58Harness();
    try {
      h.approve("github", 4, ["github_pr_merge"]);
      const dispatched: Array<{ type: string }> = [];
      const coordinator = {
        requestConsent: async () => {
          h.state.description = (t) => (t === "github_pr_merge" ? "changed under you" : `d ${t}`);
          return { approved: true, answerSource: "human" as const };
        },
        requestConfirmedConsent: async (_c: string, req: { confirmText: string }) => {
          h.state.description = (t) => (t === "github_pr_merge" ? "changed under you" : `d ${t}`);
          return { approved: true, typed: req.confirmText, answerSource: "human" as const };
        },
      } as never;
      const act = buildActDeps(
        {
          dispatcher: {
            dispatch: (a: { type: string }) => {
              dispatched.push(a);
              return Promise.resolve(
                isBeforeReadActionType(a.type)
                  ? {
                      title: "t",
                      state: "open",
                      head: { ref: "f", sha: HEAD },
                      base: { ref: "main" },
                    }
                  : { url: "x" },
              );
            },
          } as never,
          egressSink: makeEgressSink(h.db),
          audit: { recordAudit: (e) => appendAuditEntry(h.db, e) },
          policyHitl: NO_POLICY_OVERLAY,
          getTribalKbConfig: () => undefined,
          agentDoor: {
            listServerTools: async (s) => h.listing(s),
            verifyDefinition: h.door.verifyDefinition,
          },
        },
        coordinator,
        "c-cli",
        { humanOnly: { onNonHuman: () => {} } },
      );
      const out = await act.execute("github.pr.merge", MERGE, {
        basis: "approved",
        captureId: "cap_00010001000100010001000100010001",
        clientLabel: "agent",
        labelSource: "declared",
        createdAt: 0,
        expiresAt: 60_000,
        summary: "why",
      });
      expect(out).toMatchObject({ status: "rejected", code: "ERR_AGENT_TOOL_SUSPENDED" });
      expect(dispatched.filter((a) => !isBeforeReadActionType(a.type))).toEqual([]);
      const audit = h.db
        .query("SELECT hitl_status FROM audit_log WHERE action_type = 'github.pr.merge'")
        .all() as Array<{ hitl_status: string }>;
      expect(audit).toEqual([{ hitl_status: "rejected" }]);
      const ledger = h.db
        .query("SELECT result_status FROM egress_ledger WHERE method = 'github.pr.merge'")
        .all() as Array<{ result_status: string }>;
      expect(ledger.map((r) => r.result_status)).toEqual(["blocked"]);
      expect(
        getDoorApproval(h.db, "agent", "github", "github_pr_merge")?.suspendedAt,
      ).not.toBeNull();
    } finally {
      h.db.close();
    }
  });

  test("either lockoff refuses an approved type, and an unapproved one is refused whatever the policy (no earlier window)", async () => {
    const h = await i58Harness();
    try {
      h.approve("github", 4, ["github_pr_merge"]);
      expect(h.door.verdict("github.pr.merge")).toEqual({ kind: "proposable", basis: "approved" });
      h.state.disabled = new Set(["connector_write_model_access"]);
      expect(h.door.verdict("github.pr.merge").kind).toBe("denied");
      expect(h.door.verdict("github.issue.create").kind).toBe("denied");
      h.state.disabled = new Set(["mcp_action"]);
      expect(h.door.verdict("github.pr.merge").kind).toBe("denied");
    } finally {
      h.db.close();
    }
  });

  test("AD3b: a type the earlier act door accepted with no approval is refused at submit, and nothing is accepted but by the owner's approval by name (mail sends never)", async () => {
    const h = await i58Harness();
    try {
      for (const r of CONNECTOR_WRITE_ROWS) {
        expect(h.door.verdict(r.actionType).kind, r.actionType).not.toBe("proposable");
      }
      expect(await codeOf(submitAction(h, "github.issue.create", { title: "plain" }))).toBe(
        "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      );
      expect(await codeOf(submitAction(h, "gmail.message.send", { to: "a@x.com" }))).toBe(
        "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      );
      expect(h.door.verdict("slack.message.post").kind).toBe("denied");
    } finally {
      h.db.close();
    }
  });

  test("an approved proposal is still refused by the destination rules", async () => {
    const h = await i58Harness();
    try {
      h.approve("slack", 2, ["slack_message_post"]);
      const err = await submitAction(h, "slack.message.post", {
        channel: "C0123456789",
        text: "<!channel> hi",
      }).catch((e: unknown) => e as { code?: string; message?: string });
      expect((err as { code?: string }).code).toBe("ERR_CAPTURE_ACTION_REFUSED");
    } finally {
      h.db.close();
    }
  });
});

describe("AD1 — the agent origin is read through one helper, and the two outside origins cannot drift", () => {
  test("no production gateway file compares an action's origin to a string literal, except the helper and the standing-rule check", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const allowed = new Set(["engine/outside-origin.ts"]);
    const hits = files
      .filter((f) => !allowed.has(f.rel))
      .filter((f) => /\.origin\s*[!=]==?\s*["'](model|agent)["']/.test(f.contents))
      .map((f) => f.rel);
    expect(hits).toEqual([]);
    // The helper itself is where the two literals live, and the standing-rule check refuses any origin.
    const helper = await read("packages/gateway/src/engine/outside-origin.ts");
    expect(helper).toContain('return action.origin === "model";');
    expect(helper).toContain('return action.origin === "agent";');
    expect(helper).toContain("return isModelOrigin(action) || isAgentOrigin(action);");
    const standing = await read("packages/gateway/src/engine/standing-rule-step.ts");
    expect(standing).toContain("if (action.origin !== undefined) return undefined;");
  });

  test("the delegation fallback, the before-state runner and the Wave 4 guard all consult isOutsideOrigin", async () => {
    const exec = await read("packages/gateway/src/engine/executor.ts");
    expect(exec).toContain('if (isOutsideOrigin(action)) return "fallback";');
    const bs = await read("packages/gateway/src/engine/before-state.ts");
    expect(bs).toContain("if (isOutsideOrigin(action) && rows.some(");
    expect(bs).toContain("!isOutsideOrigin(action) && options.readsEveryOrigin !== true");
  });
});
