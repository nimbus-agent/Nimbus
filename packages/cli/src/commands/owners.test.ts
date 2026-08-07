import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import type { AgentBriefCliSpec } from "./_agent-brief-cli.ts";
import { type OwnersCommandDeps, parseOwnersArgs, runOwnersCommand } from "./owners.ts";

describe("parseOwnersArgs", () => {
  test("a bare path becomes the path param", () => {
    expect(parseOwnersArgs(["src/a.ts"])).toEqual({
      path: "src/a.ts",
      service: undefined,
      json: false,
      refresh: false,
    });
  });

  test("--service sets the service param", () => {
    expect(parseOwnersArgs(["--service", "checkout"]).service).toBe("checkout");
  });

  test("no args is summary mode", () => {
    expect(parseOwnersArgs([])).toEqual({
      path: undefined,
      service: undefined,
      json: false,
      refresh: false,
    });
  });

  test("--json and --refresh are flags", () => {
    const p = parseOwnersArgs(["src/a.ts", "--json", "--refresh"]);
    expect(p.json).toBe(true);
    expect(p.refresh).toBe(true);
  });

  test("a path plus --service is rejected", () => {
    expect(() => parseOwnersArgs(["src/a.ts", "--service", "checkout"])).toThrow(
      /mutually exclusive/,
    );
  });

  test("an unrecognised flag is rejected, not ignored", () => {
    expect(() => parseOwnersArgs(["--nope"])).toThrow();
  });

  test("a second positional argument is rejected", () => {
    expect(() => parseOwnersArgs(["src/a.ts", "src/b.ts"])).toThrow(/Unexpected argument/);
  });
});

describe("runOwnersCommand", () => {
  // `OwnersCommandDeps.runAgentBriefCli` is generic, so the fake is declared as a generic
  // arrow and needs no cast. If it will not typecheck as written, report NEEDS_CONTEXT
  // rather than reaching for `as unknown as` — a cast here would hide a real signature
  // mismatch between the fake and the seam it stands in for.
  function recordingDeps(sink: { params?: Record<string, unknown> }): OwnersCommandDeps {
    return {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        sink.params = spec.params;
      },
    };
  }

  // `toStrictEqual`, not `toEqual`: bun's (like Jest's) `toEqual` ignores keys whose
  // value is `undefined`, so `{ path: "x", service: undefined }` would pass against
  // `{ path: "x" }` under `toEqual` — proving nothing about whether the key was
  // actually omitted. `toStrictEqual` distinguishes a missing key from a
  // present-but-undefined one, which is exactly what the gateway's validator does.
  test("sends path and never sends an undefined service key", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runOwnersCommand(["src/a.ts"], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ path: "src/a.ts" });
  });

  test("summary mode sends an empty param object", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runOwnersCommand([], recordingDeps(sink));
    expect(sink.params).toStrictEqual({});
  });

  test("--service sends service and no path key", async () => {
    const sink: { params?: Record<string, unknown> } = {};
    await runOwnersCommand(["--service", "checkout"], recordingDeps(sink));
    expect(sink.params).toStrictEqual({ service: "checkout" });
  });

  test("kind is 'ownership' and the guard accepts a well-formed brief, rejects a malformed one", async () => {
    const sink: { guard?: (x: unknown) => boolean; kind?: string } = {};
    await runOwnersCommand([], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        sink.guard = spec.guard as (x: unknown) => boolean;
        sink.kind = spec.kind;
      },
    });
    expect(sink.kind).toBe("ownership");
    expect(sink.guard?.({ kind: "ownership", gaps: [] })).toBe(true);
    expect(sink.guard?.({ kind: "ownership", gaps: ["a file with no owner"] })).toBe(true);
    // wrong kind
    expect(sink.guard?.({ kind: "decisions", gaps: [] })).toBe(false);
    // gaps not an array
    expect(sink.guard?.({ kind: "ownership", gaps: "nope" })).toBe(false);
    // not an object at all
    expect(sink.guard?.(null)).toBe(false);
    expect(sink.guard?.("nope")).toBe(false);
  });

  test("no --refresh never sets beforeCall", async () => {
    let beforeCallSeen = false;
    await runOwnersCommand([], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        beforeCallSeen = spec.beforeCall !== undefined;
      },
    });
    expect(beforeCallSeen).toBe(false);
  });
});

/**
 * Duck-typed fake matching the handful of `IPCClient` members `owners.ts`'s `awaitPass`
 * actually calls. DI, not `mock.module` — mirrors `decisions.test.ts`'s `makeFakeIpcClient`
 * so this file cannot leak into other files in the combined `bun test packages/cli/src` run.
 */
function makeFakeIpcClient(): {
  client: IPCClient;
  calls: Array<{ method: string; params: unknown }>;
  fire: (method: string, params: unknown) => void;
  fireClose: (err: Error) => void;
  liveHandlers: () => number;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const closeHandlers = new Set<(err: Error) => void>();
  const fake = {
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return { jobId: "job1" };
    },
    onNotification: (method: string, handler: (params: unknown) => void): void => {
      const set = handlers.get(method) ?? new Set<(params: unknown) => void>();
      set.add(handler);
      handlers.set(method, set);
    },
    offNotification: (method: string, handler: (params: unknown) => void): void => {
      handlers.get(method)?.delete(handler);
    },
    onClose: (handler: (err: Error) => void): void => {
      closeHandlers.add(handler);
    },
    offClose: (handler: (err: Error) => void): void => {
      closeHandlers.delete(handler);
    },
  };
  const fire = (method: string, params: unknown): void => {
    for (const handler of [...(handlers.get(method) ?? [])]) handler(params);
  };
  const fireClose = (err: Error): void => {
    for (const handler of [...closeHandlers]) handler(err);
  };
  const liveHandlers = (): number => {
    let n = closeHandlers.size;
    for (const set of handlers.values()) n += set.size;
    return n;
  };
  return { client: fake as unknown as IPCClient, calls, fire, fireClose, liveHandlers };
}

describe("runOwnersCommand — --refresh dispatch (DI, no mock.module)", () => {
  test("--refresh calls ownership.refresh and awaits passDone before the brief call", async () => {
    const { client, calls, fire } = makeFakeIpcClient();
    let briefCalledAfterDone = false;
    await runOwnersCommand(["--refresh"], {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        fire("ownership.passDone", {});
        await passWait;
        briefCalledAfterDone = true;
      },
    });
    expect(calls).toEqual([{ method: "ownership.refresh", params: {} }]);
    expect(briefCalledAfterDone).toBe(true);
  });
});

describe("awaitPass (via --refresh) — transport death and handler teardown", () => {
  test("a gateway death mid-pass rejects instead of hanging forever", async () => {
    const { client, fireClose } = makeFakeIpcClient();
    const deps: OwnersCommandDeps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        fireClose(new Error("IPC connection closed"));
        await Promise.race([
          passWait,
          Bun.sleep(250).then(() => {
            throw new Error("awaitPass never settled after the transport closed — it hung");
          }),
        ]);
      },
    };
    await expect(runOwnersCommand(["--refresh"], deps)).rejects.toThrow(
      "gateway connection closed during the pass",
    );
  });

  test("an ownership.passError notification rejects with its message", async () => {
    const { client, fire } = makeFakeIpcClient();
    const deps: OwnersCommandDeps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        fire("ownership.passError", { message: "boom" });
        await passWait;
      },
    };
    await expect(runOwnersCommand(["--refresh"], deps)).rejects.toThrow("boom");
  });

  test("an ownership.passError notification with no message falls back to a default", async () => {
    const { client, fire } = makeFakeIpcClient();
    const deps: OwnersCommandDeps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        fire("ownership.passError", {});
        await passWait;
      },
    };
    await expect(runOwnersCommand(["--refresh"], deps)).rejects.toThrow("ownership pass failed");
  });

  test("a failed ownership.refresh RPC call rejects (not silently hangs)", async () => {
    const { client } = makeFakeIpcClient();
    (client as unknown as { call: () => Promise<never> }).call = async (): Promise<never> => {
      throw new Error("rpc unreachable");
    };
    const deps: OwnersCommandDeps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        await spec.beforeCall(client);
      },
    };
    await expect(runOwnersCommand(["--refresh"], deps)).rejects.toThrow("rpc unreachable");
  });

  test("removes every handler once the pass settles", async () => {
    const { client, fire, liveHandlers } = makeFakeIpcClient();
    let liveDuringPass = 0;
    const deps: OwnersCommandDeps = {
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        if (spec.beforeCall === undefined) return;
        const passWait = spec.beforeCall(client);
        liveDuringPass = liveHandlers();
        fire("ownership.passDone", {});
        await passWait;
      },
    };
    await runOwnersCommand(["--refresh"], deps);
    expect(liveDuringPass).toBeGreaterThan(0);
    expect(liveHandlers()).toBe(0);
  });
});
