import { describe, expect, it } from "bun:test";
import { RpcMethodError } from "./rpc-error.ts";

describe("RpcMethodError", () => {
  it("constructs without rpcData — rpcData remains undefined", () => {
    const err = new RpcMethodError(-32601, "Method not found");
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(RpcMethodError);
    expect(err.rpcCode).toBe(-32601);
    expect(err.message).toBe("Method not found");
    expect(err.name).toBe("RpcMethodError");
    expect(err.rpcData).toBeUndefined();
  });

  it("constructs with rpcData — rpcData is stored on the instance (covers the true arm of the rpcData guard)", () => {
    const data: Record<string, unknown> = { field: "value", code: 42 };
    const err = new RpcMethodError(-32600, "Invalid request", data);
    expect(err.rpcCode).toBe(-32600);
    expect(err.message).toBe("Invalid request");
    expect(err.rpcData).toBe(data);
    expect(err.rpcData?.["field"]).toBe("value");
    expect(err.rpcData?.["code"]).toBe(42);
  });

  it("rpcData is not set when explicitly passed as undefined", () => {
    const err = new RpcMethodError(-32603, "Internal error", undefined);
    expect(err.rpcData).toBeUndefined();
  });
});
