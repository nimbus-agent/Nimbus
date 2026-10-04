/**
 * `installIncompleteSignalHandler` — the handler itself, not just its registration.
 *
 * A bench run interrupted by Ctrl-C / a CI cancel must leave ONE `incomplete: true` history line
 * naming the signal, and must exit 130 even when writing that line fails. Nothing here raises a
 * real signal: the handler is taken back out of `process.listeners()` and called directly, with
 * `process.exit` swapped for a recorder for exactly the synchronous span of that call.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type IncompleteContext, installIncompleteSignalHandler } from "./signal-handler.ts";

const CTX: IncompleteContext = {
  runId: "run-c14",
  runner: "local-dev",
  reason: "overwritten-by-the-handler",
  nimbusGitSha: "deadbeef",
  bunVersion: "1.3.14",
  osVersion: "test-os",
};

type SignalListener = (signal: NodeJS.Signals) => void;

/** Installs the handler and returns exactly the listener(s) it added, plus its uninstaller. */
function install(
  historyPath: string,
  factory: () => IncompleteContext,
): { sigint: SignalListener[]; sigterm: SignalListener[]; uninstall: () => void } {
  const priorInt = new Set(process.listeners("SIGINT"));
  const priorTerm = new Set(process.listeners("SIGTERM"));
  const uninstall = installIncompleteSignalHandler(historyPath, factory);
  return {
    sigint: process.listeners("SIGINT").filter((l) => !priorInt.has(l)) as SignalListener[],
    sigterm: process.listeners("SIGTERM").filter((l) => !priorTerm.has(l)) as SignalListener[],
    uninstall,
  };
}

/** Calls `fn` with `process.exit` replaced by a recorder; the real one is always restored. */
function withRecordedExit(fn: () => void): { exits: number[]; thrown: unknown } {
  const realExit = process.exit;
  const exits: number[] = [];
  let thrown: unknown;
  process.exit = ((code?: number) => {
    exits.push(code ?? 0);
  }) as typeof process.exit;
  try {
    fn();
  } catch (e) {
    thrown = e;
  } finally {
    process.exit = realExit;
  }
  return { exits, thrown };
}

describe("installIncompleteSignalHandler", () => {
  test("one shared handler serves SIGINT and SIGTERM, records the signal, exits 130, and uninstalls cleanly", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-signal-handler-"));
    const historyPath = join(dir, "nested", "history.jsonl");
    const handle = install(historyPath, () => CTX);
    try {
      expect(handle.sigint).toHaveLength(1);
      expect(handle.sigterm).toHaveLength(1);
      expect(handle.sigterm[0]).toBe(handle.sigint[0]);

      const { exits, thrown } = withRecordedExit(() => handle.sigterm[0]?.("SIGTERM"));
      expect(thrown).toBeUndefined();
      expect(exits).toEqual([130]);

      const lines = readFileSync(historyPath, "utf8").trim().split("\n");
      expect(lines).toHaveLength(1);
      const line = JSON.parse(lines[0] ?? "") as Record<string, unknown>;
      expect(line).toMatchObject({
        schema_version: 2,
        run_id: "run-c14",
        runner: "local-dev",
        nimbus_git_sha: "deadbeef",
        bun_version: "1.3.14",
        os_version: "test-os",
        surfaces: {},
        incomplete: true,
        // The SIGNAL is the reason — the factory's own `reason` field is overwritten, not kept.
        incomplete_reason: "interrupted-by-SIGTERM",
      });

      handle.uninstall();
      expect(process.listeners("SIGINT")).not.toContain(handle.sigint[0]);
      expect(process.listeners("SIGTERM")).not.toContain(handle.sigterm[0]);
    } finally {
      handle.uninstall();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a context factory that throws still exits 130 — and writes nothing half-formed", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-signal-handler-"));
    const historyPath = join(dir, "history.jsonl");
    const boom = new Error("git sha unavailable");
    const handle = install(historyPath, () => {
      throw boom;
    });
    try {
      const { exits, thrown } = withRecordedExit(() => handle.sigint[0]?.("SIGINT"));
      // The exit is in a `finally`: an interrupted run must never hang around because the
      // bookkeeping for it failed.
      expect(exits).toEqual([130]);
      expect(thrown).toBe(boom);
      expect(existsSync(historyPath)).toBe(false);
    } finally {
      handle.uninstall();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
