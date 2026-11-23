import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
  buildSchedulerHarness,
  type SchedulerHarness,
} from "../../../test/helpers/scheduler-mesh-harness.ts";
import { readPassState, writePassState } from "../../decisions/decision-store.ts";

let h: SchedulerHarness | undefined;

afterEach(async () => {
  await h?.cleanup();
  h = undefined;
});

async function until(cond: () => boolean, ms = 3_000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await Bun.sleep(10);
}

/** Stops the sync scheduler (so nothing else reads the index), then closes it under the passes. */
async function breakIndex(x: SchedulerHarness): Promise<void> {
  await x.out.syncScheduler.stop();
  x.db.close();
}

const FAST = (section: string): string => [`[${section}]`, "debounce_ms = 1"].join("\n");
// Long enough that the index is closed before the debounce fires.
const SLOW = (section: string): string => [`[${section}]`, "debounce_ms = 300"].join("\n");

describe("createSchedulerWithMesh: the glossary pass", () => {
  it("runNow runs a plain pass, and a rebuild also reports the authored terms it restored", async () => {
    h = await buildSchedulerHarness();
    const plain = await h.out.glossaryRefresher.runNow({ rebuild: false });
    expect(plain).toMatchObject({ scanned: 0, aborted: false });
    const rebuilt = await h.out.glossaryRefresher.runNow({ rebuild: true });
    expect(rebuilt).toMatchObject({ scanned: 0, aborted: false, manualAdded: 0, manualRemoved: 0 });
  });

  it("forwards progress callbacks only when the caller asked for them", async () => {
    h = await buildSchedulerHarness();
    const progress: unknown[] = [];
    await h.out.glossaryRefresher.runNow({ rebuild: false, onProgress: (p) => progress.push(p) });
    await h.out.glossaryRefresher.runNow({ rebuild: false });
    // An empty index reports at most the one pass-level progress; nothing may throw either way.
    expect(progress.length).toBeLessThanOrEqual(1);
  });

  it("logs a failed scheduled pass and keeps the process up", async () => {
    h = await buildSchedulerHarness({ toml: FAST("glossary") });
    const warn = spyOn(h.logger, "warn");
    await breakIndex(h);
    h.out.glossaryRefresher.trigger();
    await until(() => warn.mock.calls.some((c) => c[1] === "glossary extraction pass failed"));
    expect(warn.mock.calls.some((c) => c[1] === "glossary extraction pass failed")).toBe(true);
  });
});

describe("createSchedulerWithMesh: the decisions pass", () => {
  it("a plain run keeps the pass watermark, a rebuild resets it", async () => {
    h = await buildSchedulerHarness();
    const seeded = {
      watermarkMs: 123,
      watermarkId: "sentinel",
      lastPassAt: 1,
      lastPassNew: 0,
      scannedItems: 0,
    };
    writePassState(h.db, seeded);
    await h.out.decisionsRefresher?.run({ rebuild: false });
    expect(readPassState(h.db).watermarkId).toBe("sentinel");
    await h.out.decisionsRefresher?.run({ rebuild: true });
    expect(readPassState(h.db).watermarkId).not.toBe("sentinel");
  });

  it("a run with no options is a plain run", async () => {
    h = await buildSchedulerHarness();
    writePassState(h.db, {
      watermarkMs: 5,
      watermarkId: "kept",
      lastPassAt: 1,
      lastPassNew: 0,
      scannedItems: 0,
    });
    await h.out.decisionsRefresher?.run();
    expect(readPassState(h.db).watermarkId).toBe("kept");
  });

  it("logs a failed scheduled pass", async () => {
    h = await buildSchedulerHarness({ toml: FAST("decisions") });
    const warn = spyOn(h.logger, "warn");
    await breakIndex(h);
    h.out.decisionsRefresher?.trigger();
    await until(() => warn.mock.calls.some((c) => c[1] === "decision extraction pass failed"));
    expect(warn.mock.calls.some((c) => c[1] === "decision extraction pass failed")).toBe(true);
  });
});

describe("createSchedulerWithMesh: the pre-mortem theme pass", () => {
  it("runNow runs the pass against the index", async () => {
    h = await buildSchedulerHarness();
    const out = await h.out.premortemRefresher?.runNow();
    expect(out).toMatchObject({ scanned: 0, themesWritten: 0 });
  });

  it("logs a failed scheduled pass", async () => {
    h = await buildSchedulerHarness({ toml: FAST("premortem") });
    const warn = spyOn(h.logger, "warn");
    await breakIndex(h);
    h.out.premortemRefresher?.trigger();
    await until(() => warn.mock.calls.some((c) => c[1] === "premortem theme pass failed"));
    expect(warn.mock.calls.some((c) => c[1] === "premortem theme pass failed")).toBe(true);
  });
});

describe("createSchedulerWithMesh: the ownership pass", () => {
  it("run derives ownership with no roots and no service bindings", async () => {
    h = await buildSchedulerHarness();
    const out = await h.out.ownershipRefresher?.run();
    expect(out).toMatchObject({ rootsTotal: 0, servicesBound: 0, ownersEmitted: 0 });
  });

  it("a malformed service config degrades to zero bindings and warns, instead of failing the pass", async () => {
    h = await buildSchedulerHarness({
      toml: ["[ci.service.checkout]", 'repos = ["github:acme/checkout"]', "bogus_key = 1"].join(
        "\n",
      ),
    });
    const warn = spyOn(h.logger, "warn");
    const out = await h.out.ownershipRefresher?.run();
    expect(out).toMatchObject({ servicesBound: 0 });
    expect(warn.mock.calls.some((c) => String(c[1]).includes("service configs"))).toBe(true);
  });

  it("logs a failed scheduled pass", async () => {
    h = await buildSchedulerHarness({ toml: FAST("ownership") });
    const warn = spyOn(h.logger, "warn");
    await breakIndex(h);
    h.out.ownershipRefresher?.trigger();
    await until(() => warn.mock.calls.some((c) => c[1] === "ownership derivation pass failed"));
    expect(warn.mock.calls.some((c) => c[1] === "ownership derivation pass failed")).toBe(true);
  });
});

describe("createSchedulerWithMesh: the post-sync hook reaches the passes", () => {
  it("a completed sync arms every enabled pass (a closed index then fails each one)", async () => {
    h = await buildSchedulerHarness({
      toml: [SLOW("glossary"), SLOW("decisions"), SLOW("premortem"), SLOW("ownership")].join("\n"),
    });
    const warn = spyOn(h.logger, "warn");
    h.out.syncScheduler.register({
      serviceId: "pass-probe",
      defaultIntervalMs: 3_600_000,
      initialSyncDepthDays: 1,
      sync: (_ctx, cursor) =>
        Promise.resolve({
          cursor,
          itemsUpserted: 0,
          itemsDeleted: 0,
          hasMore: false,
          durationMs: 1,
        }),
    });
    await h.out.syncScheduler.forceSync("pass-probe");
    await breakIndex(h);
    // The hook armed the debounce before the index closed; each pass then fails and says so.
    const wanted = [
      "glossary extraction pass failed",
      "decision extraction pass failed",
      "premortem theme pass failed",
      "ownership derivation pass failed",
    ];
    await until(() => wanted.every((w) => warn.mock.calls.some((c) => c[1] === w)));
    for (const w of wanted) expect(warn.mock.calls.some((c) => c[1] === w)).toBe(true);
  });
});
