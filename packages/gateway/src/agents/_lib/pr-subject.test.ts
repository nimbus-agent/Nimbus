import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { upsertGraphEntity } from "../../graph/relationship-graph.ts";
import { LocalIndex } from "../../index/local-index.ts";
import { resolvePrSubject } from "./pr-subject.ts";

function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/**
 * Seed one indexed PR item plus its `pr` graph entity, keyed exactly as
 * `graph-populator.ts`'s `syncPrGraph` does: the entity's `external_id` IS the
 * item's primary key. Every forge below differs ONLY in the external id and the
 * url — which is the point of the resolver: no branch anywhere parses either.
 */
function seedPr(
  db: Database,
  opts: {
    service: string;
    externalId: string;
    url: string;
    repo?: string;
    title?: string;
    type?: string;
    number?: number;
  },
): string {
  const itemId = `${opts.service}:${opts.externalId}`;
  const title = opts.title ?? "Cache the resolver";
  const metadata: Record<string, unknown> = {};
  if (opts.repo !== undefined) metadata["repo"] = opts.repo;
  if (opts.number !== undefined) metadata["number"] = opts.number;
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, url, canonical_url,
                       body_preview, metadata, resolve_key, modified_at, synced_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, '', ?, ?, 1700000000000, 1700000000000)`,
  ).run(
    itemId,
    opts.service,
    opts.type ?? "pr",
    opts.externalId,
    title,
    opts.url,
    opts.url,
    JSON.stringify(metadata),
    opts.url,
  );
  upsertGraphEntity(db, {
    type: opts.type ?? "pr",
    externalId: itemId,
    label: opts.repo === undefined ? title : `${opts.repo}#482`,
    service: opts.service,
    ...(opts.repo === undefined ? {} : { metadata: { repo: opts.repo } }),
  });
  return itemId;
}

describe("resolvePrSubject — forge coverage", () => {
  test("GitHub /owner/repo/pull/N", () => {
    const db = freshDb();
    const itemId = seedPr(db, {
      service: "github",
      externalId: "acme/web#482",
      url: "https://github.com/acme/web/pull/482",
      repo: "acme/web",
      number: 482,
    });
    const out = resolvePrSubject(db, "https://github.com/acme/web/pull/482");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.itemId).toBe(itemId);
    expect(out.subject.repo).toBe("acme/web");
    expect(out.subject.url).toBe("https://github.com/acme/web/pull/482");
    expect(out.subject.title).toBe("Cache the resolver");
    expect(out.subject.modifiedAt).toBe(1_700_000_000_000);
    // The `#N` in the rendered subject line is user-visible: exercises the
    // `CAST(json_extract(...))` for `number` against a REAL value, not just `null`.
    expect(out.subject.number).toBe(482);
  });

  test("GitHub Enterprise host resolves — no host table is consulted", () => {
    const db = freshDb();
    seedPr(db, {
      service: "github",
      externalId: "acme/web#482",
      url: "https://git.acme.example/acme/web/pull/482",
      repo: "acme/web",
    });
    expect(resolvePrSubject(db, "https://git.acme.example/acme/web/pull/482").ok).toBe(true);
  });

  /**
   * The case that fails THREE ways under `impact`'s parsing today: the URL shape
   * is `/-/merge_requests/`, the service cannot be guessed from a self-hosted
   * host, and the external id uses a BANG (`gitlabMrExternalId`), not a hash.
   */
  test("GitLab /-/merge_requests/N, keyed with a bang", () => {
    const db = freshDb();
    const itemId = seedPr(db, {
      service: "gitlab",
      externalId: "acme/web!482",
      url: "https://gitlab.com/acme/web/-/merge_requests/482",
      repo: "acme/web",
    });
    const out = resolvePrSubject(db, "https://gitlab.com/acme/web/-/merge_requests/482");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.itemId).toBe(itemId);
    expect(itemId).toContain("!");
  });

  test("GitLab nested subgroup path", () => {
    const db = freshDb();
    seedPr(db, {
      service: "gitlab",
      externalId: "acme/team/web!482",
      url: "https://gitlab.com/acme/team/web/-/merge_requests/482",
      repo: "acme/team/web",
    });
    expect(resolvePrSubject(db, "https://gitlab.com/acme/team/web/-/merge_requests/482").ok).toBe(
      true,
    );
  });

  test("Bitbucket Cloud /workspace/repo/pull-requests/N", () => {
    const db = freshDb();
    seedPr(db, {
      service: "bitbucket",
      externalId: "acme/web#482",
      url: "https://bitbucket.org/acme/web/pull-requests/482",
      repo: "acme/web",
    });
    expect(resolvePrSubject(db, "https://bitbucket.org/acme/web/pull-requests/482").ok).toBe(true);
  });

  test("Bitbucket Server /projects/KEY/repos/slug/pull-requests/N", () => {
    const db = freshDb();
    seedPr(db, {
      service: "bitbucket",
      externalId: "ACME/web#482",
      url: "https://bb.acme.example/projects/ACME/repos/web/pull-requests/482",
      repo: "ACME/web",
    });
    expect(
      resolvePrSubject(db, "https://bb.acme.example/projects/ACME/repos/web/pull-requests/482").ok,
    ).toBe(true);
  });
});

describe("resolvePrSubject — the ladder and the misses", () => {
  test("a sub-tab URL resolves through the trim ladder", () => {
    const db = freshDb();
    seedPr(db, {
      service: "github",
      externalId: "acme/web#482",
      url: "https://github.com/acme/web/pull/482",
      repo: "acme/web",
    });
    expect(resolvePrSubject(db, "https://github.com/acme/web/pull/482/files?w=1").ok).toBe(true);
  });

  test("not indexed", () => {
    const db = freshDb();
    const out = resolvePrSubject(db, "https://github.com/acme/web/pull/999");
    expect(out).toEqual({ ok: false, reason: "not_indexed" });
  });

  test("an indexed item that is not a pull request", () => {
    const db = freshDb();
    seedPr(db, {
      service: "jira",
      externalId: "ACME-1",
      url: "https://acme.atlassian.net/browse/ACME-1",
      type: "issue",
      repo: "acme/web",
    });
    const out = resolvePrSubject(db, "https://acme.atlassian.net/browse/ACME-1");
    expect(out).toEqual({ ok: false, reason: "not_a_pr" });
  });

  test("an unparseable url", () => {
    const db = freshDb();
    expect(resolvePrSubject(db, "not-a-url")).toEqual({ ok: false, reason: "unresolvable_url" });
  });

  test("ambiguous: two indexed items share a trimmed key", () => {
    const db = freshDb();
    // Both rows resolve to the SAME `resolve_key` — a realistic duplicate-index case (e.g.
    // the same PR re-synced under a second connector run) — so the exact and query-stripped
    // rungs miss on the deeper query URL below, and the drop-2 trim rung matches both rows
    // via one exact `resolve_key` lookup rather than guessing between them.
    seedPr(db, {
      service: "github",
      externalId: "acme/web#482",
      url: "https://github.com/acme/web/pull/482",
      repo: "acme/web",
    });
    seedPr(db, {
      service: "github",
      externalId: "acme/web#482-reindexed",
      url: "https://github.com/acme/web/pull/482",
      repo: "acme/web",
    });
    const out = resolvePrSubject(db, "https://github.com/acme/web/pull/482/checks/123");
    expect(out).toEqual({ ok: false, reason: "ambiguous" });
  });

  test("over-trim: a URL more than RESOLVE_MAX_TRIMMED_SEGMENTS (3) segments deeper misses", () => {
    const db = freshDb();
    seedPr(db, {
      service: "github",
      externalId: "acme/web#482",
      url: "https://github.com/acme/web/pull/482",
      repo: "acme/web",
    });
    // Four segments below the canonical `/acme/web/pull/482` — one more than the trim ladder
    // (`RESOLVE_MAX_TRIMMED_SEGMENTS`, resolve-by-url.ts) is bounded to walk, so no rung ever
    // reaches the indexed key and this must miss rather than guess.
    const out = resolvePrSubject(db, "https://github.com/acme/web/pull/482/commits/abc123/file/x");
    expect(out).toEqual({ ok: false, reason: "not_indexed" });
  });
});

describe("resolvePrSubject — the non-nullable fallbacks", () => {
  test("url falls back to the caller's prUrl when the item has none", () => {
    const db = freshDb();
    db.query(
      `INSERT INTO item (id, service, type, external_id, title, url, canonical_url,
                         body_preview, metadata, resolve_key, modified_at, synced_at)
       VALUES ('github:acme/web#482', 'github', 'pr', 'acme/web#482', 'T', NULL,
               'https://github.com/acme/web/pull/482', '', '{"repo":"acme/web"}',
               'https://github.com/acme/web/pull/482',
               1700000000000, 1700000000000)`,
    ).run();
    upsertGraphEntity(db, {
      type: "pr",
      externalId: "github:acme/web#482",
      label: "acme/web#482",
      service: "github",
      metadata: { repo: "acme/web" },
    });
    const out = resolvePrSubject(db, "https://github.com/acme/web/pull/482");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.url).toBe("https://github.com/acme/web/pull/482");
  });

  test("repo falls back to the entity label when the item metadata has none", () => {
    const db = freshDb();
    seedPr(db, {
      service: "github",
      externalId: "acme/web#482",
      url: "https://github.com/acme/web/pull/482",
    });
    const out = resolvePrSubject(db, "https://github.com/acme/web/pull/482");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.repo).toBe("Cache the resolver");
  });
});
