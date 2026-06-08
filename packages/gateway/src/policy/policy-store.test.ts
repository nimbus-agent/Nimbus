import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { PolicyStore } from "./policy-store.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 36);
  return db;
}

describe("PolicyStore", () => {
  let db: Database;
  beforeEach(() => {
    db = freshDb();
  });

  test("persists and reloads the last-known-valid policy", () => {
    const store = new PolicyStore(db);
    store.persist({
      toml: 'org = "acme"\n',
      sig: "AA==",
      org: "acme",
      version: 1,
      source: "peer",
      fetchedAt: 100,
    });
    const got = store.load();
    expect(got?.org).toBe("acme");
    expect(got?.version).toBe(1);
    expect(got?.source).toBe("peer");
  });

  test("persist is idempotent on id=1 (upsert) — second persist overwrites", () => {
    const store = new PolicyStore(db);
    store.persist({
      toml: "a\n",
      sig: "S1",
      org: "acme",
      version: 1,
      source: "anchor",
      fetchedAt: 1,
    });
    store.persist({
      toml: "b\n",
      sig: "S2",
      org: "acme",
      version: 2,
      source: "peer",
      fetchedAt: 2,
    });
    expect(store.load()?.version).toBe(2);
    expect(store.load()?.source).toBe("peer");
  });

  test("load() returns undefined when no policy persisted", () => {
    expect(new PolicyStore(freshDb()).load()).toBeUndefined();
  });

  test("pins and reads the anchor pubkey (upsert)", () => {
    const store = new PolicyStore(db);
    store.pinAnchorPubkey("PUBKEYB64", "pairing", 42);
    expect(store.getAnchorPubkey()).toBe("PUBKEYB64");
    store.pinAnchorPubkey("PUBKEY2", "manual", 43);
    expect(store.getAnchorPubkey()).toBe("PUBKEY2");
  });

  test("getAnchorPubkey returns undefined when unpinned", () => {
    expect(new PolicyStore(freshDb()).getAnchorPubkey()).toBeUndefined();
  });

  test("load() preserves issued_at when present (line 61 false side)", () => {
    const store = new PolicyStore(db);
    store.persist({
      toml: "a\n",
      sig: "S",
      org: "acme",
      version: 1,
      source: "anchor",
      fetchedAt: 1,
      issuedAt: "2026-06-08T00:00:00Z",
    });
    expect(store.load()?.issuedAt).toBe("2026-06-08T00:00:00Z");
  });

  test("load() coerces an unrecognized source value to 'none' (toPolicySource fallback)", () => {
    // The source column is plain TEXT (no CHECK); write a value outside the allowed set directly.
    db.query(
      `INSERT INTO org_policy_state (id, toml, sig, org, version, issued_at, fetched_at, source)
       VALUES (1, 'a', 'S', 'acme', 1, NULL, 1, 'bogus')`,
    ).run();
    expect(new PolicyStore(db).load()?.source).toBe("none");
  });
});
