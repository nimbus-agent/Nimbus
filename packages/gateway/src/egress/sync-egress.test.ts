// packages/gateway/src/egress/sync-egress.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createBlameIndexSyncable } from "../connectors/blame-index-sync.ts";
import { createFilesystemV2Syncable } from "../connectors/filesystem-v2-sync.ts";
import { createObsidianSyncable } from "../connectors/obsidian-sync.ts";
import { createOpenapiIndexerSyncable } from "../connectors/openapi-indexer-sync.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { listEgress, verifyEgressChain } from "./egress-verify.ts";
import { LOCAL_ONLY_SYNC_SERVICES, recordSyncEgress } from "./sync-egress.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});
afterEach(() => db.close());

describe("recordSyncEgress", () => {
  test("appends one authorized, not_required `sync` row destined at the service id", () => {
    const out = recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1_000 });
    // Was `toBeUndefined()` before the appender started returning its row hash,
    // which an outcome marker needs in order to name the row it describes.
    expect(out?.rowHash).toMatch(/^[0-9a-f]{64}$/);
    const rows = listEgress(db, {});
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      sourceType: "sync",
      destination: "github",
      method: "sync.run",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    });
    expect(rows[0]?.sourceId).toBeNull();
  });

  test("returns the appended row's hash", () => {
    const out = recordSyncEgress(db, { destination: "github", method: "items.fetch", now: 1_000 });
    expect(out?.rowHash).toBe(listEgress(db, {})[0]?.rowHash);
  });

  test("returns undefined for a local-only destination, because no row was written", () => {
    // The caller uses this to decide whether an outcome row may be written at
    // all: with no authorising row there is nothing for one to name.
    expect(
      recordSyncEgress(db, { destination: "filesystem", method: "items.fetch", now: 1_000 }),
    ).toBeUndefined();
  });

  test("a caller-initiated row carries the caller's label", () => {
    recordSyncEgress(db, {
      destination: "github",
      method: "items.fetch",
      now: 1_000,
      sourceId: "asafs-browser",
    });
    expect(listEgress(db, {})[0]?.sourceId).toBe("asafs-browser");
  });

  test("an absent caller keeps sourceId null, so null MEANS not-caller-initiated", () => {
    // The scheduler passes no caller. That is what lets a reader tell a fetch
    // someone asked for from a background sync nobody asked for, without having
    // to infer it from `method`.
    recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1_000 });
    expect(listEgress(db, {})[0]?.sourceId).toBeNull();
  });

  test("an empty label is stored as null, never as an empty string", () => {
    // An empty string would read as "attributed to a client whose label is
    // blank" — a claim the gateway cannot support. Absent is the honest value.
    recordSyncEgress(db, {
      destination: "github",
      method: "items.fetch",
      now: 1_000,
      sourceId: "",
    });
    expect(listEgress(db, {})[0]?.sourceId).toBeNull();
  });

  test("a local-only destination appends nothing even with a caller", () => {
    // The caller label must not become a reason to ledger a run that provably
    // never left the machine.
    recordSyncEgress(db, {
      destination: "filesystem",
      method: "items.fetch",
      now: 1_000,
      sourceId: "asafs-browser",
    });
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("destination is the caller-supplied SERVICE id, never a raw URL — this function does no derivation", () => {
    recordSyncEgress(db, { destination: "jenkins", method: "items.fetch", now: 2_000 });
    const rows = listEgress(db, {});
    expect(rows[0]?.destination).toBe("jenkins");
  });

  test("two appends chain correctly (BLAKE3, I10-verifiable)", () => {
    recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1_000 });
    recordSyncEgress(db, { destination: "gitlab", method: "items.fetch", now: 2_000 });
    const result = verifyEgressChain(db);
    expect(result.ok).toBe(true);
    expect(listEgress(db, {})).toHaveLength(2);
  });

  test("a throwing appendEgressEntry (e.g. a closed db) propagates rather than swallowing", () => {
    db.close();
    expect(() =>
      recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1 }),
    ).toThrow();
  });
});

describe("LOCAL_ONLY_SYNC_SERVICES", () => {
  test("is exactly the four local-only indexers — no more, no fewer", () => {
    // Pinned so a rename or a fifth local-only indexer is a deliberate edit here, not a silent
    // resumption of the over-count this set exists to prevent (see the doc comment).
    expect(new Set(LOCAL_ONLY_SYNC_SERVICES)).toEqual(
      new Set(["filesystem", "blame", "openapi", "obsidian"]),
    );
  });

  test("each real local-only syncable's OWN serviceId is a member — not just a matching string literal", () => {
    // Constructs the REAL syncables (the exact factories platform/assemble.ts registers on the
    // scheduler) and reads their own `.serviceId` — so a rename inside any of the four connector
    // files (which would silently reopen the over-count this set exists to close) fails this test
    // rather than staying invisible behind a hand-copied string.
    expect(LOCAL_ONLY_SYNC_SERVICES.has(createFilesystemV2Syncable({ roots: [] }).serviceId)).toBe(
      true,
    );
    expect(LOCAL_ONLY_SYNC_SERVICES.has(createBlameIndexSyncable({ roots: [] }).serviceId)).toBe(
      true,
    );
    expect(
      LOCAL_ONLY_SYNC_SERVICES.has(createOpenapiIndexerSyncable({ roots: [] }).serviceId),
    ).toBe(true);
    expect(LOCAL_ONLY_SYNC_SERVICES.has(createObsidianSyncable({ roots: [] }).serviceId)).toBe(
      true,
    );
  });

  test("recordSyncEgress is a no-op for every local-only destination — no row, not even a blocked one", () => {
    for (const destination of LOCAL_ONLY_SYNC_SERVICES) {
      const out = recordSyncEgress(db, { destination, method: "sync.run", now: 1_000 });
      expect(out).toBeUndefined();
    }
    expect(listEgress(db, {})).toHaveLength(0);
  });

  test("a real cloud destination (e.g. github) is NOT excluded — the filter is narrow, not a kill switch", () => {
    recordSyncEgress(db, { destination: "github", method: "sync.run", now: 1_000 });
    expect(listEgress(db, {})).toHaveLength(1);
  });
});

describe("recordSyncEgress expectedBytes", () => {
  /**
   * Before this field existed a `media.fetchBytes` row's whole payload was `{"method":"..."}` —
   * the ledger recorded THAT a cloud fetch happened and nothing about its size, which is a thin
   * disclosure for the one egress class whose entire subject is bytes crossing a boundary.
   */
  test("discloses the artifact size on a byte-fetch row", () => {
    recordSyncEgress(db, {
      destination: "google_drive",
      method: "media.fetchBytes",
      now: 1_000,
      expectedBytes: 390_842,
    });
    expect(JSON.parse(listEgress(db, {})[0]?.payloadSummary ?? "{}")).toEqual({
      method: "media.fetchBytes",
      expectedBytes: 390_842,
    });
  });

  /**
   * The resolver shares one closure with the byte fetch, and its round-trip carries no artifact
   * bytes. An absent field must stay absent rather than becoming a `0` that reads as
   * "a zero-byte artifact".
   */
  test("omits the field entirely when no size is supplied", () => {
    recordSyncEgress(db, {
      destination: "google_photos",
      method: "media.resolveByteUrl",
      now: 1_000,
    });
    const summary = JSON.parse(listEgress(db, {})[0]?.payloadSummary ?? "{}");
    expect(summary).toEqual({ method: "media.resolveByteUrl" });
    expect("expectedBytes" in summary).toBe(false);
  });

  test("keeps a genuine zero distinct from an absent size", () => {
    recordSyncEgress(db, {
      destination: "google_drive",
      method: "media.fetchBytes",
      now: 1_000,
      expectedBytes: 0,
    });
    expect(JSON.parse(listEgress(db, {})[0]?.payloadSummary ?? "{}")).toEqual({
      method: "media.fetchBytes",
      expectedBytes: 0,
    });
  });

  /**
   * `expectedBytes` comes from provider metadata read at index time, so these are reachable
   * without a bug in the appender. A nonsense number in a disclosure field is worse than the
   * field's absence, which at least reads as "not known".
   */
  test.each([
    ["negative", -1],
    ["fractional", 12.5],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("drops a %s size rather than writing it", (_label, value) => {
    recordSyncEgress(db, {
      destination: "google_drive",
      method: "media.fetchBytes",
      now: 1_000,
      expectedBytes: value,
    });
    expect(JSON.parse(listEgress(db, {})[0]?.payloadSummary ?? "{}")).toEqual({
      method: "media.fetchBytes",
    });
  });

  test("null reads as 'not known', not as zero", () => {
    recordSyncEgress(db, {
      destination: "google_drive",
      method: "media.fetchBytes",
      now: 1_000,
      expectedBytes: null,
    });
    expect(JSON.parse(listEgress(db, {})[0]?.payloadSummary ?? "{}")).toEqual({
      method: "media.fetchBytes",
    });
  });

  test("the row still verifies in the BLAKE3 chain", () => {
    recordSyncEgress(db, {
      destination: "google_drive",
      method: "media.fetchBytes",
      now: 1_000,
      expectedBytes: 390_842,
    });
    recordSyncEgress(db, { destination: "github", method: "sync.run", now: 2_000 });
    expect(verifyEgressChain(db).ok).toBe(true);
  });
});
