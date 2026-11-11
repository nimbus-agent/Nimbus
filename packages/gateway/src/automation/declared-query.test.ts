// Phase 10 SA2 (spec § 5.4): the declared-query executor, over a real SQLite index seeded the way the
// Gmail sync writes it (`metadata.labelIds`, `metadata.threadId`, `modified_at` in ms).
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { LocalIndex } from "../index/local-index.ts";
import {
  compileDeclaredQuery,
  runDeclaredQuery,
  SELECTED_VALUE_PATTERN,
} from "./declared-query.ts";
import { parseDeclaredQuery } from "./workflow-steps.ts";

const NOW = Date.UTC(2026, 10, 11);
const DAY = 86_400_000;

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});
afterEach(() => db.close());

let seq = 0;
function seed(over: {
  service?: string;
  type?: string;
  ageDays: number;
  metadata: unknown;
  externalId?: string;
}): void {
  seq++;
  const external = over.externalId ?? `m${String(seq)}`;
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
     VALUES (?, ?, ?, ?, 't', ?, ?, ?)`,
  ).run(
    `${over.service ?? "gmail"}:${external}`,
    over.service ?? "gmail",
    over.type ?? "email",
    external,
    NOW - over.ageDays * DAY,
    typeof over.metadata === "string" ? over.metadata : JSON.stringify(over.metadata),
    NOW,
  );
}

const q = (over: Record<string, unknown> = {}) =>
  parseDeclaredQuery(
    {
      service: "gmail",
      type: "email",
      select: "metadata.threadId",
      distinct: true,
      limit: 100,
      where: [],
      ...over,
    },
    "q",
  );

function run(over: Record<string, unknown> = {}) {
  return runDeclaredQuery(db, q(over), NOW);
}

describe("each predicate", () => {
  beforeEach(() => {
    seed({ ageDays: 90, metadata: { threadId: "t-old-read", labelIds: ["INBOX"] } });
    seed({ ageDays: 90, metadata: { threadId: "t-old-unread", labelIds: ["INBOX", "UNREAD"] } });
    seed({ ageDays: 90, metadata: { threadId: "t-old-archived", labelIds: ["CATEGORY_UPDATES"] } });
    seed({ ageDays: 5, metadata: { threadId: "t-new-read", labelIds: ["INBOX"] } });
    seed({ ageDays: 90, metadata: { threadId: "t-no-labels" } });
    seed({ ageDays: 90, service: "slack", type: "message", metadata: { threadId: "t-slack" } });
    seed({ ageDays: 90, type: "draft", metadata: { threadId: "t-draft", labelIds: ["INBOX"] } });
  });

  test("contains, notContains and olderThanDays: the spec's example", () => {
    const r = run({
      where: [
        { metadata: "labelIds", notContains: "UNREAD" },
        { metadata: "labelIds", contains: "INBOX" },
        { olderThanDays: 60 },
      ],
    });
    expect(r).toEqual({ values: ["t-old-read"], dropped: 0 });
  });

  test("service and type narrow the rows", () => {
    expect([...run().values].sort()).toEqual(
      ["t-new-read", "t-no-labels", "t-old-archived", "t-old-read", "t-old-unread"].sort(),
    );
    expect(run({ service: "slack", type: "message" }).values).toEqual(["t-slack"]);
    expect(run({ type: "draft" }).values).toEqual(["t-draft"]);
  });

  test("notContains alone keeps a row with no such label, and a row with no labels at all", () => {
    expect(
      [...run({ where: [{ metadata: "labelIds", notContains: "INBOX" }] }).values].sort(),
    ).toEqual(["t-no-labels", "t-old-archived"]);
  });

  test("newerThanDays and olderThanDays split on modified_at", () => {
    expect(run({ where: [{ newerThanDays: 30 }] }).values).toEqual(["t-new-read"]);
    expect(run({ where: [{ olderThanDays: 30 }] }).values).toHaveLength(4);
    expect(run({ where: [{ olderThanDays: 0 }] }).values).toHaveLength(5);
  });

  test("a predicate on a key no item has selects nothing, even for contains; equals works on scalars", () => {
    expect(run({ where: [{ metadata: "missing", contains: "x" }] }).values).toEqual([]);
    expect(run({ where: [{ metadata: "threadId", equals: "t-new-read" }] }).values).toEqual([
      "t-new-read",
    ]);
  });

  test("equals on a number and a boolean", () => {
    seed({ ageDays: 1, metadata: { threadId: "t-num", count: 3, flag: true } });
    seed({ ageDays: 1, metadata: { threadId: "t-num2", count: 4, flag: false } });
    expect(run({ where: [{ metadata: "count", equals: 3 }] }).values).toEqual(["t-num"]);
    expect(run({ where: [{ metadata: "flag", equals: true }] }).values).toEqual(["t-num"]);
    expect(run({ where: [{ metadata: "flag", equals: false }] }).values).toEqual(["t-num2"]);
  });

  test("a null or malformed metadata cell never raises; it just does not match", () => {
    db.query(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES ('gmail:bad', 'gmail', 'email', 'bad', 't', ?, '{not json', ?)`,
    ).run(NOW, NOW);
    db.query(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES ('gmail:nul', 'gmail', 'email', 'nul', 't', ?, NULL, ?)`,
    ).run(NOW, NOW);
    const r = run({
      where: [{ metadata: "labelIds", notContains: "UNREAD" }],
      select: "metadata.threadId",
    });
    expect(r.values).not.toContain("bad");
    // The malformed and null rows are excluded by the guarded predicate, not by an error.
    expect(r.dropped).toBe(0);
  });
});

describe("select, distinct, the drop count and the limit", () => {
  test("distinct collapses repeated thread ids; without it they repeat", () => {
    for (let i = 0; i < 3; i++) seed({ ageDays: 70 + i, metadata: { threadId: "t-same" } });
    expect(run().values).toEqual(["t-same"]);
    expect(run({ distinct: false }).values).toEqual(["t-same", "t-same", "t-same"]);
  });

  test("values that are not an id are dropped and counted", () => {
    seed({ ageDays: 70, metadata: { threadId: "ok-1" } });
    seed({ ageDays: 71, metadata: { threadId: "has space" } });
    seed({ ageDays: 72, metadata: { threadId: "../../etc" } });
    seed({ ageDays: 73, metadata: { threadId: 12345 } });
    seed({ ageDays: 74, metadata: { threadId: "x".repeat(257) } });
    seed({ ageDays: 75, metadata: { other: 1 } });
    seed({ ageDays: 76, metadata: { threadId: "line\nbreak" } });
    const r = run();
    expect(r.values).toEqual(["ok-1"]);
    expect(r.dropped).toBe(6);
  });

  test("id and external_id select the row's own columns", () => {
    seed({ ageDays: 1, metadata: {}, externalId: "ext-1" });
    expect(run({ select: "external_id" }).values).toEqual(["ext-1"]);
    expect(run({ select: "id" }).values).toEqual(["gmail:ext-1"]);
  });

  test("oldest first, and the limit caps the rows read", () => {
    for (let i = 1; i <= 5; i++) seed({ ageDays: i, metadata: { threadId: `t${String(i)}` } });
    expect(run({ limit: 2 }).values).toEqual(["t5", "t4"]);
    expect(run({ limit: 500 }).values).toHaveLength(5);
  });

  test("an empty index selects nothing", () => {
    expect(run()).toEqual({ values: [], dropped: 0 });
  });

  test("the default clock is the real one", () => {
    db.query(
      `INSERT INTO item (id, service, type, external_id, title, modified_at, metadata, synced_at)
       VALUES ('gmail:now', 'gmail', 'email', 'now', 't', ?, ?, ?)`,
    ).run(Date.now() - 5000, JSON.stringify({ threadId: "t-now" }), Date.now());
    const r = runDeclaredQuery(db, q({ where: [{ olderThanDays: 0 }] }));
    expect(r.values).toEqual(["t-now"]);
  });
});

describe("the SQL is one of a fixed few shapes; nothing from the query is concatenated", () => {
  test("a metadata key travels as a bound JSON path, never in the SQL text", () => {
    const c = compileDeclaredQuery(
      q({ where: [{ metadata: "labelIds", contains: "INBOX" }], select: "metadata.threadId" }),
      NOW,
    );
    expect(c.sql).not.toContain("labelIds");
    expect(c.sql).not.toContain("threadId");
    expect(c.sql).not.toContain("INBOX");
    expect(c.sql).not.toContain("gmail");
    expect(c.params).toEqual(["$.threadId", "gmail", "email", "$.labelIds", "INBOX", 100]);
    expect(c.sql.match(/\?/g)).toHaveLength(c.params.length);
  });

  test("a value built to break out of a quote is data, not SQL", () => {
    seed({ ageDays: 70, metadata: { threadId: "t1", labelIds: ["a'); DROP TABLE item; --"] } });
    const r = run({ where: [{ metadata: "labelIds", contains: "a'); DROP TABLE item; --" }] });
    expect(r.values).toEqual(["t1"]);
    expect(db.query("SELECT COUNT(*) AS c FROM item").get()).toEqual({ c: 1 });
    const hostile = runDeclaredQuery(db, { ...q(), service: "gmail' OR '1'='1" }, NOW);
    expect(hostile.values).toEqual([]);
  });

  test("an unvalidated query is refused by the compiler itself", () => {
    const base = q();
    expect(() => compileDeclaredQuery({ ...base, select: "title" }, NOW)).toThrow(/invalid select/);
    expect(() => compileDeclaredQuery({ ...base, limit: 501 }, NOW)).toThrow(/invalid limit/);
    expect(() => compileDeclaredQuery({ ...base, limit: 0 }, NOW)).toThrow(/invalid limit/);
    expect(() => compileDeclaredQuery({ ...base, select: "metadata.a b" }, NOW)).toThrow(
      /invalid select/,
    );
    expect(() =>
      compileDeclaredQuery({ ...base, where: [{ metadata: "a') OR 1=1 --", contains: "x" }] }, NOW),
    ).toThrow(/invalid metadata key/);
  });

  test("the accepted value alphabet", () => {
    for (const ok of ["a", "A-b_c.d:e", "18c0ffee", "x".repeat(256)]) {
      expect(SELECTED_VALUE_PATTERN.test(ok), ok).toBe(true);
    }
    for (const bad of ["", " ", "a b", "a/b", "é", "x".repeat(257)]) {
      expect(SELECTED_VALUE_PATTERN.test(bad), bad).toBe(false);
    }
  });
});
