import { expect, test } from "bun:test";
import { childExitCode } from "./exit-status.ts";

test("a clean exit with a numeric code passes it through", () => {
  expect(childExitCode(0, null)).toBe(0);
  expect(childExitCode(1, null)).toBe(1);
  expect(childExitCode(2, null)).toBe(2);
});

test("a null code with no signal falls back to 0 (never thrown, never crashes the launcher)", () => {
  expect(childExitCode(null, null)).toBe(0);
});

test("SIGTERM is reported as 128 + 15, never as a clean exit", () => {
  expect(childExitCode(null, "SIGTERM")).toBe(143);
});

test("SIGKILL is reported as 128 + 9, never as a clean exit", () => {
  expect(childExitCode(null, "SIGKILL")).toBe(137);
});

test("a signal takes precedence over a non-null code, if both are somehow present", () => {
  expect(childExitCode(0, "SIGTERM")).toBe(143);
});

test("an unmapped/unrecognised signal name still reports non-zero", () => {
  // Cast through the same `NodeJS.Signals` type index.ts uses; the function's job here is to never
  // silently normalise an unrecognised signal to a clean 0 exit, not to enumerate every signal.
  const unrecognised = "SIGNOTAREALSIGNAL" as NodeJS.Signals;
  expect(childExitCode(null, unrecognised)).toBe(1);
  expect(childExitCode(null, unrecognised)).not.toBe(0);
});
