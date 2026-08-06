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

test("a socket client CANNOT declare itself http", () => {
  // `http` exists on the ClientKind union, but it is DERIVED, never declared: the HTTP route
  // handler constructs `caller: {kind: "http"}` itself, after verifying a bearer token against the
  // labeled token map. That makes it a fact the gateway checked.
  //
  // Adding "http" to RECOGNISED would quietly undo that — any local process on the socket could
  // file its briefs under the one transport whose attribution is supposed to be server-verified,
  // and the egress ledger would record a claim instead of an observation.
  const s = new ClientKindStore();
  expect(s.declare("c1", "http")).toBe("unknown");
  expect(s.get("c1")).toBe("unknown");
});

test("the declarable kinds are exactly cli, mcp and ui", () => {
  // Pins the whole set, not just the http exclusion: a future kind added to RECOGNISED without a
  // decision would otherwise slip in silently.
  const s = new ClientKindStore();
  for (const kind of ["cli", "mcp", "ui"] as const) {
    expect(new ClientKindStore().declare("x", kind)).toBe(kind);
  }
  expect(s.declare("c2", "http")).toBe("unknown");
  expect(s.declare("c3", "unknown")).toBe("unknown");
});

test("forget clears the connection", () => {
  const s = new ClientKindStore();
  s.declare("c1", "mcp");
  s.forget("c1");
  expect(s.get("c1")).toBe("unknown");
});
