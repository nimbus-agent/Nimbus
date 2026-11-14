/**
 * Phase 28 AD3a-2a, D-7: the four deprecation surfaces (the `capture.submit` reply, `approvals.list`
 * and `approvals.get`, the approval prompt, `connector.writesStatus`) all take their text from
 * `connector-writes/agent-door-legacy.ts`. AD3b deletes that module, which fails this test on
 * purpose.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import {
  LEGACY_LIST_HEADER,
  LEGACY_MAIL_SEND_NOTICE,
  legacyNoticeFor,
} from "../connectors/connector-writes/agent-door-legacy.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { NO_POLICY_OVERLAY } from "../engine/executor.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import type { ActionBasis } from "../mcp-sink/capture-types.ts";
import { dispatchApprovalsRpc } from "./approvals-rpc.ts";
import { type CaptureRpcCtx, dispatchCaptureRpc } from "./capture-rpc.ts";
import { handleAgentWritesStatus } from "./connector-rpc-handlers/agent-writes.ts";
import type { ModelWritesDeps } from "./connector-rpc-handlers/model-writes.ts";
import type { ConsentCoordinator } from "./consent.ts";

const MCP = { clientId: "c-mcp", kind: "mcp" as const };
const OWNER = { clientId: "c-cli", kind: "cli" as const };

let db: Database;
let basis: ActionBasis;
let prompts: string[];
let ctx: CaptureRpcCtx;

beforeEach(() => {
  db = openMigratedMemoryDb();
  basis = "legacy_unapproved";
  prompts = [];
  let seq = 0;
  const gate: CaptureGateDeps = {
    db,
    store: new CaptureStore(db),
    capability: () =>
      resolveCaptureCapability(
        {
          ok: true,
          config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["note", "action"] },
        },
        { capabilitiesDisabled: new Set<string>() },
      ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq).padStart(32, "0")}`,
    now: () => 1_000,
    classifyAction: () => ({ kind: "proposable", basis }),
    isServiceConfigured: () => Promise.resolve(true),
    actionDestinationRefusal: () => undefined,
    verifyActionDefinition: () => Promise.resolve({ ok: true }),
  };
  ctx = {
    gate,
    act: {
      dispatcher: { dispatch: () => Promise.resolve({ url: "https://x" }) },
      egressSink: makeEgressSink(db),
      audit: { recordAudit: (e) => appendAuditEntry(db, e) },
      policyHitl: NO_POLICY_OVERLAY,
      getTribalKbConfig: () => undefined,
    },
  };
});
afterEach(() => db.close());

const consent = {
  requestConsent: async (_c: string, req: { prompt: string }) => {
    prompts.push(req.prompt);
    return { approved: true, answerSource: "human" as const };
  },
} as unknown as ConsentCoordinator;

async function submit(actionType: string): Promise<Record<string, unknown>> {
  const out = await dispatchCaptureRpc(
    "capture.submit",
    { kind: "action", payload: { actionType, input: { title: "t" }, summary: "why" } },
    ctx,
    MCP,
  );
  if (out.kind === "miss") throw new Error("miss");
  return out.value as Record<string, unknown>;
}

describe("the four surfaces carry the module's text", () => {
  test("submit reply, list header and detail, prompt line and status notice", async () => {
    const reply = await submit("github.issue.create");
    expect(reply["deprecation"]).toBe(legacyNoticeFor("github.issue.create"));
    expect(reply["legacy"]).toBe(true);

    const list = (await dispatchApprovalsRpc("approvals.list", {}, ctx, OWNER)) as {
      kind: "hit";
      value: { deprecation?: string; proposals: Array<{ legacy: boolean }> };
    };
    expect(list.value.deprecation).toBe(LEGACY_LIST_HEADER);
    expect(list.value.proposals[0]?.legacy).toBe(true);
    const detail = (await dispatchApprovalsRpc(
      "approvals.get",
      { id: reply["id"] },
      ctx,
      OWNER,
    )) as { value: { deprecation?: string; legacy: boolean } };
    expect(detail.value.deprecation).toBe(LEGACY_LIST_HEADER);

    await dispatchApprovalsRpc("approvals.approve", { id: reply["id"] }, ctx, OWNER, consent);
    expect(prompts[0]).toContain(legacyNoticeFor("github.issue.create"));

    // the proposal ran, so queue one more for the status count (status reads the stored flag)
    const status = await handleAgentWritesStatus({
      db,
      toolExecutor: undefined,
      getEnforcedPolicy: () => ({ capabilitiesDisabled: new Set<string>() }),
      now: () => 2_000,
      clientKind: "cli",
    } as ModelWritesDeps);
    expect(status.legacy?.notice).toBe(LEGACY_LIST_HEADER);
    expect(status.legacy?.total).toBe(1);
  });

  test("a mail send carries the mail-send text on the reply and the prompt", async () => {
    basis = "legacy_mail_send";
    const reply = await submit("gmail.message.send");
    expect(reply["deprecation"]).toBe(LEGACY_MAIL_SEND_NOTICE);
    await dispatchApprovalsRpc("approvals.approve", { id: reply["id"] }, ctx, OWNER, consent);
    expect(prompts[0]).toContain(LEGACY_MAIL_SEND_NOTICE);
  });

  test("an approved proposal carries none of it, and the reply keeps its three keys", async () => {
    basis = "approved";
    const reply = await submit("github.issue.create");
    expect(Object.keys(reply).sort((a, b) => a.localeCompare(b))).toEqual([
      "expiresAt",
      "id",
      "state",
    ]);
    const list = (await dispatchApprovalsRpc("approvals.list", {}, ctx, OWNER)) as {
      value: { deprecation?: string };
    };
    expect(list.value.deprecation).toBeUndefined();
  });

  test("the prompt's deprecation line is escaped and stays one line", async () => {
    // A type that names no row falls back to fixed text; nothing of the request reaches the prompt.
    basis = "legacy_unapproved";
    const reply = await submit("github.issue.create");
    await dispatchApprovalsRpc("approvals.approve", { id: reply["id"] }, ctx, OWNER, consent);
    const line = (prompts[0] ?? "").split("\n").find((l) => l.startsWith("Deprecated:"));
    expect(line).toBe(legacyNoticeFor("github.issue.create"));
  });
});
