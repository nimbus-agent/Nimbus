/**
 * brief-index-search.test.ts — the ONE test that proves the widening.
 *
 * Every other brief test injects a stub `IndexSearch`, so none of them can see which query the
 * gateway actually issues. This one seeds a REAL in-memory LocalIndex with a `web_clip` and two
 * non-clip items and drives the real factory, so restoring `itemType: "web_clip"` to the query
 * turns it red instead of silently reverting the feature under a green suite.
 */
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import { LocalIndex } from "../index/local-index.ts";
import { createBriefIndexSearch } from "./brief-index-search.ts";

const NOW = 1_760_000_000_000;

/** Seeds one item and returns the composite primary key the search is expected to echo back. */
function seed(
  db: Database,
  spec: { type: string; externalId: string; title: string; url?: string },
): string {
  upsertIndexedItem(db, {
    service: "nimbus",
    type: spec.type,
    externalId: spec.externalId,
    title: spec.title,
    body: `${spec.title} — the storage migration was rolled out in three stages.`,
    url: spec.url ?? null,
    canonicalUrl: null,
    modifiedAt: NOW,
    syncedAt: NOW,
  });
  return itemPrimaryKey("nimbus", spec.externalId);
}

let db: Database;
let index: LocalIndex;
let clipId: string;
let prId: string;
let emailId: string;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  index = new LocalIndex(db);
  clipId = seed(db, {
    type: "web_clip",
    externalId: "clip-1",
    title: "Storage migration writeup",
    url: "https://example.test/migration",
  });
  prId = seed(db, {
    type: "pull_request",
    externalId: "pr-1",
    title: "Storage migration rollout",
    url: "https://example.test/pr/1",
  });
  emailId = seed(db, {
    type: "email",
    externalId: "mail-1",
    title: "Storage migration status",
  });
});

describe("createBriefIndexSearch", () => {
  test("searches the WHOLE index — a clip, a pull request and an email all come back", async () => {
    const out = await createBriefIndexSearch(index)("storage migration", 8);

    // If `itemType: "web_clip"` is ever restored to the query this collapses to one hit.
    const byId = new Map(out.hits.map((h) => [h.itemId, h]));
    expect([...byId.keys()].sort()).toEqual([clipId, emailId, prId].sort());
  });

  test("returns hits of MORE THAN ONE type — the property the web_clip filter destroyed", async () => {
    const out = await createBriefIndexSearch(index)("storage migration", 8);
    const types = new Set(out.hits.map((h) => h.itemType));
    expect(types.size).toBeGreaterThan(1);
    expect([...types].sort()).toEqual(["email", "pull_request", "web_clip"]);
  });

  test("each hit's itemType is the type that item was SEEDED with", async () => {
    const out = await createBriefIndexSearch(index)("storage migration", 8);
    const byId = new Map(out.hits.map((h) => [h.itemId, h]));

    // The clip must keep saying "web_clip": brief-registry.ts sets `clipId` on exactly this
    // equality, so a mis-mapped type here silently strips clipId from every real clip.
    expect(byId.get(clipId)?.itemType).toBe("web_clip");
    expect(byId.get(prId)?.itemType).toBe("pull_request");
    expect(byId.get(emailId)?.itemType).toBe("email");
  });

  test("maps title, url and itemId off the ranked item", async () => {
    const out = await createBriefIndexSearch(index)("storage migration", 8);
    const clip = out.hits.find((h) => h.itemId === clipId);
    expect(clip?.title).toBe("Storage migration writeup");
    expect(clip?.url).toBe("https://example.test/migration");
    expect(clip?.snippet.length).toBeGreaterThan(0);
  });

  test("url is null when the indexed item has none", async () => {
    const out = await createBriefIndexSearch(index)("storage migration", 8);
    expect(out.hits.find((h) => h.itemId === emailId)?.url).toBeNull();
  });

  test("honours the caller's limit", async () => {
    const out = await createBriefIndexSearch(index)("storage migration", 2);
    expect(out.hits).toHaveLength(2);
  });

  test("reports semanticAvailable: false when no hit carries a vector rank", async () => {
    // No semanticSearch deps configured, so this index is keyword-only — exactly the signal
    // brief-gaps.ts turns into "recall was keyword-only".
    const out = await createBriefIndexSearch(index)("storage migration", 8);
    expect(out.hits.length).toBeGreaterThan(0);
    expect(out.semanticAvailable).toBe(false);
  });

  test("an unmatched question returns no hits rather than throwing", async () => {
    const out = await createBriefIndexSearch(index)("zzzznothingmatchesthis", 8);
    expect(out.hits).toEqual([]);
  });
});
