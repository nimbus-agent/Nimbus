// Phase 7 slice 4, spec acceptance 3: a cost report the owner generated with `nimbus cost report schedule`
// and approved as a standing rule posts on its schedule with no prompt, audited `standing_approved` with one
// egress row, and the posted body is exactly the preview `nimbus cost report <name> --channel slack` shows.
// Without a rule the run stops and the owner is told. An Outlook channel creates a DRAFT; nothing is sent.
// Real store, real scheduler, real runner, real executor, real egress ledger; only the transport is fake.
//
// Dates are relative to the real clock: a standing rule's expiry and window are read from it.
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeEgressSink } from "../egress/egress-ledger.ts";
import { buildUnattendedWorkflowWriteExecutor } from "../engine/run-ask.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import { LocalIndex } from "../index/local-index.ts";
import { dispatchCostRpc } from "../ipc/cost-rpc.ts";
import type { ChatopsPolicy } from "../policy/types.ts";
import { deriveRule } from "../standing/standing-rule-derive.ts";
import { insertRule } from "../standing/standing-rule-store.ts";
import { WorkflowScheduler } from "./workflow-scheduler.ts";
import { listScheduledWorkflows } from "./workflow-store.ts";

const DAY = 86_400_000;
const HEADER =
  "BilledCost,BillingAccountId,BillingCurrency,ChargePeriodStart,ProviderName,ServiceName,Tags";
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };
const CONFIG = [
  "[[cost.rule]]",
  'match = { tag = { product = "*" } }',
  'set = { product = "{tag.product}" }',
  "",
  "[[cost.report]]",
  'name = "checkout-weekly"',
  'scope = { product = "checkout" }',
  'period = "7d"',
  'tz = "UTC"',
  "",
  "[[cost.report.channel]]",
  'report = "checkout-weekly"',
  'kind = "slack"',
  'to = "C0123ABC"',
  'format = "markdown"',
  'template = "*Checkout*, {period_start} to {period_end}: {total} ({change}). {breakdown}"',
  "",
  "[[cost.report.channel]]",
  'report = "checkout-weekly"',
  'kind = "outlook"',
  'to = "cfo@example.com"',
  'format = "html"',
  'template_file = "weekly.html"',
  'subject = "Checkout cost, {period_start} to {period_end}"',
  "",
].join("\n");

let db: Database;
let localIndex: LocalIndex;
let dir: string;
beforeEach(async () => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
  dir = mkdtempSync(join(tmpdir(), "nimbus-cost-delivery-"));
  mkdirSync(join(dir, "cost-templates"));
  writeFileSync(join(dir, "cost-templates", "weekly.html"), "<p>Checkout: {total}</p>{breakdown}");
  writeFileSync(join(dir, "nimbus.toml"), CONFIG);
  const rows = [HEADER];
  for (let d = 1; d <= 16; d++) {
    const day = new Date(Date.now() - d * DAY).toISOString().slice(0, 10);
    const cost = d <= 8 ? 20 : 10;
    rows.push(
      `${String(cost)},111,USD,${day}T00:00:00Z,AWS,<!here> EC2,"{""product"":""checkout""}"`,
    );
  }
  writeFileSync(join(dir, "a.csv"), rows.join("\n"));
  await cli("cost.import", { path: join(dir, "a.csv") });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

async function cli(method: string, params: unknown): Promise<unknown> {
  const out = await dispatchCostRpc(method, params, {
    db,
    configDir: dir,
    caller: { kind: "cli" },
    chatops: () => NO_CHATOPS,
  });
  if (out.kind !== "hit") throw new Error(`${method} was not routed`);
  return out.value;
}

function approve(workflow: string): void {
  const derived = deriveRule(db, { workflow, step: 2 }, () => true, Date.now() - 1000);
  insertRule(db, { ...derived.rule, approvalAuditId: 1 });
}

function scheduler(dispatched: PlannedAction[], notes: string[]): WorkflowScheduler {
  const dispatcher: ConnectorDispatcher = {
    async dispatch(action) {
      dispatched.push(action);
      return { ok: true };
    },
  };
  return new WorkflowScheduler({
    db,
    // One second after the earliest stored fire: due, and inside the missed-fire grace window.
    now: () => Math.min(...listScheduledWorkflows(db).map((w) => w.schedule_next_at ?? 0)) + 1000,
    makeExecutor: () =>
      buildUnattendedWorkflowWriteExecutor({
        localIndex,
        dispatcher,
        egressSink: makeEgressSink(db),
        getTribalKbConfig: () => undefined,
        enforcedPolicy: () =>
          ({ capabilitiesDisabled: new Set<string>(), chatops: NO_CHATOPS }) as never,
      }),
    notify: (title, body) => {
      notes.push(`${title}: ${body}`);
    },
    costConfigDir: dir,
  });
}

const countRows = (sql: string): number => (db.query(sql).get() as { n: number }).n;

describe("acceptance 3: a scheduled cost report under a standing rule", () => {
  test("posts with no prompt: standing_approved, one egress row, the body equal to the preview", async () => {
    const generated = (await cli("cost.reportSchedule", {
      name: "checkout-weekly",
      channel: "slack",
    })) as {
      channels: { workflow: string; status: string }[];
    };
    expect(generated.channels.map((c) => [c.workflow, c.status])).toEqual([
      ["cost-checkout-weekly-slack", "new"],
    ]);
    approve("cost-checkout-weekly-slack");
    const preview = (await cli("cost.reportRender", {
      name: "checkout-weekly",
      channel: "slack",
    })) as {
      channels: { body: string | null; doorRefusal: string | null }[];
    };

    const dispatched: PlannedAction[] = [];
    const notes: string[] = [];
    expect(await scheduler(dispatched, notes).tick()).toEqual([
      { workflow: "cost-checkout-weekly-slack", kind: "ran", status: "done" },
    ]);
    const posts = dispatched.filter((a) => a.type === "slack.message.post");
    expect(posts).toHaveLength(1);
    const text = (posts[0]?.payload as { input: { channel: string; text: string } } | undefined)
      ?.input;
    expect(text?.channel).toBe("C0123ABC");
    expect(preview.channels[0]?.doorRefusal).toBeNull();
    expect(text?.text).toBe(preview.channels[0]?.body ?? "missing preview");
    expect(text?.text).not.toContain("<!here>");
    expect(notes).toEqual([]);
    const audit = db
      .query("SELECT hitl_status FROM audit_log WHERE action_type = 'slack.message.post'")
      .all() as { hitl_status: string }[];
    expect(audit.map((r) => r.hitl_status)).toEqual(["standing_approved"]);
    expect(
      countRows(
        "SELECT COUNT(*) AS n FROM egress_ledger WHERE hitl_status = 'standing_approved' AND result_status = 'authorized'",
      ),
    ).toBe(1);
  });

  test("with no rule the run stops before posting and the owner is told once", async () => {
    await cli("cost.reportSchedule", { name: "checkout-weekly", channel: "slack" });
    const dispatched: PlannedAction[] = [];
    const notes: string[] = [];
    expect(await scheduler(dispatched, notes).tick()).toEqual([
      { workflow: "cost-checkout-weekly-slack", kind: "ran", status: "blocked_on_approval" },
    ]);
    await new Promise((r) => setTimeout(r, 1));
    expect(dispatched.filter((a) => a.type === "slack.message.post")).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toContain("cost-checkout-weekly-slack is waiting for you");
  });

  test("an Outlook channel creates a draft under its rule; nothing is sent", async () => {
    await cli("cost.reportSchedule", { name: "checkout-weekly", channel: "outlook" });
    approve("cost-checkout-weekly-outlook");
    const dispatched: PlannedAction[] = [];
    expect(await scheduler(dispatched, []).tick()).toEqual([
      { workflow: "cost-checkout-weekly-outlook", kind: "ran", status: "done" },
    ]);
    const writes = dispatched.filter((a) => a.type.startsWith("outlook."));
    expect(writes).toHaveLength(1);
    expect(writes[0]?.type).toContain("draft");
    expect(dispatched.some((a) => /send/i.test(a.type))).toBe(false);
    const input = (writes[0]?.payload as { input: Record<string, unknown> } | undefined)?.input;
    expect(input?.["to"]).toBe("cfo@example.com");
    expect(input?.["contentType"]).toBe("html");
    expect(String(input?.["subject"])).toStartWith("Checkout cost, ");
  });
});
