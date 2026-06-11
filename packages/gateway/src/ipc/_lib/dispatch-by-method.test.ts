import { describe, expect, test } from "bun:test";
import { dispatchByMethod, type RpcMethodHandlerMap } from "./dispatch-by-method.ts";

describe("dispatchByMethod", () => {
  test("returns hit envelope with the handler value when method is registered", async () => {
    const result = await dispatchByMethod("foo.bar", { x: 3 }, undefined, {
      "foo.bar": (params) => {
        const p = params as { x: number };
        return { y: p.x * 2 };
      },
    });
    expect(result).toEqual({ kind: "hit", value: { y: 6 } });
  });

  test("returns miss for an unknown method (does NOT throw)", async () => {
    const result = await dispatchByMethod("unknown.method", {}, undefined, {});
    expect(result).toEqual({ kind: "miss" });
  });

  test("passes ctx through to the handler", async () => {
    const ctx = { tag: "ctx-marker" };
    const result = await dispatchByMethod("ns.identity", undefined, ctx, {
      "ns.identity": (_p, c) => c,
    });
    expect(result).toEqual({ kind: "hit", value: ctx });
  });

  test("accepts a synchronous handler return value", async () => {
    const result = await dispatchByMethod("sync.method", undefined, undefined, {
      "sync.method": () => 42,
    });
    expect(result).toEqual({ kind: "hit", value: 42 });
  });

  test("awaits a promise return value", async () => {
    const result = await dispatchByMethod("async.method", undefined, undefined, {
      "async.method": async () => "delayed",
    });
    expect(result).toEqual({ kind: "hit", value: "delayed" });
  });

  test("propagates handler errors instead of swallowing them", async () => {
    class CustomError extends Error {}
    const promise = dispatchByMethod("err.method", undefined, undefined, {
      "err.method": () => {
        throw new CustomError("nope");
      },
    });
    await expect(promise).rejects.toThrow(CustomError);
  });

  test("ignores methods inherited via prototype (prototype-pollution safety)", async () => {
    const proto = { "evil.method": () => "PWNED" };
    const handlers = Object.create(proto) as Record<string, () => unknown>;
    const result = await dispatchByMethod("evil.method", undefined, undefined, handlers);
    expect(result).toEqual({ kind: "miss" });
  });

  test("returns miss when own property exists but its value is undefined (handler === undefined branch)", async () => {
    // Object.hasOwn returns true for "ghost" but handlers["ghost"] is undefined,
    // exercising the `if (handler === undefined)` true arm (BRDA line 21 block 1 branch 0).
    // Cast through unknown because RpcMethodHandlerMap forbids undefined values at the type level.
    const handlers = { ghost: undefined } as unknown as RpcMethodHandlerMap<undefined>;
    const result = await dispatchByMethod("ghost", undefined, undefined, handlers);
    expect(result).toEqual({ kind: "miss" });
  });
});
