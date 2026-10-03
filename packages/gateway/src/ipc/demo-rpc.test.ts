import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { assembleOncallPushRuntime } from "../oncall-push/push-runtime.ts";
import { DemoRpcError, dispatchDemoRpc } from "./demo-rpc.ts";

let dbs: Database[] = [];
let roots: string[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

function fresh(): { db: Database; configDir: string; dataDir: string } {
  const root = mkdtempSync(join(tmpdir(), "nimbus-demo-rpc-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  dbs.push(db);
  return { db, configDir, dataDir };
}

describe("dispatchDemoRpc", () => {
  test("demo.seed seeds the acme corpus", async () => {
    const { db, configDir, dataDir } = fresh();
    const out = await dispatchDemoRpc("demo.seed", undefined, { db, configDir, dataDir });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    const value = out.value as { counts: { people: number } };
    expect(value.counts.people).toBe(8);
  });

  test("a second demo.seed call rejects with -32010", async () => {
    const { db, configDir, dataDir } = fresh();
    await dispatchDemoRpc("demo.seed", undefined, { db, configDir, dataDir });
    await expect(
      dispatchDemoRpc("demo.seed", undefined, { db, configDir, dataDir }),
    ).rejects.toMatchObject({
      rpcCode: -32010,
    });
  });

  test("{ nowMs: 'x' } is rejected as -32602", async () => {
    const { db, configDir, dataDir } = fresh();
    await expect(
      dispatchDemoRpc("demo.seed", { nowMs: "x" }, { db, configDir, dataDir }),
    ).rejects.toMatchObject({ rpcCode: -32602 });
  });

  test("an unrelated method misses", async () => {
    const { db, configDir, dataDir } = fresh();
    const out = await dispatchDemoRpc("gateway.ping", undefined, { db, configDir, dataDir });
    expect(out).toEqual({ kind: "miss" });
  });

  test("demo.seed honours nowMs and ctx.now, preferring the param", async () => {
    const { db, configDir, dataDir } = fresh();
    const nowMs = 5 * 24 * 60 * 60 * 1000 * 365;
    const out = await dispatchDemoRpc(
      "demo.seed",
      { nowMs },
      { db, configDir, dataDir, now: () => 1 },
    );
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    const value = out.value as { seededAtMs: number };
    expect(value.seededAtMs).toBe(nowMs);
  });

  // `t0` is the `since` edge of the demo's proof window: it must be read AFTER seeding finished,
  // so nothing the seeder itself did can fall inside the window the CLI then proves over.
  test("demo.seed returns t0, read from the gateway clock AFTER seeding finished", async () => {
    const { db, configDir, dataDir } = fresh();
    const ticks: number[] = [];
    // A monotonically advancing injected clock: every read is a new, larger value, so a `t0`
    // captured before `seedDemoCorpus` ran would be < the seeding `nowMs` and fail below.
    let n = 1_700_000_000_000;
    const now = (): number => {
      n += 1_000;
      ticks.push(n);
      return n;
    };
    const out = await dispatchDemoRpc("demo.seed", undefined, { db, configDir, dataDir, now });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    const value = out.value as { seededAtMs: number; t0: number };
    expect(ticks).toHaveLength(2);
    expect(value.seededAtMs).toBe(ticks[0] as number);
    expect(value.t0).toBe(ticks[1] as number);
    expect(value.t0).toBeGreaterThanOrEqual(value.seededAtMs);
  });

  test("demo.firePage with no on-call push runtime wired → -32010 ERR_DEMO_PUSH_UNAVAILABLE", async () => {
    const { db, configDir, dataDir } = fresh();
    const err = await dispatchDemoRpc("demo.firePage", {}, { db, configDir, dataDir }).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(DemoRpcError);
    expect(err).toMatchObject({ rpcCode: -32010 });
    expect((err as Error).message).toContain("ERR_DEMO_PUSH_UNAVAILABLE");
  });

  test("demo.firePage takes {} only — any param is -32602", async () => {
    const { db, configDir, dataDir } = fresh();
    for (const bad of [{ x: 1 }, null, [], "x", 1]) {
      await expect(
        dispatchDemoRpc("demo.firePage", bad, { db, configDir, dataDir }),
      ).rejects.toMatchObject({ rpcCode: -32602 });
    }
  });

  test("demo.firePage with a runtime fires the page and returns { incidentId, push }", async () => {
    const { db, configDir, dataDir } = fresh();
    const nowMs = Date.now();
    await dispatchDemoRpc("demo.seed", { nowMs }, { db, configDir, dataDir });
    const oncallPush = assembleOncallPushRuntime({
      db,
      configDir,
      notifications: { show: () => {} },
      logger: { error: () => {} },
      now: () => nowMs + 1_000,
    });
    const out = await dispatchDemoRpc("demo.firePage", undefined, {
      db,
      configDir,
      dataDir,
      oncallPush,
      now: () => nowMs + 2_000,
    });
    expect(out.kind).toBe("hit");
    if (out.kind !== "hit") throw new Error("unreachable");
    expect(out.value).toMatchObject({
      incidentId: "pagerduty:PDEMO412",
      push: { selected: 1, ok: 1, failed: 0 },
    });
  });

  test("rejects a non-numeric, non-finite, or negative nowMs", async () => {
    const { db, configDir, dataDir } = fresh();
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, -1, null, [], {}]) {
      await expect(
        dispatchDemoRpc("demo.seed", { nowMs: bad }, { db, configDir, dataDir }),
      ).rejects.toBeInstanceOf(DemoRpcError);
    }
  });
});
