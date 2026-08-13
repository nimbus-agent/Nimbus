import { describe, expect, test } from "bun:test";

import type { AgentBriefCliSpec } from "./_agent-brief-cli.ts";
import { type NegotiateCommandDeps, parseNegotiateArgs, runNegotiateCommand } from "./negotiate.ts";

describe("parseNegotiateArgs", () => {
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

  // `nimbus negotiate` takes no positional arguments — everything is a flag — so any bare
  // token must be rejected rather than silently swallowed.
  test("a positional argument is rejected", () => {
    expect(() => parseNegotiateArgs(["person:bob"])).toThrow(/Unexpected argument/);
  });

  test("--since with no following value is rejected", () => {
    expect(() => parseNegotiateArgs(["--since"])).toThrow();
  });

  test("--person immediately followed by another flag is rejected (not treated as the value)", () => {
    expect(() => parseNegotiateArgs(["--person", "--json"])).toThrow();
  });
});

describe("runNegotiateCommand", () => {
  // `NegotiateCommandDeps.runAgentBriefCli` is generic, so the fake is declared as a generic
  // arrow and needs no cast — mirrors `owners.test.ts`'s `recordingDeps`.
  function recordingDeps(sink: {
    params?: Record<string, unknown>;
    json?: boolean;
  }): NegotiateCommandDeps {
    return {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        sink.params = spec.params;
        sink.json = spec.json;
      },
    };
  }

  // `toStrictEqual`, not `toEqual`: bun's `toEqual` ignores keys whose value is `undefined`, so
  // `{ sinceMs: 1, personId: undefined }` would pass against `{ sinceMs: 1 }` under `toEqual` —
  // proving nothing about whether the key was actually omitted from the wire params.
  test("no flags sends an empty param object", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runNegotiateCommand([], recordingDeps(sink));
    expect(sink.params).toStrictEqual({});
  });

  test("--since is parsed to sinceMs and no personId key is sent", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runNegotiateCommand(["--since", "1d"], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ sinceMs: 24 * 60 * 60 * 1000 });
  });

  test("--person sends personId and no sinceMs key is sent", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runNegotiateCommand(["--person", "person:bob"], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ personId: "person:bob" });
  });

  test("--since and --person together send both keys", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runNegotiateCommand(["--since", "2h", "--person", "person:bob"], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ sinceMs: 2 * 60 * 60 * 1000, personId: "person:bob" });
  });

  test("--json is forwarded to the spec, absent --json defaults to false", async () => {
    const jsonSink: { json?: boolean } = {};
    await runNegotiateCommand(["--json"], recordingDeps(jsonSink));
    expect(jsonSink.json).toBe(true);

    const noJsonSink: { json?: boolean } = {};
    await runNegotiateCommand([], recordingDeps(noJsonSink));
    expect(noJsonSink.json).toBe(false);
  });

  test("kind is 'negotiate' and the guard accepts a well-formed brief, rejects a malformed one", async () => {
    const sink: { guard?: (x: unknown) => boolean; kind?: string } = {};
    await runNegotiateCommand([], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        sink.guard = spec.guard as (x: unknown) => boolean;
        sink.kind = spec.kind;
      },
    });
    expect(sink.kind).toBe("negotiate");
    expect(sink.guard?.({ kind: "negotiate", gaps: [] })).toBe(true);
    expect(sink.guard?.({ kind: "negotiate", gaps: ["a gap"] })).toBe(true);
    // wrong kind
    expect(sink.guard?.({ kind: "decisions", gaps: [] })).toBe(false);
    // gaps not an array
    expect(sink.guard?.({ kind: "negotiate", gaps: "nope" })).toBe(false);
    // not an object at all
    expect(sink.guard?.(null)).toBe(false);
    expect(sink.guard?.("nope")).toBe(false);
  });
});
