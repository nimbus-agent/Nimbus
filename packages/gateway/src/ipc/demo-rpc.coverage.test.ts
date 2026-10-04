import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DemoRpcError, dispatchDemoRpc } from "./demo-rpc.ts";

/**
 * `demo.seed`'s parameter contract — `{ nowMs?: number }` and nothing else — on the shapes
 * `demo-rpc.test.ts` does not send, and the one error path it never takes: a seeding failure that
 * is NOT the already-seeded refusal must surface unchanged, never relabelled as the -32010
 * "already seeded" refusal, whose message would then name the wrong cause.
 */

const BAD_PARAMS = "ERR_INVALID_PARAMS: demo.seed takes { nowMs?: number }";

let roots: string[] = [];
let dbs: Database[] = [];

afterEach(() => {
  for (const db of dbs) db.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
  dbs = [];
  roots = [];
});

/** An UNMIGRATED in-memory db: every param refusal fires before the db is ever touched. */
function bare(): { db: Database; configDir: string; dataDir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "nimbus-demo-rpc-cov-"));
  roots.push(root);
  const configDir = join(root, "config");
  const dataDir = join(root, "data");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(":memory:");
  dbs.push(db);
  return { db, configDir, dataDir, root };
}

async function rejectionOf(p: Promise<unknown>): Promise<unknown> {
  return p.then(
    () => {
      throw new Error("expected a rejection");
    },
    (e: unknown) => e,
  );
}

describe("demo.seed — params", () => {
  for (const [label, params] of [
    ["null", null],
    ["an array", [{ nowMs: 1 }]],
    ["a string", "now"],
    ["a number", 1_700_000_000_000],
    ["an object without nowMs", { at: 1_700_000_000_000 }],
    ["nowMs plus an extra key", { nowMs: 1_700_000_000_000, force: true }],
    ["a zero nowMs", { nowMs: 0 }],
    ["a negative nowMs", { nowMs: -5 }],
    ["an infinite nowMs", { nowMs: Number.POSITIVE_INFINITY }],
  ] as const) {
    test(`${label} is refused as -32602 before anything is seeded`, async () => {
      const { db, configDir, dataDir } = bare();
      const err = await rejectionOf(
        dispatchDemoRpc("demo.seed", params, { db, configDir, dataDir }),
      );
      expect(err).toBeInstanceOf(DemoRpcError);
      expect((err as DemoRpcError).rpcCode).toBe(-32602);
      expect((err as DemoRpcError).message).toBe(BAD_PARAMS);
      expect(readdirSync(configDir)).toEqual([]);
    });
  }
});

describe("demo.seed — a failure that is not the already-seeded refusal", () => {
  test("propagates unchanged instead of being relabelled -32010, and writes nothing", async () => {
    // No schema at all: the seeder's very first read fails, before any file or row is written.
    const { db, configDir, dataDir, root } = bare();

    const err = await rejectionOf(
      dispatchDemoRpc("demo.seed", undefined, { db, configDir, dataDir, now: () => 1 }),
    );

    expect(err).not.toBeInstanceOf(DemoRpcError);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("no such table: item");
    expect((err as Error).message).not.toContain("ERR_DEMO_ALREADY_SEEDED");
    expect("rpcCode" in (err as object)).toBe(false);
    expect(readdirSync(configDir)).toEqual([]);
    expect(readdirSync(dataDir)).toEqual([]);
    expect(existsSync(join(root, "workspace"))).toBe(false);
  });
});
