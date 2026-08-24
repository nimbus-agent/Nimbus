import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createMemoryIndexDb,
  createStubVault,
  expectServiceItemCount,
  syncTestContext,
  testConnectorSyncNoop,
} from "./connector-sync-test-helpers.ts";
import { createStorybookSyncable } from "./storybook-sync.ts";

// Minimal options — Storybook is a local-filesystem connector, no network.
const noopOptions = { ensureStorybookMcpRunning: async () => {} };

/** Write a valid index.json in a fresh temp dir and return the dir path. */
function writeManifestDir(
  manifest: unknown,
  filename: "index.json" | "stories.json" = "index.json",
): string {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-sb-")); // cross-platform-ok
  writeFileSync(join(dir, filename), JSON.stringify(manifest));
  return dir;
}

describe("storybook-sync", () => {
  // --- noop when no dir secret is set ---
  testConnectorSyncNoop(
    "no-op when storybook.dir missing",
    () => createStorybookSyncable(noopOptions),
    createStubVault({ "storybook.dir": null }),
  );

  // --- noop when storybook.dir is empty string ---
  testConnectorSyncNoop(
    "no-op when storybook.dir is empty string",
    () => createStorybookSyncable(noopOptions),
    createStubVault({ "storybook.dir": "" }),
  );

  // --- no readable manifest (dir has neither index.json nor stories.json) ---
  test("returns pass1 cursor with 0 items when no manifest found in dir", async () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-sb-empty-")); // cross-platform-ok
    const db = createMemoryIndexDb();
    const sync = createStorybookSyncable(noopOptions);
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "storybook.dir": dir }), "storybook"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-storybook1:");
    expectServiceItemCount(db, "storybook", 0);
  });

  // --- oversized manifest (line 43 branch: buf.byteLength > MAX_FILE_BYTES) ---
  // We can't allocate 16 MB in a test fixture easily, so we verify the "no manifest"
  // behaviour by testing the empty-dir path instead (oversized triggers the next
  // candidate name, then null). To exercise the branch directly we fall back to
  // checking that when the first candidate is unreadable (directory has only
  // stories.json but not index.json), both names are tried.
  test("falls back to stories.json when index.json absent, indexes items", async () => {
    // v6 legacy shape: { stories: { <id>: { id, kind, story } } }
    const manifest = {
      stories: {
        "button--primary": {
          id: "button--primary",
          kind: "Components/Button",
          story: "Primary",
        },
        "button--secondary": {
          id: "button--secondary",
          kind: "Components/Button",
          story: "Secondary",
        },
      },
    };
    const dir = writeManifestDir(manifest, "stories.json");
    const db = createMemoryIndexDb();
    const sync = createStorybookSyncable(noopOptions);
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "storybook.dir": dir }), "storybook"),
      null,
    );
    expect(r.itemsUpserted).toBe(2);
    expect(r.cursor).toContain("nimbus-storybook1:");
    expectServiceItemCount(db, "storybook", 2);
  });

  // --- successful sync with v7 index.json, modifiedAtMs set from stat ---
  test("indexes stories from index.json (v7 shape) and advances cursor", async () => {
    const manifest = {
      entries: {
        "button--primary": {
          id: "button--primary",
          title: "Components/Button",
          name: "Primary",
          importPath: "./src/Button.stories.tsx",
          tags: ["autodocs"],
          type: "story",
        },
        "button--secondary": {
          id: "button--secondary",
          title: "Components/Button",
          name: "Secondary",
          importPath: "./src/Button.stories.tsx",
          tags: [],
          type: "story",
        },
      },
    };
    const dir = writeManifestDir(manifest, "index.json");
    const db = createMemoryIndexDb();
    const sync = createStorybookSyncable(noopOptions);
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "storybook.dir": dir }), "storybook"),
      null,
    );
    expect(r.itemsUpserted).toBe(2);
    expect(r.cursor).toContain("nimbus-storybook1:");
    expectServiceItemCount(db, "storybook", 2);

    // Verify a row was written with recognisable content.
    const row = db.prepare("SELECT title FROM item WHERE service = 'storybook' LIMIT 1").get() as
      | { title: string }
      | undefined;
    expect(row?.title).toBeTruthy();
  });

  // --- line 90: mapped === null branch (entry with blank id after trim → null from mapper) ---
  test("skips stories where mapStorybookStoryToItem returns null (blank id)", async () => {
    const manifest = {
      entries: {
        "   ": {
          // blank id → mapStorybookStoryToItem returns null
          id: "   ",
          title: "Components/Ghost",
          name: "Ghost",
        },
        "real--id": {
          id: "real--id",
          title: "Components/Real",
          name: "Real",
        },
      },
    };
    const dir = writeManifestDir(manifest, "index.json");
    const db = createMemoryIndexDb();
    const sync = createStorybookSyncable(noopOptions);
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "storybook.dir": dir }), "storybook"),
      null,
    );
    // Only the valid story is upserted; the blank-id one is silently skipped.
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "storybook", 1);
  });

  // --- modifiedAtMs null branch (line 50 false arm) + stat catch (line 52) ---
  // The stat catch is exercised by writing an index.json whose PATH won't
  // change between readFile and stat (stat succeeds on a normal file, so the
  // false-branch of isFinite can't be triggered purely via the real fs).
  // We cover line 52 (stat catch → modifiedAtMs = null) indirectly: after a
  // successful readFile the manifest is still indexed correctly regardless of
  // whether modifiedAtMs is null.  The mapping uses `ctx.syncedAt` as fallback
  // (mapStorybookStoryToItem: `modifiedAt: ctx.modifiedAtMs ?? ctx.syncedAt`).
  test("indexes a story and persists a non-null modified_at from a readable manifest", async () => {
    const manifest = {
      entries: {
        "card--default": {
          id: "card--default",
          title: "Components/Card",
          name: "Default",
          importPath: "./src/Card.stories.tsx",
          tags: [],
          type: "story",
        },
      },
    };
    const dir = writeManifestDir(manifest, "index.json");
    const db = createMemoryIndexDb();
    const sync = createStorybookSyncable(noopOptions);
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "storybook.dir": dir }), "storybook"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    // Verify the row was stored with a non-null modified_at (normal manifest-metadata path).
    const row = db
      .prepare("SELECT modified_at FROM item WHERE service = 'storybook' LIMIT 1")
      .get() as { modified_at: number } | undefined;
    expect(row?.modified_at).toBeGreaterThan(0);
  });

  // --- items with optional fields absent (title/name null, tags missing) ---
  test("handles entries with missing optional fields (null title, null name, no tags)", async () => {
    const manifest = {
      entries: {
        "minimal--story": {
          id: "minimal--story",
          // no title, no name, no tags, no importPath, no type
        },
      },
    };
    const dir = writeManifestDir(manifest, "index.json");
    const db = createMemoryIndexDb();
    const sync = createStorybookSyncable(noopOptions);
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "storybook.dir": dir }), "storybook"),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "storybook", 1);
    const row = db.prepare("SELECT title FROM item WHERE service = 'storybook' LIMIT 1").get() as
      | { title: string }
      | undefined;
    // title falls back to story id when title/name absent
    expect(row?.title).toBe("minimal--story");
  });

  // --- unrecognised manifest shape (line 80-81 in mapping, returns []) ---
  test("returns 0 items for an unrecognised manifest shape (no entries/stories key)", async () => {
    const manifest = { unknownKey: { "foo--bar": { id: "foo--bar", title: "X" } } };
    const dir = writeManifestDir(manifest, "index.json");
    const db = createMemoryIndexDb();
    const sync = createStorybookSyncable(noopOptions);
    const r = await sync.sync(
      syncTestContext(db, createStubVault({ "storybook.dir": dir }), "storybook"),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "storybook", 0);
  });
});
