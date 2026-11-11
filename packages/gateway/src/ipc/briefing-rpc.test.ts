import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { type BriefingRuntime, createBriefingRuntime } from "../briefing/briefing-runtime.ts";
import { parseNimbusTomlBriefing } from "../config/briefing-toml.ts";
import { openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import { BriefingRpcError, dispatchBriefingRpc } from "./briefing-rpc.ts";

const NOW = Date.UTC(2026, 10, 12, 8, 31);

let db: Database;
let rt: BriefingRuntime;
beforeEach(() => {
  db = openMemoryIndexDatabase();
  rt = createBriefingRuntime({
    db,
    configDir: "C:/nonexistent-nimbus-test-dir",
    now: () => NOW,
    resolveSelf: async () => null,
    emit: () => {},
    toast: async () => "delivered",
    toastDelivers: () => true,
    demo: false,
    loadConfig: () => parseNimbusTomlBriefing('[briefing]\ntz = "UTC"\n'),
  });
});
afterEach(() => db.close());

const call = (method: string, params?: unknown) =>
  dispatchBriefingRpc(method, params, { runtime: rt });

describe("briefing.* methods", () => {
  test("latest is null before any run, then the run with its markdown", async () => {
    expect(await call("briefing.latest")).toEqual({ kind: "hit", value: { run: null } });
    await call("briefing.runNow", {});
    const out = (await call("briefing.latest", {})) as { value: { run: { markdown: string } } };
    expect(out.value.run.markdown).toContain("# Morning briefing");
  });

  test("runNow returns the run view; list has summaries without markdown; get finds it", async () => {
    const ran = (await call("briefing.runNow")) as { value: { run: { id: string } } };
    const id = ran.value.run.id;
    const list = (await call("briefing.list", { limit: 5 })) as {
      value: { runs: Array<Record<string, unknown>> };
    };
    expect(list.value.runs).toHaveLength(1);
    expect("markdown" in (list.value.runs[0] ?? {})).toBe(false);
    const got = (await call("briefing.get", { id })) as { value: { run: { id: string } } };
    expect(got.value.run.id).toBe(id);
  });

  test("status answers", async () => {
    const out = (await call("briefing.status")) as { value: { enabled: boolean; demo: boolean } };
    expect(out.value.enabled).toBe(false);
    expect(out.value.demo).toBe(false);
  });

  test("an unknown method is a miss", async () => {
    expect(await call("briefing.zzz")).toEqual({ kind: "miss" });
  });

  test("get of an unknown id is -32602 ERR_BRIEFING_NOT_FOUND", async () => {
    const err = await call("briefing.get", { id: "nope" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BriefingRpcError);
    expect((err as BriefingRpcError).rpcCode).toBe(-32602);
    expect((err as BriefingRpcError).message).toContain("ERR_BRIEFING_NOT_FOUND");
  });

  test("runNow while busy is -32000 ERR_BRIEFING_BUSY; another failure propagates", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slow = createBriefingRuntime({
      db,
      configDir: "C:/nonexistent-nimbus-test-dir",
      now: () => NOW,
      resolveSelf: async () => {
        await gate;
        return null;
      },
      emit: () => {},
      toast: async () => "delivered",
      toastDelivers: () => true,
      demo: false,
      loadConfig: () => parseNimbusTomlBriefing(""),
    });
    const first = dispatchBriefingRpc("briefing.runNow", {}, { runtime: slow });
    const err = await dispatchBriefingRpc("briefing.runNow", {}, { runtime: slow }).catch(
      (e: unknown) => e,
    );
    expect((err as BriefingRpcError).rpcCode).toBe(-32000);
    expect((err as BriefingRpcError).message).toContain("ERR_BRIEFING_BUSY");
    release();
    await first;

    const broken = {
      ...rt,
      runNow: async () => Promise.reject(new Error("boom")),
    } as BriefingRuntime;
    await expect(dispatchBriefingRpc("briefing.runNow", {}, { runtime: broken })).rejects.toThrow(
      "boom",
    );
  });
});

describe("payload validation", () => {
  test.each([
    ["briefing.latest", "x"],
    ["briefing.latest", null],
    ["briefing.latest", []],
    ["briefing.latest", { extra: 1 }],
    ["briefing.status", { extra: 1 }],
    ["briefing.runNow", { extra: 1 }],
    ["briefing.list", { limit: 0 }],
    ["briefing.list", { limit: 101 }],
    ["briefing.list", { limit: 1.5 }],
    ["briefing.list", { limit: "5" }],
    ["briefing.list", { other: 1 }],
    ["briefing.get", {}],
    ["briefing.get", { id: "" }],
    ["briefing.get", { id: 5 }],
    ["briefing.get", { id: "x".repeat(129) }],
    ["briefing.get", { id: "a", extra: 1 }],
  ])("%s with %j is -32602", async (method, params) => {
    const err = await call(method, params).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BriefingRpcError);
    expect((err as BriefingRpcError).rpcCode).toBe(-32602);
  });

  test("list accepts no params and the bounds 1 and 100", async () => {
    await call("briefing.list");
    await call("briefing.list", { limit: 1 });
    await call("briefing.list", { limit: 100 });
  });
});
