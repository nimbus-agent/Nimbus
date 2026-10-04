// The ONE binding between packages/gateway and packages/ui (which may not import gateway source).
// It drives the REAL rpc over REAL rows (the demo seed and page, plus a failed row from the store's
// own writer), then requires the committed UI fixture to have the SAME SHAPE. Regenerate with
// UPDATE_ONCALL_FIXTURE=1 after an intended shape change; the desktop tests then run on the new
// shape. Values are compared only for shape, since the brief text carries real dates.
import { Database } from "bun:sqlite";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fireDemoPage, seedDemoCorpus } from "../demo/seed.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { assembleOncallPushRuntime } from "../oncall-push/push-runtime.ts";
import { dispatchOncallPushRpc } from "./oncall-push-rpc.ts";

const FIXTURE = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "ui",
  "test",
  "fixtures",
  "oncall-pushed.json",
);
const FIXED_EPOCH = 1_790_000_000_000;

let dbs: Database[] = [];
let roots: string[] = [];
afterEach(() => {
  for (const d of dbs) d.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

/**
 * A value's type tree: what the desktop depends on, without the volatile values. It does NOT guard a
 * field that is null in every fixture row: that is checked only as null. Every `delivery` entry is one
 * `SinkOutcome` shape (`outcome`, optional `reason`, `at`), which the ok row already exercises with a
 * `reason` present.
 */
function shape(v: unknown): unknown {
  if (v === null) return "null";
  if (Array.isArray(v)) return v.map(shape);
  if (typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, x]) => [k, shape(x)]),
    );
  }
  return typeof v;
}

/** Times re-based onto FIXED_EPOCH, so a regenerated fixture differs only where the shape did. */
function normalize(v: unknown, nowMs: number): unknown {
  if (Array.isArray(v)) return v.map((x) => normalize(x, nowMs));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v as Record<string, unknown>).map(([k, x]) => [
        k,
        (k === "createdAt" || k === "retriedAt" || k === "at") && typeof x === "number"
          ? FIXED_EPOCH + (x - nowMs)
          : normalize(x, nowMs),
      ]),
    );
  }
  return v;
}

async function call(
  method: string,
  params: unknown,
  ctx: Parameters<typeof dispatchOncallPushRpc>[2],
) {
  const out = await dispatchOncallPushRpc(method, params, ctx);
  if (out.kind !== "hit") throw new Error(`miss: ${method}`);
  return out.value;
}

test("the UI fixture has the shape the real oncall.pushedList / pushedGet return", async () => {
  const root = mkdtempSync(join(tmpdir(), "nimbus-oncall-contract-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  const nowMs = Date.now();
  await seedDemoCorpus(db, { configDir, dataDir, nowMs });
  const rt = assembleOncallPushRuntime({
    db,
    configDir,
    notifications: { show: () => {} },
    logger: { error: () => {} },
    now: () => nowMs,
    settleImmediately: true,
  });
  const fired = await fireDemoPage(db, rt, nowMs);
  // The pushed_brief row's real writer. No incident is indexed for it, so title and service are
  // null: the desktop's null-handling is exercised from the fixture too.
  rt.store.insert(
    "pagerduty:PCONTRACTFAIL",
    { status: "failed", sessionId: null, failureCode: "timeout: no brief in 30000ms" },
    nowMs + 60_000,
  );
  // A retried failure, via the store's own writer, so `retriedAt` is a real number on this row.
  rt.store.applyRetry(
    "pagerduty:PCONTRACTFAIL",
    { status: "failed", sessionId: null, failureCode: "timeout: no brief in 30000ms" },
    nowMs + 120_000,
  );
  const ctx = { runtime: rt };
  const live = normalize(
    {
      list: await call("oncall.pushedList", { limit: 50 }, ctx),
      getOk: await call("oncall.pushedGet", { incidentId: fired.incidentId }, ctx),
      getFailed: await call("oncall.pushedGet", { incidentId: "pagerduty:PCONTRACTFAIL" }, ctx),
      getMissing: await call("oncall.pushedGet", { incidentId: "pagerduty:NOPE" }, ctx),
    },
    nowMs,
  );
  if (process.env["UPDATE_ONCALL_FIXTURE"] === "1") {
    writeFileSync(FIXTURE, `${JSON.stringify(live, null, 2)}\n`);
  }
  const committed: unknown = JSON.parse(readFileSync(FIXTURE, "utf8"));
  expect(shape(live)).toEqual(shape(committed));
  // The values the desktop tests rely on, pinned so a regenerated fixture cannot quietly lose them.
  const list = (
    live as { list: { briefs: { incidentId: string; service: unknown; retriedAt: unknown }[] } }
  ).list;
  expect(list.briefs.map((b) => b.incidentId)).toEqual([
    "pagerduty:PCONTRACTFAIL",
    fired.incidentId,
  ]);
  expect(typeof list.briefs[0]?.retriedAt).toBe("number"); // retried failure
  expect(list.briefs[1]?.retriedAt).toBeNull(); // never retried
  expect(list.briefs[1]?.service).toBe("payment-service"); // the MAPPED case, from the real brief
}, 60_000);
