import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { insertExtensionRow } from "../../automation/extension-store.ts";
import { dbRun } from "../../db/write.ts";
import { runIndexedSchemaMigrations } from "../../index/migrations/runner.ts";
import {
  createObservationNotifier,
  NOTICE_INTERVAL_MS,
  type NoticeFinding,
  noticeText,
  observationFindingsFor,
} from "./observation-notifier.ts";
import {
  applyObservationWindow,
  type ObservationWindow,
  readNoticeAt,
} from "./observation-store.ts";

const EXT = "com.example.a";
const HOUR = 3_600_000;
let dir: string;
let db: Database;
let nowMs: number;
let sent: Array<{ title: string; body: string }>;
let finding: NoticeFinding | null;

function addExt(id: string, version = "1.0.0"): void {
  insertExtensionRow(db, {
    id,
    version,
    install_path: join(dir, id),
    manifest_hash: "m",
    entry_hash: "e",
    installed_at: 1,
    last_verified_at: 1,
  });
}

function notifier(over: Partial<Parameters<typeof createObservationNotifier>[0]> = {}) {
  return createObservationNotifier({
    db,
    now: () => nowMs,
    notify: async (title, body) => {
      sent.push({ title, body });
    },
    findingsFor: () => finding,
    ...over,
  });
}

const TOUCHED = [{ extensionId: EXT, version: "1.0.0" }] as const;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "obs-notice-"));
  db = new Database(join(dir, "i.db"));
  dbRun(db, "PRAGMA foreign_keys = ON");
  runIndexedSchemaMigrations(db, 82);
  addExt(EXT);
  nowMs = 1_000 * HOUR;
  sent = [];
  finding = { os: "linux", count: 500, newestLastSeen: nowMs - 1000 };
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("noticeText", () => {
  test("Linux: the lookup was refused, so nothing was reached", () => {
    expect(noticeText(EXT, "linux", 3)).toEqual({
      title: "Nimbus: com.example.a was refused an undeclared network lookup",
      body: "3 undeclared name(s) were looked up and refused. Run nimbus extension audit com.example.a.",
    });
  });

  test("Windows and macOS: an address not matched, never a host name", () => {
    const expected = {
      title: "Nimbus: com.example.a connected to an address not matched to a declared host",
      body: "4 address(es) could not be matched to a declared host. Run nimbus extension audit com.example.a.",
    };
    expect(noticeText(EXT, "win32", 4)).toEqual(expected);
    expect(noticeText(EXT, "darwin", 4)).toEqual(expected);
  });
});

describe("createObservationNotifier", () => {
  test("one notification for 500 findings, summarising the count", async () => {
    await notifier().afterIngest([...TOUCHED, ...TOUCHED]);
    expect(sent).toEqual([noticeText(EXT, "linux", 500)]);
    expect(readNoticeAt(db, EXT, "1.0.0")).toBe(nowMs);
  });

  test("no finding, no notification and no notice row", async () => {
    finding = null;
    await notifier().afterIngest(TOUCHED);
    expect(sent).toEqual([]);
    expect(readNoticeAt(db, EXT, "1.0.0")).toBeUndefined();
  });

  test("none again within 24 h, even with new findings", async () => {
    const n = notifier();
    await n.afterIngest(TOUCHED);
    nowMs += NOTICE_INTERVAL_MS - 1;
    finding = { os: "linux", count: 900, newestLastSeen: nowMs - 10 };
    await n.afterIngest(TOUCHED);
    expect(sent).toHaveLength(1);
  });

  test("one again after 24 h when a finding stayed active past the last notice", async () => {
    const n = notifier();
    await n.afterIngest(TOUCHED);
    const notified = nowMs;
    nowMs += NOTICE_INTERVAL_MS;
    finding = { os: "linux", count: 500, newestLastSeen: notified + 5 };
    await n.afterIngest(TOUCHED);
    expect(sent).toHaveLength(2);
    expect(readNoticeAt(db, EXT, "1.0.0")).toBe(nowMs);
  });

  test("none after 24 h when nothing was active since the last notice", async () => {
    const n = notifier();
    await n.afterIngest(TOUCHED);
    const notified = nowMs;
    nowMs += 3 * NOTICE_INTERVAL_MS;
    finding = { os: "linux", count: 500, newestLastSeen: notified };
    await n.afterIngest(TOUCHED);
    expect(sent).toHaveLength(1);
  });

  test("a window for a superseded version never notifies", async () => {
    await notifier().afterIngest([{ extensionId: EXT, version: "0.9.0" }]);
    expect(sent).toEqual([]);
    expect(readNoticeAt(db, EXT, "0.9.0")).toBeUndefined();
  });

  test("an extension that is no longer installed never notifies", async () => {
    await notifier().afterIngest([{ extensionId: "com.example.gone", version: "1.0.0" }]);
    expect(sent).toEqual([]);
  });

  test("per version: a new installed version starts clean", async () => {
    const n = notifier();
    await n.afterIngest(TOUCHED);
    dbRun(db, "UPDATE extension SET version = '2.0.0' WHERE id = ?", [EXT]);
    nowMs += HOUR;
    finding = { os: "linux", count: 1, newestLastSeen: nowMs - 1 };
    await n.afterIngest([{ extensionId: EXT, version: "2.0.0" }]);
    expect(sent).toHaveLength(2);
    expect(readNoticeAt(db, EXT, "2.0.0")).toBe(nowMs);
  });

  test("two overlapping passes send one", async () => {
    let release = (): void => {};
    const gate = new Promise<void>((r) => {
      release = r;
    });
    let calls = 0;
    const n = notifier({
      notify: async () => {
        calls += 1;
        await gate;
      },
    });
    const a = n.afterIngest(TOUCHED);
    const b = n.afterIngest(TOUCHED);
    release();
    await Promise.all([a, b]);
    expect(calls).toBe(1);
  });

  test("a notify that throws or rejects is swallowed, and the notice is still written", async () => {
    await notifier({
      notify: () => {
        throw new Error("no D-Bus");
      },
    }).afterIngest(TOUCHED);
    expect(readNoticeAt(db, EXT, "1.0.0")).toBe(nowMs);
    addExt("com.example.b");
    await notifier({ notify: () => Promise.reject(new Error("off")) }).afterIngest([
      { extensionId: "com.example.b", version: "1.0.0" },
    ]);
    expect(readNoticeAt(db, "com.example.b", "1.0.0")).toBe(nowMs);
  });

  test("a findingsFor that throws is logged and skips only that extension", async () => {
    addExt("com.example.b");
    const logs: string[] = [];
    await notifier({
      findingsFor: (id) => {
        if (id === EXT) throw new Error("bad");
        return finding;
      },
      log: (l) => logs.push(l),
    }).afterIngest([...TOUCHED, { extensionId: "com.example.b", version: "1.0.0" }]);
    expect(sent).toEqual([noticeText("com.example.b", "linux", 500)]);
    expect(logs.some((l) => l.includes("bad"))).toBe(true);
  });
});

describe("observationFindingsFor", () => {
  function win(over: Partial<ObservationWindow>): ObservationWindow {
    return {
      runKey: "ext_com_example_a.1.deadbeef",
      seq: 0,
      extensionId: EXT,
      version: "1.0.0",
      os: "linux",
      networkObserved: true,
      runStart: true,
      fromMs: 1000,
      toMs: 2000,
      entries: [],
      dropped: 0,
      ...over,
    };
  }

  function grant(network: string[]): void {
    dbRun(
      db,
      `INSERT INTO extension_run_grant (extension_id, service_id, version, tree_digest, permissions_json, approved_at)
       VALUES (?, 'ext_com_example_a', '1.0.0', 'd', ?, 1)`,
      [EXT, JSON.stringify({ network, read: [], write: [] })],
    );
  }

  test("nothing observed: null", () => {
    expect(observationFindingsFor(db, EXT, "1.0.0")).toBeNull();
  });

  test("Linux: counts refused undeclared names, newest last_seen among them only", () => {
    grant(["api.github.com:443"]);
    applyObservationWindow(
      db,
      win({
        entries: [
          { outcome: "refused", destination: "evil.example", port: 443, count: 3 },
          { outcome: "used", destination: "api.github.com", port: 443, count: 1 },
        ],
      }),
    );
    // A declared host refused later (pool full) is not a finding and must not move the time.
    applyObservationWindow(
      db,
      win({
        seq: 1,
        runStart: false,
        fromMs: 5000,
        toMs: 9000,
        entries: [{ outcome: "refused", destination: "API.github.com.", port: 443, count: 1 }],
      }),
    );
    expect(observationFindingsFor(db, EXT, "1.0.0")).toEqual({
      os: "linux",
      count: 1,
      newestLastSeen: 2000,
    });
  });

  test("Windows: counts unmatched addresses", () => {
    applyObservationWindow(
      db,
      win({
        os: "win32",
        toMs: 4000,
        entries: [
          { outcome: "unmatched", destination: "203.0.113.7", port: 443, count: 2 },
          { outcome: "unmatched", destination: "203.0.113.8", port: 80, count: 1 },
        ],
      }),
    );
    expect(observationFindingsFor(db, EXT, "1.0.0")).toEqual({
      os: "win32",
      count: 2,
      newestLastSeen: 4000,
    });
  });
});
