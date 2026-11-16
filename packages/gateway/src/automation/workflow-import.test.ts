// Signed workflow import (I59): the import core (plan task 4).
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { publisherKeyFingerprint } from "@nimbus-dev/registry-format";
import {
  FIXTURE_NOW,
  FIXTURE_STEPS,
  fixtureBody,
  fixtureKey,
  pubB64,
  signFixture,
} from "../connectors/connector-writes/workflow-bundle.test-helpers.ts";
import type { OwnerApproval } from "../engine/owner-only-approval.ts";
import type { PlannedAction } from "../engine/types.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { ClientKind } from "../ipc/server/client-kind.ts";
import { BundleError } from "./workflow-bundle.ts";
import {
  IMPORT_ERR,
  ImportError,
  type ImportParams,
  importWorkflowBundle,
} from "./workflow-import.ts";
import { floorFor } from "./workflow-import-store.ts";
import { parseWorkflowSteps, workflowStepsSha256 } from "./workflow-steps.ts";
import { deleteWorkflowByName, getWorkflowByName, upsertWorkflowByName } from "./workflow-store.ts";

const KEY_A = fixtureKey(7);
const KEY_B = fixtureKey(8);
const FP_A = publisherKeyFingerprint(pubB64(KEY_A));

type Ask = (a: PlannedAction) => Promise<OwnerApproval>;

function harness(opts: { ask?: Ask; kind?: ClientKind } = {}) {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  const asked: PlannedAction[] = [];
  let clock = FIXTURE_NOW;
  const ask: Ask =
    opts.ask ??
    (async (a) => {
      asked.push(a);
      return { approved: true, auditId: 41 };
    });
  const wrapped: Ask = async (a) => {
    if (opts.ask !== undefined) asked.push(a);
    return ask(a);
  };
  const deps = {
    db,
    now: () => clock,
    askOwner: wrapped,
    clientKind: opts.kind ?? ("cli" as ClientKind),
  };
  return {
    db,
    asked,
    deps,
    tick: (ms: number) => {
      clock += ms;
    },
    run: (params: ImportParams) => importWorkflowBundle(deps, params),
  };
}

function bundle(over: Record<string, unknown> = {}, key = KEY_A, steps = FIXTURE_STEPS): string {
  return signFixture(fixtureBody(over, steps), key);
}

function payloadOf(h: { asked: PlannedAction[] }): Record<string, unknown> {
  return (h.asked[0]?.payload ?? {}) as Record<string, unknown>;
}

async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    if (e instanceof ImportError || e instanceof BundleError) return e.code;
    throw e;
  }
  throw new Error("expected a refusal");
}

function rows(db: Database, table: string): number {
  return (db.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

describe("a new import", () => {
  test("writes the workflow and its provenance in one go, asking the owner once with the exact text", async () => {
    const h = harness();
    const r = await h.run({ bundleText: bundle() });
    expect(r).toMatchObject({
      dryRun: false,
      replaced: false,
      alreadyImported: false,
      scheduled: false,
    });
    expect(h.asked).toHaveLength(1);
    const ask = h.asked[0] as PlannedAction;
    expect(ask.type).toBe("workflow.import");
    const payload = ask.payload as Record<string, unknown>;
    expect(payload["name"]).toBe("weekly-cleanup");
    expect(payload["signerFingerprint"]).toBe(FP_A);
    expect(payload["replace"]).toBe(false);
    expect(payload["schedule"]).toBeNull();
    expect(payload["clearsSchedule"]).toBe(false);
    expect(String(payload["promptText"])).toContain("This will: create a new workflow");
    const stored = getWorkflowByName(h.db, "weekly-cleanup");
    expect(stored).not.toBeNull();
    expect(floorFor(h.db, FP_A, "weekly-cleanup")).toMatchObject({
      workflowId: stored?.id,
      importCount: 1,
    });
    expect(h.db.query("SELECT approval_audit_id AS a FROM workflow_import").get()).toEqual({
      a: 41,
    });
    // Nothing about a schedule or a rule came with it.
    expect(stored?.schedule).toBeNull();
    expect(rows(h.db, "standing_rule")).toBe(0);
  });

  test("the stored text is the signed text, and its hash is the one the prompt printed", async () => {
    const h = harness();
    const text = bundle();
    await h.run({ bundleText: text });
    const stored = getWorkflowByName(h.db, "weekly-cleanup");
    const body = JSON.parse(text).body as { steps: unknown[]; stepsSha256: string };
    expect(JSON.parse(stored?.steps_json ?? "null")).toEqual(body.steps);
    expect(workflowStepsSha256(parseWorkflowSteps(stored?.steps_json ?? ""))).toBe(
      body.stepsSha256,
    );
    const payload = payloadOf(h);
    expect(String(payload["promptText"])).toContain(`Content hash: ${body.stepsSha256}`);
  });

  test("a dry run renders the text, writes nothing and asks nobody", async () => {
    const h = harness();
    const r = await h.run({ bundleText: bundle(), dryRun: true });
    expect(r.dryRun).toBe(true);
    expect((r as { promptText: string }).promptText).toContain("Import the workflow");
    expect(h.asked).toHaveLength(0);
    expect(getWorkflowByName(h.db, "weekly-cleanup")).toBeNull();
    expect(rows(h.db, "workflow_import")).toBe(0);
  });
});

describe("refusals write nothing and ask nobody", () => {
  type H = ReturnType<typeof harness>;
  type Outcome = { code: string; h: H; before: [number, number] };
  const cases: Array<[string, () => Promise<Outcome>]> = [];
  const counts = (h: H): [number, number] => [
    rows(h.db, "workflow"),
    rows(h.db, "workflow_import"),
  ];
  const add = (name: string, build: (h: H) => Promise<unknown>, kind?: ClientKind) => {
    cases.push([
      name,
      async () => {
        const h = harness(kind === undefined ? {} : { kind });
        // `build` may set up a prior import first; the refused call is the LAST thing it returns, so
        // the counts are taken just before it by wrapping `run`.
        let before = counts(h);
        const realRun = h.run;
        h.run = (params) => {
          before = counts(h);
          return realRun(params);
        };
        const code = await codeOf(build(h));
        return { code, h, before };
      },
    ]);
  };
  const run = (h: ReturnType<typeof harness>, text: string, extra: Partial<ImportParams> = {}) =>
    h.run({ bundleText: text, ...extra });

  add("a connection that is not the owner's (unknown kind)", (h) => run(h, bundle()), "unknown");
  add("a connection that is an agent kind", (h) => run(h, bundle()), "mcp" as ClientKind);
  add("a bad signature", (h) => {
    const f = JSON.parse(bundle());
    f.body.name = "tampered";
    return run(h, JSON.stringify(f));
  });
  add("a bundle carrying a schedule", (h) =>
    run(h, signFixture({ ...fixtureBody(), schedule: "* * * * *" })),
  );
  add("a bundle carrying a standing rule", (h) =>
    run(h, signFixture({ ...fixtureBody(), standingRule: {} })),
  );
  add("a model step", (h) =>
    run(h, signFixture({ ...fixtureBody(), steps: [...FIXTURE_STEPS, { kind: "run", run: "x" }] })),
  );
  add("a malformed file", (h) => run(h, "not json"));
  add("a signer pin that does not match", (h) => run(h, bundle(), { signer: "0".repeat(12) }));
  add("a signer pin that is too short", (h) => run(h, bundle(), { signer: "abc" }));
  add("a schedule the cron parser refuses", (h) => run(h, bundle(), { schedule: "* * *" }));
  add("a schedule under five minutes", (h) =>
    run(h, bundle(), { schedule: "* * * * *", scheduleTz: "UTC" }),
  );
  add("a time zone that is not one", (h) =>
    run(h, bundle(), { schedule: "0 6 * * *", scheduleTz: "Not/AZone" }),
  );
  add("a prompt too large to show", (h) => {
    const big = Array.from({ length: 10 }, (_, i) => [
      `f${String(i)}`,
      { const: "x".repeat(8000) },
    ]);
    const steps = [
      FIXTURE_STEPS[0],
      { kind: "write", label: "w", tool: "gmail_thread_archive", input: Object.fromEntries(big) },
    ];
    return run(h, signFixture({ ...fixtureBody({}, steps) }));
  });
  add("a name collision without --replace", async (h) => {
    upsertWorkflowByName(h.db, "weekly-cleanup", null, JSON.stringify(FIXTURE_STEPS), 1);
    return run(h, bundle());
  });
  add("a stale bundle (older than the floor)", async (h) => {
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 500 }) });
    h.asked.length = 0;
    return run(h, bundle({ issuedAt: FIXTURE_NOW - 900 }), { replace: true });
  });
  add("an equal time with different bytes", async (h) => {
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 500 }) });
    h.asked.length = 0;
    return run(h, bundle({ issuedAt: FIXTURE_NOW - 500, description: "different" }), {
      replace: true,
    });
  });
  add("a signer change without both flags", async (h) => {
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 500 }) });
    h.asked.length = 0;
    return run(h, bundle({ issuedAt: FIXTURE_NOW - 100 }, KEY_B), { replace: true });
  });
  add("a signer change with only --accept-signer-change", async (h) => {
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 500 }) });
    h.asked.length = 0;
    return run(h, bundle({ issuedAt: FIXTURE_NOW - 100 }, KEY_B), { acceptSignerChange: true });
  });
  add("a far-future issuedAt", (h) =>
    run(h, bundle({ issuedAt: FIXTURE_NOW + 2 * 24 * 3600 * 1000 })),
  );
  add("a name a bundle cannot hold", (h) => run(h, bundle({ name: "bad name" })));
  add("an oversized file", (h) => run(h, " ".repeat(300 * 1024)));

  test.each(cases)("%s", async (_name, build) => {
    const { code, h, before } = await build();
    expect(code).toMatch(/^ERR_/);
    expect(h.asked).toHaveLength(0);
    // The refused call changed nothing: workflow and provenance counts are those just before it.
    expect([rows(h.db, "workflow"), rows(h.db, "workflow_import")]).toEqual(before);
    expect(rows(h.db, "standing_rule")).toBe(0);
  });

  test("the codes are the documented ones", async () => {
    const h = harness({ kind: "unknown" });
    expect(await codeOf(h.run({ bundleText: bundle() }))).toBe(IMPORT_ERR.LOCAL_ONLY);
    const h2 = harness();
    expect(await codeOf(h2.run({ bundleText: bundle(), signer: "0".repeat(12) }))).toBe(
      IMPORT_ERR.SIGNER_MISMATCH,
    );
    expect(await codeOf(h2.run({ bundleText: bundle(), signer: "xyz" }))).toBe(IMPORT_ERR.BAD_PIN);
  });
});

describe("approval answers", () => {
  test.each([
    ["not_human", IMPORT_ERR.NEEDS_HUMAN],
    ["declined", IMPORT_ERR.DECLINED],
  ] as const)("a %s answer writes nothing", async (reason, code) => {
    const h = harness({ ask: async () => ({ approved: false, reason }) });
    expect(await codeOf(h.run({ bundleText: bundle() }))).toBe(code);
    expect(h.asked).toHaveLength(1);
    expect(getWorkflowByName(h.db, "weekly-cleanup")).toBeNull();
    expect(rows(h.db, "workflow_import")).toBe(0);
  });
});

describe("replace, restore and the replay floor", () => {
  test("--replace replaces and the prompt says so, with the old content hash", async () => {
    const h = harness();
    upsertWorkflowByName(
      h.db,
      "weekly-cleanup",
      "mine",
      JSON.stringify([
        {
          kind: "query",
          label: "q",
          query: {
            service: "gmail",
            type: "email",
            where: [],
            select: "id",
            distinct: false,
            limit: 1,
          },
        },
      ]),
      5,
    );
    const r = await h.run({ bundleText: bundle(), replace: true });
    expect(r).toMatchObject({ replaced: true });
    expect(String(payloadOf(h)["promptText"])).toContain('REPLACE your workflow "weekly-cleanup"');
    expect(JSON.parse(getWorkflowByName(h.db, "weekly-cleanup")?.steps_json ?? "[]")).toHaveLength(
      2,
    );
  });

  test("a newer bundle from the same signer replaces after --replace and raises the floor", async () => {
    const h = harness();
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 900 }) });
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 100 }), replace: true });
    expect(floorFor(h.db, FP_A, "weekly-cleanup")).toMatchObject({
      issuedAt: FIXTURE_NOW - 100,
      importCount: 2,
    });
  });

  test("the same recorded bundle again, with the workflow in place, is already imported (no prompt)", async () => {
    const h = harness();
    const text = bundle();
    await h.run({ bundleText: text });
    h.asked.length = 0;
    const r = await h.run({ bundleText: text });
    expect(r).toMatchObject({ alreadyImported: true, replaced: false });
    expect(h.asked).toHaveLength(0);
    expect(floorFor(h.db, FP_A, "weekly-cleanup")?.importCount).toBe(1);
  });

  test("after the owner deletes the workflow, its own recorded bundle restores through the prompt", async () => {
    const h = harness();
    const text = bundle();
    await h.run({ bundleText: text });
    deleteWorkflowByName(h.db, "weekly-cleanup");
    h.asked.length = 0;
    const r = await h.run({ bundleText: text });
    expect(r).toMatchObject({ alreadyImported: false, replaced: false });
    expect(h.asked).toHaveLength(1);
    expect(String(payloadOf(h)["promptText"])).toContain("Restores the bundle you imported on");
    expect(floorFor(h.db, FP_A, "weekly-cleanup")?.issuedAt).toBe(FIXTURE_NOW - 1000);
  });

  test("an OLDER bundle after a delete stays stale: deleting never lets an older bundle back in", async () => {
    const h = harness();
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 100 }) });
    deleteWorkflowByName(h.db, "weekly-cleanup");
    expect(await codeOf(h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 900 }) }))).toBe(
      IMPORT_ERR.STALE,
    );
    expect(getWorkflowByName(h.db, "weekly-cleanup")).toBeNull();
  });

  test("a signer change is shown in capitals and goes through with both flags", async () => {
    const h = harness();
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 500 }) });
    h.asked.length = 0;
    await h.run({
      bundleText: bundle({ issuedAt: FIXTURE_NOW - 100 }, KEY_B),
      replace: true,
      acceptSignerChange: true,
    });
    expect(String(payloadOf(h)["promptText"])).toContain(
      `SIGNER CHANGED: "weekly-cleanup" WAS IMPORTED FROM ${FP_A}`,
    );
  });

  test("a deleted workflow's earlier signer is an informational line, and no --replace is needed", async () => {
    const h = harness();
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 500 }) });
    deleteWorkflowByName(h.db, "weekly-cleanup");
    h.asked.length = 0;
    await h.run({ bundleText: bundle({ issuedAt: FIXTURE_NOW - 100 }, KEY_B) });
    expect(String(payloadOf(h)["promptText"])).toContain(
      `was imported from ${FP_A} before you deleted it`,
    );
  });
});

describe("schedules belong to the owner, never to the bundle", () => {
  test("--schedule is set in the same approval and recorded in the audit payload", async () => {
    const h = harness();
    const r = await h.run({ bundleText: bundle(), schedule: "0 6 * * 1-5", scheduleTz: "UTC" });
    expect(r).toMatchObject({ scheduled: true });
    expect(getWorkflowByName(h.db, "weekly-cleanup")).toMatchObject({
      schedule: "0 6 * * 1-5",
      schedule_tz: "UTC",
    });
    expect(payloadOf(h)["schedule"]).toEqual({
      expr: "0 6 * * 1-5",
      tz: "UTC",
    });
  });

  test("replacing a scheduled workflow with no --schedule clears it, says so and records clearsSchedule", async () => {
    const h = harness();
    upsertWorkflowByName(h.db, "weekly-cleanup", null, JSON.stringify(FIXTURE_STEPS), 5, {
      expr: "0 6 * * *",
      tz: "UTC",
      nextAt: FIXTURE_NOW + 1000,
    });
    await h.run({ bundleText: bundle(), replace: true });
    const payload = payloadOf(h);
    expect(payload["clearsSchedule"]).toBe(true);
    expect(String(payload["promptText"])).toContain(
      'Its schedule ("0 6 * * *" in "UTC") is cleared.',
    );
    expect(getWorkflowByName(h.db, "weekly-cleanup")?.schedule).toBeNull();
  });

  test("a schedule added while the prompt is open yields CHANGED and writes nothing", async () => {
    const h = harness();
    upsertWorkflowByName(h.db, "weekly-cleanup", null, JSON.stringify(FIXTURE_STEPS), 5);
    const h2 = harness({
      ask: async () => {
        upsertWorkflowByName(h2.db, "weekly-cleanup", null, JSON.stringify(FIXTURE_STEPS), 5, {
          expr: "0 7 * * *",
          tz: "UTC",
          nextAt: FIXTURE_NOW + 5,
        });
        return { approved: true, auditId: 1 };
      },
    });
    upsertWorkflowByName(h2.db, "weekly-cleanup", null, JSON.stringify(FIXTURE_STEPS), 5);
    expect(await codeOf(h2.run({ bundleText: bundle(), replace: true }))).toBe(IMPORT_ERR.CHANGED);
    expect(getWorkflowByName(h2.db, "weekly-cleanup")?.schedule).toBe("0 7 * * *");
    expect(rows(h2.db, "workflow_import")).toBe(0);
    void h;
  });

  test("a workflow edited while the prompt is open yields CHANGED; so does a name created meanwhile", async () => {
    const h = harness({
      ask: async () => {
        upsertWorkflowByName(h.db, "weekly-cleanup", null, JSON.stringify(FIXTURE_STEPS), 99);
        return { approved: true, auditId: 1 };
      },
    });
    expect(await codeOf(h.run({ bundleText: bundle() }))).toBe(IMPORT_ERR.CHANGED);
    expect(rows(h.db, "workflow_import")).toBe(0);
    expect(getWorkflowByName(h.db, "weekly-cleanup")?.updated_at).toBe(99);
  });

  test("an import elsewhere raising the floor while the prompt is open yields CHANGED", async () => {
    const h = harness({
      ask: async () => {
        h.db.run(
          `INSERT INTO workflow_import (signer_fingerprint, bundle_name, issued_at, bundle_sha256, steps_sha256,
             signer_pubkey, workflow_id, imported_at, approval_audit_id)
           VALUES (?, 'weekly-cleanup', ?, ?, ?, 'k', 'w', 1, 1)`,
          [FP_A, FIXTURE_NOW, "c".repeat(64), "d".repeat(64)],
        );
        return { approved: true, auditId: 1 };
      },
    });
    expect(await codeOf(h.run({ bundleText: bundle() }))).toBe(IMPORT_ERR.CHANGED);
    expect(getWorkflowByName(h.db, "weekly-cleanup")).toBeNull();
  });
});
