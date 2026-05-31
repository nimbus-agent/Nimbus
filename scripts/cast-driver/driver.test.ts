import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runDriver } from "./driver.ts";
import type { HarnessRun } from "./harness.ts";

let workDir: string;
beforeEach(() => {
  workDir = mkdtempSync(join(tmpdir(), "driver-test-"));
});
afterEach(() => {});

function fakeHarness(stdout: string): () => Promise<HarnessRun> {
  return async () => ({
    captures: [
      {
        input: "nimbus test",
        capture: {
          chunks: [{ tMs: 0, data: stdout }],
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      },
    ],
    tmpDirPrefix: workDir,
  });
}

function scaffold(
  workDir: string,
  scriptName: string,
  yamlBody: string,
  eventsBody: string,
): { yamlPath: string; fixturesRoot: string; demosRoot: string } {
  const yamlDir = join(workDir, "docs/demos/scripts");
  const fixturesRoot = join(workDir, "scripts/cast-driver/fixtures");
  const demosRoot = join(workDir, "docs/demos");
  mkdirSync(yamlDir, { recursive: true });
  mkdirSync(join(fixturesRoot, scriptName), { recursive: true });
  mkdirSync(join(demosRoot, "snapshots"), { recursive: true });
  const yamlPath = join(yamlDir, `${scriptName}.yaml`);
  writeFileSync(yamlPath, yamlBody);
  writeFileSync(join(fixturesRoot, `${scriptName}/events.json`), eventsBody);
  return { yamlPath, fixturesRoot, demosRoot };
}

const MIN_YAML = `name: x\ndescription: t\nevents: x/events.json\nsteps:\n  - input: nimbus test\n`;
const MIN_EVENTS = '{"steps":[]}';

describe("runDriver", () => {
  test("--update-snapshots writes hash, txt, and cast files", async () => {
    const { yamlPath, fixturesRoot, demosRoot } = scaffold(workDir, "x", MIN_YAML, MIN_EVENTS);

    const result = await runDriver({
      mode: "update",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: fakeHarness("hello world\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summaries[0]?.action).toBe("written");
    expect(existsSync(join(demosRoot, "snapshots/x.hash"))).toBe(true);
    expect(existsSync(join(demosRoot, "snapshots/x.txt"))).toBe(true);
    expect(existsSync(join(demosRoot, "x.cast"))).toBe(true);
  });

  test("--check passes when hash matches", async () => {
    const { yamlPath, fixturesRoot, demosRoot } = scaffold(
      workDir,
      "y",
      MIN_YAML.replace("x/events", "y/events"),
      MIN_EVENTS,
    );

    await runDriver({
      mode: "update",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: fakeHarness("stable bytes\n"),
    });

    const result = await runDriver({
      mode: "check",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: fakeHarness("stable bytes\n"),
    });

    expect(result.exitCode).toBe(0);
    expect(result.summaries[0]?.action).toBe("matched");
  });

  test("--check fails when hash mismatches and writes artifacts", async () => {
    const { yamlPath, fixturesRoot, demosRoot } = scaffold(
      workDir,
      "z",
      MIN_YAML.replace("x/events", "z/events"),
      MIN_EVENTS,
    );
    const artifactsDir = join(workDir, "artifacts");
    mkdirSync(artifactsDir, { recursive: true });

    await runDriver({
      mode: "update",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: fakeHarness("original output\n"),
    });

    const result = await runDriver({
      mode: "check",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir,
      harness: fakeHarness("MUTATED output\n"),
    });

    expect(result.exitCode).toBe(1);
    expect(result.summaries[0]?.action).toBe("mismatch");
    expect(existsSync(join(artifactsDir, "z.actual.txt"))).toBe(true);
    expect(existsSync(join(artifactsDir, "z.diff"))).toBe(true);
    expect(existsSync(join(artifactsDir, "z.cast"))).toBe(true);
  });
});
