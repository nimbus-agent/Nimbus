import { describe, expect, test } from "bun:test";

import { decode, subAgent } from "./sub-agent.ts";

describe("subAgent", () => {
  test("presents a local function as a zero-cost SubTask", async () => {
    const task = subAgent(() => ({ hits: 3 }));
    expect(task.taskType).toBe("agent_step");
    // Empty prompt and zero tokens are the contract, not an oversight: a lane
    // that never calls the model must contribute nothing to an agent's reported
    // usage, or the brief overstates what it spent.
    expect(task.prompt).toBe("");
    const out = await task.execute();
    expect(out.tokensIn).toBe(0);
    expect(out.tokensOut).toBe(0);
    expect(out.text).toBe(JSON.stringify({ hits: 3 }));
  });

  test("round-trips through decode", async () => {
    const value = { owners: ["a", "b"], total: 2 };
    const out = await subAgent(() => value).execute();
    // Fallback typed as the same shape so `decode`'s generic resolves to it —
    // a `null` fallback would infer `T = null` and reject the comparison.
    expect(decode(out.text, { owners: [] as string[], total: 0 })).toEqual(value);
  });

  test("the function runs at execute() time, not at construction", async () => {
    // The coordinator builds every lane up front and runs them on its own
    // schedule; a subAgent that evaluated eagerly would do the SQL work even for
    // a lane the coordinator later drops.
    let calls = 0;
    const task = subAgent(() => {
      calls += 1;
      return calls;
    });
    expect(calls).toBe(0);
    await task.execute();
    expect(calls).toBe(1);
  });
});

describe("decode", () => {
  test("parses valid JSON", () => {
    expect(decode('{"a":1}', { a: 0 })).toEqual({ a: 1 });
  });

  test("undefined text yields the fallback", () => {
    // A lane the coordinator never ran returns no text at all.
    expect(decode(undefined, { a: 9 })).toEqual({ a: 9 });
  });

  test("unparseable text yields the fallback rather than throwing", () => {
    // The load-bearing case: one malformed lane must not fail the whole
    // fan-out. The brief renders what it has and reports the gap.
    expect(decode("not json", { a: 9 })).toEqual({ a: 9 });
    expect(() => decode("{", null)).not.toThrow();
  });

  test("preserves a falsy parsed value instead of falling back to it", () => {
    // `0`, `false` and `""` are legitimate lane results. A `??`-style
    // implementation would silently swap them for the fallback.
    expect(decode("0", 42)).toBe(0);
    expect(decode("false", true)).toBe(false);
    expect(decode('""', "fallback")).toBe("");
  });
});
