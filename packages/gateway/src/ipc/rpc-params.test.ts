import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  requireNonEmptyStringField,
  requireNonEmptyStringParam,
  requireStringParam,
  requireTrimmedStringField,
  stringArrayAllOrNothing,
} from "./rpc-params.ts";

/** Shaped like every `ipc/*-rpc.ts` error class: `new XRpcError(rpcCode, message)`. */
class FakeRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "FakeRpcError";
  }
}

/** The thrown value, or a test failure if nothing was thrown. */
function thrownBy(fn: () => unknown): unknown {
  try {
    fn();
  } catch (e) {
    return e;
  }
  throw new Error("expected the call to throw");
}

/**
 * The caller's class, `-32602`, and the exact message — the three things a dispatcher and a client
 * act on. `instanceof` is the load-bearing one: `ipc/server/dispatchers.ts` maps errors by class.
 */
function expectRpcRefusal(fn: () => unknown, message: string): void {
  const e = thrownBy(fn);
  expect(e).toBeInstanceOf(FakeRpcError);
  expect((e as FakeRpcError).rpcCode).toBe(-32602);
  expect((e as FakeRpcError).message).toBe(message);
}

describe("requireNonEmptyStringParam", () => {
  const read = (params: unknown) => requireNonEmptyStringParam(params, "sessionId", FakeRpcError);
  const REFUSAL = "ERR_INVALID_PARAMS: sessionId (non-empty string) required";

  test("returns the value exactly as given — never trimmed", () => {
    expect(read({ sessionId: "s1" })).toBe("s1");
    expect(read({ sessionId: "  s1  " })).toBe("  s1  ");
    // Non-empty is the whole rule: whitespace-only passes here, unlike requireTrimmedStringField.
    expect(read({ sessionId: " " })).toBe(" ");
  });

  test("refuses a missing, non-string or empty value with the caller's error class", () => {
    for (const params of [{}, { sessionId: 7 }, { sessionId: null }, { sessionId: "" }]) {
      expectRpcRefusal(() => read(params), REFUSAL);
    }
  });

  test("a params value that is not a plain object reads as a missing key", () => {
    for (const params of [null, undefined, "sessionId", 42, ["s1"]]) {
      expectRpcRefusal(() => read(params), REFUSAL);
    }
  });
});

describe("requireNonEmptyStringField", () => {
  const read = (rec: Record<string, unknown>) =>
    requireNonEmptyStringField(rec, "peerId", FakeRpcError);
  const REFUSAL = "ERR_INVALID_PARAMS: peerId must be a non-empty string";

  test("returns the value exactly as given — never trimmed", () => {
    expect(read({ peerId: "p1" })).toBe("p1");
    expect(read({ peerId: " p1 " })).toBe(" p1 ");
  });

  test("refuses a missing, non-string or empty value, in its own wording", () => {
    for (const rec of [{}, { peerId: 1 }, { peerId: undefined }, { peerId: "" }]) {
      expectRpcRefusal(() => read(rec), REFUSAL);
    }
  });
});

describe("requireTrimmedStringField", () => {
  const read = (rec: Record<string, unknown> | undefined) =>
    requireTrimmedStringField(rec, "id", FakeRpcError);
  const REFUSAL = "Missing or invalid id";

  test("returns the value TRIMMED", () => {
    expect(read({ id: "w1" })).toBe("w1");
    expect(read({ id: "\t w1 \n" })).toBe("w1");
  });

  test("refuses a missing, non-string, empty or whitespace-only value", () => {
    for (const rec of [{}, { id: 3 }, { id: "" }, { id: "   " }]) {
      expectRpcRefusal(() => read(rec), REFUSAL);
    }
  });

  test("an absent record refuses with the same message as a bad value", () => {
    expectRpcRefusal(() => read(undefined), REFUSAL);
  });
});

describe("requireStringParam", () => {
  const REFUSAL = "ERR_INVALID_PARAMS: text (string) required";

  test("returns any string as given — the EMPTY string included", () => {
    expect(requireStringParam({ text: "hi" }, "text")).toBe("hi");
    expect(requireStringParam({ text: "" }, "text")).toBe("");
    expect(requireStringParam({ text: "  " }, "text")).toBe("  ");
  });

  test("refuses a missing or non-string value with a PLAIN Error, not a coded one", () => {
    for (const params of [{}, { text: 1 }, { text: null }, null, undefined, "text", 0]) {
      const e = thrownBy(() => requireStringParam(params, "text"));
      // Exactly `Error`, which is what both callers (`chatops-rpc.ts`, `tribal-rpc.ts`) have always
      // thrown — the server reports it as `-32603` with this message.
      expect((e as Error).constructor).toBe(Error);
      expect((e as Error).message).toBe(REFUSAL);
    }
  });
});

describe("stringArrayAllOrNothing", () => {
  test("an all-string array comes back as a COPY", () => {
    const input = ["https://a.example", "https://b.example"];
    const out = stringArrayAllOrNothing(input);
    expect(out).toEqual(input);
    expect(out).not.toBe(input);
  });

  test("a mixed array is EMPTY, never the partial list of its string elements", () => {
    expect(stringArrayAllOrNothing(["https://a.example", 1])).toEqual([]);
    expect(stringArrayAllOrNothing(["x", null, "y"])).toEqual([]);
  });

  test("a non-array is empty", () => {
    for (const v of [undefined, null, "x", 1, { 0: "x", length: 1 }]) {
      expect(stringArrayAllOrNothing(v)).toEqual([]);
    }
  });

  test("an empty array stays empty", () => {
    expect(stringArrayAllOrNothing([])).toEqual([]);
  });
});

describe("every caller passes the error class it declares itself", () => {
  test("each coded helper call names a class exported by the calling module", () => {
    // The class is a PARAMETER here, so it is a seam: `ipc/server/dispatchers.ts` maps a module's
    // refusal to `-32602` by `instanceof` on THAT module's class, and any other class falls through
    // to the generic `-32603` with the same message. That compiles, and every message assertion
    // still passes — the module suites do not all check the class — so it is pinned at the source.
    const CODED_CALL =
      /\b(?:requireNonEmptyStringParam|requireNonEmptyStringField|requireTrimmedStringField)\(([^;]*?),\s*(\w+)\s*,?\s*\)/g;
    const ipcDir = import.meta.dir;
    let calls = 0;
    for (const rel of readdirSync(ipcDir, { recursive: true, encoding: "utf8" })) {
      if (!rel.endsWith(".ts") || rel.endsWith(".test.ts") || rel === "rpc-params.ts") continue;
      const src = readFileSync(join(ipcDir, rel), "utf8");
      if (!/from "(?:\.\.?\/)+(?:ipc\/)?rpc-params\.ts"/.test(src)) continue;
      const declared = new Set(
        [...src.matchAll(/^export class (\w+) extends Error\b/gm)].map((m) => m[1]),
      );
      for (const m of src.matchAll(CODED_CALL)) {
        calls++;
        expect({ rel, errorClass: m[2], declaredHere: declared.has(m[2]) }).toEqual({
          rel,
          errorClass: m[2],
          declaredHere: true,
        });
      }
    }
    // Not vacuous: the nine modules that use a coded helper today each call it once, in a wrapper.
    expect(calls).toBeGreaterThanOrEqual(9);
  });
});
