import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { BLOCK_MS } from "./_lib/free-busy-blocks.ts";
import { answerFederatedFreeBusy, type FreeBusyGateCtx } from "./free-busy-gate.ts";
import { FreeBusyLimiter, MAX_PER_PEER_PER_HOUR } from "./free-busy-limiter.ts";

const NOW = 1_800_000_000_000 - (1_800_000_000_000 % BLOCK_MS);
const FROM = NOW + 2 * BLOCK_MS;
const TO = FROM + 8 * BLOCK_MS; // 8 blocks
let db: Database;
let n = 0;

function event(meta: Record<string, unknown>, opts: { title?: string; service?: string } = {}) {
  n += 1;
  db.run(
    `INSERT INTO item (id,service,type,external_id,title,body_preview,modified_at,synced_at,metadata)
     VALUES (?, ?, 'event', ?, ?, 'BODY-SECRET', ?, 1, ?)`,
    [
      `ev:${String(n)}`,
      opts.service ?? "google_calendar",
      String(n),
      opts.title ?? "TITLE-SECRET",
      n,
      JSON.stringify({
        attendee_count: 7,
        organizer_email: "boss-secret@example.com",
        location: "ROOM-SECRET",
        all_day: false,
        status: "confirmed",
        self_response: "accepted",
        ...meta,
      }),
    ],
  );
}
const at = (startBlock: number, blocks: number) => ({
  start_ms: FROM + startBlock * BLOCK_MS,
  end_ms: FROM + (startBlock + blocks) * BLOCK_MS,
});

function ctx(over: Partial<FreeBusyGateCtx> = {}): FreeBusyGateCtx {
  return {
    db,
    limiter: new FreeBusyLimiter(),
    requestApproval: async () => true,
    now: () => NOW,
    ...over,
  };
}
const ask = (c: FreeBusyGateCtx, from: unknown = FROM, to: unknown = TO) =>
  answerFederatedFreeBusy(c, { peerId: "peer:aa", fromMs: from, toMs: to });
const blocksOf = (r: Awaited<ReturnType<typeof ask>>): string =>
  r.kind === "ok" ? r.reply.blocks : `error:${r.error}`;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  db.run("INSERT INTO sync_state (connector_id,last_sync_at) VALUES ('google_calendar', ?)", [
    NOW - 3_600_000,
  ]);
  n = 0;
});
afterEach(() => db.close());

describe("answering", () => {
  test("an approved request is answered with blocks only", async () => {
    event(at(1, 2));
    expect(blocksOf(await ask(ctx()))).toBe("01100000");
  });

  test("an empty calendar answers all free (not a refusal)", async () => {
    expect(blocksOf(await ask(ctx()))).toBe("00000000");
  });

  test("the wire reply never contains a title, attendee, place, organiser or body", async () => {
    event(at(0, 3));
    event(at(5, 1), { title: "OTHER-TITLE" });
    const wire = JSON.stringify(await ask(ctx()));
    for (const secret of [
      "TITLE-SECRET",
      "OTHER-TITLE",
      "boss-secret",
      "ROOM-SECRET",
      "BODY-SECRET",
    ]) {
      expect(wire).not.toContain(secret);
    }
    expect(Object.keys(JSON.parse(wire).reply).sort()).toEqual(["blockMs", "blocks", "fromMs"]);
  });

  test("the reply is identical whether busy blocks came from a private or a public event", async () => {
    event({ ...at(1, 2), visibility: "private" }, { title: "Secret therapy" });
    const a = await ask(ctx());
    db.run("DELETE FROM item");
    event({ ...at(1, 2), visibility: "public" }, { title: "All-hands", service: "outlook" });
    db.run("INSERT OR REPLACE INTO sync_state (connector_id,last_sync_at) VALUES ('outlook', ?)", [
      NOW - 1000,
    ]);
    const b = await ask(ctx());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  test("the audit row holds the peer, the window and counts, never event text", async () => {
    event(at(0, 1));
    await ask(ctx());
    const rows = db
      .query("SELECT action_type, action_json, hitl_status FROM audit_log")
      .all() as Array<{ action_type: string; action_json: string; hitl_status: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.action_type).toBe("federation.freebusy.answered");
    expect(rows[0]?.hitl_status).toBe("approved");
    expect(rows[0]?.action_json).not.toContain("SECRET");
    expect(JSON.parse(rows[0]?.action_json ?? "{}")).toMatchObject({
      peerId: "peer:aa",
      scanned: 1,
    });
  });
});

describe("how an event counts", () => {
  test("cancelled and declined are free; tentative and unanswered are busy; all-day is ignored", async () => {
    event({ ...at(0, 1), status: "cancelled" });
    event({ ...at(1, 1), self_response: "declined" });
    event({ ...at(2, 1), status: "tentative" });
    event({ ...at(3, 1), self_response: "needs-action" });
    event({ ...at(4, 1), self_response: "tentative" });
    event({ ...at(5, 1), all_day: true });
    expect(blocksOf(await ask(ctx()))).toBe("00111000");
  });

  test("overlapping events from two services merge; an event outside the window is ignored", async () => {
    event(at(1, 2));
    event(at(2, 2), { service: "apple" });
    event({ start_ms: FROM - 4 * BLOCK_MS, end_ms: FROM });
    event({ start_ms: TO, end_ms: TO + BLOCK_MS });
    expect(blocksOf(await ask(ctx()))).toBe("01110000");
  });

  test("a row with no usable time is counted, never guessed", async () => {
    db.run(
      `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at,metadata)
       VALUES ('ev:x','google_calendar','event','x','t',1,1,'not json')`,
    );
    event({ all_day: false, status: "confirmed" });
    await ask(ctx());
    const j = db.query("SELECT action_json FROM audit_log").get() as { action_json: string };
    expect(JSON.parse(j.action_json).unreadable).toBe(2);
  });
});

describe("the owner approves each request", () => {
  test("a denial is a fixed refusal, audited as rejected", async () => {
    event(at(0, 2));
    let asked = 0;
    const r = await ask(
      ctx({
        requestApproval: async (input) => {
          asked += 1;
          expect(input).toEqual({ peerId: "peer:aa", fromMs: FROM, toMs: TO });
          return false;
        },
      }),
    );
    expect(asked).toBe(1);
    expect(r).toEqual({ kind: "error", error: "declined" });
    const row = db.query("SELECT action_type, hitl_status FROM audit_log").get() as {
      action_type: string;
      hitl_status: string;
    };
    expect(row).toEqual({ action_type: "federation.freebusy.declined", hitl_status: "rejected" });
  });

  test("a denial is not an empty calendar: the one answers an error, the other all-free blocks", async () => {
    const denied = await ask(ctx({ requestApproval: async () => false }));
    const empty = await ask(ctx());
    expect(denied.kind).toBe("error");
    expect(empty.kind).toBe("ok");
  });

  test("a denial reveals nothing about events: the same refusal with and without events", async () => {
    const deny = ctx({ requestApproval: async () => false, limiter: new FreeBusyLimiter() });
    const without = JSON.stringify(await ask(deny));
    event(at(0, 8));
    const withEvents = JSON.stringify(await ask({ ...deny, limiter: new FreeBusyLimiter() }));
    expect(withEvents).toBe(without);
  });

  test("an invalid operator identity is the same refusal and no prompt is shown", async () => {
    let asked = 0;
    const r = await ask(
      ctx({
        identity: { enabled: true, isOperatorValid: () => false },
        requestApproval: async () => {
          asked += 1;
          return true;
        },
      }),
    );
    expect(r).toEqual({ kind: "error", error: "declined" });
    expect(asked).toBe(0);
  });

  test("an invalid window is refused before any prompt", async () => {
    let asked = 0;
    const c = ctx({
      requestApproval: async () => {
        asked += 1;
        return true;
      },
    });
    for (const [f, t] of [
      [FROM + 1, TO],
      [TO, FROM],
      [FROM, FROM + 15 * 86_400_000],
      ["x", TO],
    ] as const) {
      expect(await ask(c, f, t)).toEqual({ kind: "error", error: "invalid_window" });
    }
    expect(asked).toBe(0);
  });
});

describe("calendar freshness fails closed", () => {
  test("no calendar connected, or a stale one, is calendar_unavailable after the approval", async () => {
    db.run("DELETE FROM sync_state");
    expect(await ask(ctx())).toEqual({ kind: "error", error: "calendar_unavailable" });
    db.run("INSERT INTO sync_state (connector_id,last_sync_at) VALUES ('google_calendar', ?)", [
      NOW - 25 * 3_600_000,
    ]);
    expect(await ask(ctx())).toEqual({ kind: "error", error: "calendar_unavailable" });
  });
});

describe("rate limits", () => {
  test("at most one open prompt per peer", async () => {
    let release: (v: boolean) => void = () => {};
    const c = ctx({
      requestApproval: () =>
        new Promise<boolean>((r) => {
          release = r;
        }),
    });
    const first = ask(c);
    expect(await ask(c)).toEqual({ kind: "error", error: "rate_limited" });
    release(true);
    expect((await first).kind).toBe("ok");
  });

  test("a peer gets at most six prompts an hour, declined ones included", async () => {
    const c = ctx({ requestApproval: async () => false });
    for (let i = 0; i < MAX_PER_PEER_PER_HOUR; i++) {
      expect(await ask(c)).toEqual({ kind: "error", error: "declined" });
    }
    expect(await ask(c)).toEqual({ kind: "error", error: "rate_limited" });
  });

  test("the limiter forgets an hour later", () => {
    const l = new FreeBusyLimiter();
    for (let i = 0; i < MAX_PER_PEER_PER_HOUR; i++) {
      expect(l.tryAcquire("p", 1000 + i)).toBe(true);
      l.release("p");
    }
    expect(l.tryAcquire("p", 2000)).toBe(false);
    expect(l.tryAcquire("p", 1000 + 3_600_001)).toBe(true);
  });

  test("at most three prompts are open across all peers", () => {
    const l = new FreeBusyLimiter();
    expect(l.tryAcquire("a", 1)).toBe(true);
    expect(l.tryAcquire("b", 1)).toBe(true);
    expect(l.tryAcquire("c", 1)).toBe(true);
    expect(l.tryAcquire("d", 1)).toBe(false);
  });
});
