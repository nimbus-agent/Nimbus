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
  expect(parseTeamArgs(["pair", "peer-host.test", "PAIRCODE"])).toEqual({
    kind: "pair",
    host: "peer-host.test",
    code: "PAIRCODE",
  });
  expect(() => parseTeamArgs(["pair", "onlyhost"])).toThrow();
});

test("query parses namespace-first arg order", () => {
  expect(parseTeamArgs(["query", "project:zurich", "peer:abcd", "find auth bugs"])).toEqual({
    kind: "query",
    namespace: "project:zurich",
    peerId: "peer:abcd",
    purpose: "find auth bugs",
  });
});

test("parses team who-knows with a peer", () => {
  expect(parseTeamArgs(["who-knows", "peer:abc", "kafka", "tuning"])).toEqual({
    kind: "whoKnows",
    peerId: "peer:abc",
    query: "kafka tuning",
  });
});

test("team who-knows requires a peer and a query", () => {
  expect(() => parseTeamArgs(["who-knows"])).toThrow();
  expect(() => parseTeamArgs(["who-knows", "peer:abc"])).toThrow();
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

// ---------------------------------------------------------------------------
// namespace: untested throw branches
// ---------------------------------------------------------------------------

test("namespace publish throws when name is present but no filters", () => {
  expect(() => parseTeamArgs(["namespace", "publish", "myns"])).toThrow();
});

test("namespace grant throws when role is missing", () => {
  expect(() => parseTeamArgs(["namespace", "grant", "ns", "peer"])).toThrow();
});

test("namespace grant throws when peerId is missing", () => {
  expect(() => parseTeamArgs(["namespace", "grant", "ns"])).toThrow();
});

test("namespace grant throws when namespace is missing", () => {
  expect(() => parseTeamArgs(["namespace", "grant"])).toThrow();
});

test("namespace revoke throws when peerId is missing", () => {
  expect(() => parseTeamArgs(["namespace", "revoke", "ns"])).toThrow();
});

test("namespace revoke throws when namespace is missing", () => {
  expect(() => parseTeamArgs(["namespace", "revoke"])).toThrow();
});

test("namespace throws on unknown action", () => {
  expect(() => parseTeamArgs(["namespace", "bogus"])).toThrow();
});

// ---------------------------------------------------------------------------
// query: untested throw branches
// ---------------------------------------------------------------------------

test("query throws when purpose is missing (ns + peer only)", () => {
  expect(() => parseTeamArgs(["query", "ns", "peer"])).toThrow();
});

test("query throws when peerId is missing", () => {
  expect(() => parseTeamArgs(["query", "ns"])).toThrow();
});

test("query throws when namespace is missing", () => {
  expect(() => parseTeamArgs(["query"])).toThrow();
});

// ---------------------------------------------------------------------------
// vault: untested throw branches
// ---------------------------------------------------------------------------

test("vault put throws when service is missing (entry provided)", () => {
  expect(() => parseTeamArgs(["vault", "put", "entry"])).toThrow();
});

test("vault put throws when entry is missing", () => {
  expect(() => parseTeamArgs(["vault", "put"])).toThrow();
});

test("vault put throws when no --secret is supplied", () => {
  expect(() => parseTeamArgs(["vault", "put", "entry", "svc"])).toThrow();
});

test("vault put throws when --secret value has no equals sign", () => {
  expect(() => parseTeamArgs(["vault", "put", "e", "s", "--secret", "noequals"])).toThrow();
});

test("vault revoke throws when toolId is missing", () => {
  expect(() => parseTeamArgs(["vault", "revoke", "entry", "peer"])).toThrow();
});

test("vault grant throws when peerId is missing", () => {
  expect(() => parseTeamArgs(["vault", "grant", "entry"])).toThrow();
});

test("vault grant throws when entry is missing", () => {
  expect(() => parseTeamArgs(["vault", "grant"])).toThrow();
});

test("vault throws on unknown action", () => {
  expect(() => parseTeamArgs(["vault", "bogus"])).toThrow();
});

// vault revoke happy path
test("vault revoke parses correctly", () => {
  expect(parseTeamArgs(["vault", "revoke", "e", "p", "t"])).toEqual({
    kind: "vaultRevoke",
    entry: "e",
    peerId: "p",
    toolId: "t",
  });
});

// ---------------------------------------------------------------------------
// invoke: untested throw branches
// ---------------------------------------------------------------------------

test("invoke throws when only peerId and entry are supplied (toolId missing)", () => {
  expect(() => parseTeamArgs(["invoke", "p", "e"])).toThrow();
});

test("invoke throws when only peerId is supplied", () => {
  expect(() => parseTeamArgs(["invoke", "peer"])).toThrow();
});

test("invoke throws when --args value is not valid JSON", () => {
  expect(() => parseTeamArgs(["invoke", "p", "e", "t", "--args", "{bad"])).toThrow();
});

// invoke happy paths
test("invoke parses with valid --args JSON", () => {
  expect(parseTeamArgs(["invoke", "p", "e", "t", "--args", '{"a":1}'])).toEqual({
    kind: "invoke",
    peerId: "p",
    entry: "e",
    toolId: "t",
    purpose: "",
    args: { a: 1 },
  });
});

test("invoke parses without --args (defaults to empty object)", () => {
  expect(parseTeamArgs(["invoke", "p", "e", "t"])).toEqual({
    kind: "invoke",
    peerId: "p",
    entry: "e",
    toolId: "t",
    purpose: "",
    args: {},
  });
});

// ---------------------------------------------------------------------------
// delegate: untested throw branches
// ---------------------------------------------------------------------------

test("delegate throws when only peerId is supplied (scope and expires missing)", () => {
  expect(() => parseTeamArgs(["delegate", "peer"])).toThrow();
});

test("delegate throws when --scope has no colon", () => {
  expect(() =>
    parseTeamArgs(["delegate", "p", "--scope", "noColonScope", "--expires", "10"]),
  ).toThrow();
});

test("delegate throws when --expires is missing", () => {
  expect(() => parseTeamArgs(["delegate", "p", "--scope", "k:v"])).toThrow();
});

test("delegate throws when --expires is non-positive", () => {
  expect(() => parseTeamArgs(["delegate", "p", "--scope", "k:v", "--expires", "-5"])).toThrow();
});

test("delegate throws when --expires is not a number", () => {
  expect(() =>
    parseTeamArgs(["delegate", "p", "--scope", "k:v", "--expires", "notanumber"]),
  ).toThrow();
});

// ---------------------------------------------------------------------------
// audit: untested throw branches and happy paths
// ---------------------------------------------------------------------------

test("audit throws when namespace is missing", () => {
  expect(() => parseTeamArgs(["audit"])).toThrow();
});

test("audit throws when namespace starts with --", () => {
  expect(() => parseTeamArgs(["audit", "--purpose", "x"])).toThrow();
});

test("audit throws when --since is negative", () => {
  expect(() => parseTeamArgs(["audit", "myns", "--since", "-1"])).toThrow();
});

test("audit throws when --since is not a number", () => {
  expect(() => parseTeamArgs(["audit", "myns", "--since", "notanumber"])).toThrow();
});

test("audit parses with just a namespace (uses defaults)", () => {
  expect(parseTeamArgs(["audit", "myns"])).toEqual({
    kind: "audit",
    namespace: "myns",
    purpose: "team-audit",
    sinceMs: 0,
  });
});

test("audit parses with --purpose and --since", () => {
  expect(parseTeamArgs(["audit", "myns", "--purpose", "why", "--since", "1000"])).toEqual({
    kind: "audit",
    namespace: "myns",
    purpose: "why",
    sinceMs: 1000,
  });
});

// ---------------------------------------------------------------------------
// purge: untested throw branches and happy paths
// ---------------------------------------------------------------------------

test("purge throws when --user flag is missing entirely", () => {
  expect(() => parseTeamArgs(["purge"])).toThrow();
});

test("purge throws when --user value is empty string", () => {
  expect(() => parseTeamArgs(["purge", "--user", ""])).toThrow();
});

test("purge parses with --user", () => {
  expect(parseTeamArgs(["purge", "--user", "u123"])).toEqual({
    kind: "purge",
    externalId: "u123",
    yes: false,
  });
});

test("purge parses with --user and --yes", () => {
  expect(parseTeamArgs(["purge", "--user", "u123", "--yes"])).toEqual({
    kind: "purge",
    externalId: "u123",
    yes: true,
  });
});

test("purge parses with --user and --force (alias for --yes)", () => {
  expect(parseTeamArgs(["purge", "--user", "u123", "--force"])).toEqual({
    kind: "purge",
    externalId: "u123",
    yes: true,
  });
});
