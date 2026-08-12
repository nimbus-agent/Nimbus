import { describe, expect, test } from "bun:test";

import { createStreamRegistry } from "./engine-ask-stream.ts";
import { createCancelStreamHandler } from "./engine-cancel-stream.ts";
import { RpcMethodError } from "./server/rpc-error.ts";
import { workflowRegistryKey } from "./workflow-cancel.ts";

describe("createCancelStreamHandler", () => {
  test("returns ok=true and aborts the controller for known streamId", () => {
    const registry = createStreamRegistry();
    const ac = new AbortController();
    registry.register("s1", ac);
    const handler = createCancelStreamHandler(registry);
    const result = handler({ streamId: "s1" });
    expect(result).toEqual({ ok: true });
    expect(ac.signal.aborted).toBe(true);
  });

  test("returns ok=true (idempotent) for unknown streamId", () => {
    const registry = createStreamRegistry();
    const handler = createCancelStreamHandler(registry);
    const result = handler({ streamId: "never-existed" });
    expect(result).toEqual({ ok: true });
  });

  test("throws RpcMethodError when streamId is not a non-empty string", () => {
    const registry = createStreamRegistry();
    const handler = createCancelStreamHandler(registry);
    expect(() => handler({ streamId: "" })).toThrow();
    expect(() => handler({ streamId: 42 as unknown as string })).toThrow();
  });

  // engine.cancelStream cancels by BARE id against the SAME registry that
  // holds composite `clientId + SEP + streamId` workflow.run keys. A crafted
  // id equal to a victim's composite key must be rejected outright — proving
  // not just that it throws, but that the victim's entry is left untouched
  // (i.e. the cross-client abort this would otherwise enable is impossible).
  test("a crafted id matching a workflow registry's composite key cannot reach it", () => {
    const registry = createStreamRegistry();
    const victimAc = new AbortController();
    const forgedKey = workflowRegistryKey("victim-client", "victim-stream");
    registry.register(forgedKey, victimAc);

    const handler = createCancelStreamHandler(registry);
    expect(() => handler({ streamId: forgedKey })).toThrow(RpcMethodError);

    // The victim's workflow entry must still be live and uncancelled.
    expect(victimAc.signal.aborted).toBe(false);
    expect(registry.has(forgedKey)).toBe(true);
  });
});
