import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import type { AgentBriefCliSpec } from "./_agent-brief-cli.ts";
import {
  type PreMortemCommandDeps,
  parsePreMortemArgs,
  runPreMortemCommand,
} from "./pre-mortem.ts";

describe("parsePreMortemArgs", () => {
  test("a bare epic ref becomes epicRef with no services and every flag off", () => {
    expect(parsePreMortemArgs(["PROJ-120"])).toEqual({
      epicRef: "PROJ-120",
      services: [],
      json: false,
      refresh: false,
      repropose: false,
    });
  });

  test("a jira:-prefixed ref is accepted verbatim (parsing does not strip the prefix)", () => {
    expect(parsePreMortemArgs(["jira:PROJ-120"]).epicRef).toBe("jira:PROJ-120");
  });

  // Discriminates a "last value wins" implementation: a broken parser that overwrote a single
  // `service` variable instead of pushing would leave this array with exactly one entry.
  test("--service is repeatable and preserves order", () => {
    const p = parsePreMortemArgs([
      "PROJ-120",
      "--service",
      "acme/billing",
      "--service",
      "acme/checkout",
    ]);
    expect(p.services).toEqual(["acme/billing", "acme/checkout"]);
  });

  test("--json, --refresh and --repropose are independent flags", () => {
    const p = parsePreMortemArgs(["PROJ-120", "--json", "--refresh", "--repropose"]);
    expect(p.json).toBe(true);
    expect(p.refresh).toBe(true);
    expect(p.repropose).toBe(true);
  });

  test("a missing epic-ref is rejected", () => {
    expect(() => parsePreMortemArgs([])).toThrow(/epic-ref/);
    expect(() => parsePreMortemArgs(["--json"])).toThrow(/epic-ref/);
  });

  test("an unrecognised flag is rejected with the exact USAGE-carrying message, not ignored", () => {
    expect(() => parsePreMortemArgs(["PROJ-120", "--nope"])).toThrow(
      /^Unrecognised flag: --nope\nUsage: nimbus pre-mortem/,
    );
  });

  test("a second positional argument is rejected", () => {
    expect(() => parsePreMortemArgs(["PROJ-120", "PROJ-121"])).toThrow(/Unexpected argument/);
  });

  test("--service with no following value is rejected", () => {
    expect(() => parsePreMortemArgs(["PROJ-120", "--service"])).toThrow();
  });

  test("--service immediately followed by another flag is rejected (not treated as the value)", () => {
    expect(() => parsePreMortemArgs(["PROJ-120", "--service", "--json"])).toThrow();
  });
});

describe("runPreMortemCommand", () => {
  // `PreMortemCommandDeps.runAgentBriefCli` is generic, so the fake is declared as a generic
  // arrow and needs no cast — mirrors `owners.test.ts`'s `recordingDeps`.
  function recordingDeps(sink: { params?: Record<string, unknown> }): PreMortemCommandDeps {
    return {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        sink.params = spec.params;
      },
    };
  }

  // `toStrictEqual`, not `toEqual`: bun's `toEqual` ignores keys whose value is `undefined`, so
  // `{ epicRef: "x", services: undefined }` would pass against `{ epicRef: "x" }` under `toEqual`
  // — proving nothing about whether the key was actually omitted from the wire params.
  test("sends only epicRef when no --service/--repropose were given", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runPreMortemCommand(["PROJ-120"], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ epicRef: "PROJ-120" });
  });

  test("sends the services array and repropose:true only when the flags were given", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runPreMortemCommand(
      ["PROJ-120", "--service", "acme/billing", "--repropose"],
      recordingDeps(sink),
    );
    expect(sink.params).toStrictEqual({
      epicRef: "PROJ-120",
      services: ["acme/billing"],
      repropose: true,
    });
  });

  test("kind is 'premortem' and the guard accepts a well-formed brief, rejects a malformed one", async () => {
    const sink: { guard?: (x: unknown) => boolean; kind?: string } = {};
    await runPreMortemCommand(["PROJ-120"], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        sink.guard = spec.guard as (x: unknown) => boolean;
        sink.kind = spec.kind;
      },
    });
    expect(sink.kind).toBe("premortem");
    expect(sink.guard?.({ kind: "premortem", gaps: [] })).toBe(true);
    expect(sink.guard?.({ kind: "premortem", gaps: ["no theme pass has run yet"] })).toBe(true);
    // wrong kind
    expect(sink.guard?.({ kind: "decisions", gaps: [] })).toBe(false);
    // gaps not an array
    expect(sink.guard?.({ kind: "premortem", gaps: "nope" })).toBe(false);
    // not an object at all
    expect(sink.guard?.(null)).toBe(false);
    expect(sink.guard?.("nope")).toBe(false);
  });

  test("no --refresh never sets beforeCall", async () => {
    let beforeCallSeen = false;
    await runPreMortemCommand(["PROJ-120"], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        beforeCallSeen = spec.beforeCall !== undefined;
      },
    });
    expect(beforeCallSeen).toBe(false);
  });
});

describe("runPreMortemCommand — --refresh dispatch (DI, no mock.module)", () => {
  // `premortem.refresh` (unlike `ownership.refresh`) is NOT job-based: it is a bare RPC call
  // awaited directly, never a `{ jobId }` + notification wait. So this proves the call shape and
  // await ordering, not a notification handshake.
  test("--refresh calls premortem.refresh with no params, genuinely awaited before returning", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    let refreshSettled = false;
    const fakeClient = {
      call: async (method: string, params: unknown): Promise<unknown> => {
        calls.push({ method, params });
        // A real microtask hop: if `beforeCall` did NOT await this promise, the assertion
        // below would observe `refreshSettled === false`.
        await Promise.resolve();
        refreshSettled = true;
        return { scanned: 1, themesWritten: 0, demoted: 0, prunedEvidence: 0, llmCalls: 0 };
      },
    } as unknown as IPCClient;

    await runPreMortemCommand(["PROJ-120", "--refresh"], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        await spec.beforeCall(fakeClient);
        expect(refreshSettled).toBe(true);
      },
    });
    expect(calls).toEqual([{ method: "premortem.refresh", params: {} }]);
  });

  test("a failed premortem.refresh RPC call rejects (not silently swallowed)", async () => {
    const fakeClient = {
      call: async (): Promise<never> => {
        throw new Error("ERR_PREMORTEM_PASS_RUNNING: a pre-mortem pass is already running");
      },
    } as unknown as IPCClient;
    const deps: PreMortemCommandDeps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        await spec.beforeCall(fakeClient);
      },
    };
    await expect(runPreMortemCommand(["PROJ-120", "--refresh"], deps)).rejects.toThrow(
      "ERR_PREMORTEM_PASS_RUNNING",
    );
  });
});
