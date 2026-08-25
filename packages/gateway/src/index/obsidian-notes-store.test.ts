import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { LocalIndex } from "./local-index.ts";
import { type ObsidianNoteWrite, writeObsidianVault } from "./obsidian-notes-store.ts";

function db(): Database {
  const d = new Database(":memory:");
  LocalIndex.ensureSchema(d);
  return d;
}

function note(path: string, body = "hello"): ObsidianNoteWrite {
  const itemId = `obsidian:v1/${path}`;
  return {
    item: {
      service: "obsidian",
      type: "obsidian_note",
      externalId: `v1/${path}`,
      title: path,
      body,
      modifiedAt: 1,
      metadata: {},
      syncedAt: 1,
    },
    note: {
      itemId,
      vaultId: "v1",
      vaultName: "V",
      relPath: path,
      title: path,
      frontmatter: {},
      tags: [],
      rawWikilinks: [],
      dailyNoteDate: undefined,
      mtimeMs: 1,
    },
  };
}

const ids = (w: readonly ObsidianNoteWrite[]) => new Set(w.map((x) => x.note.itemId));

describe("writeObsidianVault", () => {
  test("writes the item and its note row together", () => {
    const d = db();
    const writes = [note("a.md")];
    const r = writeObsidianVault(
      { db: d, depth: "full" },
      {
        vaultId: "v1",
        notes: writes,
        keepIds: ids(writes),
        syncedAt: 1,
      },
    );
    expect(r.upserted).toBe(1);
    expect(d.query("SELECT COUNT(*) AS n FROM obsidian_notes").get()).toEqual({ n: 1 });
    expect(d.query("SELECT COUNT(*) AS n FROM item WHERE service = 'obsidian'").get()).toEqual({
      n: 1,
    });
  });

  test("is idempotent on the same path", () => {
    const d = db();
    const writes = [note("a.md")];
    const input = { vaultId: "v1", notes: writes, keepIds: ids(writes), syncedAt: 1 };
    writeObsidianVault({ db: d, depth: "full" }, input);
    writeObsidianVault({ db: d, depth: "full" }, input);
    expect(d.query("SELECT COUNT(*) AS n FROM obsidian_notes").get()).toEqual({ n: 1 });
  });

  test("prunes a note that is no longer in the vault, and its item with it", () => {
    const d = db();
    const first = [note("a.md"), note("b.md")];
    writeObsidianVault(
      { db: d, depth: "full" },
      {
        vaultId: "v1",
        notes: first,
        keepIds: ids(first),
        syncedAt: 1,
      },
    );

    // Second pass sees only a.md — b.md must go from BOTH tables, not just obsidian_notes.
    const second = [note("a.md")];
    const r = writeObsidianVault(
      { db: d, depth: "full" },
      {
        vaultId: "v1",
        notes: second,
        keepIds: ids(second),
        syncedAt: 2,
      },
    );
    expect(r.deleted).toBe(1);
    expect(d.query("SELECT COUNT(*) AS n FROM obsidian_notes").get()).toEqual({ n: 1 });
    expect(d.query("SELECT COUNT(*) AS n FROM item WHERE service = 'obsidian'").get()).toEqual({
      n: 1,
    });
  });

  test("metadata_only suppresses the body — the batch still honours the depth chokepoint", () => {
    const d = db();
    const writes = [note("a.md", "a long body that must not be stored")];
    writeObsidianVault(
      { db: d, depth: "metadata_only" },
      {
        vaultId: "v1",
        notes: writes,
        keepIds: ids(writes),
        syncedAt: 1,
      },
    );
    const row = d
      .query("SELECT body, body_complete FROM item WHERE service = 'obsidian'")
      .get() as {
      body: string | null;
      body_complete: number;
    };
    expect(row.body ?? "").toBe("");
    expect(row.body_complete).toBe(0);
  });

  test("a throw mid-batch leaves BOTH tables unchanged", () => {
    // The transaction is why this capability is plural rather than per-note. Without it a partial
    // sync would leave obsidian_notes disagreeing with item and still report success.
    const d = db();
    const good = [note("a.md")];
    writeObsidianVault(
      { db: d, depth: "full" },
      {
        vaultId: "v1",
        notes: good,
        keepIds: ids(good),
        syncedAt: 1,
      },
    );

    const broken = note("c.md");
    // An oversized metadata blob makes upsertIndexedItem throw inside the transaction.
    const huge = { blob: "x".repeat(70_000) };
    const batch = [note("b.md"), { ...broken, item: { ...broken.item, metadata: huge } }];
    expect(() =>
      writeObsidianVault(
        { db: d, depth: "full" },
        {
          vaultId: "v1",
          notes: batch,
          keepIds: ids([...good, ...batch]),
          syncedAt: 2,
        },
      ),
    ).toThrow();
    expect(d.query("SELECT COUNT(*) AS n FROM obsidian_notes").get()).toEqual({ n: 1 });
  });
});
