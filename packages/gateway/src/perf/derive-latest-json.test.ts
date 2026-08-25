import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  deriveLatestJson,
  NoQualifyingLineError,
  selectLatestReferenceLine,
  writeLatestJson,
} from "./derive-latest-json.ts";
import type { HistoryLine } from "./history-line.ts";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "derive-latest-json-"));
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

const referenceLine: HistoryLine = {
  schema_version: 2,
  run_id: "ref-001",
  timestamp: "2026-05-14T10:00:00Z",
  runner: "reference-m1air",
  os_version: "macOS 14.5",
  nimbus_git_sha: "abc1234",
  bun_version: "1.2.0",
  surfaces: {
    S1: { samples_count: 3, p50_ms: 412, p95_ms: 487, p99_ms: 511, max_ms: 530 },
  },
};

const olderReferenceLine: HistoryLine = {
  ...referenceLine,
  run_id: "ref-000",
  timestamp: "2026-05-13T10:00:00Z",
  nimbus_git_sha: "def5678",
};

const ghaLine: HistoryLine = {
  ...referenceLine,
  run_id: "gha-001",
  runner: "gha-ubuntu",
};

const incompleteReferenceLine: HistoryLine = {
  ...referenceLine,
  run_id: "ref-002",
  incomplete: true,
  incomplete_reason: "operator interrupted",
};

const placeholderLine = `{"schema_version":1,"_comment":"Perf bench history."}`;

// A structurally COMPLETE reference line (valid runner + all required fields)
// whose ONLY flaw is the stale v1 schema. The trimmed-pool p95 reset makes v1
// aggregates non-comparable, so the version gate must skip it — this fixture
// pins that the `schema_version === 2` check is load-bearing (a plain placeholder
// line is skipped for the missing runner regardless of version).
const completeV1ReferenceLine = JSON.stringify({
  ...referenceLine,
  schema_version: 1,
  run_id: "ref-v1-stale",
});

function writeHistory(...lines: (HistoryLine | string)[]): string {
  const path = join(tmpDir, "history.jsonl");
  const body = `${lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n")}\n`;
  writeFileSync(path, body, "utf8");
  return path;
}

describe("selectLatestReferenceLine", () => {
  test("returns the only line when it is a complete reference run", () => {
    const got = selectLatestReferenceLine(`${JSON.stringify(referenceLine)}\n`);
    expect(got).toEqual(referenceLine);
  });

  test("skips placeholder lines without a runner field", () => {
    const got = selectLatestReferenceLine(
      `${[placeholderLine, JSON.stringify(referenceLine)].join("\n")}\n`,
    );
    expect(got).toEqual(referenceLine);
  });

  test("skips a structurally complete reference line carrying the stale schema_version 1", () => {
    // The stale v1 line is the MORE RECENT entry (last in the file); the version
    // gate must still walk past it to the older v2 line. If the gate regressed to
    // `=== 1`, this would return the v1 line and the assertion would fail.
    const got = selectLatestReferenceLine(
      `${[JSON.stringify(referenceLine), completeV1ReferenceLine].join("\n")}\n`,
    );
    expect(got).toEqual(referenceLine);
  });

  test("throws when the only reference line carries the stale schema_version 1", () => {
    expect(() => selectLatestReferenceLine(`${completeV1ReferenceLine}\n`)).toThrow();
  });

  test("skips GHA-runner lines and returns the most recent reference line", () => {
    const got = selectLatestReferenceLine(
      `${[JSON.stringify(referenceLine), JSON.stringify(ghaLine)].join("\n")}\n`,
    );
    expect(got).toEqual(referenceLine);
  });

  test("walks past incomplete reference lines to the previous complete one", () => {
    const got = selectLatestReferenceLine(
      `${[JSON.stringify(olderReferenceLine), JSON.stringify(incompleteReferenceLine)].join("\n")}\n`,
    );
    expect(got).toEqual(olderReferenceLine);
  });

  test("treats incomplete: false the same as absent", () => {
    const raw = { ...referenceLine, incomplete: false } as unknown as HistoryLine;
    const got = selectLatestReferenceLine(`${JSON.stringify(raw)}\n`);
    expect(got.run_id).toBe(referenceLine.run_id);
  });

  test("throws when the file contains only a placeholder line", () => {
    expect(() => selectLatestReferenceLine(`${placeholderLine}\n`)).toThrow();
  });

  test("throws when the file contains only GHA lines", () => {
    expect(() => selectLatestReferenceLine(`${JSON.stringify(ghaLine)}\n`)).toThrow();
  });

  test("throws when every reference line is incomplete", () => {
    expect(() =>
      selectLatestReferenceLine(`${JSON.stringify(incompleteReferenceLine)}\n`),
    ).toThrow();
  });
});

describe("writeLatestJson", () => {
  test("creates parent directories and writes JSON + trailing newline", () => {
    const out = join(tmpDir, "nested/dir/latest.json");
    writeLatestJson(out, referenceLine);
    const written = readFileSync(out, "utf8");
    expect(written).toBe(`${JSON.stringify(referenceLine)}\n`);
  });

  test("overwrites atomically (no .tmp file left behind)", () => {
    const out = join(tmpDir, "latest.json");
    writeLatestJson(out, referenceLine);
    writeLatestJson(out, olderReferenceLine);
    expect(existsSync(`${out}.tmp`)).toBe(false);
    expect(JSON.parse(readFileSync(out, "utf8"))).toEqual(olderReferenceLine);
  });
});

describe("deriveLatestJson (end-to-end)", () => {
  test("writes the most recent complete reference line to output", () => {
    const historyPath = writeHistory(placeholderLine, ghaLine, olderReferenceLine, referenceLine);
    const outputPath = join(tmpDir, "latest.json");
    deriveLatestJson({ historyPath, outputPath });
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(referenceLine);
  });

  test("throws NoQualifyingLineError when no complete reference line exists", () => {
    const historyPath = writeHistory(placeholderLine, ghaLine);
    const outputPath = join(tmpDir, "latest.json");
    expect(() => deriveLatestJson({ historyPath, outputPath })).toThrow(NoQualifyingLineError);
    expect(existsSync(outputPath)).toBe(false);
  });

  test("throws when the history file does not exist", () => {
    expect(() =>
      deriveLatestJson({
        historyPath: join(tmpDir, "missing.jsonl"),
        outputPath: join(tmpDir, "latest.json"),
      }),
    ).toThrow(/not found/);
  });
});

describe("selectLatestReferenceLine — malformed input is skipped, not fatal", () => {
  // A history file is appended to by a long-running bench; a crash or a full
  // disk mid-append leaves a truncated last line. Throwing on it would take the
  // perf gate down for a reason that has nothing to do with performance.
  test("walks past a truncated trailing line to the last complete one", () => {
    const got = selectLatestReferenceLine(
      `${JSON.stringify(referenceLine)}\n{"schema_version":2,"runner":"refer`,
    );
    expect(got).toEqual(referenceLine);
  });

  // A well-formed JSON line that is not an object at all — `null` most of all,
  // which is the shape that turns a missing type guard into a TypeError rather
  // than a quiet `false`.
  test("walks past JSON lines that are not objects", () => {
    const got = selectLatestReferenceLine(
      `${[JSON.stringify(referenceLine), "42", `"a string"`, "null"].join("\n")}\n`,
    );
    expect(got).toEqual(referenceLine);
  });

  test("ignores blank and whitespace-only lines between entries", () => {
    const got = selectLatestReferenceLine(`\n   \n${JSON.stringify(referenceLine)}\n\n\t\n\n`);
    expect(got).toEqual(referenceLine);
  });

  test("throws when every line is malformed", () => {
    expect(() => selectLatestReferenceLine("{oops\nnot json\n")).toThrow();
  });

  test("throws on an entirely empty history body", () => {
    expect(() => selectLatestReferenceLine("")).toThrow();
  });
});

describe("deriveLatestJson — malformed history", () => {
  test("skips a truncated trailing line and still writes the last complete run", () => {
    const historyPath = join(tmpDir, "history.jsonl");
    writeFileSync(
      historyPath,
      `${JSON.stringify(referenceLine)}\n{"schema_version":2,"runn`,
      "utf8",
    );
    const outputPath = join(tmpDir, "latest.json");
    deriveLatestJson({ historyPath, outputPath });
    expect(JSON.parse(readFileSync(outputPath, "utf8"))).toEqual(referenceLine);
  });

  test("reports NoQualifyingLineError naming the history path when nothing qualifies", () => {
    const historyPath = writeHistory("{oops", placeholderLine);
    const outputPath = join(tmpDir, "latest.json");
    let caught: unknown;
    try {
      deriveLatestJson({ historyPath, outputPath });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(NoQualifyingLineError);
    expect((caught as Error).message).toContain(historyPath);
    expect((caught as Error).cause).toBeInstanceOf(Error);
  });
});
