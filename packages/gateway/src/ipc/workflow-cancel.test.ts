import { describe, expect, test } from "bun:test";

import { createStreamRegistry } from "./engine-ask-stream.ts";
import { RpcMethodError } from "./server/rpc-error.ts";
import { createWorkflowCancelHandler, workflowRegistryKey } from "./workflow-cancel.ts";

describe("createWorkflowCancelHandler", () => {
  test("aborts the calling client's run and reports cancelled", () => {
    const registry = createStreamRegistry();
    const ac = new AbortController();
    registry.register(workflowRegistryKey("client-a", "wf-1"), ac);

    const result = createWorkflowCancelHandler(registry)("client-a", { streamId: "wf-1" });

    expect(result).toEqual({ cancelled: true });
    expect(ac.signal.aborted).toBe(true);
  });

  test("one client cannot cancel another client's run with the same streamId", () => {
    const registry = createStreamRegistry();
    const ac = new AbortController();
    registry.register(workflowRegistryKey("client-b", "shared-id"), ac);

    const result = createWorkflowCancelHandler(registry)("client-a", { streamId: "shared-id" });

    expect(result).toEqual({ cancelled: false });
    expect(ac.signal.aborted).toBe(false);
  });

  test("reports cancelled: false for an unknown streamId", () => {
    const registry = createStreamRegistry();
    expect(createWorkflowCancelHandler(registry)("client-a", { streamId: "nope" })).toEqual({
      cancelled: false,
    });
  });

  test("rejects a missing or non-string streamId", () => {
    const handler = createWorkflowCancelHandler(createStreamRegistry());
    expect(() => handler("client-a", null)).toThrow(RpcMethodError);
    expect(() => handler("client-a", {})).toThrow(RpcMethodError);
    expect(() => handler("client-a", { streamId: 42 })).toThrow(RpcMethodError);
    expect(() => handler("client-a", { streamId: "" })).toThrow(RpcMethodError);
  });

  test("the key separator cannot be forged from a crafted streamId", () => {
    // A NUL separator cannot appear in a JSON-RPC string id in practice, so
    // "client-a" + "x" can never collide with another client's namespace.
    expect(workflowRegistryKey("a", "b")).not.toBe(workflowRegistryKey("a:b", ""));
  });
});
