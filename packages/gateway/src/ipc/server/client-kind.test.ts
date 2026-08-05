import { expect, test } from "bun:test";
import { ClientKindStore } from "./client-kind.ts";

test("an undeclared connection is unknown", () => {
  const s = new ClientKindStore();
  expect(s.get("c1")).toBe("unknown");
});

test("declare records a recognised kind", () => {
  const s = new ClientKindStore();
  expect(s.declare("c1", "mcp")).toBe("mcp");
  expect(s.get("c1")).toBe("mcp");
});

test("an unrecognised kind is stored as unknown, never trusted verbatim", () => {
  const s = new ClientKindStore();
  expect(s.declare("c1", "totally-made-up")).toBe("unknown");
  expect(s.get("c1")).toBe("unknown");
});

test("a non-string kind is rejected without throwing", () => {
  const s = new ClientKindStore();
  expect(s.declare("c1", { kind: "mcp" })).toBe("unknown");
});

test("kind is immutable for the connection's lifetime", () => {
  const s = new ClientKindStore();
  s.declare("c1", "cli");
  expect(s.declare("c1", "mcp")).toBe("cli");
  expect(s.get("c1")).toBe("cli");
});

test("forget clears the connection", () => {
  const s = new ClientKindStore();
  s.declare("c1", "mcp");
  s.forget("c1");
  expect(s.get("c1")).toBe("unknown");
});
