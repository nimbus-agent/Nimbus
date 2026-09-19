import { describe, expect, test } from "bun:test";

import { nimbusCommand } from "./demo-hint.ts";

describe("nimbusCommand", () => {
  test("non-demo: plain nimbus invocation", () => {
    expect(nimbusCommand("stop", false)).toBe("nimbus stop");
  });

  test("demo: --demo inserted right after the binary name", () => {
    expect(nimbusCommand("stop", true)).toBe("nimbus --demo stop");
  });

  test("non-demo: a multi-word rest is passed through unchanged", () => {
    expect(nimbusCommand("connector sync github", false)).toBe("nimbus connector sync github");
  });

  test("demo: a multi-word rest keeps --demo first", () => {
    expect(nimbusCommand("connector sync github", true)).toBe(
      "nimbus --demo connector sync github",
    );
  });
});
