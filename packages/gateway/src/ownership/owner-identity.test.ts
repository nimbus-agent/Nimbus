import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { isBotAuthor, resolveOwner } from "./owner-identity.ts";

describe("isBotAuthor", () => {
  test("filters a [bot]-suffixed name", () => {
    expect(isBotAuthor("dependabot[bot]", "x@y.com")).toBe(true);
    expect(isBotAuthor("renovate[bot]", "x@y.com")).toBe(true);
  });

  test("filters the bare github noreply address", () => {
    expect(isBotAuthor("GitHub", "noreply@github.com")).toBe(true);
  });

  // LOAD-BEARING: `*@users.noreply.github.com` addresses belong to REAL people
  // who enabled email privacy. Filtering them would erase real contributors.
  test("does NOT filter users.noreply.github.com — those are real people", () => {
    expect(isBotAuthor("Real Person", "1234+real@users.noreply.github.com")).toBe(false);
  });

  test("does not filter an ordinary author", () => {
    expect(isBotAuthor("Ada Lovelace", "ada@example.com")).toBe(false);
  });

  test("is case-insensitive on the bot suffix", () => {
    expect(isBotAuthor("Dependabot[BOT]", "x@y.com")).toBe(true);
  });
});

describe("resolveOwner", () => {
  let db: Database;
  beforeEach(() => {
    db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  });

  test("resolves to an existing person id", () => {
    db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
      "person-1",
      "Ada Lovelace",
      "ada@example.com",
    ]);
    const out = resolveOwner(db, "ada@example.com", "Ada L");
    expect(out).toEqual({
      entityExternalId: "person-1",
      label: "Ada Lovelace",
      resolved: true,
    });
  });

  test("matches case-insensitively via normalizeEmail", () => {
    db.run("INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)", [
      "person-1",
      "Ada Lovelace",
      "ada@example.com",
    ]);
    expect(resolveOwner(db, "ADA@Example.COM", "Ada L").entityExternalId).toBe("person-1");
  });

  test("falls back to git:<email> when no person matches", () => {
    const out = resolveOwner(db, "stranger@example.com", "A Stranger");
    expect(out).toEqual({
      entityExternalId: "git:stranger@example.com",
      label: "A Stranger",
      resolved: false,
    });
  });

  // The fallback must never write to `person`: a decade of drive-by committers
  // and CI identities would otherwise pollute people data permanently.
  test("the fallback does NOT insert into the person table", () => {
    resolveOwner(db, "stranger@example.com", "A Stranger");
    const n = db.query("SELECT COUNT(*) AS n FROM person").get() as { n: number };
    expect(n.n).toBe(0);
  });

  test("an unresolved author with no name falls back to the email as label", () => {
    expect(resolveOwner(db, "anon@example.com", null).label).toBe("anon@example.com");
  });
});
