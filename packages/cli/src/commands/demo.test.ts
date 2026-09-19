import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createStreamCapture } from "../../test/helpers/stream-capture.ts";
import { GatewayNotRunningError } from "../lib/with-gateway-ipc.ts";
import type { CliPlatformPaths } from "../paths.ts";
import {
  type DemoDeps,
  DemoGatewayUnresponsiveError,
  type DemoSeedSummary,
  defaultDemoDeps,
  parseDemoArgs,
  runDemo,
} from "./demo.ts";

const DEMO_DATA_DIR = join("demo-root", "data");

function demoPaths(): CliPlatformPaths {
  return {
    configDir: join("demo-root", "config"),
    dataDir: DEMO_DATA_DIR,
    logDir: join(DEMO_DATA_DIR, "logs"),
    socketPath: join("demo-root", "fake.sock"),
    extensionsDir: join(DEMO_DATA_DIR, "extensions"),
    tempDir: join("demo-root", "tmp"),
    demo: true,
  };
}

const SEED: DemoSeedSummary = {
  counts: { people: 5, items: 42 },
  tour: { whyRef: "src/retry/backoff.ts:42", ownersPath: "src/retry" },
};

function fakeDeps(overrides: Partial<DemoDeps> = {}): {
  deps: DemoDeps;
  calls: string[];
  out: string[];
} {
  const calls: string[] = [];
  const out: string[] = [];
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
    oncall: async () => {
      calls.push("oncall");
    },
    why: async (ref) => {
      calls.push(`why(${ref})`);
    },
    owners: async (dir) => {
      calls.push(`owners(${dir})`);
    },
    out: (s) => {
      out.push(s);
    },
    ...overrides,
  };
  return { deps, calls, out };
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

  test("(a) default run: stop, removeDir(demo root), start, seed, stop, start, then the 3-brief tour", async () => {
    const { deps, calls, out } = fakeDeps();
    await runDemo([], deps);

    expect(calls).toEqual([
      "stop",
      "removeDir(demo-root)",
      "start",
      "seed",
      "stop",
      "start",
      "oncall",
      `why(${SEED.tour.whyRef})`,
      `owners(${SEED.tour.ownersPath})`,
    ]);

    const joined = out.join("");
    expect(joined).toContain("nimbus --demo oncall");
    expect(joined).toContain(`nimbus --demo why ${SEED.tour.whyRef}`);
    expect(joined).toContain(`nimbus --demo owners ${SEED.tour.ownersPath}`);
    const oncallIdx = joined.indexOf("nimbus --demo oncall");
    const whyIdx = joined.indexOf(`nimbus --demo why ${SEED.tour.whyRef}`);
    const ownersIdx = joined.indexOf(`nimbus --demo owners ${SEED.tour.ownersPath}`);
    expect(oncallIdx).toBeGreaterThan(-1);
    expect(oncallIdx).toBeLessThan(whyIdx);
    expect(whyIdx).toBeLessThan(ownersIdx);
  });

  test("(b) --no-tour skips the three brief calls", async () => {
    const { deps, calls, out } = fakeDeps();
    await runDemo(["--no-tour"], deps);

    expect(calls).toEqual(["stop", "removeDir(demo-root)", "start", "seed", "stop", "start"]);
    const joined = out.join("");
    expect(joined).not.toContain("oncall");
    expect(joined).not.toContain("nimbus --demo why");
    expect(joined).not.toContain("nimbus --demo owners");
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

  test("why forwards the tour ref to `nimbus why`, whose own validation runs first", async () => {
    await expect(defaultDemoDeps.why("https://user:pw@example.com/acme/pull/1")).rejects.toThrow(
      /must not contain userinfo/,
    );
  });

  test("owners forwards the tour path to `nimbus owners`, whose own argument parser runs first", async () => {
    await expect(defaultDemoDeps.owners("--not-a-flag")).rejects.toThrow(
      /Unrecognised flag: --not-a-flag/,
    );
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
});
