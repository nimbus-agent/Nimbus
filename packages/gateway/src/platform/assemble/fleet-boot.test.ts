import { describe, expect, test } from "bun:test";
import {
  DEFAULT_FLEET_CONFIG,
  type FleetDisabledJob,
  type FleetDroppedJob,
  type FleetJobOrigin,
  type NimbusFleetJobToml,
  type NimbusFleetToml,
} from "../../config/fleet-toml.ts";
import type { FleetScheduler } from "../../fleet/fleet-scheduler.ts";
import type { FleetStore } from "../../fleet/fleet-store.ts";
import type { FleetSupervisor } from "../../fleet/fleet-supervisor.ts";
import { UNKNOWN_HOST_ACTIVITY } from "../host-activity.ts";
import { type FleetRuntime, fleetRpcCtxFor } from "./fleet-boot.ts";

/** A runtime whose supervisor-backed fields are plain mutable state, so a test can "reload". */
function mutableRuntime() {
  const state = {
    scheduler: undefined as FleetScheduler | undefined,
    config: DEFAULT_FLEET_CONFIG as NimbusFleetToml,
    jobs: [] as readonly NimbusFleetJobToml[],
    origins: new Map<string, FleetJobOrigin>() as ReadonlyMap<string, FleetJobOrigin>,
    disabled: [] as readonly FleetDisabledJob[],
    dropped: [] as readonly FleetDroppedJob[],
    checks: 0,
  };
  const store = { marker: "store" } as unknown as FleetStore;
  const runtime: FleetRuntime = {
    supervisor: {
      check: async () => {
        state.checks += 1;
        return "ignored";
      },
    } as unknown as FleetSupervisor,
    store,
    get scheduler() {
      return state.scheduler;
    },
    get config() {
      return state.config;
    },
    get jobs() {
      return state.jobs;
    },
    get origins() {
      return state.origins;
    },
    get disabled() {
      return state.disabled;
    },
    get dropped() {
      return state.dropped;
    },
  };
  return { runtime, state, store };
}

describe("fleetRpcCtxFor", () => {
  test("carries the fixed pieces: the store and the host-activity reader", () => {
    const { runtime, store } = mutableRuntime();
    const ctx = fleetRpcCtxFor(runtime, UNKNOWN_HOST_ACTIVITY);
    expect(ctx.store).toBe(store);
    expect(ctx.hostActivity).toBe(UNKNOWN_HOST_ACTIVITY);
  });

  test("every supervisor-backed field is read live, so a reload is visible without rebuilding", () => {
    const { runtime, state } = mutableRuntime();
    const ctx = fleetRpcCtxFor(runtime, UNKNOWN_HOST_ACTIVITY);
    expect(ctx.scheduler).toBeUndefined();
    expect(ctx.jobs).toEqual([]);
    expect(ctx.disabled).toEqual([]);
    expect(ctx.dropped).toEqual([]);
    expect(ctx.origins?.size).toBe(0);
    expect(ctx.config).toBe(DEFAULT_FLEET_CONFIG);

    const scheduler = { marker: "scheduler" } as unknown as FleetScheduler;
    const config = { ...DEFAULT_FLEET_CONFIG, enabled: true };
    const job = { id: "j1" } as unknown as NimbusFleetJobToml;
    const disabled = { id: "j2" } as unknown as FleetDisabledJob;
    const dropped = { id: "j3" } as unknown as FleetDroppedJob;
    state.scheduler = scheduler;
    state.config = config;
    state.jobs = [job];
    state.origins = new Map([["j1", { layer: "base" } as unknown as FleetJobOrigin]]);
    state.disabled = [disabled];
    state.dropped = [dropped];

    expect(ctx.scheduler).toBe(scheduler);
    expect(ctx.config).toBe(config);
    expect(ctx.jobs).toEqual([job]);
    expect(ctx.origins?.has("j1")).toBe(true);
    expect(ctx.disabled).toEqual([disabled]);
    expect(ctx.dropped).toEqual([dropped]);
  });

  test("now reads the wall clock", () => {
    const ctx = fleetRpcCtxFor(mutableRuntime().runtime, UNKNOWN_HOST_ACTIVITY);
    const before = Date.now();
    const t = ctx.now();
    expect(t).toBeGreaterThanOrEqual(before);
    expect(t).toBeLessThanOrEqual(Date.now());
  });

  test("settled runs a fresh reload check each call and resolves to nothing", async () => {
    const { runtime, state } = mutableRuntime();
    const ctx = fleetRpcCtxFor(runtime, UNKNOWN_HOST_ACTIVITY);
    expect(await ctx.settled?.()).toBeUndefined();
    expect(await ctx.settled?.()).toBeUndefined();
    expect(state.checks).toBe(2);
  });
});
