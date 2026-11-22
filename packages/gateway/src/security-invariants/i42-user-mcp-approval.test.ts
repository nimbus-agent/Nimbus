import { describe, expect, test } from "bun:test";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import { read } from "../../test/helpers/security-invariants.ts";
import { NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";

describe("I42 — every user-MCP tool call needs the local owner's approval", () => {
  test("gate() ORs the user-MCP floor with I2, after the frozen set and before the policy overlay", async () => {
    // OR, never assignment, and derived from `action.type` (I3) — so it only ever tightens and
    // a payload field cannot opt a call out.
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toMatch(
      /HITL_REQUIRED\.has\(action\.type\)\s*\|\|\s*isUserMcpActionType\(action\.type\)/,
    );
    expect(src).toMatch(
      /const requiresHITL =\s*HITL_REQUIRED\.has\(action\.type\)\s*\|\|\s*isUserMcpActionType\(action\.type\)\s*\|\|\s*this\.requiredByPolicy\(action\.type\);/,
    );
    expect(src).not.toMatch(/isUserMcpActionType\(\s*action\.payload/);
  });

  test('tryDelegatedApproval returns "fallback" for a user-MCP type before consulting any delegate (I20 not consulted)', async () => {
    const src = await read("packages/gateway/src/engine/executor.ts");
    const fnAt = src.indexOf("private async tryDelegatedApproval(");
    expect(fnAt).toBeGreaterThan(-1);
    const fnEnd = src.indexOf("\n  }\n", fnAt);
    expect(fnEnd).toBeGreaterThan(fnAt);
    const body = src.slice(fnAt, fnEnd);
    expect(body).toMatch(
      /if \(this\.delegation === undefined \|\| isUserMcpActionType\(action\.type\)\) return "fallback";/,
    );
    // ORDER: the early return precedes the first store lookup.
    expect(body.indexOf("isUserMcpActionType(action.type)")).toBeLessThan(
      body.indexOf("activeDelegateePeer("),
    );
  });

  test("behavioural: a DENYING owner blocks a user-MCP call that no frozen-set entry or policy names", async () => {
    const { HITL_REQUIRED, NO_POLICY_OVERLAY, ToolExecutor, isUserMcpActionType } = await import(
      "../engine/executor.ts"
    );
    const type = "mcp_x.y";
    expect(isUserMcpActionType(type)).toBe(true);
    // Precondition: neither I2 nor a policy is what gates it here.
    expect(HITL_REQUIRED.has(type)).toBe(false);
    let prompts = 0;
    let dispatches = 0;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          prompts += 1;
          return { approved: false, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      {
        dispatch: async () => {
          dispatches += 1;
          return {};
        },
      },
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
      undefined,
      { userMcpWriteGrants: () => [] },
    );
    const res = await exec.execute({ type, payload: {} });
    expect(res.status).toBe("rejected");
    expect(prompts).toBe(1);
    expect(dispatches).toBe(0);
  });

  test("share replay never runs a user-MCP tool: the classifier refuses it, and the runner refuses it again", async () => {
    // Replay runs tools with NO consent, from a share file a third party may have supplied, so a
    // user-MCP key must never classify read-only whatever verb it ends in.
    const { isReadOnlyToolId } = await import("../share/read-tool-registry.ts");
    for (const id of ["mcp_notes_search", "mcp_x_get", "mcp_a_b_list", "mcp_x_read"]) {
      expect(isReadOnlyToolId(id)).toBe(false);
    }
    const reg = await read("packages/gateway/src/share/read-tool-registry.ts");
    expect(reg).toMatch(/if \(isOwnerCodeServerToolKey\(toolId\)\) return false;/);
    // Second layer: the replay runner treats a user-MCP key as absent before it looks the tool up.
    const rpc = await read("packages/gateway/src/ipc/share-rpc.ts");
    const fnAt = rpc.indexOf("async function runReplayTool(");
    expect(fnAt).toBeGreaterThan(-1);
    const body = rpc.slice(fnAt, rpc.indexOf("\n}\n", fnAt));
    const guardAt = body.indexOf("if (isOwnerCodeServerToolKey(toolId))");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(body.indexOf("tools[toolId]"));
  });

  test("the dispatcher refuses a user-MCP key under any action type but its own (gate stays type-only, I3)", async () => {
    const { createConnectorDispatcher } = await import("../connectors/registry.ts");
    const ran: string[] = [];
    const d = createConnectorDispatcher({
      listTools: async () => ({
        mcp_x_echo: {
          execute: async () => {
            ran.push("mcp_x_echo");
            return {};
          },
        },
      }),
    });
    // An action of a first-party HITL type (delegable under I20) smuggling a user-MCP key.
    await expect(
      d.dispatch({ type: "github.pr_list", payload: { mcpToolId: "mcp_x_echo" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(ran).toEqual([]);
    await d.dispatch({ type: "mcp_x.echo", payload: { mcpToolId: "mcp_x_echo" } });
    expect(ran).toEqual(["mcp_x_echo"]);
    // Source pin: the check runs on the RESOLVED key, before the tool executes.
    const src = await read("packages/gateway/src/connectors/registry.ts");
    const dispatchAt = src.indexOf("async dispatch(action: PlannedAction)");
    expect(dispatchAt).toBeGreaterThan(-1);
    const assertAt = src.indexOf("assertUserMcpKeyMatchesActionType(", dispatchAt);
    expect(assertAt).toBeGreaterThan(dispatchAt);
    expect(assertAt).toBeLessThan(src.indexOf("execute(input, {})", dispatchAt));
  });

  test("ChatOps never offers user-MCP tools: its runAsk params say offerUserMcpTools: false explicitly", async () => {
    // ChatOps calls runAsk with clientId "chatops", which is NOT a registered ClientKind and would
    // read as `unknown` (= the plain CLI, an owner kind) if the decision were a lookup inside
    // runAsk. So the flag must be a literal false at this call site.
    const src = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    const at = src.indexOf("createChatOpsAskEngine((query) => ({");
    expect(at).toBeGreaterThan(-1);
    const end = src.indexOf("}))", at);
    expect(end).toBeGreaterThan(at);
    const body = src.slice(at, end);
    expect(body).toContain('clientId: "chatops"');
    expect(body).toMatch(/\bofferUserMcpTools: false,/);
    // And runAsk itself never derives the decision from a client kind.
    const runAsk = stripComments(await read("packages/gateway/src/engine/run-ask.ts"));
    expect(runAsk).not.toMatch(/getClientKind|ClientKind|USER_MCP_OFFER_BY_KIND/);
    expect(runAsk).toMatch(/if \(p\.offerUserMcpTools === true\) \{/);
  });

  test("the IPC offer table refuses every non-owner kind", async () => {
    const { USER_MCP_OFFER_BY_KIND } = await import("../ipc/server/inline-handlers.ts");
    for (const kind of ["chatops", "http", "mcp", "fleet", "push"] as const) {
      expect(USER_MCP_OFFER_BY_KIND[kind]).toBe(false);
    }
    // The IPC invoke handler forwards the entry decision with `=== true`, never a truthy read.
    const main = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    expect(main).toContain("offerUserMcpTools: ctx.offerUserMcpTools === true,");
  });

  test("a user-MCP agent tool never calls the listing's own execute — only the turn's executor", async () => {
    const src = stripComments(await read("packages/gateway/src/engine/user-mcp-agent-tools.ts"));
    // Every `.execute` property ACCESS — called or not, so neither `entry.execute?.(x)` nor
    // `const f = entry.execute; f(x)` slips past — must be immediately preceded by the bare
    // identifier `ex`/`executor`; `entry.execute`, `tools[k].execute` and `executor().execute`
    // all make the two counts differ.
    const allAccesses = src.match(/\.\s*execute\b/g) ?? [];
    const executorAccesses = src.match(/(?<![\w$.])(?:ex|executor)\s*\??\.\s*execute\b/g) ?? [];
    expect(allAccesses.length).toBeGreaterThan(0);
    expect(executorAccesses).toHaveLength(allAccesses.length);
    // Bracket access (`entry["execute"]`) and reflection (`Reflect.get(entry, "execute")`).
    expect(src).not.toMatch(/\[\s*["'`]execute["'`]\s*\]/);
    expect(src).not.toMatch(/Reflect\s*\.\s*get\s*\([^)]*["'`]execute["'`]/);
    // Destructuring, plain or renamed, as a binding or a parameter: `const { execute } = entry`,
    // `const { execute: run } = entry`, `({ execute }) => …`. Must NOT match the file's own
    // `createTool({ …, execute: async (…) => { … } })` literal, whose span contains a `{`.
    expect(src).not.toMatch(/\{[^{}]*\bexecute\b[^{}]*\}\s*[=)]/);
    // STATED BOUND: this check is name-based — a listing entry aliased to a variable named
    // `ex`/`executor`, or a dynamically composed property name, evades it. The real defense is
    // that listing entries are typed `Record<string, unknown>` and the only dispatch goes through
    // `executor()` (the turn's ToolExecutor).
  });

  test("the owner SEES a user-MCP payload unredacted at the prompt; other types and the audit row stay redacted", async () => {
    // The owner's approval is the only boundary on a user-MCP call, and the global
    // SENSITIVE_PAYLOAD_KEY is a substring match (`author`, `keywords`, `monkey`), so a
    // prompt-injected model could hide its input under such a key if the display redacted it.
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    const prompts: { prompt: string; details: Record<string, unknown> | undefined }[] = [];
    const audits: string[] = [];
    const exec = new ToolExecutor(
      {
        requestApproval: async (prompt, details) => {
          prompts.push({ prompt, details });
          return { approved: false, answerSource: "human" as const };
        },
      },
      { recordAudit: (e) => audits.push(e.actionJson) },
      { dispatch: async () => ({}) },
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
      undefined,
      { userMcpWriteGrants: () => [] },
    );
    const input = { keywords: "kw-VALUE", author: "au-VALUE", api_key: "ak-VALUE" };
    await exec.execute({
      type: "mcp_x.y",
      payload: { mcpToolId: "mcp_x_y", input, requestedBy: "model" },
    });
    expect(prompts).toHaveLength(1);
    expect(prompts[0]?.details?.["input"]).toEqual(input);
    for (const v of ["kw-VALUE", "au-VALUE", "ak-VALUE", "requestedBy"]) {
      expect(prompts[0]?.prompt).toContain(v);
    }
    // The audit row is NOT widened: it still redacts the secret-looking key.
    expect(audits.join("\n")).not.toContain("ak-VALUE");
    // A first-party HITL type is still redacted at the prompt.
    await exec.execute({ type: "email.send", payload: { input: { api_key: "ak-OTHER" } } });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]?.prompt).not.toContain("ak-OTHER");
    expect(JSON.stringify(prompts[1]?.details)).not.toContain("ak-OTHER");
    // Source pin: the display branch keys on the action TYPE (I3), never the payload.
    const src = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    expect(src).toMatch(/if \(isUserMcpActionType\(action\.type\)\) return action\.payload;/);
  });

  test("gateway-main offers the agent only --model servers, through the org-policy lock-off", async () => {
    // `listUserMcpConnectors` would offer EVERY registered user MCP server to the model,
    // including ones the owner registered without --model; the un-gated
    // `listModelAccessibleUserMcpIds` would ignore a `user_mcp_model_access = false` org policy.
    const main = stripComments(await read("packages/gateway/src/gateway-main.ts"));
    expect(main).toMatch(
      /listModelAccessibleIds:\s*\(\)\s*=>\s*listPolicyGatedModelAccessibleOwnerCodeServerIds\(\s*platform\.localIndex\.getDatabase\(\),\s*platform\.enforcedPolicy\?\.\(\),?\s*\)/,
    );
    // Both owner-code sources list through the mesh's one router (ext_ -> extension slot).
    expect(main).toMatch(
      /listTools:\s*\(serviceId\)\s*=>\s*platform\.connectorMesh\.listOwnerCodeServerTools\(serviceId\)/,
    );
    expect(main).not.toMatch(/listUserMcpConnectors/);
    expect(main).not.toMatch(/\blistModelAccessibleUserMcpIds\b/);
    // Nor may it read the extension grants itself and skip the lock-off.
    expect(main).not.toMatch(
      /\blistModelAccessibleExtensionGrants\b|\blistRunGrants\b|\bgetRunGrant\b/,
    );
    // The gated lister consults the predicate BEFORE it reads the table.
    const gated = stripComments(
      await read("packages/gateway/src/connectors/user-mcp-model-capability.ts"),
    );
    const fnAt = gated.indexOf("export function listPolicyGatedModelAccessibleUserMcpIds(");
    expect(fnAt).toBeGreaterThan(-1);
    const body = gated.slice(fnAt);
    expect(body.indexOf("isUserMcpModelAccessEnabled(")).toBeGreaterThan(-1);
    expect(body.indexOf("isUserMcpModelAccessEnabled(")).toBeLessThan(
      body.indexOf("listModelAccessibleUserMcpIds("),
    );
    // The engine agent's combined source: the predicate precedes BOTH reads.
    const ownerAt = gated.indexOf(
      "export function listPolicyGatedModelAccessibleOwnerCodeServerIds(",
    );
    expect(ownerAt).toBeGreaterThan(-1);
    const owner = gated.slice(ownerAt);
    const gateAt = owner.indexOf("isUserMcpModelAccessEnabled(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(owner.indexOf("listModelAccessibleUserMcpIds(")).toBeGreaterThan(gateAt);
    expect(owner.indexOf("listModelAccessibleExtensionGrants(")).toBeGreaterThan(gateAt);
  });

  test("the org-policy lock-off is fail-closed and read LAZILY from the live policy gate", async () => {
    const { isUserMcpModelAccessEnabled } = await import(
      "../connectors/user-mcp-model-capability.ts"
    );
    // Absent accessor → locked off; never "cannot tell, so allowed".
    expect(isUserMcpModelAccessEnabled(undefined)).toBe(false);
    expect(
      isUserMcpModelAccessEnabled({ capabilitiesDisabled: new Set(["user_mcp_model_access"]) }),
    ).toBe(false);
    expect(isUserMcpModelAccessEnabled({ capabilitiesDisabled: new Set() })).toBe(true);
    // assemble.ts hands PlatformServices a GETTER over policyGate.enforced(), not a snapshot, so
    // a policy applied after boot takes effect on the next turn rather than the next restart.
    const assemble = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    expect(assemble).toMatch(/enforcedPolicy:\s*\(\)\s*=>\s*policyGate\.enforced\(\)/);
  });

  test("ext_ (approved extension) actions get the same floor: behavioural deny, no prompt bypass", async () => {
    const { HITL_REQUIRED, NO_POLICY_OVERLAY, ToolExecutor, isUserMcpActionType } = await import(
      "../engine/executor.ts"
    );
    const type = "ext_x.y";
    expect(isUserMcpActionType(type)).toBe(true);
    expect(HITL_REQUIRED.has(type)).toBe(false);
    let prompts = 0;
    let dispatches = 0;
    const exec = new ToolExecutor(
      {
        requestApproval: async () => {
          prompts += 1;
          return { approved: false, answerSource: "human" as const };
        },
      },
      { recordAudit: () => {} },
      {
        dispatch: async () => {
          dispatches += 1;
          return {};
        },
      },
      undefined,
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const res = await exec.execute({ type, payload: {} });
    expect(res.status).toBe("rejected");
    expect(prompts).toBe(1);
    expect(dispatches).toBe(0);
  });

  test("a delegate never approves an ext_ call: the delegate is not consulted and the owner is prompted (I20)", async () => {
    const { NO_POLICY_OVERLAY, ToolExecutor } = await import("../engine/executor.ts");
    let prompts = 0;
    let remote = 0;
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
          activeDelegateFor: () => true,
          activeDelegateePeer: () => "peer-1",
        },
        isOperatorValid: () => true,
        requestRemote: async () => {
          remote += 1;
          return { kind: "answered", peerId: "peer-1", approved: true };
        },
      },
      NULL_EGRESS_SINK,
      NO_POLICY_OVERLAY,
    );
    const res = await exec.execute({ type: "ext_x.y", payload: {} });
    expect(res.status).toBe("rejected");
    expect(remote).toBe(0);
    expect(prompts).toBe(1);
  });

  test("share replay never runs an ext_ tool", async () => {
    const { isReadOnlyToolId } = await import("../share/read-tool-registry.ts");
    for (const id of ["ext_x_y", "ext_notes_search", "ext_x_get", "ext_x__list"]) {
      expect(isReadOnlyToolId(id)).toBe(false);
    }
    // runReplayTool is module-private; pin the guard is the widened predicate, ahead of the lookup.
    const rpc = await read("packages/gateway/src/ipc/share-rpc.ts");
    const fnAt = rpc.indexOf("async function runReplayTool(");
    const body = rpc.slice(fnAt, rpc.indexOf("\n}\n", fnAt));
    const guardAt = body.indexOf("if (isOwnerCodeServerToolKey(toolId))");
    expect(guardAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(body.indexOf("tools[toolId]"));
  });

  test("the dispatcher pairs ext_ keys with ext_ action types in both directions", async () => {
    const { createConnectorDispatcher } = await import("../connectors/registry.ts");
    const ran: string[] = [];
    const mk = (key: string) => ({
      execute: async () => {
        ran.push(key);
        return {};
      },
    });
    const d = createConnectorDispatcher({
      listTools: async () => ({ ext_x_echo: mk("ext_x_echo"), mcp_x_echo: mk("mcp_x_echo") }),
    });
    await expect(
      d.dispatch({ type: "github.pr_list", payload: { mcpToolId: "ext_x_echo" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    await expect(
      d.dispatch({ type: "ext_x.echo", payload: { mcpToolId: "mcp_x_echo" } }),
    ).rejects.toThrow(/ERR_USER_MCP_ACTION_MISMATCH/);
    expect(ran).toEqual([]);
    await d.dispatch({ type: "ext_x.echo", payload: { mcpToolId: "ext_x_echo" } });
    expect(ran).toEqual(["ext_x_echo"]);
  });

  test("share replay refuses an OFFERED user-MCP tool name (<mcp_id>__<tool>) whatever its verb", async () => {
    const { isReadOnlyToolId } = await import("../share/read-tool-registry.ts");
    expect(isReadOnlyToolId("mcp_x__list")).toBe(false);
    expect(isReadOnlyToolId("mcp_notes__search")).toBe(false);
  });

  describe("agent door (Phase 28 AD5a): an outside agent reaches an mcp_ tool only for a tool the owner approved for agents by name, with an unchanged definition", () => {
    async function rig() {
      const { toStandardSchema } = await import("@mastra/core/schema");
      const { createAgentDoor } = await import(
        "../connectors/connector-writes/agent-door-runtime.ts"
      );
      const { definitionSha256 } = await import(
        "../connectors/connector-writes/definition-hash.ts"
      );
      const { upsertDoorApprovals } = await import(
        "../connectors/connector-writes/door-approval-store.ts"
      );
      const { insertUserMcpConnector, listModelAccessibleUserMcpIds } = await import(
        "../connectors/user-mcp-store.ts"
      );
      const { mcpClientToolKey } = await import("../connectors/lazy-mesh/tool-map.ts");
      const { openMigratedMemoryDb } = await import("../index/migrated-db-template.ts");
      const db = openMigratedMemoryDb();
      const entry = (description: string, extra: Record<string, unknown> = {}) => ({
        description,
        inputSchema: toStandardSchema({
          type: "object",
          properties: { text: { type: "string", ...extra } },
        } as Parameters<typeof toStandardSchema>[0]),
      });
      let listed: Record<string, unknown> = {};
      let policyOff = new Set<string>();
      let userMcpAllowed = true;
      const door = createAgentDoor({
        db,
        enforcedPolicy: () => ({ capabilitiesDisabled: policyOff }) as never,
        listServerTools: async () => undefined,
        listUserMcpDefinitions: async () => listed,
        tribalKbConfig: () => undefined,
        userMcpPolicy: { userMcpModelAccessAllowed: () => userMcpAllowed },
        isServiceConfigured: async () => true,
        now: () => 10,
      });
      const register = (id: string, model: boolean) =>
        insertUserMcpConnector(db, {
          service_id: id,
          command: "srv",
          args_json: "[]",
          read_paths_json: "[]",
          net_hosts_json: "[]",
          model_access: model ? 1 : 0,
          created_at: 1,
        });
      const approve = (id: string, tool: string, e: unknown) =>
        upsertDoorApprovals(
          db,
          "agent",
          id,
          [{ toolId: tool, definitionSha256: definitionSha256(tool, e) as string }],
          2,
        );
      return {
        db,
        door,
        entry,
        register,
        approve,
        key: mcpClientToolKey,
        setListed: (l: Record<string, unknown>) => {
          listed = l;
        },
        setPolicyOff: (s: Set<string>) => {
          policyOff = s;
        },
        setUserMcpAllowed: (b: boolean) => {
          userMcpAllowed = b;
        },
        modelIds: () => listModelAccessibleUserMcpIds(db),
      };
    }

    test("the two grants are independent: an agent approval is not a --model grant, and a --model grant is not an agent approval", async () => {
      const r = await rig();
      r.register("mcp_a", false);
      r.approve("mcp_a", "append", r.entry("adds"));
      // approved for agents without --model, and the model is offered nothing
      expect(r.door.verdict("mcp_a.append")).toEqual({ kind: "proposable", basis: "approved" });
      expect(r.modelIds()).toEqual([]);
      // a --model server's unapproved tool is refused (AD3b), never `approved`
      r.register("mcp_b", true);
      expect(r.door.verdict("mcp_b.append")).toEqual({
        kind: "denied",
        class: "agent_not_approved",
      });
      r.db.close();
    });

    test("policy: an approved tool needs mcp_action AND user_mcp_model_access (fail closed); neither leaves it proposable", async () => {
      const r = await rig();
      r.register("mcp_a", true);
      r.approve("mcp_a", "append", r.entry("adds"));
      r.setPolicyOff(new Set(["mcp_action"]));
      expect(r.door.verdict("mcp_a.append").kind).toBe("denied");
      r.setPolicyOff(new Set());
      r.setUserMcpAllowed(false);
      expect(r.door.verdict("mcp_a.append").kind).toBe("denied");
      r.db.close();
    });

    test("an extension is never proposable on this door, even with an approval row filed under its id", async () => {
      const r = await rig();
      const { upsertDoorApprovals } = await import(
        "../connectors/connector-writes/door-approval-store.ts"
      );
      upsertDoorApprovals(
        r.db,
        "agent",
        "ext_x",
        [{ toolId: "tool", definitionSha256: "a".repeat(64) }],
        1,
      );
      expect(r.door.verdict("ext_x.tool")).toEqual({ kind: "unknown" });
      expect((await r.door.verifyDefinition("ext_x.tool")).ok).toBe(false);
      expect((await r.door.describe(["ext_x.tool"]))[0]?.state).toBe("not_proposable");
      r.db.close();
    });

    test("a changed definition (a description byte, or a schema keyword the sanitiser drops) suspends the tool at all three checks, with ONE audit row", async () => {
      for (const changed of [
        (r: Awaited<ReturnType<typeof rig>>) => r.entry("addz"),
        (r: Awaited<ReturnType<typeof rig>>) => r.entry("adds", { pattern: "^x$" }),
      ]) {
        const r = await rig();
        r.register("mcp_a", false);
        r.approve("mcp_a", "append", r.entry("adds"));
        r.setListed({ [r.key("mcp_a", "append")]: changed(r) });
        const submit = await r.door.verifyDefinition("mcp_a.append");
        expect(submit).toMatchObject({ ok: false, code: "ERR_AGENT_TOOL_SUSPENDED" });
        // the approval and the post-answer veto ask the same function, and find it already suspended
        expect(await r.door.verifyDefinition("mcp_a.append", 5)).toMatchObject({ ok: false });
        expect(await r.door.userMcpCallFacts("mcp_a.append", "approved", 5)).toMatchObject({
          ok: false,
          code: "ERR_AGENT_TOOL_SUSPENDED",
        });
        expect(r.door.verdict("mcp_a.append")).toEqual({ kind: "suspended" });
        const n = r.db
          .query(
            "SELECT COUNT(*) AS n FROM audit_log WHERE action_type = 'connector.writes.agent.suspend'",
          )
          .get() as { n: number };
        expect(n.n).toBe(1);
        r.db.close();
      }
    });

    test("a missing tool or an unlistable server refuses and marks nothing; a proposal older than the registration is refused", async () => {
      const r = await rig();
      r.register("mcp_a", false);
      r.approve("mcp_a", "append", r.entry("adds"));
      r.setListed({});
      expect((await r.door.verifyDefinition("mcp_a.append")).ok).toBe(false);
      expect(r.door.verdict("mcp_a.append")).toEqual({ kind: "proposable", basis: "approved" });
      r.setListed({ [r.key("mcp_a", "append")]: r.entry("adds") });
      expect((await r.door.verifyDefinition("mcp_a.append", 5)).ok).toBe(true);
      // registered at 1; a proposal made at 0 predates it
      expect((await r.door.verifyDefinition("mcp_a.append", 0)).ok).toBe(false);
      r.db.close();
    });

    test("source pin: the enable runs its steps in the fixed order and never writes the shared wave row", async () => {
      const src = await read(
        "packages/gateway/src/ipc/connector-rpc-handlers/agent-writes-user-mcp.ts",
      );
      const body = src.slice(src.indexOf("export async function handleUserMcpAgentWritesEnable("));
      const order = [
        "requireAgentEnableCaller(deps)",
        "refuseScopeParams(rec)",
        "getUserMcpConnector(deps.db, service)",
        "requireUserMcpAgentPolicy(deps)",
        "deps.listUserMcpDefinitions?.(service)",
        "requireOwnerApproval(executor, payload, deps)",
        "upsertDoorApprovals(deps.db",
      ].map((s) => body.indexOf(s));
      for (const at of order) expect(at).toBeGreaterThan(-1);
      expect([...order].sort((a, b) => a - b)).toEqual(order);
      expect(stripComments(src)).not.toContain("raiseWriteEnablementWave");
      expect(stripComments(src)).not.toContain("setModelWriteEnablement");
    });

    test("source pin: the act wiring reads the call facts (one listing and the definition check) before it builds the executor", async () => {
      const src = await read("packages/gateway/src/ipc/capture-rpc.ts");
      const body = src.slice(src.indexOf("export function buildActDeps("));
      const facts = body.indexOf("userMcpCallFacts(actionType, provenance.basis");
      const build = body.indexOf("buildAgentWriteExecutor(");
      expect(facts).toBeGreaterThan(-1);
      expect(facts).toBeLessThan(build);
      // the gateway's own key is the only one dispatched
      expect(body).toContain("userMcpToolKeyForActionType(actionType)");
    });
  });
});
