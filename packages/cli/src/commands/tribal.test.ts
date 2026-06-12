import { expect, test } from "bun:test";
import { parseTribalArgs } from "./tribal.ts";

test("default + status → status", () => {
  expect(parseTribalArgs([])).toEqual({ kind: "status" });
  expect(parseTribalArgs(["status"])).toEqual({ kind: "status" });
});

test("start / stop / scan", () => {
  expect(parseTribalArgs(["start"])).toEqual({ kind: "start" });
  expect(parseTribalArgs(["stop"])).toEqual({ kind: "stop" });
  expect(parseTribalArgs(["scan"])).toEqual({ kind: "scan" });
});

test("list with and without a status filter", () => {
  expect(parseTribalArgs(["list"])).toEqual({ kind: "list" });
  expect(parseTribalArgs(["list", "suggested"])).toEqual({ kind: "list", status: "suggested" });
});

test("dismiss requires a cluster id", () => {
  expect(parseTribalArgs(["dismiss", "k1"])).toEqual({ kind: "dismiss", clusterId: "k1" });
  expect(() => parseTribalArgs(["dismiss"])).toThrow(/dismiss <cluster-id>/);
});

test("capture parses cluster id and optional --target", () => {
  expect(parseTribalArgs(["capture", "k1"])).toEqual({ kind: "capture", clusterId: "k1" });
  expect(parseTribalArgs(["capture", "k1", "--target", "confluence"])).toEqual({
    kind: "capture",
    clusterId: "k1",
    target: "confluence",
  });
  expect(parseTribalArgs(["capture", "k1", "--target", "notion"])).toEqual({
    kind: "capture",
    clusterId: "k1",
    target: "notion",
  });
});

test("capture rejects a missing cluster id or a bad --target", () => {
  expect(() => parseTribalArgs(["capture"])).toThrow(/capture <cluster-id>/);
  expect(() => parseTribalArgs(["capture", "k1", "--target", "jira"])).toThrow(/--target must be/);
});

test("unknown subcommand throws usage", () => {
  expect(() => parseTribalArgs(["bogus"])).toThrow(/Unknown subcommand/);
});
