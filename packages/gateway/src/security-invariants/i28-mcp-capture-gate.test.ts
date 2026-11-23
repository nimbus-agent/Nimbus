import { describe, expect, test } from "bun:test";
import { stripComments, stripStringLiterals } from "../../../../scripts/structure-audit/lib.ts";
import { grepRepo, read, readDirFiles } from "../../test/helpers/security-invariants.ts";

describe("I28 — MCP content enters only through the capture gate, in a fixed order", () => {
  test("AD7a: a proposer label's source is display only: named by the modules that store, show or report it, and compared by none of the gate's steps (I28, D-AD-13)", async () => {
    const files = (await grepRepo(/\blabelSource\b/)).filter(
      (f) => f.startsWith("packages/gateway/src/") && !/\.test\.ts$|test-helpers\.ts$/.test(f),
    );
    expect(files).toEqual([
      "packages/gateway/src/audit/agent-door-proof.ts",
      "packages/gateway/src/engine/executor.ts",
      "packages/gateway/src/engine/proposer-block.ts",
      "packages/gateway/src/engine/types.ts",
      "packages/gateway/src/ipc/approvals-rpc.ts",
      "packages/gateway/src/ipc/capture-rpc.ts",
      "packages/gateway/src/mcp-sink/capture-act.ts",
      "packages/gateway/src/mcp-sink/capture-gate.ts",
      "packages/gateway/src/mcp-sink/capture-store.ts",
      "packages/gateway/src/mcp-sink/capture-types.ts",
    ]);
    // In the gate, the act door and the executor it is only carried: a declaration, a property
    // passed on, or the one sanitiser call. No condition names it.
    const carried =
      /^(readonly labelSource: LabelSource;|labelSource,|labelSource: (row|proposer|p)\.labelSource,|const labelSource = sanitizeLabelSource\(params\["labelSource"\], clientLabel\);|const ctx: SubmitContext = \{ deps, caller, kind: kindRaw, clientLabel, labelSource \};|const \{ deps, caller, kind, clientLabel, labelSource \} = ctx;|proposer\?: Pick<AgentProposer, "door" \| "captureId" \| "label" \| "labelSource">;)$/;
    for (const rel of [
      "mcp-sink/capture-gate.ts",
      "mcp-sink/capture-act.ts",
      "engine/executor.ts",
    ]) {
      const src = stripComments(await read(`packages/gateway/src/${rel}`));
      const lines = src
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => /\blabelSource\b/.test(l));
      expect(lines.length, rel).toBeGreaterThan(0);
      for (const line of lines) {
        expect(line, `${rel}: ${line}`).toMatch(carried);
      }
    }
  });

  test("submitCapture checks capability → client kind → attempt limit → kind → validate → items → link endpoints → durable cap → pending cap, in that order", async () => {
    const src = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    const body = src.slice(src.indexOf("export async function submitCapture"));
    const order = [
      "deps.capability()",
      "CAPTURE_ROLE_BY_KIND[caller.kind]",
      "deps.limiter.tryAcquire(",
      "cap.kinds.includes(",
      "validateCapturePayload(kindRaw",
      "deps.classifyAction?.(",
      "requireDestinationAllowed(ctx, v, basis)",
      "deps.isServiceConfigured?.(",
      // AD3a-2a: the definition check lists the connector, so it is LAST of the action checks.
      "requireDefinitionVerified(ctx, v, basis)",
      "missingItem(",
      "resolveLinkEndpoints(",
      "deps.store.countCreatedSince(",
      "deps.store.countPendingActions(",
      "deps.store.countPendingNative(",
      "deps.db.transaction(",
    ];
    const idx = order.map((s) => body.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("the role table is total and only mcp submits; mcp is never owner", async () => {
    const { CAPTURE_ROLE_BY_KIND } = await import("../mcp-sink/capture-client-policy.ts");
    const submitters = Object.entries(CAPTURE_ROLE_BY_KIND)
      .filter(([, r]) => r === "submit")
      .map(([k]) => k);
    expect(submitters).toEqual(["mcp"]);
    expect(CAPTURE_ROLE_BY_KIND.mcp).not.toBe("owner");
  });

  test("an absent policy accessor DISABLES the sink (fail-closed, I22)", async () => {
    const { resolveCaptureCapability } = await import("../mcp-sink/capture-capability.ts");
    const { DEFAULT_MCP_SINK_CONFIG } = await import("../config/mcp-sink-toml.ts");
    const c = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
      undefined,
    );
    expect(c.enabled).toBe(false);
  });

  test("both namespaces are LAN-forbidden; only the two owner reads reach the Tauri allowlist", async () => {
    const lan = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(lan).toMatch(/"capture",\s*"captures"/);
    const tauri = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    // Every `"capture(s).x",` ENTRY line in the Rust file: the read-only desktop Captures page
    // (2026-10-16) reaches captures.list/get; no owner verb and no MCP-client method ever does.
    const entries = [...tauri.matchAll(/^\s*"(captures?\.[A-Za-z]+)",\s*$/gm)].map((m) => m[1]);
    expect(entries).toEqual(["captures.get", "captures.list"]);
  });

  test("AD2: approvals is LAN-forbidden by namespace and is on no Tauri allowlist entry line", async () => {
    const lan = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(lan).toMatch(/"capture",\s*"captures",[\s\S]*?"approvals"/);
    const tauri = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    // Entry lines only: the Rust negative test asserts these names without a trailing comma line.
    expect([
      ...tauri.matchAll(/^\s*"(approvals\.[A-Za-z]+|capture\.mine|capture\.describe)",\s*$/gm),
    ]).toEqual([]);
    expect(tauri).toContain("fn allowlist_approvals_never_renderer()");
  });

  test("capture items are never extraction input", async () => {
    const { DECISION_SOURCE_TYPES } = await import("../decisions/decision-source-types.ts");
    const { GLOSSARY_SOURCE_TYPES } = await import("../glossary/glossary-source-types.ts");
    expect(DECISION_SOURCE_TYPES.has("nimbus:capture")).toBe(false);
    expect(GLOSSARY_SOURCE_TYPES.has("nimbus:capture")).toBe(false);

    // A source mapping is no way back in: the entry parser refuses `nimbus:*` and the resolver
    // drops it, from a pack layer and from the owner's base layer alike.
    const { mergeLayerDocs, parseLayerDoc } = await import("../config/layered-merge.ts");
    const { parseSourceMapEntry, resolveSourceMapping } = await import(
      "../sources/source-mapping.ts"
    );
    const layer = (kind: "pack" | "base") => ({ kind, id: kind, path: `/virtual/${kind}.toml` });
    const doc = mergeLayerDocs([
      parseLayerDoc(layer("pack"), '[sources]\nmap = ["nimbus:capture=note"]\n'),
      parseLayerDoc(layer("base"), '[sources]\nmap = ["nimbus:capture=note"]\n'),
    ]);
    const mapping = resolveSourceMapping({ doc });
    expect(mapping.typesFor("decisions")).not.toContain("nimbus:capture");
    expect(mapping.typesFor("glossary")).not.toContain("nimbus:capture");
    expect(mapping.kindOf("nimbus:capture")).toBeUndefined();
    expect(parseSourceMapEntry("nimbus:capture=note")).toBeUndefined();
  });

  test("capture items embed LOCALLY only (no remote egress through the embedder)", async () => {
    const { LOCAL_ONLY_PROSE_TYPES, PROSE_HEAVY_TYPES } = await import("../embedding/routing.ts");
    expect(LOCAL_ONLY_PROSE_TYPES.has("nimbus:capture")).toBe(true);
    expect(PROSE_HEAVY_TYPES.has("nimbus:capture")).toBe(false);
  });

  test("acceptCapture checks capability → owner → proposed → items exist → precondition → one transaction, in that order", async () => {
    const src = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    const start = src.indexOf("export function acceptCapture");
    const end = src.indexOf("\nexport function", start + 1);
    const body = src.slice(start, end);
    const order = [
      "deps.capability(",
      "requireOwner(caller)",
      'row.state !== "proposed"',
      "missingItem(",
      "assertAcceptable(",
      "deps.db.transaction(",
    ];
    const idx = order.map((s) => body.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("a proposal writes no item and no native row until accepted (absent by construction)", async () => {
    const { openMigratedMemoryDb } = await import("../index/migrated-db-template.ts");
    const { DEFAULT_MCP_SINK_CONFIG } = await import("../config/mcp-sink-toml.ts");
    const { resolveCaptureCapability } = await import("../mcp-sink/capture-capability.ts");
    const { acceptCapture, submitCapture } = await import("../mcp-sink/capture-gate.ts");
    const { CaptureAttemptLimiter, CaptureRefusalCounter } = await import(
      "../mcp-sink/capture-rate-limit.ts"
    );
    const { CaptureStore } = await import("../mcp-sink/capture-store.ts");
    const db = openMigratedMemoryDb();
    try {
      const cap = resolveCaptureCapability(
        { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
        { capabilitiesDisabled: new Set<string>() },
      );
      let seq = 0;
      const deps = {
        db,
        store: new CaptureStore(db),
        capability: () => cap,
        limiter: new CaptureAttemptLimiter(),
        refusals: new CaptureRefusalCounter(),
        newId: () => `cap_${String(++seq)}`,
        now: () => 1_000_000,
        scheduleEmbedding: () => {},
        actionDestinationRefusal: () => undefined,
      };
      const count = (sql: string): number => (db.query(sql).get() as { n: number }).n;
      const items = "SELECT COUNT(*) AS n FROM item WHERE service = 'nimbus'";
      const decisions = "SELECT COUNT(*) AS n FROM decision_record";
      const { id } = await submitCapture(
        deps,
        { clientId: "c-mcp", kind: "mcp" },
        { kind: "decision", payload: { statement: "Adopt WAL" } },
      );
      expect(count(items)).toBe(0);
      expect(count(decisions)).toBe(0);
      acceptCapture(deps, { clientId: "c-cli", kind: "unknown" }, id);
      expect(count(items)).toBe(1);
      expect(count(decisions)).toBe(1);
    } finally {
      db.close();
    }
  });

  test("capture.accept never records an `approved` row (I4: no consent gate ran)", async () => {
    const src = await read("packages/gateway/src/mcp-sink/capture-gate.ts");
    const at = src.indexOf('actionType: "capture.accept"');
    expect(at).toBeGreaterThan(0);
    expect(src.slice(at, at + 400)).toMatch(/hitlStatus:\s*"not_required"/);
  });

  test("act door: acceptAction claims BEFORE execute, and execute is the last step before finalize", async () => {
    const src = stripComments(await read("packages/gateway/src/mcp-sink/capture-act.ts"));
    const start = src.indexOf("export async function acceptAction");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    const order = [
      "cap.actionEnabled",
      "CAPTURE_ROLE_BY_KIND[caller.kind]",
      'row.state !== "proposed"',
      "deps.now() >= expiresAt",
      // AD3a-2a: step 4 is named steps, each a function above `acceptAction` that reads the live
      // verdict, the connector, the refusal for the approval-time basis, the human-only rule and
      // the definition; all of them precede the claim.
      "requireVerdictAtApproval(deps, stored.actionType)",
      "requireConfiguredAtApproval(deps, stored.actionType)",
      "actionDestinationVerdict(deps, stored.actionType, stored.input, basis)",
      "act.humanOnly",
      "requireDefinitionAtApproval(deps, stored.actionType, basis)",
      "deps.store.claimAction(",
      "act.execute(",
      "deps.store.finalizeAction(",
    ];
    const idx = order.map((s) => body.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("act door destination (OR1/OR2, OR-B2-2/3): both checks reach the injected dep, which assemble wires to the door's refusal (the model door's modelWriteRefusal, messaging first)", async () => {
    const gate = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    const req = gate.slice(gate.indexOf("function requireDestinationAllowed("));
    expect(req.slice(0, req.indexOf("\n}\n"))).toContain(
      "actionDestinationVerdict(ctx.deps, v.payload.actionType, v.payload.input, basis)",
    );
    const act = stripComments(await read("packages/gateway/src/mcp-sink/capture-act.ts"));
    const verdict = act.slice(act.indexOf("export function actionDestinationVerdict("));
    expect(verdict.slice(0, verdict.indexOf("\n}\n"))).toContain(
      "return deps.actionDestinationRefusal(actionType, input, basis);",
    );
    // D32(f): the sink names no ChatOps or connectors module; the check is injected.
    for (const f of ["capture-gate.ts", "capture-act.ts", "capture-types.ts"]) {
      const src = stripComments(await read(`packages/gateway/src/mcp-sink/${f}`));
      expect(src.toLowerCase().includes("chatops"), f).toBe(false);
      expect(src.includes("messagingDestinationRefusal"), f).toBe(false);
    }
    // AD3b: the act door's own refusal function is gone; the door's refusal is the model door's
    // check (messaging first, then the KB target), with the live policy and KB config read per call.
    const rpc = stripComments(await read("packages/gateway/src/ipc/capture-rpc.ts"));
    expect(rpc).not.toContain("createActionDestinationRefusal");
    expect(rpc).not.toContain("actDoorRefusal");
    const runtime = stripComments(
      await read("packages/gateway/src/connectors/connector-writes/agent-door-runtime.ts"),
    );
    const helper = runtime.slice(runtime.indexOf("const approvedRefusal = ("));
    const helperBody = helper.slice(0, helper.indexOf("\n  };\n"));
    expect(helperBody).toContain(
      "return modelWriteRefusal(row.toolId, input, { chatops, kb: deps.tribalKbConfig() });",
    );
    expect(runtime).not.toContain("actDoorRefusal");
    const refusals = stripComments(
      await read("packages/gateway/src/connectors/connector-writes/model-write-refusals.ts"),
    );
    expect(refusals).not.toContain("actDoorRefusal");
    const model = refusals.slice(refusals.indexOf("export function modelWriteRefusal("));
    const first = model.indexOf(
      "= messagingDestinationRefusal(toolId, input, { chatops: ctx.chatops });",
    );
    expect(first).toBeGreaterThan(0);
    expect(model.slice(0, model.indexOf("\n}\n"))).toContain(
      "return knowledgeBaseRefusal(toolId, input, ctx.kb);",
    );
  });

  test("B3 (OR-B3-1, review fix 2): assemble wires the act door with TWO accessors, the KB one the same as platform.tribalKbConfig, loaded before the capture gate", async () => {
    const assemble = stripComments(await read("packages/gateway/src/platform/assemble.ts"));
    expect(assemble).toContain("actionDestinationRefusal: agentDoor.refusal,");
    expect(assemble).toMatch(
      /enforcedPolicy: \(\) => policyGate\.enforced\(\),\s*listServerTools:/,
    );
    expect(assemble).toMatch(
      /tribalKbConfig: \(\) => tribalKbConfigOf\(tribalCfg, tribalUnreadable\),/,
    );
    const load = assemble.indexOf(
      "const tribalCfg = loadNimbusTribalFromConfigDir(paths.configDir);",
    );
    const gate = assemble.indexOf("const captureGate: CaptureGateDeps = {");
    expect(load).toBeGreaterThan(0);
    expect(gate).toBeGreaterThan(load);
    // Loaded once: the act door and the platform accessor read the same value.
    expect(assemble.split("loadNimbusTribalFromConfigDir(paths.configDir)")).toHaveLength(2);
  });

  test("act door: acceptCapture routes an action row to an acceptAction CALL, after the owner check", async () => {
    const src = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    const start = src.indexOf("export function acceptCapture(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    const call = body.search(
      /if \(row\.kind === "action"\) return acceptAction\(deps, caller, row, act\);/,
    );
    expect(call).toBeGreaterThan(0);
    expect(body.indexOf("requireOwner(caller)")).toBeGreaterThan(0);
    expect(body.indexOf("requireOwner(caller)")).toBeLessThan(call);
  });

  test("act door: the dispatched payload's mcpToolId is the routing table's value; no delegate; policy overlay passed", async () => {
    const src = stripComments(await read("packages/gateway/src/ipc/capture-rpc.ts"));
    expect(src).toMatch(
      /const toolId = row\?\.toolId \?\? userMcpToolKeyForActionType\(actionType\);/,
    );
    // AD3a-2a: routed by the write row (every row), never by the 47-type table; what may reach
    // this point is decided by the gate's verdict at submit and approval.
    expect(src).toMatch(/const row = agentDoorRow\(actionType\);/);
    expect(src).toMatch(/payload: \{ mcpToolId: toolId, input \}/);
    // Phase 28 AD1: the executor is the shared door maker's (no delegation input exists), and the
    // action is an `origin: "agent"` one carrying the gateway-set proposer. The old wrapper is gone.
    expect(src).toContain("buildAgentWriteExecutor({");
    expect(src).toContain("policyHitl: w.policyHitl,");
    expect(src).toContain('origin: "agent",');
    expect(src).toContain("proposer: agentProposerOf(provenance),");
    expect(src).not.toContain("new ToolExecutor(");
    expect(src).not.toContain("provenanceConsent");
    expect(src).not.toContain("delegation");
  });

  test("act door: an absent policy accessor disables actions (fail-closed)", async () => {
    const { resolveCaptureCapability } = await import("../mcp-sink/capture-capability.ts");
    const { DEFAULT_MCP_SINK_CONFIG } = await import("../config/mcp-sink-toml.ts");
    const c = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["action"] } },
      undefined,
    );
    expect(c.actionEnabled).toBe(false);
  });

  // ---- Phase 28 AD2: the owner's queue and one-step approval (`approvals.*`) ----------------------

  test("AD2: approvals-rpc.ts checks the connection kind, reaches the gate only via acceptCapture, never acceptAction, and imports nothing from llm/", async () => {
    const src = stripStringLiterals(
      stripComments(await read("packages/gateway/src/ipc/approvals-rpc.ts")),
    );
    const approve = src.slice(src.indexOf("async function approve("));
    // requireApprover is the first call of every handler, before the gate is touched.
    for (const m of ["approvals.list", "approvals.get", "approvals.approve", "approvals.decline"]) {
      expect(await read("packages/gateway/src/ipc/approvals-rpc.ts")).toContain(`"${m}"`);
    }
    expect(src.match(/requireApprover\(c\.caller\);/g)).toHaveLength(4);
    // approve: the kind check (getCapture via requireActionRow) precedes acceptCapture, which
    // precedes the reply; the human-only option (buildActDeps wraps the consent itself) is asked
    // for before acceptCapture runs, and approvals-rpc.ts never wraps a consent on its own.
    const iRow = approve.indexOf("requireActionRow(");
    const iWrap = approve.indexOf("humanOnly:");
    expect(src).not.toContain("humanOnlyConsent");
    const iAccept = approve.indexOf("acceptCapture(");
    const iReply = approve.indexOf("NON_HUMAN_REASON");
    expect(iRow).toBeGreaterThan(-1);
    expect(iRow).toBeLessThan(iWrap);
    expect(iWrap).toBeLessThan(iAccept);
    expect(iAccept).toBeLessThan(iReply);
    expect(src).not.toMatch(/\bacceptAction\b/);
    expect(src).not.toMatch(/\bToolExecutor\b|\bbuildAgentWriteExecutor\b/);
    expect(src).not.toMatch(/from\s+["'][^"']*\/llm\//);
  });

  test("AD2: the human-only wrapper lives in ipc/consent.ts and is used only by capture-rpc.ts (buildActDeps, which also sets the flag) and the dispatcher's agent-door enable; capture-rpc.ts has no delegation", async () => {
    const consent = await read("packages/gateway/src/ipc/consent.ts");
    expect(consent).toMatch(/export function humanOnlyConsent\(/);
    expect(consent).toContain('answer.answerSource !== "human"');
    const users = (await grepRepo(/\bhumanOnlyConsent\b/)).filter(
      (p) => !p.endsWith("/ipc/consent.ts"),
    );
    // AD3a-1 added the agent-door enable in the dispatcher; AD3a-2a moved the act door's use into
    // buildActDeps, so the flag and the wrapper it vouches for have ONE producer.
    // Phase 10 IC5a: the incident remediation executor (gateway-main.ts) is the third user: its consent takes
    // a human answer only, so `--yes`, a script and an old client cannot approve an engine-proposed action.
    expect(users.sort()).toEqual([
      "packages/gateway/src/gateway-main.ts",
      "packages/gateway/src/ipc/capture-rpc.ts",
      "packages/gateway/src/ipc/server/dispatchers/platform-rpcs.ts",
    ]);
    const rpc = stripComments(await read("packages/gateway/src/ipc/capture-rpc.ts"));
    expect(rpc).not.toContain("delegation");
  });

  test("AD3a-2a: `humanOnly: true` is written in production only inside buildActDeps, in the same expression that wraps the consent in humanOnlyConsent", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const writers = files
      .filter(
        (f) =>
          !/\.test(-helpers)?\.ts$/.test(f.rel) &&
          /\bhumanOnly:\s*true/.test(stripComments(f.contents)),
      )
      .map((f) => f.rel);
    expect(writers).toEqual(["ipc/capture-rpc.ts"]);
    const rpc = stripComments(await read("packages/gateway/src/ipc/capture-rpc.ts"));
    const body = rpc.slice(rpc.indexOf("export function buildActDeps("));
    const iWrap = body.indexOf("humanOnlyConsent(");
    const iFlag = body.search(/humanOnly:\s*true/);
    const iExecute = body.indexOf("async execute(");
    expect(iWrap).toBeGreaterThan(-1);
    expect(iFlag).toBeGreaterThan(iWrap);
    expect(iFlag).toBeLessThan(iExecute);
    // The flag is written once, and the wrapper is applied to the coordinator before the vetoing one.
    expect(body.match(/humanOnly:\s*true/g)).toHaveLength(1);
    expect(body.indexOf("vetoingConsent(")).toBeGreaterThan(iWrap);
  });

  test("AD2: buildActDeps is the only place under ipc/ that builds the act door's executor", async () => {
    const files = await readDirFiles("packages/gateway/src/ipc");
    const builders = files
      .filter((f) => /\bbuildAgentWriteExecutor\(/.test(stripComments(f.contents)))
      .map((f) => f.rel);
    expect(builders).toEqual(["capture-rpc.ts"]);
    const count = (
      stripComments(await read("packages/gateway/src/ipc/capture-rpc.ts")).match(
        /\bbuildAgentWriteExecutor\(/g,
      ) ?? []
    ).length;
    expect(count).toBe(1);
  });

  test("AD2: capture.state answers only its submitter, and APPROVER_BY_KIND is cli and ui", async () => {
    const gate = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    expect(gate).toContain("row.sessionId !== caller.clientId");
    const { APPROVER_BY_KIND } = await import("../mcp-sink/capture-client-policy.ts");
    expect(
      Object.entries(APPROVER_BY_KIND)
        .filter(([, v]) => v)
        .map(([k]) => k)
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["cli", "ui"]);
  });
});
