import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { CliExit } from "../lib/cli-exit.ts";
import type { LocalityReport } from "../lib/locality-panel.ts";
import { defaultTourRunners, type TourRunners } from "../lib/run-tour.ts";
import { GatewayNotRunningError } from "../lib/with-gateway-ipc.ts";
import type { CliPlatformPaths } from "../paths.ts";
import {
  type DemoDeps,
  DemoGatewayUnresponsiveError,
  type DemoSeedSummary,
  defaultDemoDeps,
  type FireDemoPageSummary,
  parseDemoArgs,
  runDemo,
  startDemoGateway,
} from "./demo.ts";
import type { ProveResult } from "./prove.ts";

const DEMO_DATA_DIR = join("demo-root", "data");

function demoPaths(): CliPlatformPaths {
  return {
    configDir: join("demo-root", "config"),
    dataDir: DEMO_DATA_DIR,
    logDir: join(DEMO_DATA_DIR, "logs"),
    socketPath: join("demo-root", "fake.sock"),
    extensionsDir: join(DEMO_DATA_DIR, "extensions"),
    tempDir: join("demo-root", "tmp"),
    sandboxDir: join("demo-root", "sandbox"),
    demo: true,
  };
}

/**
 * The three steps `demo.seed` now returns — the SAME `TourStep` shape `tour.plan` returns for
 * `nimbus wow`, built gateway-side by `tourStepFor(kind, candidate, true)`, so `command` carries
 * `--demo` and `args` never does.
 */
const SEED: DemoSeedSummary = {
  counts: { people: 5, items: 42 },
  tour: [
    {
      kind: "oncall",
      title: "On-call triage",
      command: "nimbus --demo oncall pushed",
      args: ["pushed"],
      reason: "the page that just fired",
    },
    {
      kind: "why",
      title: "Why this line changed",
      command: "nimbus --demo why src/retry/backoff.ts:42",
      args: ["src/retry/backoff.ts:42"],
      reason: "the capped-backoff line",
    },
    {
      kind: "owners",
      title: "Who owns this code",
      command: "nimbus --demo owners src/retry",
      args: ["src/retry"],
      reason: "bus factor 1",
    },
  ],
  t0: 1000,
};

/** A page that pushed exactly one brief — what `demo.firePage` returns on a healthy demo gateway. */
const PAGE: FireDemoPageSummary = {
  incidentId: "pagerduty:PDEMO412",
  push: { selected: 1, ok: 1, failed: 0 },
};

const LOCALITY: LocalityReport = {
  listeners: [{ name: "ipc", address: "npipe:...", loopback: true }],
  inventory: [{ service: "github", items: 10 }],
  db: { path: join("demo-root", "data", "nimbus.db"), bytes: 1024 },
  t1: 2000,
};

/** A verified, fully covered, zero-egress window — what a demo gateway must always report. */
function cleanProof(): ProveResult {
  return {
    rows: [],
    completeness: {
      coverage: {
        browser: "none",
        chatops: "none",
        mcp: "none",
        http: "none",
        task: "none",
        session: "none",
        sync: "none",
        model: "none",
        peer: "none",
      },
      outboundEgressEvents: 0,
      indeterminate: false,
    },
    verify: { ok: true, verifiedRows: 0 },
  };
}

function fakeDeps(overrides: Partial<DemoDeps> = {}): {
  deps: DemoDeps;
  calls: string[];
  out: string[];
  err: string[];
  proveWindows: Array<[number, number]>;
} {
  const calls: string[] = [];
  const out: string[] = [];
  const err: string[] = [];
  const proveWindows: Array<[number, number]> = [];
  // Every kind records its OWN name plus the argv it received, so the call log proves WHICH step
  // ran with WHICH arguments rather than only that "a runner" ran.
  const runners = Object.fromEntries(
    (["why", "owners", "oncall", "standup", "decisions", "glossary"] as const).map((kind) => [
      kind,
      async (args: string[]) => {
        calls.push(`${kind}(${args.join(" ")})`);
      },
    ]),
  ) as TourRunners;
  const deps: DemoDeps = {
    paths: () => demoPaths(),
    stop: async (p) => {
      calls.push(`stop`);
      void p;
      return "stopped";
    },
    removeDir: (dir) => {
      calls.push(`removeDir(${dir})`);
    },
    start: async () => {
      calls.push("start");
      return true;
    },
    seed: async (p) => {
      calls.push("seed");
      void p;
      return SEED;
    },
    firePage: async (p) => {
      calls.push("firePage");
      void p;
      return PAGE;
    },
    runners,
    locality: async (p) => {
      calls.push("locality");
      void p;
      return LOCALITY;
    },
    prove: async (p, since, until) => {
      calls.push(`prove(${String(since)},${String(until)})`);
      proveWindows.push([since, until]);
      void p;
      return cleanProof();
    },
    out: (s) => {
      out.push(s);
    },
    err: (s) => {
      err.push(s);
    },
    ...overrides,
  };
  return { deps, calls, out, err, proveWindows };
}

const originalExitCode = process.exitCode;
afterEach(() => {
  process.exitCode = originalExitCode;
});

describe("runDemo", () => {
  test("(g) refuses when paths.demo is not true — internal error, never a real root", async () => {
    const { demo: _demo, ...nonDemoPaths } = demoPaths();
    const { deps } = fakeDeps({ paths: () => nonDemoPaths });
    await expect(runDemo([], deps)).rejects.toThrow(/NIMBUS_DEMO not set/);
  });

  test("(a) default run: stop, removeDir(demo root), start, seed, stop, start, the 3-step tour, then the panel", async () => {
    const { deps, calls, out } = fakeDeps();
    await runDemo([], deps);

    expect(calls).toEqual([
      "stop",
      "removeDir(demo-root)",
      "start",
      "seed",
      "stop",
      "start",
      "firePage",
      "oncall(pushed)",
      "why(src/retry/backoff.ts:42)",
      "owners(src/retry)",
      "locality",
      "prove(1000,2000)",
    ]);

    const joined = out.join("");
    // The panel is step 4 of 4 — the total reaches the brief headers through `runTour`, so all
    // four say `/4`.
    expect(joined).toContain("── [1/4] On-call triage");
    expect(joined).toContain("── [2/4] Why this line changed");
    expect(joined).toContain("── [3/4] Who owns this code");
    expect(joined).toContain("── [4/4] Where your data is");

    const oncallIdx = joined.indexOf("$ nimbus --demo oncall pushed");
    const whyIdx = joined.indexOf("$ nimbus --demo why src/retry/backoff.ts:42");
    const ownersIdx = joined.indexOf("$ nimbus --demo owners src/retry");
    expect(oncallIdx).toBeGreaterThan(-1);
    expect(oncallIdx).toBeLessThan(whyIdx);
    expect(whyIdx).toBeLessThan(ownersIdx);

    // The panel prints after the last brief and BEFORE the closing block, which stays last — the
    // release gate requires the output to END with the `Stop it with` line.
    const panelIdx = joined.indexOf("Listeners the gateway has open right now:");
    const closingIdx = joined.indexOf("The demo gateway is still running");
    expect(ownersIdx).toBeLessThan(panelIdx);
    expect(panelIdx).toBeLessThan(closingIdx);
    expect(joined.trimEnd().endsWith("remove everything with `nimbus demo reset`.")).toBe(true);
  });

  test("(a) the proof window is exactly the GATEWAY's t0..t1, never a CLI-side clock", async () => {
    const { deps, proveWindows } = fakeDeps();
    await runDemo([], deps);
    expect(proveWindows).toEqual([[SEED.t0, LOCALITY.t1]]);
  });

  test("(b) --no-tour runs no step and makes no locality or prove call", async () => {
    const { deps, calls, out } = fakeDeps();
    await runDemo(["--no-tour"], deps);

    expect(calls).toEqual([
      "stop",
      "removeDir(demo-root)",
      "start",
      "seed",
      "stop",
      "start",
      "firePage",
    ]);
    const joined = out.join("");
    expect(joined).not.toContain("[1/4]");
    expect(joined).not.toContain("Where your data is");
    expect(joined).not.toContain("Listeners the gateway has open right now:");
  });

  test.each([[[] as string[]], [["--no-tour"]]])(
    "%p fires the page exactly once, after the second start and before any tour step",
    async (args) => {
      const { deps, calls, out } = fakeDeps();
      await runDemo(args, deps);
      expect(calls.filter((c) => c === "firePage")).toHaveLength(1);
      const fire = calls.indexOf("firePage");
      expect(calls.lastIndexOf("start")).toBe(fire - 1);
      const firstStep = calls.findIndex((c) => c.startsWith("oncall("));
      if (firstStep >= 0) expect(fire).toBeLessThan(firstStep);
      expect(out.join("")).toContain(
        "A page just fired: P1 on payment-service. Its brief was assembled before anyone asked.",
      );
    },
  );

  test.each([[[] as string[]], [["--no-tour"]]])(
    "%p: a firePage rejection is reported, stops the demo gateway, and exits 1 without touring",
    async (args) => {
      const { deps, calls, err } = fakeDeps({
        firePage: async () => {
          calls.push("firePage");
          throw new Error("boom");
        },
      });
      await expect(runDemo(args, deps)).rejects.toMatchObject({ name: "CliExit", code: 1 });
      expect(calls).toEqual([
        "stop",
        "removeDir(demo-root)",
        "start",
        "seed",
        "stop",
        "start",
        "firePage",
        "stop",
      ]);
      expect(err.join("")).toContain("boom");
    },
  );

  test("a non-Error firePage rejection is stringified into the page error, not dropped", async () => {
    const { deps, calls, err } = fakeDeps({
      firePage: () => {
        calls.push("firePage");
        return Promise.reject("socket hang up");
      },
    });
    await expect(runDemo(["--no-tour"], deps)).rejects.toMatchObject({ name: "CliExit", code: 1 });
    expect(err.join("")).toBe("The demo page could not be fired: socket hang up\n");
    expect(calls.slice(-2)).toEqual(["firePage", "stop"]);
  });

  test("a firePage rejection whose cleanup stop ALSO fails still exits 1 with the page error", async () => {
    let n = 0;
    const { deps, calls, err } = fakeDeps({
      stop: async () => {
        calls.push("stop");
        n += 1;
        if (n > 2) throw new Error("stop failed");
        return "stopped";
      },
      firePage: async () => {
        calls.push("firePage");
        throw new Error("boom");
      },
    });
    await expect(runDemo(["--no-tour"], deps)).rejects.toMatchObject({ name: "CliExit", code: 1 });
    expect(calls.slice(-2)).toEqual(["firePage", "stop"]);
    expect(err.join("")).toContain("boom");
    expect(err.join("")).not.toContain("stop failed");
  });

  test("a page that pushed no brief says so without a failure marker, still tours, then CliExit(1)", async () => {
    const { deps, calls, out } = fakeDeps({
      firePage: async () => {
        calls.push("firePage");
        return { incidentId: "pagerduty:PDEMO412", push: { selected: 0, ok: 0, failed: 0 } };
      },
    });
    await expect(runDemo([], deps)).rejects.toMatchObject({ name: "CliExit", code: 1 });
    const joined = out.join("");
    expect(joined).toContain("A page just fired, but no brief was pushed");
    for (const marker of ["ERR_", "Gateway is not running", "No LLM provider available"]) {
      expect(joined).not.toContain(marker);
    }
    expect(calls).toContain("oncall(pushed)");
    expect(joined).toContain("The demo gateway is still running");
  });

  test("a failing step still runs the others, prints the panel and the closing block, then CliExit(1)", async () => {
    const { deps, calls, out } = fakeDeps();
    const failing: TourRunners = {
      ...deps.runners,
      why: async () => {
        calls.push("why(boom)");
        throw new CliExit(2);
      },
    };
    const run = runDemo([], { ...deps, runners: failing });
    await expect(run).rejects.toMatchObject({ name: "CliExit", code: 1 });

    expect(calls).toEqual([
      "stop",
      "removeDir(demo-root)",
      "start",
      "seed",
      "stop",
      "start",
      "firePage",
      "oncall(pushed)",
      "why(boom)",
      "owners(src/retry)",
      "locality",
      "prove(1000,2000)",
    ]);
    const joined = out.join("");
    expect(joined).toContain("── [3/4] Who owns this code");
    expect(joined).toContain("Listeners the gateway has open right now:");
    expect(joined).toContain("The demo gateway is still running");
  });

  test("a failed prove call still prints the panel and the closing block, then CliExit(1)", async () => {
    const { deps, out } = fakeDeps({
      prove: async () => {
        throw new Error("boom");
      },
    });
    const run = runDemo([], deps);
    await expect(run).rejects.toMatchObject({ name: "CliExit", code: 1 });

    const joined = out.join("");
    expect(joined).toContain("Listeners the gateway has open right now:");
    expect(joined).toContain("proof unavailable — the egress.proveWindow call failed: boom");
    expect(joined).not.toContain("in the covered classes:");
    expect(joined).toContain("The demo gateway is still running");
  });

  test("a clean tour prints the zero-egress proof line and resolves", async () => {
    const { deps, out } = fakeDeps();
    await expect(runDemo([], deps)).resolves.toBeUndefined();
    expect(out.join("")).toContain(
      "outbound egress events during this tour, in the covered classes: 0",
    );
  });

  test("(c) `stop` calls only stop", async () => {
    const { deps, calls, out } = fakeDeps();
    await runDemo(["stop"], deps);
    expect(calls).toEqual(["stop"]);
    expect(out.join("")).toContain("Demo gateway stopped.");
  });

  test("(c) `stop` when nothing was running reports that instead", async () => {
    const { deps, out } = fakeDeps({ stop: async () => "not-running" });
    await runDemo(["stop"], deps);
    expect(out.join("")).toContain("No demo gateway was running.");
  });

  test("(d) `reset` calls stop then removeDir", async () => {
    const { deps, calls, out } = fakeDeps();
    await runDemo(["reset"], deps);
    expect(calls).toEqual(["stop", "removeDir(demo-root)"]);
    expect(out.join("")).toContain("Demo root removed: demo-root");
  });

  test("(e) a failing first start stops the flow before seed", async () => {
    const { deps, calls } = fakeDeps({
      start: async () => {
        calls.push("start");
        return false;
      },
    });
    await runDemo([], deps);
    expect(calls).toEqual(["stop", "removeDir(demo-root)", "start"]);
  });

  test("(e) a failing SECOND start stops the flow before the tour", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps({
      start: async () => {
        calls.push("start");
        n += 1;
        return n < 2;
      },
    });
    await runDemo([], deps);
    expect(calls).toEqual(["stop", "removeDir(demo-root)", "start", "seed", "stop", "start"]);
  });

  test.each([
    [["bogus"]],
    [["--no-tour", "stop"]],
    [["stop", "--no-tour"]],
    [["reset", "now"]],
    [["stop", "stop"]],
    [["--no-tour", "--no-tour"]],
    [["--json"]],
  ])(
    "(f) %p is refused with the usage text before anything is stopped, deleted or started",
    async (args) => {
      let pathsCalls = 0;
      const { deps, calls, out } = fakeDeps({
        paths: () => {
          pathsCalls += 1;
          return demoPaths();
        },
      });
      await expect(runDemo(args, deps)).rejects.toThrow(
        /Usage: nimbus demo \[--no-tour\] \| nimbus demo stop \| nimbus demo reset/,
      );
      expect(calls).toEqual([]);
      expect(out).toEqual([]);
      expect(pathsCalls).toBe(0);
    },
  );

  test("(f) parseDemoArgs accepts exactly the four valid forms", () => {
    expect(parseDemoArgs([])).toBe("run");
    expect(parseDemoArgs(["--no-tour"])).toBe("run-no-tour");
    expect(parseDemoArgs(["stop"])).toBe("stop");
    expect(parseDemoArgs(["reset"])).toBe("reset");
    expect(() => parseDemoArgs(["reset", "--no-tour"])).toThrow(/Unexpected arguments/);
  });

  const UNRESPONSIVE = { status: "unresponsive", pid: 4242 } as const;

  test.each([[[] as string[]], [["--no-tour"]], [["reset"]], [["stop"]]])(
    "(h) %p aborts on an unresponsive demo gateway without deleting or starting anything",
    async (args) => {
      const { deps, calls, out } = fakeDeps({
        stop: async () => {
          calls.push("stop");
          return UNRESPONSIVE;
        },
      });
      const err = await runDemo(args, deps).then(
        () => undefined,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(DemoGatewayUnresponsiveError);
      expect((err as Error).message).toContain("pid 4242");
      expect((err as Error).message).toContain("end that process, then rerun `nimbus demo`");
      expect(calls).toEqual(["stop"]);
      expect(out).toEqual([]);
    },
  );

  test("(h) an unresponsive gateway at the post-seed restart aborts before the second start", async () => {
    let n = 0;
    const { deps, calls } = fakeDeps({
      stop: async () => {
        calls.push("stop");
        n += 1;
        return n === 1 ? "not-running" : UNRESPONSIVE;
      },
    });
    await expect(runDemo([], deps)).rejects.toThrow(DemoGatewayUnresponsiveError);
    expect(calls).toEqual(["stop", "removeDir(demo-root)", "start", "seed", "stop"]);
  });

  test("(i) a failed seed stops the gateway it started, then rethrows the seed error", async () => {
    const seedError = new Error("ERR_DEMO_ALREADY_SEEDED: boom");
    const { deps, calls } = fakeDeps({
      seed: async () => {
        calls.push("seed");
        throw seedError;
      },
    });
    const err = await runDemo(["--no-tour"], deps).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBe(seedError);
    expect(calls).toEqual(["stop", "removeDir(demo-root)", "start", "seed", "stop"]);
  });

  test("(i) a failed seed whose cleanup stop ALSO fails still reports the seed error", async () => {
    const seedError = new Error("seed failed");
    let n = 0;
    const { deps, calls } = fakeDeps({
      stop: async () => {
        calls.push("stop");
        n += 1;
        if (n > 1) throw new Error("stop failed");
        return "not-running";
      },
      seed: async () => {
        calls.push("seed");
        throw seedError;
      },
    });
    await expect(runDemo([], deps)).rejects.toBe(seedError);
    expect(calls).toEqual(["stop", "removeDir(demo-root)", "start", "seed", "stop"]);
  });
});

// ── The production deps ──────────────────────────────────────────────────────────────────────
// Every case below runs on a fresh directory under the OS temp dir, or refuses before any path is
// touched. None reaches the real install: no case resolves a real root and then does I/O on it,
// and none can spawn a gateway (the one `start` case refuses at path resolution, its first line).

const tempRoots: string[] = [];
afterAll(() => {
  for (const r of tempRoots) rmSync(r, { recursive: true, force: true });
});

function tempDemoPaths(): CliPlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-demo-cmd-"));
  tempRoots.push(root);
  const dataDir = join(root, "data");
  return {
    configDir: join(root, "config"),
    dataDir,
    logDir: join(dataDir, "logs"),
    socketPath: join(root, "fake.sock"),
    extensionsDir: join(dataDir, "extensions"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
    demo: true,
  };
}

/** Run `fn` with `NIMBUS_DEMO` set to `value` (or unset), restoring the previous value after. */
async function withNimbusDemoEnv(
  value: string | undefined,
  fn: () => Promise<void>,
): Promise<void> {
  const prev = process.env["NIMBUS_DEMO"];
  if (value === undefined) delete process.env["NIMBUS_DEMO"];
  else process.env["NIMBUS_DEMO"] = value;
  try {
    await fn();
  } finally {
    if (prev === undefined) delete process.env["NIMBUS_DEMO"];
    else process.env["NIMBUS_DEMO"] = prev;
  }
}

describe("defaultDemoDeps", () => {
  test("runDemo with the DEFAULT deps refuses a non-demo root before stopping or deleting anything", async () => {
    // Without NIMBUS_DEMO the default `paths` resolves the REAL root, which must never reach
    // `stop` / `removeDir` — the internal-error refusal is the only thing standing between a
    // mis-dispatched `nimbus demo reset` and the user's real data directory.
    await withNimbusDemoEnv(undefined, async () => {
      await expect(runDemo(["reset"])).rejects.toThrow(/NIMBUS_DEMO not set/);
    });
  });

  test("stop reports not-running for a root with no gateway state file", async () => {
    expect(await defaultDemoDeps.stop(tempDemoPaths())).toBe("not-running");
  });

  test("removeDir deletes a populated directory tree", () => {
    const { dataDir } = tempDemoPaths();
    mkdirSync(join(dataDir, "logs"), { recursive: true });
    writeFileSync(join(dataDir, "logs", "gateway.log"), "x");
    defaultDemoDeps.removeDir(dataDir);
    expect(existsSync(dataDir)).toBe(false);
  });

  test("start refuses at path resolution on an ambiguous NIMBUS_DEMO — no gateway is spawned", async () => {
    await withNimbusDemoEnv("yes", async () => {
      await expect(defaultDemoDeps.start()).rejects.toThrow(/must be 1 or unset/);
    });
  });

  test("seed with no running demo gateway rejects with the demo-root not-running message", async () => {
    const err = await defaultDemoDeps.seed(tempDemoPaths()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GatewayNotRunningError);
    expect((err as Error).message).toContain("(demo root)");
  });

  test("firePage with no running demo gateway rejects with the demo-root not-running message", async () => {
    const err = await defaultDemoDeps.firePage(tempDemoPaths()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GatewayNotRunningError);
    expect((err as Error).message).toContain("(demo root)");
  });

  // The tour is no longer dispatched through per-step deps: `nimbus demo` runs the SAME runner
  // table `nimbus wow` does, so a step cannot behave differently on one surface than on the other.
  test("runners IS defaultTourRunners — the demo shares the `nimbus wow` runner table", () => {
    expect(defaultDemoDeps.runners).toBe(defaultTourRunners);
  });

  test("locality with no running demo gateway rejects with the demo-root not-running message", async () => {
    const err = await defaultDemoDeps.locality(tempDemoPaths()).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GatewayNotRunningError);
    expect((err as Error).message).toContain("(demo root)");
  });

  test("prove with no running demo gateway rejects with the demo-root not-running message", async () => {
    const err = await defaultDemoDeps.prove(tempDemoPaths(), 1, 2).then(
      () => undefined,
      (e: unknown) => e,
    );
    expect(err).toBeInstanceOf(GatewayNotRunningError);
    expect((err as Error).message).toContain("(demo root)");
  });

  test("out writes to stdout verbatim", () => {
    const cap = createStreamCapture();
    cap.install();
    try {
      defaultDemoDeps.out("hello demo\n");
    } finally {
      cap.restore();
    }
    expect(cap.stdoutChunks.join("")).toBe("hello demo\n");
  });

  test("err writes to stderr verbatim", () => {
    const cap = createStreamCapture();
    cap.install();
    try {
      defaultDemoDeps.err("bad demo\n");
    } finally {
      cap.restore();
    }
    expect(cap.stderrChunks.join("")).toBe("bad demo\n");
  });
});

// `runStart` reports failure ONLY through `process.exitCode`. These pin how `defaultDemoDeps.start`
// reads that: with an injected start, so no gateway is spawned.
describe("startDemoGateway — reading runStart's exit code", () => {
  // These cases set `process.exitCode` on purpose, and Bun IGNORES an assignment of `undefined` —
  // so the file-level restore (to an `undefined` original) cannot undo a 1 set here, and the whole
  // `bun test` run would exit 1 with every test green. Restore the exact prior value instead; an
  // unset code is success, i.e. 0.
  let priorExitCode: typeof process.exitCode;
  beforeEach(() => {
    priorExitCode = process.exitCode ?? 0;
  });
  afterEach(() => {
    process.exitCode = priorExitCode;
  });

  test("starts with exactly --no-wizard, and a start that records no failure is success", async () => {
    process.exitCode = 0;
    const seen: string[][] = [];
    expect(
      await startDemoGateway(async (args) => {
        seen.push(args);
      }),
    ).toBe(true);
    expect(seen).toEqual([["--no-wizard"]]);
    expect(process.exitCode).toBe(0);
  });

  test("on success the exit code is put back to what it was before the start", async () => {
    process.exitCode = 5;
    expect(
      await startDemoGateway(async () => {
        process.exitCode = 0;
      }),
    ).toBe(true);
    expect(process.exitCode).toBe(5);
  });

  test("a failed start reports false and KEEPS its exit code for the process to exit with", async () => {
    process.exitCode = 0;
    expect(
      await startDemoGateway(async () => {
        process.exitCode = 1;
      }),
    ).toBe(false);
    expect(process.exitCode).toBe(1);
  });
});
