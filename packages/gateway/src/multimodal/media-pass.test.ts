import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { MediaPassDeps } from "./media-pass.ts";
import { runMediaPass } from "./media-pass.ts";

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
      sttFor: () => ({
        isLocal: true,
        model: "whisper-base",
        isAvailable: async () => true,
        understand: async () => "transcript",
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
          sttFor: () => ({
            isLocal: true,
            model: "m",
            isAvailable: async () => true,
            understand: async () => {
              calls += 1;
              if (calls === 1) throw new Error("first one fails");
              return "ok";
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
          sttFor: () => undefined,
          gpu: { acquire: async () => () => undefined, touch: () => undefined },
        },
      }),
    );
    expect(summary.understood).toBe(0);
    expect(summary.skippedByReason["no_local_model"]).toBe(1);
  });

  test("advances the cursor so an interrupted pass resumes", async () => {
    addMediaFile("a.mp4");
    const summary = await runMediaPass(deps());
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
          sttFor: () => ({
            isLocal: true,
            model: "m",
            isAvailable: async () => true,
            understand: async () => long,
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
