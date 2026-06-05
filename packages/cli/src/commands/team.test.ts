import { expect, test } from "bun:test";
import { parseTeamArgs } from "./team.ts";

test("discover (default)", () => {
  expect(parseTeamArgs([])).toEqual({ kind: "discover" });
  expect(parseTeamArgs(["discover"])).toEqual({ kind: "discover" });
});

test("namespace publish requires a name and >=1 filter", () => {
  expect(
    parseTeamArgs([
      "namespace",
      "publish",
      "project:zurich",
      "--type",
      "pull_request",
      "--service",
      "github",
    ]),
  ).toEqual({
    kind: "namespacePublish",
    name: "project:zurich",
    filters: [
      { kind: "type", value: "pull_request" },
      { kind: "service", value: "github" },
    ],
  });
  expect(() => parseTeamArgs(["namespace", "publish"])).toThrow();
});

test("namespace grant", () => {
  expect(parseTeamArgs(["namespace", "grant", "project:zurich", "peer:abcd", "viewer"])).toEqual({
    kind: "namespaceGrant",
    namespace: "project:zurich",
    peerId: "peer:abcd",
    role: "viewer",
    standing: false,
  });
});

test("namespace grant with --standing", () => {
  expect(parseTeamArgs(["namespace", "grant", "ns", "peer:abcd", "viewer", "--standing"])).toEqual({
    kind: "namespaceGrant",
    namespace: "ns",
    peerId: "peer:abcd",
    role: "viewer",
    standing: true,
  });
});

test("namespace revoke", () => {
  expect(parseTeamArgs(["namespace", "revoke", "ns", "peer:abcd"])).toEqual({
    kind: "namespaceRevoke",
    namespace: "ns",
    peerId: "peer:abcd",
  });
});

test("pair", () => {
  expect(parseTeamArgs(["pair", "192.168.1.20", "PAIRCODE"])).toEqual({
    kind: "pair",
    host: "192.168.1.20",
    code: "PAIRCODE",
  });
  expect(() => parseTeamArgs(["pair", "onlyhost"])).toThrow();
});

test("query + who-knows", () => {
  expect(parseTeamArgs(["query", "project:zurich", "peer:abcd", "find auth bugs"])).toEqual({
    kind: "query",
    namespace: "project:zurich",
    peerId: "peer:abcd",
    purpose: "find auth bugs",
  });
  expect(parseTeamArgs(["who-knows", "auth.ts race"])).toEqual({
    kind: "whoKnows",
    query: "auth.ts race",
  });
});

test("unknown subcommand throws", () => {
  expect(() => parseTeamArgs(["bogus"])).toThrow();
});

test("parses team consent approve/deny", () => {
  expect(parseTeamArgs(["consent", "req-1", "approve"])).toEqual({
    kind: "consent",
    requestId: "req-1",
    approved: true,
  });
  expect(parseTeamArgs(["consent", "req-2", "deny"])).toEqual({
    kind: "consent",
    requestId: "req-2",
    approved: false,
  });
});

test("team consent rejects a bad verb", () => {
  expect(() => parseTeamArgs(["consent", "req-1", "maybe"])).toThrow();
});

test("parses team listen", () => {
  expect(parseTeamArgs(["listen"])).toEqual({ kind: "listen" });
});
