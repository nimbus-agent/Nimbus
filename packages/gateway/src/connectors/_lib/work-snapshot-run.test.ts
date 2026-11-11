import { describe, expect, test } from "bun:test";

import type { SyncContext } from "../../sync/types.ts";
import {
  applySnapshot,
  snapshotDue,
  snapshotIntervalMs,
  type SnapshotFetch,
} from "./work-snapshot-run.ts";

function fakeCtx(replace?: () => { stored: number; dropped: number }) {
  const logs: Array<{ level: string; obj: Record<string, unknown> }> = [];
  const replaced: Array<{ relation: string; ids: readonly string[] }> = [];
  const log =
    (level: string) =>
    (obj: Record<string, unknown>): void => {
      logs.push({ level, obj });
    };
  const ctx = {
    logger: { info: log("info"), warn: log("warn") },
    replaceWorkSnapshot: (relation: string, ids: readonly string[]) => {
      replaced.push({ relation, ids });
      return replace === undefined ? { stored: ids.length, dropped: 0 } : replace();
    },
  } as unknown as SyncContext;
  return { ctx, logs, replaced };
}

describe("snapshotDue and snapshotIntervalMs", () => {
  test("due when never attempted, when the interval elapsed, and when the clock moved back", () => {
    const iv = snapshotIntervalMs(15);
    expect(snapshotDue(null, 1_000, iv)).toBe(true);
    expect(snapshotDue(0, iv, iv)).toBe(true);
    expect(snapshotDue(0, iv - 1, iv)).toBe(false);
    expect(snapshotDue(5_000, 1_000, iv)).toBe(true);
  });
  test("an absent interval is 15 minutes and a configured one passes through", () => {
    expect(snapshotIntervalMs()).toBe(15 * 60_000);
    expect(snapshotIntervalMs(30)).toBe(30 * 60_000);
  });
});

describe("applySnapshot", () => {
  test("a complete fetch replaces the snapshot and logs the counts", async () => {
    const { ctx, logs, replaced } = fakeCtx();
    await applySnapshot(ctx, "jira", "assigned", () =>
      Promise.resolve({ kind: "complete", externalIds: ["A-1"], capped: true, total: 450 }),
    );
    expect(replaced).toEqual([{ relation: "assigned", ids: ["A-1"] }]);
    expect(logs[0]?.level).toBe("info");
    expect(logs[0]?.obj).toMatchObject({ stored: 1, snapshot_capped: true, total: 450 });
  });

  test("a partial fetch replaces nothing and warns", async () => {
    const { ctx, logs, replaced } = fakeCtx();
    const f: SnapshotFetch = { kind: "partial", reason: "HTTP 500" };
    await applySnapshot(ctx, "jira", "assigned", () => Promise.resolve(f));
    expect(replaced).toEqual([]);
    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.obj).toMatchObject({ snapshot_partial: true, reason: "HTTP 500" });
  });

  test("a throwing fetch is a partial, with the reason truncated", async () => {
    const { ctx, logs, replaced } = fakeCtx();
    await applySnapshot(ctx, "github", "authored_open", () => {
      throw new Error("x".repeat(500));
    });
    expect(replaced).toEqual([]);
    expect(String(logs[0]?.obj["reason"]).length).toBe(200);
  });

  test("a throwing replace is logged, never thrown", async () => {
    const { ctx, logs } = fakeCtx(() => {
      throw new Error("boom");
    });
    await applySnapshot(ctx, "linear", "assigned", () =>
      Promise.resolve({ kind: "complete", externalIds: ["a"], capped: false }),
    );
    expect(logs[0]?.level).toBe("warn");
    expect(logs[0]?.obj).toMatchObject({ reason: "boom" });
  });

  test("a complete fetch with no total omits it from the log", async () => {
    const { ctx, logs } = fakeCtx();
    await applySnapshot(ctx, "linear", "assigned", () =>
      Promise.resolve({ kind: "complete", externalIds: [], capped: false }),
    );
    expect("total" in (logs[0]?.obj ?? {})).toBe(false);
  });
});
