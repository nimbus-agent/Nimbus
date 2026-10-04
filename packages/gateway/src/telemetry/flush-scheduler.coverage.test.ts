/**
 * The telemetry session-id file's failure arms, which `flush-scheduler.test.ts` does not reach:
 *  - the path exists but cannot be READ as a file (a directory sits there),
 *  - the data directory itself is missing, so the exclusive create fails with ENOENT, and
 *  - (POSIX) every exclusive create fails with EEXIST, which must stay BOUNDED.
 *
 * In every case the flush still goes out with a well-formed, freshly minted session id — a
 * session file the gateway cannot use is never a reason to drop telemetry or to crash the tick —
 * and nothing is written in place of the obstacle.
 *
 * No sleeps: the first tick runs synchronously inside `startTelemetryFlushScheduler`, and `fetch`
 * is invoked synchronously within it, so each payload is recorded before the call returns. The
 * interval and `fetch` globals are swapped only for that synchronous span and always restored.
 */
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";

import { parseStoredTelemetrySessionId, startTelemetryFlushScheduler } from "./flush-scheduler.ts";

const SESSION_FILE = ".nimbus-telemetry-session";

/** Runs two flush ticks against `dataDir` and returns the session id each one sent. */
function twoTicks(dataDir: string, tomlDir: string): string[] {
  const tomlPath = join(tomlDir, "nimbus.toml");
  writeFileSync(
    tomlPath,
    '[telemetry]\nenabled = true\nflush_interval_seconds = 60\nendpoint = "https://telemetry.invalid/ingest"\n',
    "utf8",
  );
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT NOT NULL, body TEXT);
    CREATE TABLE embedding_chunk (id INTEGER PRIMARY KEY, item_id TEXT NOT NULL);
    CREATE TABLE sync_state (connector_id TEXT PRIMARY KEY, last_sync_at INTEGER);
  `);
  const sessionIds: string[] = [];
  let tick: (() => void) | undefined;
  const realSetInterval = globalThis.setInterval;
  const realClearInterval = globalThis.clearInterval;
  const realFetch = globalThis.fetch;
  try {
    globalThis.setInterval = ((fn: () => void) => {
      tick = fn;
      return 0;
    }) as unknown as typeof setInterval;
    globalThis.clearInterval = (() => {}) as unknown as typeof clearInterval;
    globalThis.fetch = ((_url: string, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { session_id: string };
      sessionIds.push(body.session_id);
      return Promise.resolve(new Response(null, { status: 204 }));
    }) as unknown as typeof fetch;

    const handle = startTelemetryFlushScheduler({
      dataDir,
      activeTomlPath: tomlPath,
      getDatabase: () => db,
      gatewayVersion: "0.0.0-cov",
      logger: pino({ level: "silent" }),
    });
    tick?.();
    handle.stop();
  } finally {
    globalThis.setInterval = realSetInterval;
    globalThis.clearInterval = realClearInterval;
    globalThis.fetch = realFetch;
    db.close();
  }
  return sessionIds;
}

/** Both ticks flushed, each with a valid v4 id, and the two ids differ (nothing was persisted). */
function expectFreshIdPerTick(ids: string[]): void {
  expect(ids).toHaveLength(2);
  for (const id of ids) expect(parseStoredTelemetrySessionId(id)).toBe(id);
  expect(ids[0]).not.toBe(ids[1]);
}

describe("telemetry session id — when the session file cannot be used", () => {
  test("a DIRECTORY at the session path: unreadable, so each flush mints a fresh id and the directory is left alone", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-flush-cov-"));
    try {
      mkdirSync(join(dir, SESSION_FILE));
      expectFreshIdPerTick(twoTicks(dir, dir));
      expect(lstatSync(join(dir, SESSION_FILE)).isDirectory()).toBe(true);
      expect(readdirSync(join(dir, SESSION_FILE))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a MISSING data directory: the exclusive create fails, the flush still goes out, and nothing is created", () => {
    const root = mkdtempSync(join(tmpdir(), "nimbus-flush-cov-"));
    try {
      const dataDir = join(root, "data-dir-never-created");
      expectFreshIdPerTick(twoTicks(dataDir, root));
      expect(existsSync(dataDir)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  // POSIX only, by premise rather than by guess: `open(O_CREAT|O_EXCL)` on a dangling symlink
  // fails with EEXIST there, while reading through it is ENOENT — the exact "someone else created
  // it between my read and my create" shape the retry loop exists for, made permanent. Windows
  // FOLLOWS the link on an exclusive create and writes the target instead, so the shape cannot be
  // built there. The premise is asserted on a separate link before the scheduler runs.
  test.skipIf(process.platform === "win32")(
    "EEXIST on every create attempt: the retry loop is bounded and still yields a fresh id",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "nimbus-flush-cov-"));
      try {
        const probe = join(dir, "premise-link");
        symlinkSync(join(dir, "premise-target"), probe);
        let code: string | undefined;
        try {
          writeFileSync(probe, "x", { flag: "wx" });
        } catch (e) {
          code = (e as NodeJS.ErrnoException).code;
        }
        expect(code).toBe("EEXIST");

        const link = join(dir, SESSION_FILE);
        symlinkSync(join(dir, "never-created-target"), link);
        expectFreshIdPerTick(twoTicks(dir, dir));
        // Neither followed nor replaced: still a symlink, still dangling.
        expect(lstatSync(link).isSymbolicLink()).toBe(true);
        expect(existsSync(join(dir, "never-created-target"))).toBe(false);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );
});
