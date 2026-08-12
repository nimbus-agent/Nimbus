import { expect, test } from "bun:test";
import { parseNegotiateArgs } from "./negotiate.ts";

test("parses --since, --person and --json", () => {
  const a = parseNegotiateArgs(["--since", "90d", "--person", "person:bob", "--json"]);
  expect(a.since).toBe("90d");
  expect(a.person).toBe("person:bob");
  expect(a.json).toBe(true);
});

test("defaults are empty and non-json", () => {
  const a = parseNegotiateArgs([]);
  expect(a.since).toBeUndefined();
  expect(a.person).toBeUndefined();
  expect(a.json).toBe(false);
});

test("an unrecognised flag is rejected, never ignored", () => {
  expect(() => parseNegotiateArgs(["--persn", "x"])).toThrow(/Unrecognised flag/);
});
