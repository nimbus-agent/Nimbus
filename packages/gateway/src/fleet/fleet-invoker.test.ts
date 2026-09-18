import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SynthesisRouter } from "../agents/_lib/synthesis-llm.ts";
import type { NimbusFleetJobToml } from "../config/fleet-toml.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { ResolvedSynthesisProvider } from "../llm/router.ts";
import {
  buildDefaultFleetDispatch,
  buildFleetInvoker,
  DEFAULT_JOB_TIMEOUT_MS,
  type FleetDispatchContext,
  type FleetInvokerDeps,
} from "./fleet-invoker.ts";
import { createFleetRemoteBudget } from "./fleet-synthesis-router.ts";

/**
 * Deliberately WIDER than `FleetDispatch`: a test double should not have to name the production
 * context type to stand in for it. That it is assignable at all is itself part of what this file
 * checks — the seam typechecks with no assertion on either side.
 */
type FleetInvokerTestDispatch = (
  method: string,
  params: unknown,
  ctx: { notify: (m: string, p: unknown) => void; caller?: { clientId: string; kind: string } },
) => Promise<unknown>;

function deps(dispatch: FleetInvokerTestDispatch): FleetInvokerDeps {
  return {
    db: new Database(":memory:"),
    router: undefined,
    budget: createFleetRemoteBudget(false, 0),
    timeoutMs: 50,
    dispatch,
  };
}

const JOB: NimbusFleetJobToml = {
  name: "j",
  agent: "catchup",
  intervalSeconds: 1,
  params: {},
  digestMinDelta: 1,
  sweep: null,
};

describe("buildFleetInvoker", () => {
  test("resolves only after briefReady, not when dispatch returns", async () => {
    const order: string[] = [];
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        order.push("dispatch-returned");
        setTimeout(() => {
          order.push("brief-notified");
          ctx.notify("catchup.briefReady", {
            sessionId: "s1",
            brief: "# hi",
            findings: { a: 1 },
            synthesis: null,
          });
        }, 5);
        return { sessionId: "s1" };
      }),
    );
    const out = await invoke(JOB);
    order.push("invoke-resolved");
    // The whole point: dispatch returning is NOT the job finishing.
    // `order` alone must be able to go red: a bare `await dispatch(...)` implementation resolves
    // BEFORE the notification is emitted, so it produces ["dispatch-returned", "invoke-resolved"]
    // and the middle element is missing. Without the emission recorded here, both implementations
    // append in the same order and the assertion proves nothing.
    expect(order).toEqual(["dispatch-returned", "brief-notified", "invoke-resolved"]);
    expect(out).toEqual({
      status: "done",
      briefMarkdown: "# hi",
      findingsJson: JSON.stringify({ a: 1 }),
      synthesisJson: null,
    });
  });

  test("a notification that arrives BEFORE dispatch returns is replayed, not dropped", async () => {
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        // Synchronous emitter: the sessionId is not known to the invoker yet.
        ctx.notify("catchup.briefReady", {
          sessionId: "s1",
          brief: "early",
          findings: { ok: true },
          synthesis: { provider: "local" },
        });
        return { sessionId: "s1" };
      }),
    );
    expect(await invoke(JOB)).toEqual({
      status: "done",
      briefMarkdown: "early",
      findingsJson: JSON.stringify({ ok: true }),
      synthesisJson: JSON.stringify({ provider: "local" }),
    });
  });

  test("briefError settles as failed", async () => {
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        ctx.notify("catchup.briefError", { sessionId: "s1", error: "boom" });
        return { sessionId: "s1" };
      }),
    );
    expect(await invoke(JOB)).toEqual({ status: "failed", error: "boom" });
  });

  test("a briefError with no readable message still settles", async () => {
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        ctx.notify("catchup.briefError", { sessionId: "s1" });
        return { sessionId: "s1" };
      }),
    );
    expect(await invoke(JOB)).toEqual({ status: "failed", error: "unknown error" });
  });

  test("a brief that never arrives times out rather than wedging the fleet", async () => {
    const invoke = buildFleetInvoker(deps(async () => ({ sessionId: "s1" })));
    const out = await invoke(JOB);
    expect(out.status).toBe("failed");
    expect("error" in out && out.error).toMatch(/timed out/);
  });

  test("a notification for a DIFFERENT sessionId is ignored", async () => {
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        ctx.notify("catchup.briefReady", { sessionId: "other", brief: "x", findings: {} });
        return { sessionId: "s1" };
      }),
    );
    expect((await invoke(JOB)).status).toBe("failed"); // times out; the stray notify did not settle it
  });

  test("an unrelated notification method for the right session is ignored", async () => {
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        ctx.notify("catchup.progress", { sessionId: "s1" });
        return { sessionId: "s1" };
      }),
    );
    expect((await invoke(JOB)).status).toBe("failed"); // times out
  });

  test("an ineligible agent is refused before any dispatch", async () => {
    let dispatched = false;
    const invoke = buildFleetInvoker(
      deps(async () => {
        dispatched = true;
        return { sessionId: "s" };
      }),
    );
    const out = await invoke({ ...JOB, agent: "premortem" });
    expect(out).toEqual({ status: "failed", error: "agent not fleet-eligible: premortem" });
    expect(dispatched).toBe(false);
  });

  test("an unknown agent name is refused too", async () => {
    const invoke = buildFleetInvoker(deps(async () => ({ sessionId: "s" })));
    expect(await invoke({ ...JOB, agent: "constructor" })).toEqual({
      status: "failed",
      error: "agent not fleet-eligible: constructor",
    });
  });

  test("the caller kind is fleet and the clientId is the job name", async () => {
    let seen: { clientId: string; kind: string } | undefined;
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        seen = ctx.caller;
        ctx.notify("catchup.briefReady", { sessionId: "s1", brief: "x", findings: {} });
        return { sessionId: "s1" };
      }),
    );
    await invoke(JOB);
    expect(seen).toEqual({ clientId: "j", kind: "fleet" });
  });

  test("the resolved method and the job params reach dispatch verbatim", async () => {
    let seenMethod: string | undefined;
    let seenParams: unknown;
    const invoke = buildFleetInvoker(
      deps(async (m, p, ctx) => {
        seenMethod = m;
        seenParams = p;
        ctx.notify("catchup.briefReady", { sessionId: "s1", brief: "x", findings: {} });
        return { sessionId: "s1" };
      }),
    );
    await invoke({ ...JOB, params: { sinceMs: 3600000 } });
    expect(seenMethod).toBe("agents.catchup");
    expect(seenParams).toEqual({ sinceMs: 3600000 });
  });

  test("a dispatch that returns no sessionId fails rather than waiting for a notification", async () => {
    const invoke = buildFleetInvoker(deps(async () => ({})));
    // The MESSAGE is what distinguishes this from the timeout path, and it is a fact about the
    // code rather than about the machine. A wall-clock bound was tried here and removed: CI
    // runners are 13-18x slower than a dev box at scheduling work, so a "settled in under 50ms"
    // assertion fails there for reasons unrelated to this code.
    expect(await invoke(JOB)).toEqual({
      status: "failed",
      error: "agent catchup returned no sessionId",
    });
  });

  test("a thrown dispatch settles as failed with the error message", async () => {
    const invoke = buildFleetInvoker(
      deps(async () => {
        throw new Error("index locked");
      }),
    );
    expect(await invoke(JOB)).toEqual({ status: "failed", error: "index locked" });
  });

  test("a non-Error throw is stringified rather than lost", async () => {
    const invoke = buildFleetInvoker(
      deps(async () => {
        // A connector or agent can reject with a non-Error; the outcome must still carry a message.
        throw "nope";
      }),
    );
    expect(await invoke(JOB)).toEqual({ status: "failed", error: "nope" });
  });

  test("a briefReady with no markdown records a null body rather than failing", async () => {
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        ctx.notify("catchup.briefReady", { sessionId: "s1" });
        return { sessionId: "s1" };
      }),
    );
    expect(await invoke(JOB)).toEqual({
      status: "done",
      briefMarkdown: null,
      findingsJson: "{}",
      synthesisJson: null,
    });
  });

  // There is deliberately NO test that a second notification arriving after the outcome is settled
  // "changes nothing". Such a test cannot fail: a second `resolve()` on an already-resolved promise
  // is a no-op whether or not the `settled` guard exists, so the assertion would be green with the
  // guard deleted. The guard's effect is not observable from outside this module, and a green
  // assertion that proves nothing is worse than an acknowledged gap. What IS observable is the
  // order the queued notifications are replayed in, which the next test pins.

  test("the FIRST of two queued notifications wins the outcome", async () => {
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        // Both emitted BEFORE dispatch returns, so both are queued and replayed together.
        ctx.notify("catchup.briefReady", { sessionId: "s1", brief: "first", findings: {} });
        ctx.notify("catchup.briefError", { sessionId: "s1", error: "late" });
        return { sessionId: "s1" };
      }),
    );
    // Fails if the replay ever stops being FIFO — the outcome would become the error.
    expect(await invoke(JOB)).toEqual({
      status: "done",
      briefMarkdown: "first",
      findingsJson: "{}",
      synthesisJson: null,
    });
  });

  test("index, configDir and a router are all threaded through, and the router is WRAPPED", async () => {
    const db = new Database(":memory:");
    let sawRunner = false;
    let resolveCalls = 0;
    let generateCalls = 0;
    // I38: whatever the invoker builds the runner with must be the WRAPPED router.
    //
    // `generateCalls` is the assertion that can actually go red, and it needs BOTH of the
    // conditions below to be meaningful:
    //
    //   * the provider must be NON-LOCAL — the wrapper passes a local one through untouched;
    //   * `[agents] synthesis` must be "allow-remote" — under the DEFAULT "local",
    //     `synthesis-llm.ts` refuses a remote provider on its own, so `generateMarkdown` goes
    //     uncalled with the RAW router too and the assertion would be green either way.
    //
    // With both in place: the WRAPPED router withholds the provider (allow_remote = false), so the
    // runner falls back to the deterministic render and never generates; the RAW router hands the
    // provider over and the runner calls `generateMarkdown`. `sawRunner`, `resolveCalls` and
    // `status` are identical on both paths and so cannot tell them apart.
    const configDir = mkdtempSync(join(tmpdir(), "nimbus-fleet-invoker-"));
    writeFileSync(join(configDir, "nimbus.toml"), `[agents]\nsynthesis = "allow-remote"\n`, "utf8");
    const router: SynthesisRouter = {
      resolveForSynthesis: async (_preferLocal?: boolean) => {
        resolveCalls += 1;
        return { isLocal: false, providerId: "anthropic", modelName: "m" };
      },
      generateMarkdown: async () => {
        generateCalls += 1;
        return "unused";
      },
    };
    const invoke = buildFleetInvoker({
      db,
      router,
      budget: createFleetRemoteBudget(false, 0),
      index: new LocalIndex(db),
      configDir,
      // No timeoutMs: the DEFAULT applies, and the job still settles on the notification.
      dispatch: async (_m, _p, ctx) => {
        sawRunner = ctx.runner !== undefined;
        if (ctx.runner?.run !== undefined) {
          // Reaching the router THROUGH the runner is what proves the wrap is on the live path.
          await ctx.runner.run("summarise this brief");
        }
        ctx.notify("catchup.briefReady", { sessionId: "s1", brief: "x", findings: {} });
        return { sessionId: "s1" };
      },
    });
    expect((await invoke(JOB)).status).toBe("done");
    expect(sawRunner).toBe(true);
    expect(resolveCalls).toBeGreaterThan(0);
    // The load-bearing one: a raw router would have reached the model.
    expect(generateCalls).toBe(0);
  });

  test("the default dispatch UNWRAPS the RpcMissOrHit envelope", async () => {
    // The envelope is why `dispatchAgentsRpc` cannot be handed to the seam directly: the sessionId
    // sits under `.value`. Reading it off the envelope would fail every production run.
    const invoke = buildFleetInvoker({
      db: new Database(":memory:"),
      router: undefined,
      budget: createFleetRemoteBudget(false, 0),
      timeoutMs: 50,
      dispatch: buildDefaultFleetDispatch(async (_m, _p, ctx) => {
        ctx.notify("catchup.briefReady", { sessionId: "s1", brief: "unwrapped", findings: {} });
        // The ENVELOPE, deliberately — this is the one test whose subject is the unwrapping, so
        // the inner dispatcher must return what `dispatchAgentsRpc` really returns.
        return { kind: "hit", value: { sessionId: "s1" } };
      }),
    });
    expect(await invoke(JOB)).toEqual({
      status: "done",
      briefMarkdown: "unwrapped",
      findingsJson: "{}",
      synthesisJson: null,
    });
  });

  test("the default dispatch throws loudly on a miss rather than waiting out the timeout", async () => {
    const dispatch = buildDefaultFleetDispatch(async () => ({ kind: "miss" }));
    const ctx: FleetDispatchContext = {
      db: new Database(":memory:"),
      notify: () => {},
      caller: { clientId: "j", kind: "fleet" },
    };
    // Structurally unreachable through `buildFleetInvoker` — `resolveFleetAgentMethod` and
    // `dispatchByMethod` read the SAME handler map — which is exactly why it is exercised here.
    await expect(dispatch("agents.catchup", {}, ctx)).rejects.toThrow(/not served/);
  });

  test("a miss surfaces as a failed outcome, not a hang", async () => {
    const invoke = buildFleetInvoker({
      db: new Database(":memory:"),
      router: undefined,
      budget: createFleetRemoteBudget(false, 0),
      timeoutMs: 50,
      dispatch: buildDefaultFleetDispatch(async () => ({ kind: "miss" })),
    });
    const out = await invoke(JOB);
    expect(out).toEqual({ status: "failed", error: "agent method not served: agents.catchup" });
  });

  test("the default timeout is bounded but generous", () => {
    expect(DEFAULT_JOB_TIMEOUT_MS).toBe(600_000);
  });
});

describe("per-brief remote-withholding disclosure (I38)", () => {
  // I38's row claimed budget exhaustion is disclosed per brief. It was not: the wrapper withholds
  // the provider and `synthesis-llm.ts` reports `no_eligible_provider` with no detail — the same
  // answer a machine with no model configured gets. These pin the fleet-local disclosure that
  // closes it without widening `SynthesisAttempt`.
  const ready = (sessionId: string, synthesis: unknown) => ({
    sessionId,
    brief: "# b",
    findings: {},
    synthesis,
  });

  test("a withholding during the job lands on that brief's provenance", async () => {
    const budget = createFleetRemoteBudget(false, 0);
    const invoke = buildFleetInvoker({
      db: new Database(":memory:"),
      router: undefined,
      budget,
      timeoutMs: 50,
      dispatch: async (_m, _p, ctx) => {
        budget.noteWithheld(); // what wrapFleetSynthesisRouter does when it refuses a remote provider
        ctx.notify("catchup.briefReady", ready("s1", { attempted: false }));
        return { sessionId: "s1" };
      },
    });
    const out = await invoke(JOB);
    expect(out.status).toBe("done");
    const s = JSON.parse((out as { synthesisJson: string }).synthesisJson) as Record<
      string,
      number
    >;
    expect(s["fleetRemoteWithheld"]).toBe(1);
  });

  test("no withholding leaves the provenance untouched", async () => {
    // A `null` synthesis alone would NOT discriminate — it stays null through `readReady`'s
    // pre-existing path whether or not the disclosure exists. The non-null case is what proves the
    // provenance is passed through unmodified rather than merely absent.
    const invoke = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        ctx.notify("catchup.briefReady", ready("s1", null));
        return { sessionId: "s1" };
      }),
    );
    expect(((await invoke(JOB)) as { synthesisJson: string | null }).synthesisJson).toBeNull();

    const withProv = buildFleetInvoker(
      deps(async (_m, _p, ctx) => {
        ctx.notify("catchup.briefReady", ready("s1", { attempted: true, model: "qwen" }));
        return { sessionId: "s1" };
      }),
    );
    const out = await withProv(JOB);
    expect(JSON.parse((out as { synthesisJson: string }).synthesisJson)).toEqual({
      attempted: true,
      model: "qwen",
    });
  });

  test("the count is this JOB's delta, not the run's running total", async () => {
    // The budget is per-RUN and spans several jobs. Reading the raw counter would attribute an
    // earlier job's refusals to this brief — the same per-run-vs-per-item confusion that made
    // `remote_calls_made` a false record before it was fixed.
    const budget = createFleetRemoteBudget(false, 0);
    budget.noteWithheld();
    budget.noteWithheld(); // two refusals from an EARLIER job in the same run
    const invoke = buildFleetInvoker({
      db: new Database(":memory:"),
      router: undefined,
      budget,
      timeoutMs: 50,
      dispatch: async (_m, _p, ctx) => {
        budget.noteWithheld(); // exactly one belongs to THIS job
        ctx.notify("catchup.briefReady", ready("s1", { attempted: false }));
        return { sessionId: "s1" };
      },
    });
    const out = await invoke(JOB);
    const s = JSON.parse((out as { synthesisJson: string }).synthesisJson) as Record<
      string,
      number
    >;
    expect(s["fleetRemoteWithheld"]).toBe(1);
  });
});

describe("COMPOSED I38 path — invoker → wrapped router → real synthesis runner", () => {
  // Closes most of the bound the I38 row recorded. The two doors and the budget were exercised
  // against the WRAPPER, and the invoker was separately proven to build its runner with the wrapper
  // — but "proven separately" is not "proven composed". This drives the runner the invoker actually
  // built, through `ctx.runner`, so door 1, the budget and the disclosure are exercised together.
  const REMOTE: ResolvedSynthesisProvider = {
    providerId: "anthropic",
    modelName: "opus",
    isLocal: false,
  };

  function allowRemoteConfigDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "fleet-composed-"));
    // Without this the DEFAULT `synthesis = "local"` refuses a remote provider on its own, and the
    // assertions below would hold for a reason unrelated to the fleet wrapper.
    writeFileSync(join(dir, "nimbus.toml"), '[agents]\nsynthesis = "allow-remote"\n');
    return dir;
  }

  test("the budget is spent through the REAL runner, and the second job is disclosed", async () => {
    const generated: string[] = [];
    const router: SynthesisRouter = {
      resolveForSynthesis: async () => REMOTE,
      generateMarkdown: async (_p, provider) => {
        generated.push(provider.providerId);
        return "# synthesised";
      },
    };
    const budget = createFleetRemoteBudget(true, 1); // exactly one remote call for the run
    const configDir = allowRemoteConfigDir();

    const invoke = buildFleetInvoker({
      db: new Database(":memory:"),
      router,
      budget,
      configDir,
      timeoutMs: 200,
      dispatch: async (_m, _p, ctx) => {
        // The runner the INVOKER built — `buildAgentSynthesisRunner` over the wrapped router.
        if (ctx.runner !== undefined) await ctx.runner.run("prompt");
        ctx.notify("catchup.briefReady", {
          sessionId: "s1",
          brief: "# b",
          findings: {},
          synthesis: { attempted: true },
        });
        return { sessionId: "s1" };
      },
    });

    // First job: the budget covers it, so the remote provider is used for real.
    const first = await invoke(JOB);
    expect(first.status).toBe("done");
    expect(generated).toEqual(["anthropic"]);
    expect(budget.spent()).toBe(1);
    expect(JSON.parse((first as { synthesisJson: string }).synthesisJson)).not.toHaveProperty(
      "fleetRemoteWithheld",
    );

    // Second job, same run: the budget is spent, so door 1 withholds and the brief says so.
    const second = await invoke(JOB);
    expect(second.status).toBe("done");
    expect(generated).toEqual(["anthropic"]); // no second remote call
    const s = JSON.parse((second as { synthesisJson: string }).synthesisJson) as Record<
      string,
      number
    >;
    expect(s["fleetRemoteWithheld"]).toBe(1);
  });

  test("with allow_remote false the real runner never reaches a remote provider", async () => {
    const generated: string[] = [];
    const router: SynthesisRouter = {
      resolveForSynthesis: async () => REMOTE,
      generateMarkdown: async (_p, provider) => {
        generated.push(provider.providerId);
        return "# nope";
      },
    };
    const invoke = buildFleetInvoker({
      db: new Database(":memory:"),
      router,
      budget: createFleetRemoteBudget(false, 0),
      configDir: allowRemoteConfigDir(),
      timeoutMs: 200,
      dispatch: async (_m, _p, ctx) => {
        if (ctx.runner !== undefined) await ctx.runner.run("prompt");
        ctx.notify("catchup.briefReady", {
          sessionId: "s1",
          brief: "# b",
          findings: {},
          synthesis: { attempted: true },
        });
        return { sessionId: "s1" };
      },
    });
    const out = await invoke(JOB);
    expect(generated).toEqual([]); // the invariant, through the composed path
    const s = JSON.parse((out as { synthesisJson: string }).synthesisJson) as Record<
      string,
      number
    >;
    expect(s["fleetRemoteWithheld"]).toBe(1);
  });
});
