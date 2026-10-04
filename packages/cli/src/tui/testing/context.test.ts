import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname } from "node:path";

import { StubIpcClient } from "../test-helpers/stub-client.ts";
import { ipcContextFor, makeHistoryPath, silentLogger } from "./context.ts";

// The TUI tests render components against these fixtures. A logger that printed would interleave
// log lines with the Ink frames those tests assert on, and a history path outside a fresh temp dir
// would read (or overwrite) a real REPL history — so both properties are pinned here directly
// rather than left to whichever component test happens to notice.

const LEVELS = ["debug", "info", "warn", "error"] as const;
const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

describe("silentLogger", () => {
  test("every level accepts pino's call shapes, returns undefined, and prints nothing", () => {
    const printed: string[] = [];
    const saved = CONSOLE_METHODS.map((m) => [m, console[m]] as const);
    for (const m of CONSOLE_METHODS) {
      console[m] = (...args: unknown[]): void => {
        printed.push(`${m}: ${args.map(String).join(" ")}`);
      };
    }
    const results: unknown[] = [];
    try {
      for (const level of LEVELS) {
        results.push(silentLogger[level]("message only"));
        results.push(silentLogger[level]({ requestId: "r-1" }, "object then message"));
      }
    } finally {
      for (const [m, fn] of saved) console[m] = fn;
    }
    expect(results).toEqual(Array.from({ length: LEVELS.length * 2 }, () => undefined));
    expect(printed).toEqual([]);
  });
});

describe("ipcContextFor", () => {
  test("wraps the stub's own client and the silent logger, nothing else", () => {
    const stub = new StubIpcClient({ results: { "diag.ping": "pong" } });
    const ctx = ipcContextFor(stub);
    expect(ctx.client).toBe(stub.asClient());
    expect(ctx.logger).toBe(silentLogger);
    expect(Object.keys(ctx).sort((a, b) => a.localeCompare(b))).toEqual(["client", "logger"]);
  });
});

describe("makeHistoryPath", () => {
  test("with no prefix, names a hist.json inside a fresh nimbus-tui- temp directory", () => {
    const h = makeHistoryPath();
    try {
      expect(basename(h.path)).toBe("hist.json");
      const dir = dirname(h.path);
      expect(basename(dir).startsWith("nimbus-tui-")).toBe(true);
      // Real paths on both sides: macOS's temp dir sits behind the /var -> /private/var symlink.
      expect(realpathSync(dirname(dir))).toBe(realpathSync(tmpdir()));
      // The directory exists; the history file itself is left for the code under test to create.
      expect(existsSync(dir)).toBe(true);
      expect(existsSync(h.path)).toBe(false);
    } finally {
      h.cleanup();
    }
  });

  test("honours a caller's prefix, and two calls never share a directory", () => {
    const a = makeHistoryPath("nimbus-ctx-test-");
    const b = makeHistoryPath("nimbus-ctx-test-");
    try {
      expect(basename(dirname(a.path)).startsWith("nimbus-ctx-test-")).toBe(true);
      expect(dirname(a.path)).not.toBe(dirname(b.path));
    } finally {
      a.cleanup();
      b.cleanup();
    }
  });

  test("cleanup removes the directory with the history written into it, and is safe to repeat", () => {
    const h = makeHistoryPath();
    writeFileSync(h.path, JSON.stringify(["first question"]), "utf8");
    expect(readFileSync(h.path, "utf8")).toBe('["first question"]');
    h.cleanup();
    expect(existsSync(dirname(h.path))).toBe(false);
    expect(() => {
      h.cleanup();
    }).not.toThrow();
  });
});
