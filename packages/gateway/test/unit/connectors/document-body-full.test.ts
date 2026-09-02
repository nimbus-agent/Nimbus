import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BriefRunController } from "../../../src/briefs/brief-run-store.ts";
import { saveBriefReport } from "../../../src/briefs/brief-save.ts";
import type { BriefRun, Report } from "../../../src/briefs/brief-types.ts";
import { ingestClip } from "../../../src/clips/clip-ingest.ts";
import type { ConnectorServiceId } from "../../../src/connectors/connector-catalog.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createObsidianSyncable } from "../../../src/connectors/obsidian-sync.ts";
import { mapZoomTranscriptToItem } from "../../../src/connectors/zoom-transcript-mapping.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";

/**
 * Task 11: Obsidian notes, Zoom transcripts, web clips, and research briefs
 * now pass the declared-full `body:` field (instead of a pre-clamped
 * `bodyPreview:`) to `upsertIndexedItem*`, so the store — not the connector —
 * is the single place that applies the per-type length cap (`body-caps.ts`).
 *
 * `obsidian:obsidian_note`, `zoom:transcript`, `nimbus:web_clip`, and
 * `nimbus:research_brief` are all in `LONG_BODY_TYPES` (cap = `BODY_MAX_PROSE`
 * = 16,384), so a 4,000-char document fits whole and `body_complete` becomes 1
 * for all four.
 *
 * Three of them earn that cap by being in `PROSE_HEAVY_TYPES`; `nimbus:web_clip`
 * earns it via `LOCAL_ONLY_PROSE_TYPES` instead, because clips are deliberately
 * kept off the remote embedder (#1006) while still being paragraph-shaped. The
 * two sets are unioned in `body-caps.ts` precisely so this file's expectations
 * do not depend on which of them a type came from.
 */

type ItemBodyRow = {
  body: string;
  body_preview: string;
  body_complete: number;
};

function readBodyRow(db: Database, service: string, type: string): ItemBodyRow {
  const row = db
    .query("SELECT body, body_preview, body_complete FROM item WHERE service = ? AND type = ?")
    .get(service, type) as ItemBodyRow | null;
  if (row === null) {
    throw new Error(`expected a ${service}:${type} row`);
  }
  return row;
}

const LONG_TEXT = "A".repeat(4000);

function assertFullBody(row: ItemBodyRow): void {
  expect(row.body).toHaveLength(4000);
  expect(row.body_preview).toHaveLength(512);
  expect(row.body_preview).toBe(row.body.slice(0, 512));
  expect(row.body_complete).toBe(1);
}

describe("document-body-full — obsidian:obsidian_note", () => {
  test("indexes the full 4000-char note body", async () => {
    const root = mkdtempSync(join(tmpdir(), "document-body-full-obsidian-"));
    mkdirSync(join(root, ".obsidian"), { recursive: true });
    writeFileSync(join(root, "Note.md"), LONG_TEXT);

    const db = createMemoryIndexDb();
    const sync = createObsidianSyncable({
      roots: [
        {
          path: root,
          gitAware: false,
          codeIndex: false,
          dependencyGraph: false,
          mediaIndex: false,
          exclude: [],
        },
      ],
    });
    const r = await sync.sync(
      syncTestContext(db, EMPTY_NIMBUS_VAULT, sync.serviceId as ConnectorServiceId),
      null,
    );
    expect(r.itemsUpserted).toBe(1);

    assertFullBody(readBodyRow(db, "obsidian", "obsidian_note"));
  });
});

describe("document-body-full — zoom:transcript", () => {
  test("indexes the full 4000-char transcript plainText", () => {
    const db = createMemoryIndexDb();
    const row = mapZoomTranscriptToItem({
      meeting: { uuid: "uuid-body-full", topic: "Full Body Test" },
      recordingFile: { id: "rec-body-full", file_type: "TRANSCRIPT" },
      plainText: LONG_TEXT,
      syncedAt: Date.now(),
    });
    if (row === null) {
      throw new Error("expected mapping to succeed");
    }
    const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "zoom");
    ctx.upsertItem(row);

    assertFullBody(readBodyRow(db, "zoom", "transcript"));
  });
});

describe("document-body-full — nimbus:web_clip", () => {
  test("indexes the full 4000-char clip body", () => {
    const db = createMemoryIndexDb();
    ingestClip(db, {
      url: "https://ex.com/long-article",
      title: "A Long Article",
      mode: "article",
      body: LONG_TEXT,
      tags: [],
      capturedAt: 1_750_000_000_000,
    });

    assertFullBody(readBodyRow(db, "nimbus", "web_clip"));
  });
});

describe("document-body-full — nimbus:research_brief", () => {
  function doneRun(report: Report): BriefRun {
    const c = new BriefRunController({ nowMs: () => 1000 });
    const out = c.create({
      brief: "full body brief",
      sources: [{ url: "https://a.test/1", title: "A" }],
      useIndex: true,
    });
    if ("error" in out) throw new Error("expected a run");
    c.finish(out.run, report);
    return out.run;
  }

  test("indexes the full 4000-char summary", () => {
    const raw = new Database(":memory:");
    runIndexedSchemaMigrations(raw, CURRENT_SCHEMA_VERSION);

    const report: Report = {
      summary: LONG_TEXT,
      findings: [],
      conflicts: [],
      gaps: [],
      synthesis: { model: "llama3.1:8b", remote: false },
    };
    saveBriefReport(raw, doneRun(report));

    assertFullBody(readBodyRow(raw, "nimbus", "research_brief"));
  });
});
