import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import { resolveItemByUrl } from "./resolve-by-url.ts";

function dbWith(rows: Array<{ id: string; key: string | null; type?: string }>): Database {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE item (id TEXT PRIMARY KEY, service TEXT, type TEXT, title TEXT,
    url TEXT, resolve_key TEXT, modified_at INTEGER)`);
  for (const r of rows) {
    db.query(
      `INSERT INTO item (id, service, type, title, url, resolve_key, modified_at)
       VALUES (?, 'github', ?, 'T', ?, ?, 7)`,
    ).run(r.id, r.type ?? "pull_request", r.key, r.key);
  }
  return db;
}

test("rung 1 — exact key matches", () => {
  const db = dbWith([{ id: "a", key: "https://github.com/o/r/pull/1" }]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1#note");
  expect(out).toMatchObject({ found: true, matchKind: "exact" });
  db.close();
});

test("rung 2 — all query params dropped", () => {
  const db = dbWith([{ id: "a", key: "https://github.com/o/r/pull/1" }]);
  const out = resolveItemByUrl(db, "https://github.com/o/r/pull/1?tab=files");
  expect(out).toMatchObject({ found: true, matchKind: "query_stripped" });
  db.close();
});

test("rung 3 — trailing path segments trimmed", () => {
  const db = dbWith([{ id: "a", key: "https://bitbucket.org/o/r/pull-requests/42" }]);
  const out = resolveItemByUrl(db, "https://bitbucket.org/o/r/pull-requests/42/diff");
  expect(out).toMatchObject({ found: true, matchKind: "path_trimmed" });
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
