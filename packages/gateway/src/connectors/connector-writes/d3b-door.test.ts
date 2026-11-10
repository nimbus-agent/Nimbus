// Phase 9.7 D3b through the real door: the seven deploy-trigger and mobile-release rows are offered
// only at `--wave 4` with each write approved by name, read before they prompt, refused by their
// guards or the model-door rules before any prompt, typed to confirm, and run as `origin: "model"`
// actions through the door's executor. The rows, the listing check, the before-state runner and
// the executor are the production ones; the connector side is a fake slot and a fake dispatcher.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { toStandardSchema } from "@mastra/core/schema";

import { makeEgressSink } from "../../egress/egress-ledger.ts";
import { createBeforeStateRunner, isBeforeReadActionType } from "../../engine/before-state.ts";
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
import { classifyActionType } from "../proposable-actions.ts";
import { DEPLOY_MOBILE_ROWS } from "./deploy-mobile.ts";
import {
  FIREBASE_TESTER_EMAIL_REFUSAL,
  NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL,
} from "./deploy-refusals.ts";
import { offerableWritesEnabledBy, setModelWriteEnablement } from "./enablement-store.ts";
import { createModelWriteToolSource } from "./model-write-source.ts";
import { type ConnectorWriteRow, previewTemplateKeys } from "./types.ts";

const SERVICES = ["bitrise", "codemagic", "firebase", "netlify", "testflight", "vercel"];
const nameOf = (r: ConnectorWriteRow): string => `${serviceOf(r.actionType)}__${r.toolId}`;
const NAMES = DEPLOY_MOBILE_ROWS.map(nameOf).sort((a, b) => a.localeCompare(b));

const mcp = (value: unknown) => ({ content: [{ type: "text", text: JSON.stringify(value) }] });

/** What a server lists for `service`: each write with its template keys, each reader with none. */
function listingFor(service: string, opts: { readonly omitReaders?: boolean } = {}) {
  const out: Record<string, unknown> = {};
  const entry = (keys: readonly string[]) => ({
    description: "tool",
    inputSchema: toStandardSchema({
      type: "object",
      properties: Object.fromEntries(keys.map((k) => [k, {}])),
    } as Parameters<typeof toStandardSchema>[0]),
  });
  for (const r of DEPLOY_MOBILE_ROWS) {
    if (serviceOf(r.actionType) !== service || r.preview === undefined) continue;
    out[mcpClientToolKey(service, r.toolId)] = entry([...previewTemplateKeys(r.preview)]);
    if (opts.omitReaders !== true && r.before !== undefined) {
      out[mcpClientToolKey(service, r.before.tool)] = entry([]);
      if (r.before.also !== undefined) {
        out[mcpClientToolKey(service, r.before.also.tool)] = entry([]);
      }
    }
  }
  return out;
}

const ALLOWED = { capabilitiesDisabled: new Set<string>() } as unknown as EnforcedPolicy;

// Replies by read tool. `vercel_get`, `netlify_get` and `firebase_get` are the vendors' documented
// shapes (the connector returns them raw); the rest are the connector's own projections.
const REPLIES: Readonly<Record<string, unknown>> = {
  vercel_get: {
    id: "dpl_abcdefgh12345678",
    name: "web",
    projectId: "prj_1",
    target: "production",
    readyState: "READY",
  },
  vercel_project_production_get: { projectId: "prj_1", name: "web", production: null },
  netlify_get: {
    name: "acme-web",
    build_settings: { repo_branch: "main" },
    published_deploy: { id: "dep1", state: "ready", branch: "main" },
  },
  netlify_deploy_list: [{ id: "dep1", state: "ready", branch: "main", context: "production" }],
  bitrise_build_latest: { build: null },
  codemagic_build_latest: { build: null, scanned: 50 },
  testflight_beta_groups_list: {
    groups: [
      { id: "g-priv", name: "Team", isInternalGroup: false, publicLinkEnabled: false },
      { id: "g-pub", name: "Public Beta", isInternalGroup: false, publicLinkEnabled: true },
    ],
  },
  testflight_build_groups_get: { groups: [] },
  firebase_get: { displayVersion: "2.4.0", buildVersion: "240" },
};

describe("D3b through the real door", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 84);
  });
  afterEach(() => db.close());

  function enableAll(maxWave: 2 | 3 | 4, approve: (r: ConnectorWriteRow) => boolean): void {
    for (const s of SERVICES) {
      const approved = DEPLOY_MOBILE_ROWS.filter(
        (r) => serviceOf(r.actionType) === s && approve(r),
      ).map((r) => r.toolId);
      setModelWriteEnablement(db, s, maxWave, 1, approved);
    }
  }

  async function door(
    opts: {
      readonly omitReaders?: boolean;
      readonly replies?: Readonly<Record<string, unknown>>;
      readonly readThrows?: boolean;
      readonly answer?: (req: ConfirmedApprovalRequest) => ConfirmedApprovalResult;
    } = {},
  ) {
    const src = createModelWriteToolSource({
      db,
      enforcedPolicy: () => ALLOWED,
      listServerTools: async (service) =>
        listingFor(service, opts.omitReaders === true ? { omitReaders: true } : {}),
      toolsEpoch: () => 0,
      warn: () => {},
    });
    const confirmed: ConfirmedApprovalRequest[] = [];
    const dispatched: PlannedAction[] = [];
    const consent: ConsentChannel = {
      requestApproval: async () => true,
      requestConfirmedApproval: async (req) => {
        confirmed.push(req);
        return opts.answer?.(req) ?? { approved: true, typed: req.confirmText };
      },
    };
    const replies = { ...REPLIES, ...opts.replies };
    const exec = new ToolExecutor(
      consent,
      { recordAudit: () => {} } as AuditSink,
      {
        dispatch: async (a: PlannedAction) => {
          dispatched.push(a);
          if (isBeforeReadActionType(a.type)) {
            if (opts.readThrows === true) throw new Error("the read failed");
            const key = String((a.payload as { mcpToolId?: unknown }).mcpToolId);
            const tool = Object.keys(replies)
              .sort((x, y) => y.length - x.length)
              .find((t) => key.endsWith(t));
            return mcp(tool === undefined ? {} : replies[tool]);
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

  test("seven rows on six services", () => {
    expect(NAMES).toHaveLength(7);
    expect([...new Set(DEPLOY_MOBILE_ROWS.map((r) => serviceOf(r.actionType)))].sort()).toEqual(
      SERVICES,
    );
  });

  test("at max_wave 3 (the default) none is offered, whatever was approved", async () => {
    enableAll(3, () => true);
    const d = await door();
    expect(d.offered.filter((n) => NAMES.includes(n))).toEqual([]);
    for (const s of SERVICES) {
      expect(offerableWritesEnabledBy(s, 3).filter((r) => r.wave === 4)).toEqual([]);
    }
  });

  test("at max_wave 4 with each write approved by name exactly the seven are offered, under names that fit", async () => {
    enableAll(4, () => true);
    const d = await door();
    expect(d.offered.filter((n) => NAMES.includes(n))).toEqual(NAMES);
    for (const n of NAMES) {
      expect(n.length, n).toBeLessThanOrEqual(CONNECTOR_WRITE_TOOL_NAME_MAX);
      expect(n, n).toMatch(/^[A-Za-z0-9_-]+$/);
    }
  });

  test("an opt-in from before D3b (wave 4, nothing approved by name) offers none; a write not approved is not offered", async () => {
    enableAll(4, () => false);
    expect((await door()).offered.filter((n) => NAMES.includes(n))).toEqual([]);
    enableAll(4, (r) => r.toolId !== "firebase_app_distribution_distribute");
    const d = await door();
    expect(d.offered).not.toContain("firebase__firebase_app_distribution_distribute");
    expect(d.offered).toContain("vercel__vercel_deployment_promote");
  });

  test("a reader missing from the server's listing, first or second, means the row is not offered", async () => {
    enableAll(4, () => true);
    expect((await door({ omitReaders: true })).offered.filter((n) => NAMES.includes(n))).toEqual(
      [],
    );
  });

  test("a reader that fails at call time refuses: no prompt, only the read was dispatched", async () => {
    enableAll(4, () => true);
    const d = await door({ readThrows: true });
    const out = await d.call("bitrise__bitrise_build_trigger", {
      appSlug: "app-1",
      branch: "main",
      workflow: "deploy",
    });
    expect(JSON.stringify(out)).toContain("refused");
    expect(d.confirmed).toEqual([]);
    expect(writesOnly(d)).toEqual([]);
  });

  test("a Vercel production redeploy is offered: the prompt carries the effect line and the typed text, the write is an origin:model action", async () => {
    enableAll(4, () => true);
    const d = await door();
    const out = await d.call("vercel__vercel_deployment_redeploy", {
      deploymentId: "dpl_abcdefgh12345678",
      target: "production",
    });
    expect(out).toEqual({ ok: true, queued: "vercel.deployment.redeploy" });
    expect(d.confirmed).toHaveLength(1);
    expect(d.confirmed[0]?.confirmText).toBe("vercel/redeploy 12345678 production");
    const prompt = d.confirmed[0]?.prompt ?? "";
    expect(prompt).toContain("To approve, type exactly: vercel/redeploy 12345678 production");
    expect(prompt).toContain("Requested by: the model");
    expect(prompt).toContain("the deployment it replaces is not shown");
    const write = writesOnly(d);
    expect(write).toHaveLength(1);
    expect(write[0]?.origin).toBe("model");
  });

  test("a mismatch or a denial of the typed text is declined, and nothing runs", async () => {
    enableAll(4, () => true);
    const input = { projectId: "prj_0123456789abcdef", deploymentId: "dpl_new00000001" };
    const mismatch = await door({
      answer: () => ({ approved: true, typed: "vercel/promote other" }),
    });
    expect(await mismatch.call("vercel__vercel_deployment_promote", input)).toEqual({
      declined: DECLINED_RESULT_TEXT,
    });
    expect(writesOnly(mismatch)).toEqual([]);
    const denied = await door({ answer: () => ({ approved: false, typed: "" }) });
    expect(await denied.call("vercel__vercel_deployment_promote", input)).toEqual({
      declined: DECLINED_RESULT_TEXT,
    });
    expect(writesOnly(denied)).toEqual([]);
  });

  test("Netlify: a branch equal to the production branch is refused with the guard's reason before any prompt", async () => {
    enableAll(4, () => true);
    const d = await door();
    const out = await d.call("netlify__netlify_build_trigger", {
      siteId: "site-1",
      branch: "main",
    });
    expect(JSON.stringify(out)).toContain("pass production: true");
    expect(d.confirmed).toEqual([]);
    expect(writesOnly(d)).toEqual([]);
    // An unreadable production branch is the same refusal.
    const blind = await door({ replies: { netlify_get: { name: "acme-web" } } });
    expect(
      JSON.stringify(
        await blind.call("netlify__netlify_build_trigger", { siteId: "site-1", branch: "x" }),
      ),
    ).toContain("pass production: true");
    expect(blind.confirmed).toEqual([]);
  });

  test("Netlify: a feature branch builds; production: true types its own text and says PRODUCTION", async () => {
    enableAll(4, () => true);
    const branch = await door();
    await branch.call("netlify__netlify_build_trigger", {
      siteId: "site-0001",
      branch: "feature-x",
    });
    expect(branch.confirmed[0]?.confirmText).toBe("netlify/build ite-0001");
    const prod = await door();
    await prod.call("netlify__netlify_build_trigger", { siteId: "site-0001", production: true });
    expect(prod.confirmed[0]?.confirmText).toBe("netlify/publish production ite-0001");
    expect(prod.confirmed[0]?.prompt).toContain("PRODUCTION");
    expect(writesOnly(prod)).toHaveLength(1);
  });

  test("Netlify: neither or both of branch and production is refused before any read or prompt", async () => {
    enableAll(4, () => true);
    const d = await door();
    for (const input of [{ siteId: "s" }, { siteId: "s", branch: "x", production: true }]) {
      expect(JSON.stringify(await d.call("netlify__netlify_build_trigger", input))).toContain(
        NETLIFY_BRANCH_OR_PRODUCTION_REFUSAL,
      );
    }
    expect(d.dispatched).toEqual([]);
    expect(d.confirmed).toEqual([]);
  });

  test("TestFlight: a public-link group is refused before any prompt; a private one shows each group's link state and runs", async () => {
    enableAll(4, () => true);
    const base = { appId: "1234567890", buildId: "b-0000-1111-2222-3333" };
    const pub = await door();
    expect(
      JSON.stringify(
        await pub.call("testflight__testflight_build_distribute", {
          ...base,
          betaGroupIds: ["g-priv", "g-pub"],
        }),
      ),
    ).toContain("public link");
    expect(pub.confirmed).toEqual([]);
    expect(writesOnly(pub)).toEqual([]);

    const ok = await door();
    const out = await ok.call("testflight__testflight_build_distribute", {
      ...base,
      betaGroupIds: ["g-priv"],
    });
    expect(out).toEqual({ ok: true, queued: "testflight.build.distribute" });
    expect(ok.confirmed[0]?.prompt).toContain(
      "Target group g-priv: Team (external; public link off)",
    );
    expect(ok.confirmed[0]?.confirmText).toBe("testflight/distribute 1234567890 222-3333");
  });

  test("Firebase: tester emails are refused before any read or prompt; groups run", async () => {
    enableAll(4, () => true);
    const d = await door();
    const refused = await d.call("firebase__firebase_app_distribution_distribute", {
      appId: "1:123456789:android:abc",
      releaseId: "rel_1",
      testerEmails: ["a@b.co"],
    });
    expect(JSON.stringify(refused)).toContain(FIREBASE_TESTER_EMAIL_REFUSAL);
    expect(d.dispatched).toEqual([]);
    expect(d.confirmed).toEqual([]);
    const ok = await door();
    expect(
      await ok.call("firebase__firebase_app_distribution_distribute", {
        appId: "1:123456789:android:abc",
        releaseId: "rel_1",
        groupAliases: ["qa"],
      }),
    ).toEqual({ ok: true, queued: "firebase.release.distribute" });
    expect(ok.confirmed[0]?.prompt).toContain(
      "Already sent: Firebase cannot say who already has this release",
    );
    expect(ok.confirmed[0]?.confirmText).toBe("firebase/distribute 1:123456789:android:abc rel_1");
  });

  test("Bitrise and Codemagic: the latest-build reader runs (a _latest read) and the build starts after the typed text", async () => {
    enableAll(4, () => true);
    const b = await door();
    expect(
      await b.call("bitrise__bitrise_build_trigger", {
        appSlug: "app-slug-1",
        branch: "main",
        workflow: "deploy",
      }),
    ).toEqual({ ok: true, queued: "bitrise.build.trigger" });
    expect(b.confirmed[0]?.prompt).toContain(
      "Latest build: (none: no build of this branch and workflow yet)",
    );
    const c = await door();
    expect(
      await c.call("codemagic__codemagic_build_trigger", {
        appId: "app1",
        workflowId: "ios",
        branch: "main",
      }),
    ).toEqual({ ok: true, queued: "codemagic.build.trigger" });
    expect(c.confirmed[0]?.prompt).toContain("last 50 builds");
  });

  test("none of the seven is proposable on the MCP act door", () => {
    const ctx = {
      modelAccessServices: () => new Set<string>(),
      userMcpModelAccessAllowed: () => false,
    };
    for (const r of DEPLOY_MOBILE_ROWS) {
      expect(classifyActionType(r.actionType, ctx).kind, r.toolId).toBe("denied");
    }
  });
});
