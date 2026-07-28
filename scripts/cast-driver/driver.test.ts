import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

  test("a mismatch carries the diff even when NO artifacts dir is given", async () => {
    // The failing path in CI runs without --artifacts-dir, so attaching the
    // diff only when artifacts were requested left the drift undiagnosable:
    // a macOS-only drift sat red on `main` reporting nothing but a hash.
    const { yamlPath, fixturesRoot, demosRoot } = scaffold(
      workDir,
      "d",
      MIN_YAML.replace("x/events", "d/events"),
      MIN_EVENTS,
    );

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
      artifactsDir: undefined,
      harness: fakeHarness("MUTATED output\n"),
    });

    expect(result.summaries[0]?.action).toBe("mismatch");
    const diff = result.summaries[0]?.diff ?? "";
    // Both sides must be identifiable — a diff naming only one is useless.
    expect(diff).toContain("original output");
    expect(diff).toContain("MUTATED output");
  });

  test("a match carries no diff", async () => {
    const { yamlPath, fixturesRoot, demosRoot } = scaffold(
      workDir,
      "m",
      MIN_YAML.replace("x/events", "m/events"),
      MIN_EVENTS,
    );

    await runDriver({
      mode: "update",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: fakeHarness("stable output\n"),
    });

    const result = await runDriver({
      mode: "check",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: fakeHarness("stable output\n"),
    });

    expect(result.summaries[0]?.action).toBe("matched");
    expect(result.summaries[0]?.diff).toBeUndefined();
  });
});

describe("runDriver — the .cast is a publishable artifact", () => {
  function multiChunkHarness(datas: readonly string[]): () => Promise<HarnessRun> {
    return async () => ({
      captures: datas.map((d, i) => ({
        input: `nimbus step-${String(i)}`,
        capture: {
          chunks: [{ tMs: 100 + i, data: d }],
          stderr: "",
          exitCode: 0,
          timedOut: false,
        },
      })),
      tmpDirPrefix: workDir,
    });
  }

  test("the recording machine's temp path never reaches the cast", async () => {
    // The cast gets uploaded to asciinema and rendered into the docs hero, so
    // it needs the same scrubbing as the snapshot. Built from raw chunks it
    // leaked the recorder's tmpdir — and therefore their username.
    const { yamlPath, fixturesRoot, demosRoot } = scaffold(workDir, "x", MIN_YAML, MIN_EVENTS);
    await runDriver({
      mode: "update",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: multiChunkHarness([`Added ${join(workDir, "sample-repo")} to nimbus.toml\n`]),
    });
    const cast = readFileSync(join(demosRoot, "x.cast"), "utf8");
    expect(cast).not.toContain(workDir);
    expect(cast).toContain("<TMP>/sample-repo");
  });

  test("without pacingSeconds the raw harness timings are preserved", async () => {
    const { yamlPath, fixturesRoot, demosRoot } = scaffold(workDir, "x", MIN_YAML, MIN_EVENTS);
    await runDriver({
      mode: "update",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: multiChunkHarness(["a\n", "b\n"]),
    });
    const lines = readFileSync(join(demosRoot, "x.cast"), "utf8").trim().split("\n").slice(1);
    expect(JSON.parse(lines[0] ?? "[]")[0]).toBe(0.1);
    expect(JSON.parse(lines[1] ?? "[]")[0]).toBe(0.101);
  });

  test("pacingSeconds re-times events evenly for playback", async () => {
    const paced = `name: x\ndescription: t\nevents: x/events.json\npacingSeconds: 3\nsteps:\n  - input: nimbus test\n`;
    const { yamlPath, fixturesRoot, demosRoot } = scaffold(workDir, "x", paced, MIN_EVENTS);
    await runDriver({
      mode: "update",
      scriptPaths: [yamlPath],
      demosRoot,
      fixturesRoot,
      artifactsDir: undefined,
      harness: multiChunkHarness(["a\n", "b\n", "c\n"]),
    });
    const lines = readFileSync(join(demosRoot, "x.cast"), "utf8").trim().split("\n").slice(1);
    expect(lines.map((l) => JSON.parse(l)[0])).toEqual([3, 6, 9]);
  });

  test("pacing changes the cast but NOT the snapshot hash", async () => {
    // The hash is the drift tripwire; it must track what the demo SAYS, not how
    // fast it plays, or re-pacing would read as a behavioural regression.
    const base = scaffold(workDir, "x", MIN_YAML, MIN_EVENTS);
    const unpaced = await runDriver({
      mode: "update",
      scriptPaths: [base.yamlPath],
      demosRoot: base.demosRoot,
      fixturesRoot: base.fixturesRoot,
      artifactsDir: undefined,
      harness: multiChunkHarness(["a\n", "b\n"]),
    });
    writeFileSync(
      base.yamlPath,
      `name: x\ndescription: t\nevents: x/events.json\npacingSeconds: 2\nsteps:\n  - input: nimbus test\n`,
    );
    const pacedRun = await runDriver({
      mode: "update",
      scriptPaths: [base.yamlPath],
      demosRoot: base.demosRoot,
      fixturesRoot: base.fixturesRoot,
      artifactsDir: undefined,
      harness: multiChunkHarness(["a\n", "b\n"]),
    });
    expect(pacedRun.summaries[0]?.hash).toBe(unpaced.summaries[0]?.hash);
  });
});
