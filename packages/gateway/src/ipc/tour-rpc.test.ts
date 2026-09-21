import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { dispatchTourRpc, TourRpcError } from "./tour-rpc.ts";

describe("dispatchTourRpc", () => {
  let db: Database;
  let ctx: { db: Database; configDir: string | undefined; demo: boolean; nowMs: () => number };

  beforeEach(() => {
    db = openMigratedMemoryDb();
    ctx = { db, configDir: undefined, demo: false, nowMs: () => 7 };
  });

  afterEach(() => {
    db.close();
  });

  test("an unknown method is a miss", async () => {
    expect((await dispatchTourRpc("tour.nope", {}, ctx)).kind).toBe("miss");
  });

  test("defaults to 3 steps and stamps t0 from the gateway clock", async () => {
    const out = await dispatchTourRpc("tour.plan", {}, ctx);
    expect(out.kind).toBe("hit");
    if (out.kind === "hit") expect((out.value as { t0: number }).t0).toBe(7);
  });

  for (const bad of [0, 7, 1.5, "3", null]) {
    test(`refuses steps=${JSON.stringify(bad)} rather than clamping`, async () => {
      await expect(dispatchTourRpc("tour.plan", { steps: bad }, ctx)).rejects.toBeInstanceOf(
        TourRpcError,
      );
    });
  }
});
