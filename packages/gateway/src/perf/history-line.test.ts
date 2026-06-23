import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendHistoryLine, type HistoryLine } from "./history-line.ts";

function freshDir(): string {
  return mkdtempSync(join(tmpdir(), "perf-history-test-"));
}

describe("appendHistoryLine", () => {
  test("creates the file if missing and writes a single trailing-newline line", () => {
    const dir = freshDir();
    const path = join(dir, "history.jsonl");
    try {
      const line: HistoryLine = {
        schema_version: 2,
        run_id: "abc",
        timestamp: "2026-04-26T12:00:00Z",
        runner: "local-dev",
        os_version: "test",
        nimbus_git_sha: "deadbeef",
        bun_version: "1.2.0",
        surfaces: { "S2-a": { samples_count: 100, p95_ms: 42 } },
      };
      appendHistoryLine(path, line);
      const content = readFileSync(path, "utf8");
      expect(content.endsWith("\n")).toBe(true);
      const lines = content.trim().split("\n");
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(lines[0] ?? "");
      expect(parsed.schema_version).toBe(2);
      expect(parsed.run_id).toBe("abc");
      expect(parsed.surfaces["S2-a"].p95_ms).toBe(42);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("appends a second line without rewriting existing content", () => {
    const dir = freshDir();
    const path = join(dir, "history.jsonl");
    try {
      const base: Omit<HistoryLine, "run_id"> = {
        schema_version: 2,
        timestamp: "2026-04-26T12:00:00Z",
        runner: "local-dev",
        os_version: "test",
        nimbus_git_sha: "deadbeef",
        bun_version: "1.2.0",
        surfaces: {},
      };
      appendHistoryLine(path, { ...base, run_id: "first" });
      appendHistoryLine(path, { ...base, run_id: "second" });
      const lines = readFileSync(path, "utf8").trim().split("\n");
      expect(lines).toHaveLength(2);
      expect(JSON.parse(lines[0] ?? "").run_id).toBe("first");
      expect(JSON.parse(lines[1] ?? "").run_id).toBe("second");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("incomplete: true is preserved in the serialized line", () => {
    const dir = freshDir();
    const path = join(dir, "history.jsonl");
    try {
      const line: HistoryLine = {
        schema_version: 2,
        run_id: "x",
        timestamp: "2026-04-26T12:00:00Z",
        runner: "local-dev",
        os_version: "test",
        nimbus_git_sha: "deadbeef",
        bun_version: "1.2.0",
        surfaces: {},
        incomplete: true,
        incomplete_reason: "interrupted",
      };
      appendHistoryLine(path, line);
      const parsed = JSON.parse(readFileSync(path, "utf8").trim());
      expect(parsed.incomplete).toBe(true);
      expect(parsed.incomplete_reason).toBe("interrupted");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("appendHistoryLine — stub_reason field", () => {
  test("round-trips the stub_reason field on a per-surface entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "history-stub-test-"));
    const path = join(dir, "history.jsonl");
    try {
      const line: HistoryLine = {
        schema_version: 2,
        run_id: "abc",
        timestamp: "2026-04-26T00:00:00Z",
        runner: "local-dev",
        os_version: "test",
        nimbus_git_sha: "deadbeef",
        bun_version: "1.2.0",
        surfaces: {
          S3: { samples_count: 0, stub_reason: "renderer instrumentation pending" },
        },
      };
      appendHistoryLine(path, line);
      const parsed = JSON.parse(readFileSync(path, "utf8").trim()) as HistoryLine;
      expect(parsed.surfaces.S3?.stub_reason).toBe("renderer instrumentation pending");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("appendHistoryLine — busy_retries field", () => {
  test("round-trips busy_retries through JSON serialisation", () => {
    const dir = mkdtempSync(join(tmpdir(), "history-busyretries-"));
    try {
      const path = join(dir, "history.jsonl");
      appendHistoryLine(path, {
        schema_version: 2,
        run_id: "test",
        timestamp: "2026-04-28T00:00:00Z",
        runner: "local-dev",
        os_version: "test",
        nimbus_git_sha: "abc",
        bun_version: "1.0.0",
        surfaces: {
          S10: { samples_count: 5, throughput_per_sec: 1234, busy_retries: 17 },
        },
      });
      const parsed = JSON.parse(readFileSync(path, "utf8").trim()) as {
        surfaces: { S10: { busy_retries?: number } };
      };
      expect(parsed.surfaces.S10.busy_retries).toBe(17);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("omits busy_retries when not provided (no key written)", () => {
    const dir = mkdtempSync(join(tmpdir(), "history-busyretries-"));
    try {
      const path = join(dir, "history.jsonl");
      appendHistoryLine(path, {
        schema_version: 2,
        run_id: "test",
        timestamp: "2026-04-28T00:00:00Z",
        runner: "local-dev",
        os_version: "test",
        nimbus_git_sha: "abc",
        bun_version: "1.0.0",
        surfaces: { "S2-a": { samples_count: 100, p95_ms: 12 } },
      });
      const text = readFileSync(path, "utf8");
      expect(text).not.toContain("busy_retries");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
