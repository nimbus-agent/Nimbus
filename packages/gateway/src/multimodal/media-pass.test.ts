import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { findCandidates } from "./media-discovery.ts";
import type { MediaPassDeps } from "./media-pass.ts";
import { runMediaPass } from "./media-pass.ts";
import { writeCursor } from "./media-pass-state.ts";
import { understandingExternalId } from "./understanding-item.ts";

let db: Database;
let root: string;

function addMediaFile(name: string): string {
  const p = join(root, name);
  writeFileSync(p, "x");
  upsertIndexedItem(db, {
    service: "filesystem",
    type: "media_av",
    externalId: p,
    title: name,
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: { path: p, sizeBytes: 1, mediaKind: "av" },
  });
  return p;
}

function deps(over: Partial<MediaPassDeps> = {}): MediaPassDeps {
  return {
    db,
    roots: [root],
    limit: 100,
    maxBytes: 1_000_000,
    nowMs: () => 5000,
    passId: "default",
    gate: {
      enabled: true,
      capabilityDisabled: false,
      understanderFor: () => ({
        isLocal: true,
        model: "whisper-base",
        isAvailable: async () => true,
        understand: async () => ({ text: "transcript" }),
      }),
      gpu: { acquire: async () => () => undefined, touch: () => undefined },
    },
    ...over,
  };
}

beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  root = mkdtempSync(join(tmpdir(), "nimbus-pass-"));
});

describe("runMediaPass", () => {
  test("understands each candidate and writes a derived item", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps());
    expect(summary.understood).toBe(1);

    const rows = db
      .query<{ body: string | null }, []>(
        "SELECT body FROM item WHERE service='nimbus' AND type='video_understanding'",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.body).toBe("transcript");
  });

  test("is idempotent — a second run understands nothing new", async () => {
    addMediaFile("a.mp4");
    await runMediaPass(deps());
    const second = await runMediaPass(deps({ passId: "second" }));
    expect(second.understood).toBe(0);
  });

  test("honours the limit budget", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    addMediaFile("c.mp4");
    expect((await runMediaPass(deps({ limit: 2 }))).understood).toBe(2);
  });

  test("a per-artifact failure does NOT abort the pass", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    let calls = 0;
    const summary = await runMediaPass(
      deps({
        gate: {
          enabled: true,
          capabilityDisabled: false,
          understanderFor: () => ({
            isLocal: true,
            model: "m",
            isAvailable: async () => true,
            understand: async () => {
              calls += 1;
              if (calls === 1) throw new Error("first one fails");
              return { text: "ok" };
            },
          }),
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(1);
    expect(summary.skippedByReason["transcribe_failed"]).toBe(1);
  });

  test("reports skips BY REASON — a bare success line is the disclosure failure", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(
      deps({ roots: [] }), // nothing is inside a configured root
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["path_outside_roots"]).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  test("refuses everything when the capability is disabled", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(
      deps({
        gate: {
          enabled: false,
          capabilityDisabled: false,
          understanderFor: () => undefined,
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["no_local_model"]).toBe(1);
  });

  test("advances the cursor so an interrupted pass resumes", async () => {
    addMediaFile("a.mp4");
    // A second candidate the limit does not reach: this run is genuinely INTERRUPTED (more work
    // remains), distinct from a drained run — which, correctly, clears the cursor instead (see
    // "runMediaPass — cursor resume" below). limit:1 is what keeps candidates.length < limit
    // false, so the cursor this run wrote is not cleared out from under the assertion.
    addMediaFile("zz-remainder.mp4");
    const summary = await runMediaPass(deps({ limit: 1 }));
    expect(summary.lastItemId).not.toBeNull();
    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id ?? null).toBe(summary.lastItemId);
  });

  test("advances the cursor on a SKIP, so a resumed pass does not restart on the same artifact", async () => {
    addMediaFile("unreadable.mp4");
    // A second candidate + limit:1 keeps this run from draining the queue (see above) — the
    // property under test is the mid-run advance, not the drain-clear this same run would
    // otherwise also trigger.
    addMediaFile("zz-remainder.mp4");
    // roots: [] means every candidate refuses with path_outside_roots before the gate is reached.
    const summary = await runMediaPass(deps({ roots: [], limit: 1 }));
    expect(summary.understood).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(summary.lastItemId).not.toBeNull();

    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id ?? null).toBe(summary.lastItemId);
  });

  test("advances the cursor on a gate-refusal SKIP too — the second skip branch", async () => {
    addMediaFile("unreadable.mp4");
    // Same reason as the two tests above: a second candidate + limit:1 keeps this an interrupted
    // (not drained) run.
    addMediaFile("zz-remainder.mp4");
    // capability disabled means resolveLocalMediaPath succeeds but understandArtifact refuses —
    // the OTHER skip branch, distinct from path_outside_roots above.
    const summary = await runMediaPass(
      deps({
        limit: 1,
        gate: {
          enabled: false,
          capabilityDisabled: false,
          understanderFor: () => undefined,
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["no_local_model"]).toBe(1);
    expect(summary.lastItemId).not.toBeNull();

    const cursor = db
      .query<{ last_item_id: string }, []>("SELECT last_item_id FROM media_pass_cursor")
      .get();
    expect(cursor?.last_item_id ?? null).toBe(summary.lastItemId);
  });

  test("appends ZERO egress rows — this PR makes no outbound request", async () => {
    addMediaFile("a.mp4");
    await runMediaPass(deps());
    const n = db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM egress_ledger").get()?.n;
    expect(n).toBe(0);
  });

  test("a long transcript is stored in full, not truncated to the 512-char preview cap", async () => {
    addMediaFile("long.mp4");
    const long = "x".repeat(3_000);
    await runMediaPass(
      deps({
        gate: {
          enabled: true,
          capabilityDisabled: false,
          understanderFor: () => ({
            isLocal: true,
            model: "m",
            isAvailable: async () => true,
            understand: async () => ({ text: long }),
          }),
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    const row = db
      .query<{ body: string | null }, []>(
        "SELECT body FROM item WHERE service='nimbus' AND type='video_understanding'",
      )
      .get();
    expect(row?.body?.length).toBe(3_000);
  });
});

describe("runMediaPass — discovery filters threaded through", () => {
  test("passes deps.service through to discovery, excluding other services", async () => {
    const p = addMediaFile("a.mp4");
    upsertIndexedItem(db, {
      service: "onedrive",
      type: "media_av",
      externalId: "cloud-1",
      title: "cloud.mp4",
      bodyPreview: "",
      modifiedAt: 1000,
      syncedAt: 1000,
      metadata: { path: p, sizeBytes: 1, mediaKind: "av" },
    });
    // Only "filesystem" resolves a modality (the registry has no onedrive entry), so scoping to
    // "filesystem" should understand exactly the one filesystem candidate.
    const summary = await runMediaPass(deps({ service: "filesystem" }));
    expect(summary.understood).toBe(1);
  });

  test("passes deps.modality through to discovery", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps({ modality: "av" }));
    expect(summary.understood).toBe(1);
  });

  test("an unmatched modality filter understands nothing", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps({ modality: "image" }));
    expect(summary.understood).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  test("passes deps.sinceMs through to discovery, excluding older items", async () => {
    const p = join(root, "old.mp4");
    writeFileSync(p, "x");
    upsertIndexedItem(db, {
      service: "filesystem",
      type: "media_av",
      externalId: p,
      title: "old.mp4",
      bodyPreview: "",
      modifiedAt: 100,
      syncedAt: 100,
      metadata: { path: p, sizeBytes: 1, mediaKind: "av" },
    });
    const summary = await runMediaPass(deps({ sinceMs: 500 }));
    expect(summary.understood).toBe(0);
    expect(summary.skipped).toBe(0);
  });

  test("passes deps.afterItemId through to discovery, resuming past a cursor", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    // Neither has been understood yet — find their ids and sort order WITHOUT running a pass,
    // so the isolation is on the afterItemId filter, not on idempotency (an already-understood
    // item is excluded from candidates regardless of afterItemId, which would make this test
    // pass for the wrong reason).
    const [first] = findCandidates(db, { limit: 1 });
    if (first === undefined) throw new Error("expected a candidate");

    const summary = await runMediaPass(deps({ afterItemId: first.itemId }));
    // Exactly one candidate sorts after the cursor — proof the filter reached discovery, since
    // without it both a.mp4 and b.mp4 (neither yet understood) would be eligible.
    expect(summary.understood).toBe(1);
  });
});

describe("runMediaPass — scratch sweep", () => {
  test("sweeps stale scratch WAVs at the start of the pass when scratchDir is set", async () => {
    const scratchDir = mkdtempSync(join(tmpdir(), "nimbus-scratch-"));
    const stale = join(scratchDir, "nimbus-stt-old.wav");
    writeFileSync(stale, "x");
    // Backdate the file well past the sweep's default 1h max age.
    const past = new Date(Date.now() - 2 * 60 * 60 * 1000);
    utimesSync(stale, past, past);

    addMediaFile("a.mp4");
    await runMediaPass(deps({ scratchDir, nowMs: () => Date.now() }));

    expect(existsSync(stale)).toBe(false);
  });

  test("runs with no scratch sweep at all when scratchDir is omitted", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps());
    expect(summary.understood).toBe(1);
  });
});

describe("runMediaPass — cursor resume", () => {
  test("resumes from the stored cursor when afterItemId is not explicitly supplied", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    addMediaFile("c.mp4");
    const [first] = findCandidates(db, { limit: 1 });
    if (first === undefined) throw new Error("expected a candidate");
    // Seed the cursor exactly as an earlier, interrupted run would have left it — WITHOUT
    // running a pass first, so this isolates the READ half of resumability from the WRITE half
    // (already covered by the "advances the cursor" tests above).
    writeCursor(db, "default", { lastItemId: first.itemId, processedCount: 1, nowMs: 5000 });

    const summary = await runMediaPass(deps());

    // Two candidates sort after the seeded cursor — the first is not reprocessed.
    expect(summary.understood).toBe(2);
    const understoodFirst = db
      .query<{ n: number }, [string]>(
        "SELECT COUNT(*) AS n FROM item WHERE service='nimbus' AND external_id = ?",
      )
      .get(understandingExternalId(first.itemId));
    expect(understoodFirst?.n).toBe(0);
  });

  test("an explicit afterItemId overrides the stored cursor", async () => {
    addMediaFile("a.mp4");
    addMediaFile("b.mp4");
    addMediaFile("c.mp4");
    const candidates = findCandidates(db, { limit: 3 });
    const [first, second] = candidates;
    if (first === undefined || second === undefined) throw new Error("expected two candidates");
    // Seed the cursor at the SECOND item. If the caller's explicit afterItemId did not win, this
    // run would resume from "second" and understand only the third candidate.
    writeCursor(db, "default", { lastItemId: second.itemId, processedCount: 2, nowMs: 5000 });

    const summary = await runMediaPass(deps({ afterItemId: first.itemId }));

    // afterItemId=first makes both second and third eligible — proof the caller's explicit
    // value won over the stored (further-along) cursor.
    expect(summary.understood).toBe(2);
  });

  test("a drained run clears the cursor, so a subsequent run retries a previously skipped artifact", async () => {
    addMediaFile("unreadable.mp4");
    // roots: [] means the single candidate is skipped with path_outside_roots and never
    // understood — a transient-failure stand-in.
    const first = await runMediaPass(deps({ roots: [] }));
    expect(first.understood).toBe(0);
    expect(first.skipped).toBe(1);

    // Fewer candidates than the limit (1 of 100) means the queue drained — the cursor must be
    // gone, not merely unread, or the next run would resume PAST the skipped artifact forever.
    const cursorAfterDrain = db
      .query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_pass_cursor")
      .get();
    expect(cursorAfterDrain?.n).toBe(0);

    // A second run, now with a working root, retries the same artifact from the top rather than
    // resuming past it — proof the cursor was actually cleared, not merely left unread.
    const second = await runMediaPass(deps());
    expect(second.understood).toBe(1);
  });
});
