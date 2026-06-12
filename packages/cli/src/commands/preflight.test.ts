import { expect, test } from "bun:test";
import { parsePreflightArgs } from "./preflight.ts";

test("preflight run: ref + --namespace + --strict + --json", () => {
  expect(
    parsePreflightArgs(["HEAD~1..HEAD", "--namespace", "project:zurich", "--strict", "--json"]),
  ).toEqual({
    mode: "run",
    ref: "HEAD~1..HEAD",
    namespace: "project:zurich",
    strict: true,
    json: true,
  });
});

test("preflight run defaults: not strict, not json", () => {
  expect(parsePreflightArgs(["HEAD", "--namespace", "n"])).toEqual({
    mode: "run",
    ref: "HEAD",
    namespace: "n",
    strict: false,
    json: false,
  });
});

test("preflight run requires a ref and --namespace", () => {
  expect(() => parsePreflightArgs(["HEAD"])).toThrow();
  expect(() => parsePreflightArgs(["--namespace", "n"])).toThrow();
  expect(() => parsePreflightArgs(["HEAD", "--namespace", "--json"])).toThrow();
});

test("preflight approve <id>", () => {
  expect(parsePreflightArgs(["approve", "abc-123"])).toEqual({
    mode: "approve",
    requestId: "abc-123",
  });
  expect(() => parsePreflightArgs(["approve"])).toThrow();
});
