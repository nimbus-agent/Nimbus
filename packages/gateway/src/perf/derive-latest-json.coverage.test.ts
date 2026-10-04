/**
 * The CLI half of `derive-latest-json.ts`: its flag rules (`parseArgs`) and the entry point's
 * reporting (`runDeriveLatestJsonMain`). `_perf-reference.yml` runs this file as a script, so these
 * are the messages a failed reference publish shows in the workflow log.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs, runDeriveLatestJsonMain } from "./derive-latest-json.ts";
import type { HistoryLine } from "./history-line.ts";

const USAGE = "usage: bun derive-latest-json.ts --history <path> --output <path>";

describe("parseArgs", () => {
  test("reads both flags, in either order, ignoring anything else", () => {
    expect(parseArgs(["--history", "h.jsonl", "--output", "o.json"])).toEqual({
      historyPath: "h.jsonl",
      outputPath: "o.json",
    });
    expect(parseArgs(["--verbose", "--output", "o.json", "extra", "--history", "h.jsonl"])).toEqual(
      { historyPath: "h.jsonl", outputPath: "o.json" },
    );
  });

  test("a repeated flag takes its last value", () => {
    expect(parseArgs(["--history", "a", "--history", "b", "--output", "o"])).toEqual({
      historyPath: "b",
      outputPath: "o",
    });
  });

  test("a flag at the end of argv has no value", () => {
    expect(() => parseArgs(["--output", "o.json", "--history"])).toThrow(
      "flag --history requires a value (got <end of args>)",
    );
  });

  test("a flag whose next token is another flag has no value", () => {
    expect(() => parseArgs(["--output", "--history", "h.jsonl"])).toThrow(
      "flag --output requires a value (got --history)",
    );
  });

  test("a missing or empty flag is a usage error, never a default path", () => {
    expect(() => parseArgs([])).toThrow(USAGE);
    expect(() => parseArgs(["--history", "h.jsonl"])).toThrow(USAGE);
    expect(() => parseArgs(["--output", "o.json"])).toThrow(USAGE);
    expect(() => parseArgs(["--history", "", "--output", "o.json"])).toThrow(USAGE);
    expect(() => parseArgs(["--history", "h.jsonl", "--output", ""])).toThrow(USAGE);
  });
});

describe("runDeriveLatestJsonMain", () => {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "derive-latest-cli-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function io(): {
    out: string[];
    err: string[];
    stdout: (s: string) => void;
    stderr: (s: string) => void;
  } {
    const out: string[] = [];
    const err: string[] = [];
    return { out, err, stdout: (s) => out.push(s), stderr: (s) => err.push(s) };
  }

  const reference: HistoryLine = {
    schema_version: 2,
    run_id: "ref-cli",
    timestamp: "2026-05-14T10:00:00Z",
    runner: "reference-m1air",
    os_version: "macOS 14.5",
    nimbus_git_sha: "abc1234",
    bun_version: "1.3.0",
    surfaces: { S1: { samples_count: 3, p95_ms: 487 } },
  };

  test("writes the latest reference line and reports OK on stdout only", () => {
    const historyPath = join(dir, "history.jsonl");
    const outputPath = join(dir, "nested", "latest.json");
    writeFileSync(historyPath, `${JSON.stringify(reference)}\n`, "utf8");
    const sink = io();
    const code = runDeriveLatestJsonMain(["--history", historyPath, "--output", outputPath], sink);
    expect(code).toBe(0);
    expect(sink.out).toEqual(["derive-latest-json: OK"]);
    expect(sink.err).toEqual([]);
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(reference);
  });

  test("a missing history file exits 1 with the reason on stderr and writes nothing", () => {
    const historyPath = join(dir, "absent.jsonl");
    const outputPath = join(dir, "latest.json");
    const sink = io();
    const code = runDeriveLatestJsonMain(["--history", historyPath, "--output", outputPath], sink);
    expect(code).toBe(1);
    expect(sink.out).toEqual([]);
    expect(sink.err).toEqual([`derive-latest-json: history file not found: ${historyPath}`]);
    expect(existsSync(outputPath)).toBe(false);
  });

  test("a history with no complete reference line exits 1 naming the file", () => {
    const historyPath = join(dir, "history.jsonl");
    writeFileSync(historyPath, `${JSON.stringify({ ...reference, runner: "gha-ubuntu" })}\n`);
    const sink = io();
    const code = runDeriveLatestJsonMain(
      ["--history", historyPath, "--output", join(dir, "latest.json")],
      sink,
    );
    expect(code).toBe(1);
    expect(sink.err).toEqual([
      `derive-latest-json: no complete reference-m1air line found in ${historyPath}`,
    ]);
  });

  test("bad flags exit 1 with the usage line, before touching the filesystem", () => {
    const sink = io();
    expect(runDeriveLatestJsonMain(["--history"], sink)).toBe(1);
    expect(sink.err).toEqual([
      "derive-latest-json: flag --history requires a value (got <end of args>)",
    ]);
    const sink2 = io();
    expect(runDeriveLatestJsonMain([], sink2)).toBe(1);
    expect(sink2.err).toEqual([`derive-latest-json: ${USAGE}`]);
    expect(sink2.out).toEqual([]);
    // A history path that does not exist, with --output missing: the usage error must win. Had the
    // history file been looked at first, this would read "history file not found" instead.
    const absent = join(dir, "absent.jsonl");
    const sink3 = io();
    expect(runDeriveLatestJsonMain(["--history", absent], sink3)).toBe(1);
    expect(sink3.err).toEqual([`derive-latest-json: ${USAGE}`]);
    expect(existsSync(absent)).toBe(false);
  });
});
