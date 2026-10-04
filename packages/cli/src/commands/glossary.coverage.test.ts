import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { isolatePlatformEnv } from "../../test/helpers/isolate-platform-env.ts";
import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import type { IPCClient } from "../ipc-client/index.ts";
import { CliExit } from "../lib/cli-exit.ts";
import type { AgentBriefCliSpec } from "./_agent-brief-cli.ts";
import { type GlossaryCommandDeps, readRebuildPreview, runGlossaryCommand } from "./glossary.ts";

/**
 * Branches `glossary.test.ts` leaves unexercised, all through the command's own DI seam: in-place
 * progress on a terminal (and its absence off one), a pass that errors or whose start call fails,
 * `--rebuild --yes`, the brief params, and the preview's remaining malformed-payload shapes.
 */

const DONE = {
  consolidated: 2,
  upgraded: 0,
  upgradesVetoed: 0,
  vetoedTerms: [] as string[],
  retried: 0,
  llmConfigured: false,
  llmProduced: false,
};

interface FakeClient {
  readonly client: IPCClient;
  readonly calls: Array<{ method: string; params: unknown }>;
  fire(method: string, params: unknown): void;
  liveHandlers(): number;
}

function fakeClient(callImpl?: (method: string) => Promise<unknown>): FakeClient {
  const calls: Array<{ method: string; params: unknown }> = [];
  const handlers = new Map<string, Set<(params: unknown) => void>>();
  const closeHandlers = new Set<(err: Error) => void>();
  const client = {
    call: async (method: string, params: unknown): Promise<unknown> => {
      calls.push({ method, params });
      return callImpl === undefined ? { jobId: "job-1" } : callImpl(method);
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
  return {
    client: client as unknown as IPCClient,
    calls,
    fire: (method, params) => {
      for (const h of [...(handlers.get(method) ?? [])]) h(params);
    },
    liveHandlers: () => {
      let n = closeHandlers.size;
      for (const set of handlers.values()) n += set.size;
      return n;
    },
  };
}

/**
 * Deps whose `runAgentBriefCli` records the spec and runs its `beforeCall` (the pass), letting
 * `during` drive notifications while the pass waits.
 */
function passDeps(
  fake: FakeClient,
  during: (f: FakeClient) => void,
): { deps: GlossaryCommandDeps; specs: Array<AgentBriefCliSpec<unknown>> } {
  const specs: Array<AgentBriefCliSpec<unknown>> = [];
  return {
    specs,
    deps: {
      withGatewayIpc: async <T>(fn: (c: IPCClient) => Promise<T>): Promise<T> => fn(fake.client),
      runAgentBriefCli: async <T>(spec: AgentBriefCliSpec<T>): Promise<void> => {
        specs.push(spec as AgentBriefCliSpec<unknown>);
        if (spec.beforeCall === undefined) return;
        const pass = spec.beforeCall(fake.client);
        during(fake);
        await pass;
      },
    },
  };
}

const cap = createStreamCapture();
let ttyDesc: PropertyDescriptor | undefined;
beforeEach(() => {
  ttyDesc = Object.getOwnPropertyDescriptor(process.stderr, "isTTY");
  cap.stdoutChunks.length = 0;
  cap.stderrChunks.length = 0;
  cap.install();
});
afterEach(() => {
  cap.restore();
  if (ttyDesc === undefined) delete (process.stderr as unknown as { isTTY?: boolean }).isTTY;
  else Object.defineProperty(process.stderr, "isTTY", ttyDesc);
});

function setStderrTty(value: boolean): void {
  Object.defineProperty(process.stderr, "isTTY", { value, configurable: true });
}

describe("--refresh pass progress", () => {
  test("on a terminal, progress rewrites one line in place and is closed before the summary", async () => {
    setStderrTty(true);
    const fake = fakeClient();
    const { deps } = passDeps(fake, (f) => {
      f.fire("glossary.passProgress", { done: 1, total: 3 });
      f.fire("glossary.passProgress", { done: 3, total: 3 });
      f.fire("glossary.passDone", DONE);
    });
    await runGlossaryCommand(["--refresh"], deps);
    expect(cap.stderrChunks).toEqual([
      "\r\u001b[K  consolidating 1/3",
      "\r\u001b[K  consolidating 3/3",
      "\n",
      "Pass complete: 2 new, 0 upgraded.\n",
    ]);
    expect(fake.calls[0]).toEqual({ method: "glossary.refresh", params: {} });
  });

  test("off a terminal, progress is dropped entirely — only the summary is written", async () => {
    setStderrTty(false);
    const fake = fakeClient();
    const { deps } = passDeps(fake, (f) => {
      f.fire("glossary.passProgress", { done: 1, total: 3 });
      f.fire("glossary.passDone", DONE);
    });
    await runGlossaryCommand(["--refresh"], deps);
    expect(cap.stderrChunks).toEqual(["Pass complete: 2 new, 0 upgraded.\n"]);
  });

  test("a passError rejects with the gateway's message and removes every handler", async () => {
    setStderrTty(true);
    const fake = fakeClient();
    const { deps } = passDeps(fake, (f) => {
      f.fire("glossary.passError", { message: "ERR_GLOSSARY_PASS_RUNNING: a pass is in flight" });
    });
    await expect(runGlossaryCommand(["--refresh"], deps)).rejects.toThrow(
      new Error("ERR_GLOSSARY_PASS_RUNNING: a pass is in flight"),
    );
    expect(fake.liveHandlers()).toBe(0);
    // No progress was drawn, so there is no progress line to terminate.
    expect(cap.stderrChunks).toEqual([]);
  });

  test("a start call that rejects with a non-Error becomes an Error carrying that text", async () => {
    const fake = fakeClient(async () => {
      throw "pass refused";
    });
    const { deps } = passDeps(fake, () => {});
    let caught: unknown;
    try {
      await runGlossaryCommand(["--refresh"], deps);
    } catch (e) {
      caught = e;
    }
    // Asserted by hand, not with `rejects.toThrow(new Error("pass refused"))`: Bun's matcher compares
    // only the message and also passes for a bare STRING with that text — exactly what an
    // un-normalised rejection would be, so it could never see the wrapping go missing.
    expect(caught).toBeInstanceOf(Error);
    expect((caught as Error).message).toBe("pass refused");
    expect(fake.liveHandlers()).toBe(0);
  });

  test("a start call that rejects with an Error propagates that same Error, not a re-wrap", async () => {
    const original = new Error("ERR_GLOSSARY_DISABLED");
    const fake = fakeClient(async () => {
      throw original;
    });
    const { deps } = passDeps(fake, () => {});
    let caught: unknown;
    try {
      await runGlossaryCommand(["--refresh"], deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(original);
    expect(fake.liveHandlers()).toBe(0);
  });

  test("--rebuild --yes runs the REBUILD pass, never a refresh", async () => {
    const fake = fakeClient();
    const { deps } = passDeps(fake, (f) => f.fire("glossary.passDone", DONE));
    await runGlossaryCommand(["--rebuild", "--yes"], deps);
    expect(fake.calls.map((c) => c.method)).toEqual(["glossary.rebuild"]);
  });
});

describe("runGlossaryCommand — brief parameters", () => {
  test("a term and a limit reach the agents.glossary params; no pass is attached", async () => {
    const fake = fakeClient();
    const { deps, specs } = passDeps(fake, () => {});
    await runGlossaryCommand(["Change", "Data", "--limit", "5", "--json"], deps);
    expect(specs).toHaveLength(1);
    expect(specs[0]?.kind).toBe("glossary");
    expect(specs[0]?.json).toBe(true);
    expect(specs[0]?.params).toEqual({ term: "Change Data", limit: 5 });
    expect(specs[0]?.beforeCall).toBeUndefined();
    expect(fake.calls).toEqual([]);
  });
});

describe("rebuild preview — remaining failure shapes", () => {
  test("a briefError whose params are null still rejects, with the generic message", async () => {
    const fake = fakeClient(async () => ({ sessionId: "s" }));
    const pending = readRebuildPreview(fake.client, 5_000);
    fake.fire("glossary.briefError", null);
    await expect(pending).rejects.toThrow(new Error("Agent failed"));
  });

  test("a briefReady whose findings are null or not an object is malformed", async () => {
    for (const findings of [null, 42]) {
      const fake = fakeClient(async () => ({ sessionId: "s" }));
      const pending = readRebuildPreview(fake.client, 5_000);
      fake.fire("glossary.briefReady", { findings });
      await expect(pending).rejects.toThrow(new Error("Malformed glossary.briefReady payload"));
    }
  });

  test("a non-Error preview failure is printed as-is and exits 2", async () => {
    const deps: GlossaryCommandDeps = {
      withGatewayIpc: async () => {
        throw "pipe broke";
      },
      runAgentBriefCli: async () => {
        throw new Error("must not run on the preview path");
      },
    };
    let caught: unknown;
    try {
      await runGlossaryCommand(["--rebuild"], deps);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(CliExit);
    expect((caught as CliExit).code).toBe(2);
    expect(cap.stderrChunks).toEqual(["pipe broke\n"]);
  });
});

describe("production defaults", () => {
  test("with no deps, a bad flag is refused before the gateway is ever consulted", async () => {
    const restoreEnv = isolatePlatformEnv(join(tmpdir(), "nimbus-glossary-cov-env-never-created"));
    try {
      await expect(runGlossaryCommand(["--bogus"])).rejects.toThrow(/^Unknown flag: --bogus/);
    } finally {
      restoreEnv();
    }
  });
});
