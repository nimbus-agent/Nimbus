import { describe, expect, test } from "bun:test";

import { CAPTURE_TOOL_SPECS, captureToolsFor } from "./capture-tools.ts";
import type { IpcCallable } from "./client-surface.ts";
import type { AdapterDeps } from "./tool-runtime.ts";

function deps(
  impl: (method: string, params: unknown) => Promise<unknown>,
  extra: Partial<AdapterDeps> = {},
): {
  deps: AdapterDeps;
  calls: Array<[string, unknown]>;
} {
  const calls: Array<[string, unknown]> = [];
  const client: IpcCallable = {
    call: async <T>(m: string, p?: unknown) => {
      calls.push([m, p]);
      return (await impl(m, p)) as T;
    },
    disconnect: async () => {},
  };
  return { calls, deps: { getClient: async () => client, ...extra } };
}

const ENABLED = {
  enabled: true,
  kinds: ["note"],
  pending: 0,
  maxPending: 100,
  maxPerHour: 30,
  refusedSinceStart: {},
};

describe("captureToolsFor", () => {
  test("enabled + note kind → capture_note registered", async () => {
    const { deps: d } = deps(async () => ENABLED);
    expect((await captureToolsFor(d)).map((s) => s.name)).toEqual(["capture_note"]);
  });

  test.each([
    ["disabled", async () => ({ ...ENABLED, enabled: false, kinds: [], disabledReason: "config" })],
    ["note not in kinds", async () => ({ ...ENABLED, kinds: [] })],
    ["a non-object status", async () => "nope"],
    ["a status without a kinds array", async () => ({ enabled: true })],
    [
      "an old gateway (Method not found)",
      async () => {
        throw Object.assign(new Error("Method not found"), { code: -32601 });
      },
    ],
    ["a malformed status", async () => ({ enabled: "yes" })],
  ])("%s → no capture tool", async (_n, impl) => {
    const { deps: d } = deps(impl);
    expect(await captureToolsFor(d)).toEqual([]);
  });

  test("Review Focus 3: gateway DOWN at spawn → no capture tool, and no throw", async () => {
    const d: AdapterDeps = {
      getClient: async () => {
        throw new Error("not running");
      },
    };
    expect(await captureToolsFor(d)).toEqual([]);
  });

  test("declareKind failed (agent tools disabled) → no capture tool: the gateway cannot see us as mcp", async () => {
    const { deps: d, calls } = deps(async () => ENABLED, {
      agentToolsDisabledReason: () => "old gateway",
    });
    expect(await captureToolsFor(d)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("capture_note", () => {
  const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "capture_note");

  test("is annotated as a non-destructive, non-idempotent, closed-world write", () => {
    expect(spec?.annotations).toEqual({
      readOnlyHint: false,
      destructiveHint: false,
      idempotentHint: false,
      openWorldHint: false,
    });
  });

  test("submits kind note with the client label and returns the stored-locally text", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_1", state: "live" }));
    const res = await spec?.run(d, { title: "t", body: "b", tags: ["x"] }, () => "claude-code");
    expect(calls).toEqual([
      [
        "capture.submit",
        {
          kind: "note",
          payload: { title: "t", body: "b", tags: ["x"] },
          clientLabel: "claude-code",
        },
      ],
    ]);
    expect(res?.isError).toBeUndefined();
    expect(res?.content[0]?.text).toContain("Captured note cap_1");
    expect(res?.content[0]?.text).toContain("nimbus captures revoke cap_1");
  });

  test("forwards relatesTo and omits clientLabel when the client sent none", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_2", state: "live" }));
    await spec?.run(d, { title: "t", body: "b", relatesTo: ["github:1"] }, () => undefined);
    expect(calls).toEqual([
      [
        "capture.submit",
        { kind: "note", payload: { title: "t", body: "b", relatesTo: ["github:1"] } },
      ],
    ]);
  });

  test("a gateway reply with no id is an error result, not a fabricated success", async () => {
    const { deps: d } = deps(async () => ({ state: "live" }));
    const res = await spec?.run(d, { title: "t", body: "b" }, () => undefined);
    expect(res?.isError).toBe(true);
  });

  test("a gateway refusal surfaces as an isError result with the code", async () => {
    const { deps: d } = deps(async () => {
      throw new Error("ERR_CAPTURE_RATE_LIMITED: hourly capture cap reached");
    });
    const res = await spec?.run(d, { title: "t", body: "b" }, () => undefined);
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toContain("ERR_CAPTURE_RATE_LIMITED");
  });
});
