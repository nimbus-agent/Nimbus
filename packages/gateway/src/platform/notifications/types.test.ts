import { describe, expect, test } from "bun:test";

import { describeSpawnFailure, pickEnv, prepareNotificationText } from "./types.ts";

describe("prepareNotificationText", () => {
  test("keeps ordinary text, TAB and LF; strips other controls and DEL", () => {
    expect(prepareNotificationText("a\tb\nc", 100)).toBe("a\tb\nc");
    expect(prepareNotificationText("a\u0000b\rc\u001B[0m\u007Fd", 100)).toBe("abc[0md");
  });

  test("caps by code points with a trailing ellipsis, never splitting a surrogate pair", () => {
    expect(prepareNotificationText("abcdef", 6)).toBe("abcdef");
    expect(prepareNotificationText("abcdefg", 6)).toBe("abcde…");
    const capped = prepareNotificationText("😀".repeat(10), 4);
    expect(capped).toBe("😀😀😀…");
    expect(Array.from(capped)).toHaveLength(4);
  });

  test("the cap counts text AFTER stripping", () => {
    expect(prepareNotificationText("\u0000\u0000abc", 3)).toBe("abc");
  });
});

describe("pickEnv", () => {
  test("copies only the named, non-empty keys", () => {
    expect(pickEnv({ A: "1", B: "", C: "3", SECRET: "x" }, ["A", "B", "C", "D"])).toEqual({
      A: "1",
      C: "3",
    });
  });
});

describe("describeSpawnFailure", () => {
  test("never includes stdout/stderr", () => {
    const r = { ok: false, stdout: "OUT-SENTINEL", stderr: "ERR-SENTINEL", code: 2 };
    expect(describeSpawnFailure("tool", r)).toBe("tool exited with code 2");
    expect(describeSpawnFailure("tool", { ...r, code: null })).toBe(
      "tool could not be started, was killed, or timed out",
    );
  });
});
