import { Database } from "bun:sqlite";
import { afterEach, beforeEach, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { BLOCK_MS } from "./_lib/free-busy-blocks.ts";
import { askPeerFreeBusy } from "./schedule-ask.ts";

const NOW = 1_800_000_000_000 - (1_800_000_000_000 % BLOCK_MS);
const FROM = NOW + 2 * BLOCK_MS;
const TO = FROM + 4 * BLOCK_MS;
let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 33);
  db.run("INSERT INTO sync_state (connector_id,last_sync_at) VALUES ('outlook', ?)", [NOW - 1000]);
});
afterEach(() => db.close());

const input = { fromMs: FROM, toMs: TO, durationMs: BLOCK_MS };
const deps = (send: (p: { fromMs: number; toMs: number }) => Promise<unknown>) => ({
  db,
  send,
  now: () => NOW,
});
const ok = (blocks: string) => async () => ({
  kind: "ok",
  reply: { fromMs: FROM, blockMs: BLOCK_MS, blocks },
});

test("intersects the peer's blocks with the owner's own", async () => {
  db.run(
    `INSERT INTO item (id,service,type,external_id,title,modified_at,synced_at,metadata)
     VALUES ('e','outlook','event','e','t',1,1,?)`,
    [JSON.stringify({ start_ms: FROM, end_ms: FROM + BLOCK_MS, status: "confirmed" })],
  );
  const r = await askPeerFreeBusy(deps(ok("0010")), input);
  expect(r).toMatchObject({
    kind: "ok",
    slots: [
      { startMs: FROM + BLOCK_MS, endMs: FROM + 2 * BLOCK_MS },
      { startMs: FROM + 3 * BLOCK_MS },
    ],
  });
});

test("a window the gateway would refuse is refused here, before anything is sent", async () => {
  let sent = 0;
  const r = await askPeerFreeBusy(
    deps(async () => {
      sent += 1;
      return {};
    }),
    { ...input, toMs: TO + 1 },
  );
  expect(r).toEqual({ kind: "error", error: "invalid_window" });
  expect(sent).toBe(0);
});

test("an owner with no fresh calendar is told so and nothing is sent", async () => {
  db.run("DELETE FROM sync_state");
  let sent = 0;
  const r = await askPeerFreeBusy(
    deps(async () => {
      sent += 1;
      return {};
    }),
    input,
  );
  expect(r).toEqual({ kind: "error", error: "own_calendar_unavailable" });
  expect(sent).toBe(0);
});

test("the peer's refusals pass through as their fixed codes", async () => {
  for (const code of ["declined", "rate_limited", "invalid_window", "calendar_unavailable"]) {
    expect(
      await askPeerFreeBusy(
        deps(async () => ({ kind: "error", error: code })),
        input,
      ),
    ).toEqual({
      kind: "error",
      error: code as "declined",
    });
  }
});

test("an unknown refusal, a malformed reply and a transport failure are distinct, fixed errors", async () => {
  expect(
    await askPeerFreeBusy(
      deps(async () => ({ kind: "error", error: "x" })),
      input,
    ),
  ).toEqual({
    kind: "error",
    error: "malformed_reply",
  });
  expect(await askPeerFreeBusy(deps(ok("01")), input)).toEqual({
    kind: "error",
    error: "malformed_reply",
  });
  expect(
    await askPeerFreeBusy(
      deps(async () => {
        throw new Error("boom");
      }),
      input,
    ),
  ).toEqual({ kind: "error", error: "peer_unreachable" });
});
