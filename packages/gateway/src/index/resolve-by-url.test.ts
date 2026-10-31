import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { resolveItemByUrl } from "./resolve-by-url.ts";

function dbWith(
  rows: Array<{ id: string; key: string | null; type?: string; metadata?: string }>,
): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT, type TEXT, title TEXT,
    url TEXT, resolve_key TEXT, modified_at INTEGER, metadata TEXT)`);
  for (const r of rows) {
    db.query(
      `INSERT INTO item (id, service, type, title, url, resolve_key, modified_at, metadata)
       VALUES (?, 'github', ?, 'T', ?, ?, 7, ?)`,
    ).run(r.id, r.type ?? "pull_request", r.key, r.key, r.metadata ?? null);
  }
  return db;
}

const PR_KEY = "https://github.com/o/r/pull/1";

test("a found item carries its branch", () => {
  const db = dbWith([{ id: "a", key: PR_KEY, metadata: JSON.stringify({ branch: "feat/x" }) }]);
  expect(resolveItemByUrl(db, PR_KEY)).toMatchObject({ found: true, item: { branch: "feat/x" } });
  db.close();
});

// Absent, not null: an item with no branch says nothing about one.
test.each([
  ["no metadata", undefined],
  ["metadata without a branch", JSON.stringify({ state: "open" })],
  ["an empty branch", JSON.stringify({ branch: "" })],
  ["a non-string branch", JSON.stringify({ branch: 7 })],
  // `json_extract` returns these two as serialized JSON text, which a JS string check would pass.
  ["an object branch", JSON.stringify({ branch: { name: "feat/x" } })],
  ["an array branch", JSON.stringify({ branch: ["feat/x"] })],
  ["malformed metadata", "{branch: feat/x"],
])("%s resolves with no branch key", (_label, metadata) => {
  const db = dbWith([{ id: "a", key: PR_KEY, ...(metadata === undefined ? {} : { metadata }) }]);
  const out = resolveItemByUrl(db, PR_KEY);
  expect(out.found).toBe(true);
  if (out.found) expect(out.item).not.toHaveProperty("branch");
  db.close();
});

test("resolve exposes the branch and nothing else from metadata", () => {
  const db = dbWith([
    { id: "a", key: PR_KEY, metadata: JSON.stringify({ branch: "feat/x", author: "dana" }) },
  ]);
  const out = resolveItemByUrl(db, PR_KEY);
  expect(out.found).toBe(true);
  if (out.found) {
    expect(Object.keys(out.item).sort()).toEqual(
      ["branch", "id", "modified_at", "service", "title", "type", "url"].sort(),
    );
  }
  db.close();
});

test("an ambiguous candidate keeps its shape: no branch", () => {
  const metadata = JSON.stringify({ branch: "feat/x" });
  const db = dbWith([
    { id: "a", key: PR_KEY, metadata },
    { id: "b", key: PR_KEY, metadata },
  ]);
  const out = resolveItemByUrl(db, PR_KEY);
  expect(out).toMatchObject({ found: false, reason: "ambiguous" });
  if (!out.found && out.reason === "ambiguous") {
    for (const c of out.candidates) expect(c).not.toHaveProperty("branch");
  }
  db.close();
});

// The three MATCHING rungs of the ladder share one shape: seed a key, ask with a
// URL that only that rung can reduce to it, assert which rung answered. The
// declining cases below stay separate — they assert a different outcome.
test.each([
  [
    "1 — exact key matches",
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/1#note",
    "exact",
  ],
  [
    "2 — all query params dropped",
    "https://github.com/o/r/pull/1",
    "https://github.com/o/r/pull/1?tab=files",
    "query_stripped",
  ],
  [
    "3 — trailing path segments trimmed",
    "https://bitbucket.org/o/r/pull-requests/42",
    "https://bitbucket.org/o/r/pull-requests/42/diff",
    "path_trimmed",
  ],
])("rung %s", (_label, seededKey, askedUrl, matchKind) => {
  const db = dbWith([{ id: "a", key: seededKey }]);
  const out = resolveItemByUrl(db, askedUrl);
  expect(out).toMatchObject({ found: true, matchKind });
  db.close();
});

test("rung 3 declines rather than guessing when a trim is not unique", () => {
  const db = dbWith([
    { id: "a", key: "https://github.com/o/r/pull/1", type: "pull_request" },
    { id: "b", key: "https://github.com/o/r/pull/1", type: "issue" },
  ]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1/files");
  expect(out).toMatchObject({ found: false, reason: "ambiguous", truncated: false });
  if (out.found === false && out.reason === "ambiguous") {
    expect(out.candidates).toHaveLength(2);
  }
  db.close();
});

test("over the cap returns truncated with NO candidates", () => {
  const db = dbWith(
    Array.from({ length: 6 }, (_, i) => ({
      id: `x${String(i)}`,
      key: "https://github.com/o/r/pull/1",
    })),
  );
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1/files");
  expect(out).toMatchObject({ found: false, reason: "ambiguous", truncated: true });
  if (out.found === false && out.reason === "ambiguous") {
    expect(out.candidates).toEqual([]);
  }
  db.close();
});

test("an unparseable url is unresolvable, never a stored key lookup", () => {
  const db = dbWith([{ id: "a", key: "not a url" }]);
  const out = resolveItemByUrl(db, "not a url");
  // canonicalizeUrl returns unparseable input VERBATIM, so without an explicit parse check this
  // would match the poisoned row above and report found:true.
  expect(out).toMatchObject({ found: false, reason: "unresolvable_url", service: null });
  db.close();
});

test("a parseable URL with a non-http(s) scheme is unresolvable", () => {
  // `new URL()` ACCEPTS all of these, so only the explicit protocol check rejects them. Planting a
  // row whose stored key IS the input proves the scheme gate runs BEFORE any lookup — otherwise
  // these would match and report found:true.
  const db = dbWith([{ id: "a", key: "file:///etc/passwd" }]);
  for (const raw of [
    "file:///etc/passwd",
    "javascript:alert(1)",
    "ftp://h/x",
    "data:text/plain,x",
  ]) {
    expect(resolveItemByUrl(db, raw)).toMatchObject({
      found: false,
      reason: "unresolvable_url",
      service: null,
      fetchable: false,
    });
  }
  db.close();
});

test("a well-formed url with nothing indexed is not_indexed", () => {
  const db = dbWith([]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/9");
  expect(out).toMatchObject({ found: false, reason: "not_indexed", fetchable: false });
  db.close();
});

test("an exact match wins over a trimmable one", () => {
  const db = dbWith([
    { id: "deep", key: "https://github.com/o/r/pull/1/files" },
    { id: "shallow", key: "https://github.com/o/r/pull/1" },
  ]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1/files");
  expect(out).toMatchObject({ found: true, matchKind: "exact" });
  if (out.found) {
    expect(out.item.id).toBe("deep");
  }
  db.close();
});

test("a pathological path resolves in bounded time", () => {
  const db = dbWith([]);
  const long = `https://example.com/${Array.from({ length: 5_000 }, () => "seg").join("/")}`;
  const t0 = performance.now();
  resolveItemByUrl(db, long);
  expect(performance.now() - t0).toBeLessThan(250);
  db.close();
});
