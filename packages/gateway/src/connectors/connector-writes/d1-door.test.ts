// Phase 9.7 D1 through the real door: the 27 Wave 4 rows are offered only at `--wave 4` with each
// write approved by name, read before they prompt, refused when their current state cannot be
// read, typed to confirm, and run as `origin: "model"` actions through the door's executor. The
// rows, the listing check, the before-state runner and the executor are the production ones; the
// connector side is a fake slot and a fake dispatcher.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { makeEgressSink } from "../../egress/egress-ledger.ts";
import {
  createBeforeStateRunner,
  isBeforeReadActionType,
  WAVE4_BEFORE_REFUSAL,
} from "../../engine/before-state.ts";
import {
  buildConnectorWriteAgentTools,
  CONNECTOR_WRITE_TOOL_NAME_MAX,
  DECLINED_RESULT_TEXT,
} from "../../engine/connector-write-agent-tools.ts";
import { NO_POLICY_OVERLAY, ToolExecutor } from "../../engine/executor.ts";
import { serviceOf } from "../../engine/service-of.ts";
import type {
  AuditSink,
  ConfirmedApprovalRequest,
  ConfirmedApprovalResult,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "../../engine/types.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import type { EnforcedPolicy } from "../../policy/policy-gate.ts";
import { mcpClientToolKey } from "../lazy-mesh/tool-map.ts";
import { D1_SHA, MIN_INPUT } from "./d1-golden.test-helpers.ts";
import { DEPLOY_MOBILE_ROWS } from "./deploy-mobile.ts";
import {
  offerableWritesEnabledBy,
  setModelWriteEnablement,
  writesEnabledBy,
} from "./enablement-store.ts";
import { CONNECTOR_WRITE_ROWS } from "./index.ts";
import { isModelOfferableRow } from "./model-offerable.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

// The D1 rows: the Wave 4 rows offered through a before-state. The two bound commits (D1c) and the
// seven deploy and mobile rows (D3b, `d3b-door.test.ts`) have their own door tests.
const D3B_TOOL_IDS: ReadonlySet<string> = new Set(DEPLOY_MOBILE_ROWS.map((r) => r.toolId));
const D1_OFFERED = CONNECTOR_WRITE_ROWS.filter(
  (r) =>
    r.wave === 4 && r.bound === undefined && isModelOfferableRow(r) && !D3B_TOOL_IDS.has(r.toolId),
);
const D1_SERVICES = [...new Set(D1_OFFERED.map((r) => serviceOf(r.actionType)))].sort((a, b) =>
  a.localeCompare(b),
);
const nameOf = (r: ConnectorWriteRow): string => `${serviceOf(r.actionType)}__${r.toolId}`;
const OFFERED_NAMES = D1_OFFERED.map(nameOf).sort((a, b) => a.localeCompare(b));

const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** What a server lists for `service`: each D1 write with its template keys, each reader with none. */
function listingFor(service: string, opts: { readonly omitReaders?: boolean } = {}) {
  const out: Record<string, unknown> = {};
  const entry = (keys: readonly string[]) => ({
    description: "tool",
    inputSchema: toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, {}])),
    } as Parameters<typeof toStandardSchema>[0]),
  });
  for (const r of CONNECTOR_WRITE_ROWS) {
    if (serviceOf(r.actionType) !== service || r.wave !== 4 || r.preview === undefined) continue;
    out[mcpClientToolKey(service, r.toolId)] = entry([...previewTemplateKeys(r.preview)]);
    if (opts.omitReaders !== true && r.before !== undefined) {
      out[mcpClientToolKey(service, r.before.tool)] = entry([]);
    }
  }
  return out;
}

const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;

describe("D1 through the real door", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 84);
  });
  afterEach(() => db.close());

  /** Enable every D1 service at `maxWave`, approving `approve(row)` rows by name. */
  function enableAll(maxWave: 2 | 3 | 4, approve: (r: ConnectorWriteRow) => boolean): void {
    for (const s of D1_SERVICES) {
      const approved = CONNECTOR_WRITE_ROWS.filter(
        (r) => serviceOf(r.actionType) === s && r.wave === 4 && approve(r),
      ).map((r) => r.toolId);
      setModelWriteEnablement(db, s, maxWave, 1, approved);
    }
  }

  async function door(opts: {
    readonly omitReaders?: boolean;
    readonly readReply?: unknown;
    readonly readThrows?: boolean;
    readonly answer?: (req: ConfirmedApprovalRequest) => ConfirmedApprovalResult;
  }) {
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => ALLOWED,
      listServerTools: async (service) =>
        listingFor(service, opts.omitReaders === true ? { omitReaders: true } : {}),
      toolsEpoch: () => 0,
      warn: () => {},
    });
    const plain: string[] = [];
    const confirmed: ConfirmedApprovalRequest[] = [];
    const dispatched: PlannedAction[] = [];
    const consent: ConsentChannel = {
      requestApproval: async (prompt) => {
        plain.push(prompt);
        return true;
      },
      requestConfirmedApproval: async (req) => {
        confirmed.push(req);
        return opts.answer?.(req) ?? { approved: true, typed: req.confirmText };
      },
    };
    const exec = new ToolExecutor(
      consent,
      { recordAudit: () => {} } as AuditSink,
      {
        dispatch: async (a: PlannedAction) => {
          dispatched.push(a);
          if (isBeforeReadActionType(a.type)) {
            if (opts.readThrows === true) throw new Error("the read failed");
            return opts.readReply;
          }
          return { ok: true, queued: a.type };
        },
      } as ConnectorDispatcher,
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      undefined,
      createBeforeStateRunner(),
    );
    const tools = await buildConnectorWriteAgentTools(
      src,
      () => exec,
      (_s, _t, d) => d,
      new Set(),
    );
    return {
      plain,
      confirmed,
      dispatched,
      offered: Object.keys(tools).sort((a, b) => a.localeCompare(b)),
      call: async (name: string, input: Record<string, unknown>) => {
        const t = tools[name] as
          | { execute?: (i: unknown, c: unknown) => Promise<unknown> }
          | undefined;
        if (t?.execute === undefined) throw new Error(`${name} is not offered`);
        return await t.execute(input, {});
      },
    };
  }

  const writesOnly = (d: { dispatched: PlannedAction[] }) =>
    d.dispatched.filter((a) => !isBeforeReadActionType(a.type));

  test("the 27 rows are on 13 services, and 27 names are expected", () => {
    expect(D1_OFFERED).toHaveLength(27);
    expect(D1_SERVICES).toEqual([
      "apple",
      "argocd",
      "aws",
      "circleci",
      "flux",
      "github",
      "github_actions",
      "gitlab",
      "jenkins",
      "mlflow",
      "onedrive",
      "outlook",
      "snowflake",
    ]);
  });

  test("at max_wave 3 (the default) none of the 27 is offered, whatever was approved", async () => {
    enableAll(3, () => true);
    const d = await door({});
    expect(d.offered.filter((n) => OFFERED_NAMES.includes(n))).toEqual([]);
    for (const s of D1_SERVICES) {
      for (const r of offerableWritesEnabledBy(s, 3)) expect(r.wave, r.toolId).toBeLessThan(4);
    }
  });

  test("at max_wave 4, with each write approved by name, exactly the 27 are offered, under names that fit", async () => {
    enableAll(4, () => true);
    const d = await door({});
    expect(d.offered.filter((n) => OFFERED_NAMES.includes(n))).toEqual(OFFERED_NAMES);
    // Nothing else of Wave 4 slips in: the Bitbucket merge, Azure, Cloud Run and the commits are out.
    expect(
      d.offered.filter((n) => /bitbucket|azure|gcp|file_commit|commit_create/.test(n)),
    ).toEqual([]);
    for (const n of OFFERED_NAMES) {
      expect(n.length, n).toBeLessThanOrEqual(CONNECTOR_WRITE_TOOL_NAME_MAX);
      expect(n, n).toMatch(/^[A-Za-z0-9_-]+$/);
    }
    expect(
      D1_SERVICES.reduce(
        (n, s) =>
          n +
          offerableWritesEnabledBy(s, 4).filter((r) => r.wave === 4 && r.bound === undefined)
            .length,
        0,
      ),
    ).toBe(27);
  });

  test("an opt-in from before D1 (wave 4, nothing approved by name) offers none; a write not approved is not offered", async () => {
    enableAll(4, () => false);
    expect((await door({})).offered.filter((n) => OFFERED_NAMES.includes(n))).toEqual([]);
    enableAll(4, (r) => r.toolId !== "jenkins_build_abort");
    const d = await door({});
    expect(d.offered).not.toContain("jenkins__jenkins_build_abort");
    expect(d.offered).toContain("jenkins__jenkins_build_trigger");
  });

  test("the Bitbucket merge is never offered, even enabled at wave 4 and approved by name", async () => {
    setModelWriteEnablement(db, "bitbucket", 4, 1, ["bitbucket_pr_merge"]);
    expect(offerableWritesEnabledBy("bitbucket", 4)).toEqual([]);
    expect(writesEnabledBy("bitbucket", 4).map((r) => r.toolId)).toContain("bitbucket_pr_merge");
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => ALLOWED,
      listServerTools: async (s) => listingFor(s),
      toolsEpoch: () => 0,
      warn: () => {},
    });
    expect(src.offerableEnabledRows().map((r) => r.toolId)).toEqual([]);
  });

  test("a reader missing from the server's listing means the row is not offered", async () => {
    enableAll(4, () => true);
    const d = await door({ omitReaders: true });
    expect(d.offered.filter((n) => OFFERED_NAMES.includes(n))).toEqual([]);
  });

  test("a reader that fails at call time is { refused }: no prompt, and only the read was dispatched", async () => {
    enableAll(4, () => true);
    const d = await door({ readThrows: true });
    const out = await d.call(
      "jenkins__jenkins_build_trigger",
      MIN_INPUT["jenkins_build_trigger"] ?? {},
    );
    expect(out).toEqual({ refused: WAVE4_BEFORE_REFUSAL });
    expect(d.confirmed).toEqual([]);
    expect(d.plain).toEqual([]);
    expect(writesOnly(d)).toEqual([]);
    // an unreadable reply (no job in it) is the same
    const empty = await door({ readReply: mcp({}) });
    expect(await empty.call("jenkins__jenkins_build_trigger", { jobName: "deploy" })).toEqual({
      refused: WAVE4_BEFORE_REFUSAL,
    });
    expect(empty.confirmed).toEqual([]);
  });

  test("a GitHub merge with no sha, or the wrong one, is refused with the guard's reason before any prompt", async () => {
    enableAll(4, () => true);
    const pr = {
      title: "T",
      state: "open",
      head: { ref: "x", sha: D1_SHA },
      base: { ref: "main" },
    };
    const d = await door({ readReply: mcp(pr) });
    const input = { owner: "acme", repo: "api", pullNumber: 42 };
    for (const sha of [undefined, "b".repeat(40)]) {
      const out = await d.call("github__github_pr_merge", { ...input, sha });
      expect(JSON.stringify(out), String(sha)).toContain("current head commit");
    }
    expect(d.confirmed).toEqual([]);
    expect(writesOnly(d)).toEqual([]);
  });

  test("the prompt says what to type; the exact text runs the write as an origin:model action, a mismatch or a denial is declined", async () => {
    enableAll(4, () => true);
    const reply = mcp({ name: "deploy-prod", fullName: "deploy-prod", buildable: true });
    const ok = await door({ readReply: reply });
    const out = await ok.call("jenkins__jenkins_build_trigger", { jobName: "deploy-prod" });
    expect(out).toEqual({ ok: true, queued: "jenkins.build.trigger" });
    expect(ok.confirmed).toHaveLength(1);
    expect(ok.confirmed[0]?.confirmText).toBe("jenkins/trigger deploy-prod");
    expect(ok.confirmed[0]?.prompt).toContain(
      "To approve, type exactly: jenkins/trigger deploy-prod",
    );
    expect(ok.confirmed[0]?.prompt).toContain("Requested by: the model");
    expect(ok.confirmed[0]?.prompt).toContain("Job: deploy-prod");
    const write = writesOnly(ok);
    expect(write).toHaveLength(1);
    expect(write[0]?.origin).toBe("model");
    expect(ok.plain).toEqual([]);

    const mismatch = await door({
      readReply: reply,
      answer: () => ({ approved: true, typed: "jenkins/trigger other" }),
    });
    expect(
      await mismatch.call("jenkins__jenkins_build_trigger", { jobName: "deploy-prod" }),
    ).toEqual({
      declined: DECLINED_RESULT_TEXT,
    });
    expect(writesOnly(mismatch)).toEqual([]);

    const denied = await door({
      readReply: reply,
      answer: () => ({ approved: false, typed: "" }),
    });
    expect(await denied.call("jenkins__jenkins_build_trigger", { jobName: "deploy-prod" })).toEqual(
      {
        declined: DECLINED_RESULT_TEXT,
      },
    );
    expect(writesOnly(denied)).toEqual([]);
  });

  test("a write-transport row (Argo CD) is read, shown and run the same way", async () => {
    enableAll(4, () => true);
    const app = {
      metadata: { name: "web" },
      spec: { destination: { namespace: "prod" } },
      status: { sync: { status: "OutOfSync" }, history: [{ id: 12, revision: "r12" }] },
    };
    const d = await door({ readReply: mcp(app) });
    expect(await d.call("argocd__argocd_app_rollback", { name: "web", id: 12 })).toEqual({
      ok: true,
      queued: "argocd.app.rollback",
    });
    expect(d.confirmed[0]?.confirmText).toBe("argocd/rollback web@12");
    expect(d.confirmed[0]?.prompt).toContain("History entry 12: r12");
    // An id outside the history is refused before the prompt.
    const bad = await door({ readReply: mcp(app) });
    expect(
      JSON.stringify(await bad.call("argocd__argocd_app_rollback", { name: "web", id: 99 })),
    ).toContain("deployment history");
    expect(bad.confirmed).toEqual([]);
  });
});
