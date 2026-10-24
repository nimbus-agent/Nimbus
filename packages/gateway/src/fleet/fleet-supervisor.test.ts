import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  DEFAULT_FLEET_CONFIG,
  type FleetDroppedJob,
  type NimbusFleetJobToml,
} from "../config/fleet-toml.ts";
import type { LayerRef } from "../config/layered-merge.ts";
import type { FleetScheduler } from "./fleet-scheduler.ts";
import { type FleetLoad, FleetSupervisor } from "./fleet-supervisor.ts";

const job = (name: string): NimbusFleetJobToml => ({
  name,
  agent: "changelog",
  intervalSeconds: 3600,
  params: {},
  digestMinDelta: 0,
  sweep: null,
});

const load = (over: Partial<FleetLoad["config"]> = {}, jobs: string[] = ["a"]): FleetLoad => ({
  config: { ...DEFAULT_FLEET_CONFIG, enabled: true, ...over },
  jobs: jobs.map(job),
  origins: new Map(),
  disabled: [],
  dropped: [],
  configError: false,
});
const disabled = (): FleetLoad => ({
  config: { ...DEFAULT_FLEET_CONFIG },
  jobs: [],
  origins: new Map(),
  disabled: [],
  dropped: [],
  configError: false,
});
const BASE: LayerRef = { kind: "base", id: "base", path: join(tmpdir(), "nimbus.toml") };
const drop = (name: string | null, reason = "bad"): FleetDroppedJob => ({
  name,
  layer: BASE,
  reason,
});
const withDrops = (dropped: FleetDroppedJob[], jobs: string[] = ["a"]): FleetLoad => ({
  ...load({}, jobs),
  dropped,
});

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

type Stub = FleetScheduler & { calls: string[] };
function stub(retire: (() => Promise<void>) | undefined, log: string[]): Stub {
  const calls: string[] = [];
  return {
    calls,
    start: () => calls.push("start"),
    stop: () => calls.push("stop"),
    retire: () => {
      calls.push("retire");
      log.push("retire");
      return retire ? retire() : Promise.resolve();
    },
  } as unknown as Stub;
}

function harness(initial: FleetLoad, opts: { retire?: () => Promise<void> } = {}) {
  const state = { version: 1, load: initial, loadCalls: 0 };
  const loadHook: { fn: (() => FleetLoad) | undefined } = { fn: undefined };
  const built: { load: FleetLoad; scheduler: Stub | undefined }[] = [];
  const order: string[] = [];
  const errors: unknown[] = [];
  const infos: string[] = [];
  let buildThrows = false;
  const logger = {
    error: (...a: unknown[]) => errors.push(a),
    info: (m: string) => infos.push(m),
  } as unknown as Logger;
  const build = (l: FleetLoad): Stub | undefined => {
    order.push("build");
    if (buildThrows) throw new Error("boom");
    const s = l.config.enabled && l.jobs.length > 0 ? stub(opts.retire, order) : undefined;
    built.push({ load: l, scheduler: s });
    return s;
  };
  const sup = new FleetSupervisor(
    {
      version: () => state.version,
      load: () => {
        state.loadCalls++;
        return loadHook.fn ? loadHook.fn() : state.load;
      },
      build,
      logger,
    },
    { version: 1, load: initial },
  );
  return {
    sup,
    state,
    loadHook,
    built,
    order,
    errors,
    infos,
    setBuildThrows: (b: boolean) => {
      buildThrows = b;
    },
    bump: (l: FleetLoad) => {
      state.version++;
      state.load = l;
    },
  };
}

describe("FleetSupervisor", () => {
  test("boot builds and starts when enabled with jobs", () => {
    const h = harness(load());
    expect(h.sup.current().scheduler).toBeDefined();
    expect(h.built[0]?.scheduler?.calls).toEqual(["start"]);
  });

  test("boot builds nothing when disabled", () => {
    const h = harness(disabled());
    expect(h.sup.current().scheduler).toBeUndefined();
    expect(h.built).toHaveLength(1);
    expect(h.built[0]?.scheduler).toBeUndefined();
  });

  test("boot does not load again", () => {
    expect(harness(load()).state.loadCalls).toBe(0);
  });

  test("same version is not even loaded", async () => {
    const h = harness(load());
    expect(await h.sup.check()).toBe("unchanged");
    expect(h.state.loadCalls).toBe(0);
  });

  test("unchanged fleet section is not a reload", async () => {
    const h = harness(load());
    h.bump(load());
    expect(await h.sup.check()).toBe("unchanged");
    expect(h.built).toHaveLength(1);
    expect(h.built[0]?.scheduler?.calls).toEqual(["start"]);
  });

  test("enable after boot starts a scheduler", async () => {
    const h = harness(disabled());
    h.bump(load());
    expect(await h.sup.check()).toBe("reloaded");
    expect(h.sup.current().scheduler).toBeDefined();
    expect(h.built[1]?.scheduler?.calls).toEqual(["start"]);
    expect(h.infos[0]).toBe(
      "[fleet] config changed; reloaded (enabled=true, jobs=1, running=true)",
    );
  });

  test("disable retires the running scheduler", async () => {
    const h = harness(load());
    const old = h.built[0]?.scheduler;
    h.bump(disabled());
    expect(await h.sup.check()).toBe("reloaded");
    expect(old?.calls.filter((c) => c === "retire")).toHaveLength(1);
    expect(h.sup.current().scheduler).toBeUndefined();
  });

  test("a job change swaps schedulers after the old one retires", async () => {
    const d = deferred();
    const h = harness(load(), { retire: () => d.promise });
    const old = h.sup.current();
    h.bump(load({}, ["a", "b"]));
    const p = h.sup.check();
    await Promise.resolve();
    expect(h.sup.current()).toBe(old);
    d.resolve();
    expect(await p).toBe("reloaded");
    expect(h.sup.current().scheduler).not.toBe(old.scheduler);
    expect(h.sup.current().jobs).toHaveLength(2);
    expect(h.order).toEqual(["build", "retire", "build"]);
  });

  test("a config error stops the fleet and recovery restarts it", async () => {
    const h = harness(load());
    h.bump({ ...disabled(), configError: true });
    expect(await h.sup.check()).toBe("reloaded");
    expect(h.sup.current().scheduler).toBeUndefined();
    h.bump(load());
    expect(await h.sup.check()).toBe("reloaded");
    expect(h.sup.current().scheduler).toBeDefined();
  });

  test("concurrent checks share one reload", async () => {
    const d = deferred();
    const h = harness(load(), { retire: () => d.promise });
    h.bump(load({}, ["b"]));
    const p1 = h.sup.check();
    const p2 = h.sup.check();
    expect(p2).toBe(p1);
    d.resolve();
    await Promise.all([p1, p2]);
    expect(h.built).toHaveLength(2);
  });

  test("start() after stop() arms nothing", () => {
    const h = harness(load());
    h.sup.stop();
    h.sup.start();
    expect((h.sup as unknown as { timer: unknown }).timer).toBeUndefined();
  });

  test("stop during a pending swap builds nothing", async () => {
    const d = deferred();
    const h = harness(load(), { retire: () => d.promise });
    h.bump(load({}, ["b"]));
    const p = h.sup.check();
    await Promise.resolve();
    h.sup.stop();
    d.resolve();
    await p;
    expect(h.built).toHaveLength(1);
    expect(h.sup.current().scheduler).toBeUndefined();
  });

  test("a throwing build leaves the fleet off and logs", async () => {
    const h = harness(load());
    h.setBuildThrows(true);
    h.bump(load({}, ["b"]));
    expect(await h.sup.check()).toBe("reloaded");
    expect(h.sup.current().scheduler).toBeUndefined();
    expect(h.errors).toHaveLength(1);
  });

  test("settled waits for a pending reload", async () => {
    const d = deferred();
    const h = harness(load(), { retire: () => d.promise });
    h.bump(load({}, ["b"]));
    void h.sup.check();
    let done = false;
    const s = h.sup.settled().then(() => {
      done = true;
    });
    await Promise.resolve();
    expect(done).toBe(false);
    d.resolve();
    await s;
    expect(done).toBe(true);
    expect(h.sup.current().jobs.map((j) => j.name)).toEqual(["b"]);
  });

  test("an edit during a pending reload is caught up", async () => {
    const d = deferred();
    const h = harness(load(), { retire: () => d.promise });
    h.bump(load({}, ["b"]));
    const p = h.sup.check();
    await Promise.resolve();
    h.bump(load({}, ["c"]));
    d.resolve();
    expect(await p).toBe("reloaded");
    expect(h.built).toHaveLength(2);
    expect(h.built[1]?.load.jobs.map((j) => j.name)).toEqual(["c"]);
    expect(h.sup.current().jobs.map((j) => j.name)).toEqual(["c"]);
  });

  test("an unexpected throw never rejects check or settled", async () => {
    const h = harness(load());
    h.loadHook.fn = () => {
      throw new Error("load blew up");
    };
    h.bump(load({}, ["z"]));
    expect(await h.sup.check()).toBe("unchanged");
    expect(h.errors).toHaveLength(1);
    await h.sup.settled();
    expect(h.sup.current().scheduler).toBeDefined();
    h.loadHook.fn = undefined;
    h.bump(load({}, ["y"]));
    expect(await h.sup.check()).toBe("reloaded");
  });

  test("a throw after the old scheduler retired does not leave a retired scheduler in the view", async () => {
    const h = harness(load());
    h.bump(load({}, ["b"]));
    // The catch-up load (after the retire) throws; the first load succeeds.
    h.loadHook.fn = () => {
      if (h.state.loadCalls > 1) throw new Error("late");
      return h.state.load;
    };
    const old = h.built[0]?.scheduler as Stub;
    const origRetire = old.retire.bind(old);
    old.retire = () => {
      h.state.version++; // an edit lands while draining, forcing a catch-up load
      return origRetire();
    };
    expect(await h.sup.check()).toBe("unchanged");
    expect(h.errors).toHaveLength(1);
    expect(h.sup.current().scheduler).toBeUndefined();
    expect(h.sup.current().jobs.map((j) => j.name)).toEqual(["a"]);
  });
  describe("dropped jobs", () => {
    const dropLines = (errors: unknown[]): string[] =>
      errors
        .map((e) => (e as unknown[])[1])
        .filter((m): m is string => typeof m === "string" && m.includes("dropped"));

    test("boot logs each dropped job once", () => {
      const h = harness(withDrops([drop("x", "reason x"), drop(null, "reason y")]));
      expect(dropLines(h.errors)).toEqual([
        `[fleet] job "x" dropped (base base, ${BASE.path}): reason x`,
        `[fleet] job "(unnamed)" dropped (base base, ${BASE.path}): reason y`,
      ]);
      expect((h.errors[0] as unknown[])[0]).toEqual({
        job: "x",
        layer: "base",
        layerId: "base",
        file: BASE.path,
        reason: "reason x",
      });
    });

    test("a reload that changes drops logs the new ones", async () => {
      const h = harness(withDrops([drop("x")]));
      h.bump(withDrops([drop("x"), drop("y")]));
      expect(await h.sup.check()).toBe("reloaded");
      expect(dropLines(h.errors)).toEqual([
        `[fleet] job "x" dropped (base base, ${BASE.path}): bad`,
        `[fleet] job "x" dropped (base base, ${BASE.path}): bad`,
        `[fleet] job "y" dropped (base base, ${BASE.path}): bad`,
      ]);
    });

    test("an unrelated edit does not re-log drops", async () => {
      const h = harness(withDrops([drop("x")]));
      const before = h.errors.length;
      h.bump(withDrops([drop("x")]));
      expect(await h.sup.check()).toBe("unchanged");
      expect(h.errors).toHaveLength(before);
    });

    test("current() carries disabled and dropped", async () => {
      const origin = { layer: BASE, replaces: [] };
      const h = harness(load());
      expect(h.sup.current().dropped).toEqual([]);
      expect(h.sup.current().disabled).toEqual([]);
      h.bump({
        ...withDrops([drop("x")]),
        origins: new Map([["a", origin]]),
        disabled: [{ name: "off", agent: "catchup", origin }],
      });
      expect(await h.sup.check()).toBe("reloaded");
      expect(h.sup.current().dropped.map((d) => d.name)).toEqual(["x"]);
      expect(h.sup.current().disabled.map((d) => d.name)).toEqual(["off"]);
      expect(h.sup.current().origins.get("a")).toEqual(origin);
    });
  });
});
