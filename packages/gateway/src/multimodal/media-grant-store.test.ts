import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import {
  createGrant,
  hasActiveGrant,
  listActiveGrants,
  MediaGrantRefusedError,
  revokeGrant,
  revokeOrphanedGrants,
} from "./media-grant-store.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

describe("createGrant", () => {
  test("writes an active grant and reports it as new", () => {
    const out = createGrant(db, {
      itemId: "i1",
      modality: "image",
      modelVendor: "openai",
      nowMs: 1000,
    });
    expect(out.alreadyActive).toBe(false);
    expect(hasActiveGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai" })).toBe(
      true,
    );
  });

  /**
   * Idempotent, and it must return the EXISTING id rather than `INSERT OR IGNORE`-ing: the batch
   * preview has to print "16 new (4 already granted)", which needs the caller to distinguish the
   * two cases. `INSERT OR IGNORE` succeeds silently while returning nothing to distinguish with.
   */
  test("is idempotent — a second identical grant returns the existing id, never throws", () => {
    const first = createGrant(db, {
      itemId: "i1",
      modality: "image",
      modelVendor: "openai",
      nowMs: 1000,
    });
    const second = createGrant(db, {
      itemId: "i1",
      modality: "image",
      modelVendor: "openai",
      nowMs: 2000,
    });
    expect(second.alreadyActive).toBe(true);
    expect(second.id).toBe(first.id);
    expect(listActiveGrants(db)).toHaveLength(1);
  });

  test("a different vendor on the same artifact is a SEPARATE grant, never an upgrade", () => {
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 1000 });
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "anthropic", nowMs: 1000 });
    expect(listActiveGrants(db)).toHaveLength(2);
  });

  /**
   * § 19.4: `av` is refused at WRITE time. The CHECK constraint keeps the value because the column
   * outlives this release, but writing a row nothing will ever read is the ships-inert pattern one
   * layer up — the exact failure this slice has hit three times.
   */
  test("REFUSES an av grant in this release, naming the bound", () => {
    expect(() =>
      createGrant(db, { itemId: "i1", modality: "av", modelVendor: "openai", nowMs: 1000 }),
    ).toThrow(MediaGrantRefusedError);
    expect(listActiveGrants(db)).toHaveLength(0);
  });
});

describe("revokeGrant", () => {
  test("revocation is append-only: the row survives with revoked_at set", () => {
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(revokeGrant(db, { itemId: "i1", nowMs: 2000 })).toBe(1);
    expect(hasActiveGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai" })).toBe(
      false,
    );
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_grant").get()?.n).toBe(1);
  });

  test("re-granting after revocation works and leaves both rows", () => {
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 1000 });
    revokeGrant(db, { itemId: "i1", nowMs: 2000 });
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 3000 });
    expect(listActiveGrants(db)).toHaveLength(1);
    expect(db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_grant").get()?.n).toBe(2);
  });

  test("--vendor narrows the revocation to one vendor", () => {
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 1000 });
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "anthropic", nowMs: 1000 });
    expect(revokeGrant(db, { itemId: "i1", modelVendor: "openai", nowMs: 2000 })).toBe(1);
    expect(listActiveGrants(db).map((g) => g.modelVendor)).toEqual(["anthropic"]);
  });

  test("revoking a grant that does not exist reports zero rather than throwing", () => {
    expect(revokeGrant(db, { itemId: "nope", nowMs: 2000 })).toBe(0);
  });
});

describe("revokeOrphanedGrants", () => {
  /**
   * § 19.7. Revoked, never DELETEd: § 18.3's whole argument for the partial index is that
   * revocation is an append-only audit trail, and a pruner that deleted rows would be the one
   * caller allowed to rewrite history.
   */
  test("revokes grants whose source item has left the index, and leaves live ones alone", () => {
    upsertIndexedItem(db, {
      service: "google_drive",
      type: "file",
      externalId: "live",
      title: "live",
      bodyPreview: "",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: { mimeType: "image/png" },
    });
    const liveId = db
      .query<{ id: string }, []>("SELECT id FROM item WHERE external_id = 'live'")
      .get()?.id as string;

    createGrant(db, { itemId: liveId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    createGrant(db, { itemId: "gone", modality: "image", modelVendor: "openai", nowMs: 1000 });

    expect(revokeOrphanedGrants(db, 5000)).toBe(1);
    expect(listActiveGrants(db).map((g) => g.itemId)).toEqual([liveId]);
  });
});
