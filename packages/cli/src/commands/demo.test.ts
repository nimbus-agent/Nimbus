import { afterEach, describe, expect, test } from "bun:test";
import { join } from "node:path";

import type { CliPlatformPaths } from "../paths.ts";
import { type DemoDeps, type DemoSeedSummary, runDemo } from "./demo.ts";

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

  test("(f) an unknown subcommand prints usage and sets exit code 1", async () => {
    const { deps, calls } = fakeDeps();
    await runDemo(["bogus"], deps);
    expect(calls).toEqual([]);
    expect(process.exitCode).toBe(1);
  });
});
