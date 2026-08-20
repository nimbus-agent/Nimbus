# A browser-viable "why": `agents.why` answers about a pull request

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give `agents.why` a second entry point — `{ prUrl }` instead of `{ ref }` — so a caller holding a pull request URL gets the four PR-centric lanes without a local checkout, and fix the forge-coverage defect in `agents.impact` that the shared resolver exposes.

**Architecture:** `why`'s six lanes already discard the file and ask `findPrForSha`; blame is only the adapter from a line to a pull request. This plan adds one resolver that goes URL → indexed item → `pr` graph entity (no parsing), routes both `why` and `impact` through it, and lets `runWhy` fill its lane input from either entry. Two lanes drop on the PR arm — `authorship` (line-level) and `downstream` (needs a file subject; it is what `impact` already answers) — and the render says so.

**Tech Stack:** Bun + TypeScript 7 strict, `bun:sqlite`, `bun:test`, Biome, markdownlint-cli2. Gateway package `packages/gateway`, CLI `packages/cli`.

**Spec:** `docs/superpowers/specs/2026-08-19-why-from-a-pull-request-design.md` — **in the `nimbus-web-clipper` repo** (`C:/gitrep/nimbus-web-clipper`, branch `worktree-c2-4-why-from-a-pr`). §2 is the resolver and the impact defect, §3 the lanes, §4 the render. That spec is the binding authority; this plan argues from it.

## Global Constraints

- **`@nimbus-dev/sdk` must be at `^1.18.0`** in `packages/gateway/package.json` — that release ships `WhyChangeSubject` and `WhyBrief.changeSubject`. Do not hand-write either type here; they are SDK-owned. (Published from nimbus-sdk PR #132.)
- **`packages/gateway/src/agents/_lib/findings.ts` re-exports brief types BY EXPLICIT NAME.** `WhyChangeSubject` must be added to that list or no gateway code can name the type. This is the first edit, and it is easy to miss.
- **`WhyChangeSubject.url` and `.repo` are non-nullable in the shipped SDK type**, but their sources are not. Fallbacks are fixed by this plan and are not the implementer's choice:
  - `url` — use `item.url`; when it is null, use **the caller's `prUrl`**. That is the URL the user asked about, and it is never null.
  - `repo` — use `json_extract(i.metadata, '$.repo')`; when absent, use the **pr graph entity's `label`**.
- **`itemId` is opaque.** Never parse it, never reconstruct it. `<service>:<externalId>` where the external id is connector-defined — `acme/web#482` on GitHub and Bitbucket, `group/project!482` on GitLab. Building an id from parts is the defect this plan removes.
- **`changeSubject` tri-state** (spec §1.1, decided): **absent** = a `ref`-shaped question; **`null`** = a `prUrl` question whose subject did not resolve; **a value** = one that resolved. On the `prUrl` arm `subject` is **always** null. Never both.
- **`agents.whyPeek` stays synchronous and HTTP-excluded.** It must reject `prUrl`. Do not add it to the HTTP surface, and do not change `HTTP_EXCLUDED_AGENT_METHODS`.
- **No new HTTP method and no scope change.** `why` is already reachable at `POST /v1/agents/why`; this is a params-only contract change.
- **`why.ts` must not import from `why-peek.ts`** — the existing duplication of lane helpers is deliberate (see the note above `findPrForSha`).
- **No `any`.** Use `unknown` plus a type guard for anything crossing a boundary. Rows read from `bun:sqlite` are typed at the query site, as the surrounding code does.
- **Gates:** `bun run typecheck`, `bun run lint`, `bun test`, and — because this plan writes files under `docs/` — **`bun run lint:markdown`**. A locally-green branch still fails CI if markdownlint was not run.
- Conventional Commits. The feature commits are `feat(agents): …`; the impact regression fix is `fix(agents): …`.

---

### Task 1: The shared PR resolver

**Files:**

- Create: `packages/gateway/src/agents/_lib/pr-subject.ts`
- Create: `packages/gateway/src/agents/_lib/pr-subject.test.ts`
- Modify: `packages/gateway/src/agents/_lib/findings.ts` (add `WhyChangeSubject` to the re-export list)
- Modify: `packages/gateway/package.json` (`@nimbus-dev/sdk` → `^1.18.0`)

**Interfaces:**

- Consumes: `resolveItemByUrl` from `../../index/resolve-by-url.ts`, returning `ResolveResponse` — on success `{ found: true, item: { id, service, type, title, url: string | null, modified_at }, matchKind }`; on failure `{ found: false, reason: "not_indexed" | "unresolvable_url" | "ambiguous", … }`.
- Produces:

  ```ts
  export type PrResolveMiss = {
    readonly ok: false;
    readonly reason: "not_indexed" | "ambiguous" | "not_a_pr" | "unresolvable_url";
  };
  export type PrResolveHit = { readonly ok: true; readonly subject: WhyChangeSubject };
  export function resolvePrSubject(db: Database, url: string): PrResolveHit | PrResolveMiss;
  ```

  Tasks 2 and 4 both call `resolvePrSubject`.

- [ ] **Step 1: Bump the SDK and open the re-export**

In `packages/gateway/package.json`, set `"@nimbus-dev/sdk": "^1.18.0"`. Then run `bun install` from the repo root.

In `packages/gateway/src/agents/_lib/findings.ts`, add `WhyChangeSubject` to the alphabetical `export type { … }` list, immediately before `WhyFinding`.

Verify the type is reachable: `bun run typecheck` must still pass, and

```bash
grep -n "WhyChangeSubject" packages/gateway/src/agents/_lib/findings.ts
```

must print one line.

- [ ] **Step 2: Write the failing tests**

Create `packages/gateway/src/agents/_lib/pr-subject.test.ts`. Follow the fixture style of `packages/gateway/src/agents/why.test.ts`: an in-memory `Database`, `LocalIndex.ensureSchema(db)`, `upsertIndexedItemForSync` for items and `upsertGraphEntity` for graph rows.

```ts
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
  },
): string {
  const itemId = `${opts.service}:${opts.externalId}`;
  const title = opts.title ?? "Cache the resolver";
  // NOTE (post-implementation correction): `item` has no `indexed_at` column — it is
  // `synced_at` — and `resolve_key` is not optional: `resolveItemByUrl` (`resolve-by-url.ts`)
  // matches every rung of its ladder on `resolve_key` alone, so a fixture without it resolves
  // nothing. Both fixes below match what actually shipped in `pr-subject.test.ts`.
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
    JSON.stringify(opts.repo === undefined ? {} : { repo: opts.repo }),
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
    });
    const out = resolvePrSubject(db, "https://github.com/acme/web/pull/482");
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.subject.itemId).toBe(itemId);
    expect(out.subject.repo).toBe("acme/web");
    expect(out.subject.url).toBe("https://github.com/acme/web/pull/482");
    expect(out.subject.title).toBe("Cache the resolver");
    expect(out.subject.modifiedAt).toBe(1_700_000_000_000);
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test packages/gateway/src/agents/_lib/pr-subject.test.ts`

Expected: FAIL — the module `./pr-subject.ts` does not exist.

- [ ] **Step 4: Write the resolver**

Create `packages/gateway/src/agents/_lib/pr-subject.ts`:

```ts
import type { Database } from "bun:sqlite";

import { resolveItemByUrl } from "../../index/resolve-by-url.ts";
import type { WhyChangeSubject } from "./findings.ts";

export type PrResolveMiss = {
  readonly ok: false;
  readonly reason: "not_indexed" | "ambiguous" | "not_a_pr" | "unresolvable_url";
};

export type PrResolveHit = { readonly ok: true; readonly subject: WhyChangeSubject };

/**
 * Resolve a pull-request URL to the indexed item and `pr` graph entity behind it.
 *
 * DELIBERATELY PARSE-FREE. `agents.impact` used to rebuild the identity from a
 * URL — `${service}:${owner}/${repo}#${num}` — which fails three independent
 * ways: the regex was GitHub-shaped, the service was guessed from the hostname
 * (so every self-hosted instance missed), and GitLab merge requests are keyed
 * with a BANG (`gitlabMrExternalId`), not a hash. None of that can be fixed by a
 * better pattern, because the pattern is the mistake.
 *
 * Instead: ask the index. `resolveItemByUrl` already matches every forge and
 * every self-hosted host through its canonical-url ladder, and `syncPrGraph`
 * writes the `pr` entity's `external_id` AS the item's primary key
 * (`graph-populator.ts`), so the entity is one equality join away.
 */
export function resolvePrSubject(db: Database, url: string): PrResolveHit | PrResolveMiss {
  const resolved = resolveItemByUrl(db, url);
  if (!resolved.found) {
    return { ok: false, reason: resolved.reason === "ambiguous" ? "ambiguous" : resolved.reason };
  }
  if (resolved.item.type !== "pr") {
    return { ok: false, reason: "not_a_pr" };
  }

  // `graph_entity` declares UNIQUE(type, external_id) (`graph-v7-sql.ts:9`), so
  // this can match at most one row: the LIMIT 1 is belt-and-braces, not a
  // tiebreak between candidates. The join is safe on casing for the same reason
  // the design rests on — `syncPrGraph` writes `externalId: row.id`, so both
  // sides of `i.id = e.external_id` are the same string from the same write.
  const row = db
    .query(
      `SELECT e.id                                  AS entity_id,
              e.label                               AS label,
              json_extract(e.metadata, '$.repo')    AS entity_repo,
              json_extract(i.metadata, '$.repo')    AS item_repo,
              CAST(json_extract(i.metadata, '$.number') AS INTEGER) AS number
         FROM graph_entity e
         JOIN item i ON i.id = e.external_id
        WHERE e.type = 'pr' AND e.external_id = ?
        LIMIT 1`,
    )
    .get(resolved.item.id) as {
    entity_id: string;
    label: string;
    entity_repo: string | null;
    item_repo: string | null;
    number: number | null;
  } | null;

  // An indexed `pr` item without its graph entity does not arise from ordinary
  // sync — `item-store.ts` calls `syncGraphFromIndexedItem` on the same write —
  // but reporting it as a miss is honest, where asserting it cannot happen is not.
  if (row === null) {
    return { ok: false, reason: "not_indexed" };
  }

  return {
    ok: true,
    subject: {
      itemId: resolved.item.id,
      entityId: row.entity_id,
      // `repo` is non-nullable in the SDK type but its source is not; the entity
      // label is the last resort rather than an empty string, which would read as
      // "a repo named nothing".
      repo: row.item_repo ?? row.entity_repo ?? row.label,
      number: row.number,
      // Likewise `url`: the caller's own URL is the honest fallback — it is what
      // they asked about, and it is never null.
      url: resolved.item.url ?? url,
      title: resolved.item.title,
      modifiedAt: resolved.item.modified_at,
    },
  };
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/_lib/pr-subject.test.ts`

Expected: PASS, 14 tests.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test packages/gateway/src/agents`

```bash
git add packages/gateway/src/agents/_lib/pr-subject.ts packages/gateway/src/agents/_lib/pr-subject.test.ts packages/gateway/src/agents/_lib/findings.ts packages/gateway/package.json bun.lock
git commit -m "feat(agents): resolve a pull-request URL through the index, not a pattern

One resolver: URL -> indexed item (resolveItemByUrl's existing ladder) ->
pr graph entity, joined on the entity external_id that syncPrGraph writes as
the item's primary key. No regex, no host-to-service table, no per-forge
external-id format.

That is not a refactor of impact's parsing, it is its removal: the parsing
fails on GitLab three separate ways, and one of them (merge requests are
keyed with a bang, not a hash) no pattern fix would have caught."
```

---

### Task 2: `agents.impact` moves onto the resolver

**Files:**

- Modify: `packages/gateway/src/agents/impact.ts:130-165` (delete `PR_URL_RE`, `HOST_TO_SERVICE`, and the PR branch of `resolveStartEntity`)
- Modify: `packages/gateway/src/agents/impact.test.ts` (add the regression test)

**Interfaces:**

- Consumes: `resolvePrSubject` from Task 1.
- Produces: nothing new. `resolveStartEntity` keeps its signature and its `ResolvedStart` return type; only the PR branch changes.

- [ ] **Step 1: Write the failing regression test**

In `packages/gateway/src/agents/impact.test.ts`, add a test that seeds a GitLab merge request exactly as the connector indexes one (bang-keyed external id) and asserts `runImpact` resolves it — today `startEntityId` comes back `null` because the URL never matches `PR_URL_RE`, and even if it did, the reconstructed id would use a hash:

```ts
test("a GitLab merge request URL resolves to its pr entity", async () => {
  const db = freshDb();
  // `gitlabMrExternalId` (connectors/_lib/gitlab/events.ts) — a BANG, not a hash.
  const itemId = "gitlab:acme/web!482";
  // `resolve_key` is required — `resolveItemByUrl` matches on it alone (see the note beside
  // Task 1's `seedPr`) — and `item` has no `indexed_at` column; it is `synced_at`.
  db.query(
    `INSERT INTO item (id, service, type, external_id, title, url, canonical_url,
                       body_preview, metadata, resolve_key, modified_at, synced_at)
     VALUES (?, 'gitlab', 'pr', 'acme/web!482', 'Cache the resolver',
             'https://gitlab.com/acme/web/-/merge_requests/482',
             'https://gitlab.com/acme/web/-/merge_requests/482', '',
             '{"repo":"acme/web","number":482}',
             'https://gitlab.com/acme/web/-/merge_requests/482',
             1700000000000, 1700000000000)`,
  ).run(itemId);
  // Capture the return: `upsertGraphEntity` gives back the id it inserted, and that
  // id is deterministic — `deterministicGraphEntityId` is sha256 over type+externalId
  // (`relationship-graph.ts:32-34`), not a random UUID.
  const entityId = upsertGraphEntity(db, {
    type: "pr",
    externalId: itemId,
    label: "acme/web#482",
    service: "gitlab",
    metadata: { repo: "acme/web" },
  });

  const brief = await runImpact(
    { fileOrPrUrl: "https://gitlab.com/acme/web/-/merge_requests/482" },
    { db, notify: () => {}, sessionId: "impact-gitlab-1" },
  );

  // NOT `not.toBeNull()`. A non-null id is what the BUG produces too: a GitLab URL
  // under the old code fell through to a LIKE scan over item titles and returned
  // something. Only an exact match distinguishes the fix from what it replaces.
  expect(brief.startEntityId).toBe(entityId);
});
```

Match the file's existing imports and `freshDb`/context helpers rather than introducing new ones — read the top of `impact.test.ts` first and reuse what is there.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/agents/impact.test.ts`

Expected: FAIL — `startEntityId` is `null`. That failure IS the defect the spec describes; capture the output for the report.

- [ ] **Step 3: Replace the PR branch**

In `packages/gateway/src/agents/impact.ts`, delete `PR_URL_RE` and `HOST_TO_SERVICE` entirely, and replace the PR branch at the top of `resolveStartEntity` with a call to the resolver:

```ts
function resolveStartEntity(db: Database, fileOrPrUrl: string): ResolvedStart | null {
  const pr = resolvePrSubject(db, fileOrPrUrl);
  if (pr.ok) {
    return {
      entityId: pr.subject.entityId,
      entityType: "pr",
      repoIds: repoIdsForRepoLabel(db, pr.subject.repo),
    };
  }
  // …the existing symbol branch, then the topic branch, unchanged…
}
```

The symbol and topic fallbacks stay exactly as they are: a non-URL input still has to reach them.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/impact.test.ts`

Expected: PASS, including the pre-existing GitHub PR tests — the resolver must not regress them. If a pre-existing test fails, do not adjust the test; the resolver or this wiring is wrong.

- [ ] **Step 5: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test packages/gateway/src/agents`

```bash
git add packages/gateway/src/agents/impact.ts packages/gateway/src/agents/impact.test.ts
git commit -m "fix(agents): impact resolves GitLab and self-hosted pull requests

The PR branch rebuilt an identity by pattern and missed three ways: the regex
was GitHub-shaped, the service was guessed from the hostname so every
self-hosted instance fell through, and GitLab merge requests are keyed with a
bang. A GitLab URL then fell through to a symbol lookup and finally a LIKE scan
over item titles — which quietly returned SOMETHING, so the lane looked like it
worked.

Now it asks the index. The regression test seeds a bang-keyed merge request and
fails on the old code."
```

---

### Task 3: The `prUrl` params arm

**Files:**

- Modify: `packages/gateway/src/agents/_lib/why-types.ts` (the `WhyInput` union)
- Modify: `packages/gateway/src/ipc/agents-rpc.ts:416-435` (`requireWhyParams`) and `:458-461` (`handleWhyPeek`)
- Modify: `packages/gateway/src/ipc/agents-rpc.why.test.ts`

**Interfaces:**

- Consumes: nothing from Tasks 1-2.
- Produces:

  ```ts
  export type WhyRefInput = { ref: string; line?: number };
  export type WhyPrInput = { prUrl: string };
  export type WhyInput = WhyRefInput | WhyPrInput;
  export function isWhyPrInput(input: WhyInput): input is WhyPrInput;
  ```

  Task 4 branches on `isWhyPrInput`.

- [ ] **Step 1: Write the failing tests**

In `packages/gateway/src/ipc/agents-rpc.why.test.ts`, add:

```ts
test("agents.why accepts { prUrl }", async () => {
  const out = await dispatchAgents(
    "agents.why",
    { prUrl: "https://github.com/acme/web/pull/482" },
    ctx(),
  );
  expect(out).toHaveProperty("sessionId");
});

test("agents.why rejects a payload carrying both arms", async () => {
  await expect(
    dispatchAgents("agents.why", { ref: "src/a.ts", prUrl: "https://x/y/pull/1" }, ctx()),
  ).rejects.toThrow(/exactly one of/i);
});

test("agents.why rejects an empty prUrl", async () => {
  await expect(dispatchAgents("agents.why", { prUrl: "   " }, ctx())).rejects.toThrow(/prUrl/);
});

test("agents.whyPeek still rejects prUrl", async () => {
  await expect(dispatchAgents("agents.whyPeek", { prUrl: "https://x/y/pull/1" }, ctx())).rejects
    .toThrow(/ref/);
});
```

Use the file's existing dispatch helper and context factory — read the top of `agents-rpc.why.test.ts` and reuse them rather than inventing new ones.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/ipc/agents-rpc.why.test.ts`

Expected: FAIL — `requireWhyParams` rejects `{ prUrl }` because `ref` is not a string.

- [ ] **Step 3: Widen the input type**

In `packages/gateway/src/agents/_lib/why-types.ts`, replace `export type WhyInput = { ref: string; line?: number };` with:

```ts
export type WhyRefInput = { ref: string; line?: number };

/** The browser-viable arm: a pull request URL, no local checkout required. */
export type WhyPrInput = { prUrl: string };

/**
 * Exactly one arm, never both. `agents.whyPeek` accepts only `WhyRefInput` — it
 * is line-level by nature and stays HTTP-excluded.
 */
export type WhyInput = WhyRefInput | WhyPrInput;

export function isWhyPrInput(input: WhyInput): input is WhyPrInput {
  return "prUrl" in input;
}
```

- [ ] **Step 4: Split the validators**

In `packages/gateway/src/ipc/agents-rpc.ts`, keep the existing `ref` validation as `requireWhyRefParams` (same body, same limits, returning `WhyRefInput`), have `handleWhyPeek` call **that** one, and add:

```ts
const MAX_PR_URL_LEN = 2048;

function requireWhyParams(params: unknown): WhyInput {
  if (params === null || typeof params !== "object" || Array.isArray(params)) {
    throw new AgentsRpcError(-32602, "agents.why requires { ref: string } or { prUrl: string }");
  }
  const p = params as { ref?: unknown; prUrl?: unknown };
  const hasRef = p.ref !== undefined;
  const hasPrUrl = p.prUrl !== undefined;
  if (hasRef === hasPrUrl) {
    throw new AgentsRpcError(-32602, "agents.why requires exactly one of { ref } or { prUrl }");
  }
  if (hasPrUrl) {
    if (typeof p.prUrl !== "string") {
      throw new AgentsRpcError(-32602, "prUrl must be a string");
    }
    const trimmed = p.prUrl.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_PR_URL_LEN) {
      throw new AgentsRpcError(-32602, `prUrl must be 1..${MAX_PR_URL_LEN} chars after trim`);
    }
    return { prUrl: trimmed };
  }
  return requireWhyRefParams(params);
}
```

`hasRef === hasPrUrl` covers both failure modes in one line: neither supplied, or both.

- [ ] **Step 5: Run to verify they pass**

Run: `bun test packages/gateway/src/ipc/agents-rpc.why.test.ts`

Expected: PASS, and every pre-existing test in that file still passes — the `ref` arm is untouched behaviour.

- [ ] **Step 6: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test packages/gateway/src/ipc`

```bash
git add packages/gateway/src/agents/_lib/why-types.ts packages/gateway/src/ipc/agents-rpc.ts packages/gateway/src/ipc/agents-rpc.why.test.ts
git commit -m "feat(agents): agents.why takes { prUrl } as well as { ref }

Exactly one arm, never both — hasRef === hasPrUrl rejects an empty payload and
a both-arms payload with the same test. No new method, no allow-list change, no
scope change: why is already reachable over HTTP, it just demanded an input a
browser cannot supply.

whyPeek keeps the ref-only validator. It is line-level by nature and stays
HTTP-excluded; nothing here changes that."
```

---

### Task 4: The lanes, and the brief

**Files:**

- Modify: `packages/gateway/src/agents/why.ts` — `LaneInput` (`:34-37`), `runWhy` (`:59-129`), and the five lane functions that call `findPrForSha`
- Modify: `packages/gateway/src/agents/why.test.ts` (add the `prUrl` arm's tests)

**Interfaces:**

- Consumes: `resolvePrSubject` (Task 1), `isWhyPrInput` and the `WhyInput` union (Task 3).
- Produces: a `WhyBrief` whose `changeSubject` follows the tri-state in the Global Constraints. Task 5 renders it.

- [ ] **Step 1: Write the failing tests**

Add to `packages/gateway/src/agents/why.test.ts`, reusing that file's `freshDb`/fixture helpers:

```ts
describe("runWhy — the prUrl arm", () => {
  test("answers the four PR lanes without a checkout, and spawns no blame", async () => {
    const db = freshDb();
    // Seed the PR, its ticket and its discussion exactly as the ref-arm fixtures
    // do, but DO NOT seed blame or filesystem roots — the point of this arm.
    seedPrWithTicketAndDiscussion(db);
    let spawned = 0;
    const brief = await runWhy(
      { prUrl: "https://github.com/acme/web/pull/482" },
      { db, roots: [], notify: () => {}, sessionId: "why-pr-1", spawn: () => { spawned += 1; return null; } },
    );

    expect(spawned).toBe(0);
    expect(brief.subject).toBeNull();
    expect(brief.changeSubject?.repo).toBe("acme/web");
    expect(brief.query).toEqual({ ref: "https://github.com/acme/web/pull/482", line: null });
    const lanes = new Set(brief.findings.map((f) => f.lane));
    expect(lanes.has("pull_request")).toBe(true);
    expect(lanes.has("ticket")).toBe(true);
    expect(lanes.has("authorship")).toBe(false);
    expect(lanes.has("downstream")).toBe(false);
  });

  test("a miss returns a brief with a null changeSubject, not a failure", async () => {
    const db = freshDb();
    const brief = await runWhy(
      { prUrl: "https://github.com/acme/web/pull/999" },
      { db, roots: [], notify: () => {}, sessionId: "why-pr-2" },
    );
    expect(brief.kind).toBe("why");
    expect(brief.changeSubject).toBeNull();
    expect(brief.subject).toBeNull();
    expect(brief.findings).toEqual([]);
  });

  test("the ref arm leaves changeSubject absent", async () => {
    const db = freshDb();
    const brief = await runWhy({ ref: refAt(12) }, ctxFor(db));
    expect("changeSubject" in brief && brief.changeSubject !== undefined).toBe(false);
  });
});
```

Write `seedPrWithTicketAndDiscussion` beside the file's existing fixture builder, reusing its helpers; it must seed the same rows the ref-arm PR fixture does, minus blame.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/agents/why.test.ts`

Expected: FAIL — `runWhy` reads `input.ref` unconditionally.

- [ ] **Step 3: Give `LaneInput` a resolved PR**

In `why.ts`, widen `LaneInput` so the lanes stop deriving the PR themselves:

```ts
type LaneInput = {
  subject: WhySubject | null;
  blame: BlameLookup | null;
  /**
   * The pull request the lanes answer about, resolved ONCE by whichever entry
   * point ran: blame -> sha -> findPrForSha on the ref arm, the index resolver
   * on the prUrl arm. The lanes must not care which — that is what makes this
   * an entry point rather than a second code path.
   */
  pr: PrForSha | null;
  /**
   * Blame's author time on the ref arm, the PR's own timestamp on the prUrl arm —
   * and never one standing in for the other. See the per-arm computation below.
   */
  occurredAt: number | null;
  /**
   * Which entry point ran. `subAuthorship` and `subDownstream` are file/line lanes
   * by nature — they stay silent on `"change"` rather than reporting a gap for the
   * file subject a `prUrl` question never had. Explicit, not inferred from
   * `subject === null`: inference would also silence the genuine ref-arm case
   * where a ref legitimately fails to resolve, which must keep its gap note.
   * (NOTE, post-implementation correction: this field is what makes Step 5's "no edit"
   * claim for `subAuthorship`/`subDownstream` false — see that step's note.)
   */
  arm: "ref" | "change";
};
```

- [ ] **Step 4: Route both entries into it**

Rewrite the head of `runWhy` so the two arms converge:

```ts
export async function runWhy(input: WhyInput, ctx: WhyContext): Promise<WhyBrief> {
  const start = performance.now();
  const preflightGaps: GapNote[] = [];
  const empty = detectEmptyIndex(ctx.db);
  if (empty !== null) preflightGaps.push(empty);

  let subject: WhySubject | null = null;
  let blame: BlameLookup | null = null;
  let pr: PrForSha | null = null;
  let changeSubject: WhyChangeSubject | null | undefined;
  let queryRef: string;
  let queryLine: number | null;

  if (isWhyPrInput(input)) {
    queryRef = input.prUrl;
    queryLine = null;
    const resolved = resolvePrSubject(ctx.db, input.prUrl);
    // null, not absent: the caller asked about a change and we could not name it.
    changeSubject = resolved.ok ? resolved.subject : null;
    pr = resolved.ok
      ? {
          entityId: resolved.subject.entityId,
          number: resolved.subject.number,
          title: resolved.subject.title,
          url: resolved.subject.url,
          modifiedAt: resolved.subject.modifiedAt,
        }
      : null;
  } else {
    queryRef = input.ref;
    queryLine = input.line ?? parseRef(input.ref).line;
    subject = resolveWhySubject(ctx.db, ctx.roots, input);
    if (subject !== null && subject.lineNo !== null) {
      blame = await ensureBlameLine(
        ctx.db,
        { repoRoot: subject.repoRoot, filePath: subject.filePath },
        subject.lineNo,
        ctx.spawn,
      );
    }
    pr = blame === null ? null : findPrForSha(ctx.db, blame.commitSha);
  }

  const lane: LaneInput = {
    subject,
    blame,
    pr,
    // PER-ARM, not a shared `??` chain. `BlameLookup.authorTimeMs` is
    // `number | null` — `blame-store.ts` defaults it to null when git blame emits
    // no author-time line — so `blame?.authorTimeMs ?? pr?.modifiedAt` would, on
    // the REF arm, silently substitute the PR's merge time for the commit's author
    // time whenever both are present. `subDriver` would then correlate incidents
    // against the wrong instant: a wrong answer, not an absent one, in the arm this
    // work must leave untouched.
    occurredAt: isWhyPrInput(input) ? (pr?.modifiedAt ?? null) : (blame?.authorTimeMs ?? null),
  };
  // …coordinator and tasks unchanged…
```

and its return:

```ts
  return {
    kind: "why",
    agentVersion: 1,
    generatedAt: Date.now(),
    latencyMs: Math.round(performance.now() - start),
    gaps,
    query: { ref: queryRef, line: queryLine },
    subject,
    ...(changeSubject === undefined ? {} : { changeSubject }),
    findings: allFindings,
  };
```

The spread is what keeps the field **absent** on the ref arm rather than explicitly `undefined` — the repo compiles with `exactOptionalPropertyTypes`, and absent is also the only thing `JSON.stringify` can put on the wire.

- [ ] **Step 5: Point the lanes at `lane.pr`**

In `subPullRequest`, `subTicket` and `subDiscussion`, replace the opening

```ts
const sha = lane.blame?.commitSha;
const pr = sha === undefined ? null : findPrForSha(db, sha);
```

with `const pr = lane.pr;`. In `subDiscussion` keep the commit-entity lookup guarded on `lane.blame?.commitSha`, since a commit-message thread genuinely needs the SHA and the prUrl arm has none. In `subDriver`, replace `lane.blame?.authorTimeMs` with `lane.occurredAt`.

**CORRECTION (post-implementation): this "need no edit" claim is false, and it is what produced
the gap-note defect a follow-up commit had to fix.** On the prUrl arm `lane.subject` is `null`
(never populated — the prUrl arm has no file/line subject to resolve), so `subAuthorship`'s
existing `lane.subject?.lineNo == null` early-return and `subDownstream`'s existing
`lane.subject === null` early-return are BOTH still true on that arm — but they return the gap
note ("Cannot anchor authorship: no resolvable file/line subject for this ref.", "No indexed
code symbols for this file …"), not silence. Those gap notes are correct on the ref arm (a ref
that genuinely failed to resolve) and WRONG on the prUrl arm (the absence is the shape of the
question, not a gap in anyone's index) — the two cases are indistinguishable from
`lane.subject === null` alone. What actually shipped: both functions gained an explicit
`if (lane.arm === "change") return {};` before their existing early-return, using the `arm`
field Step 3 added for exactly this. `subPullRequest`, `subTicket` and `subDiscussion` needed no
equivalent change — their existing `pr === null` / fixture guards already degrade correctly on
both arms.

- [ ] **Step 6: Run the tests to verify they pass**

Run: `bun test packages/gateway/src/agents/why.test.ts`

Expected: PASS, including every pre-existing ref-arm test — this task must not change ref-arm behaviour. A changed ref-arm expectation means the refactor is wrong, not the test.

- [ ] **Step 7: Gates and commit**

Run: `bun run typecheck && bun run lint && bun test packages/gateway/src/agents`

```bash
git add packages/gateway/src/agents/why.ts packages/gateway/src/agents/why.test.ts
git commit -m "feat(agents): why answers about a pull request, no checkout required

Four of the six lanes already opened by throwing the file away and asking
findPrForSha — blame was the adapter from a line to a pull request, not the
subject. LaneInput now carries the resolved PR and the timestamp, filled by
blame on the ref arm and by the index resolver on the prUrl arm, and the lanes
stop knowing which ran.

authorship and downstream return nothing on the prUrl arm: the first is
line-level, and the second is the question the impact agent already answers.

A resolver miss returns a brief with changeSubject null, following impact's
precedent of a null start entity rather than a failed run."
```

---

### Task 5: The render, and the CLI

**Files:**

- Modify: `packages/gateway/src/agents/_lib/render.ts:283-289` (`renderWhySubjectLine`)
- Modify: `packages/gateway/src/agents/_lib/render.why.test.ts`
- Modify: `packages/cli/src/commands/why.ts` (accept a URL) and its test

**Interfaces:**

- Consumes: `WhyBrief.changeSubject` (Task 4).
- Produces: the user-visible text. The browser extension renders this string verbatim, so this task is also the extension's entire disclosure.

- [ ] **Step 1: Write the failing render tests**

In `packages/gateway/src/agents/_lib/render.why.test.ts`:

```ts
test("a change subject names the PR and what this entry point cannot answer", () => {
  const out = renderWhy(briefWith({
    subject: null,
    changeSubject: {
      itemId: "github:acme/web#482",
      entityId: "e1",
      repo: "acme/web",
      number: 482,
      url: "https://github.com/acme/web/pull/482",
      title: "Cache the resolver",
      modifiedAt: 1_700_000_000_000,
    },
  }));
  expect(out).toContain("acme/web#482");
  expect(out).toContain("Cache the resolver");
  expect(out).toContain("nimbus why <file>:<line>");
  expect(out).toContain("nimbus impact");
  expect(out).not.toContain("Could not resolve");
});

test("a change subject that did not resolve says so, and does not blame the ref", () => {
  const out = renderWhy(briefWith({
    subject: null,
    changeSubject: null,
    query: { ref: "https://github.com/acme/web/pull/999", line: null },
  }));
  expect(out).toContain("https://github.com/acme/web/pull/999");
  expect(out).toContain("not in your index");
});

test("a ref brief renders exactly as before", () => {
  const out = renderWhy(briefWith({
    subject: { repoRoot: "/repo", filePath: "src/a.ts", lineNo: 12, symbol: null },
  }));
  expect(out).toContain("`src/a.ts:12` in `/repo`");
});
```

Reuse the file's existing brief builder; add `briefWith` beside it only if none exists.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test packages/gateway/src/agents/_lib/render.why.test.ts`

Expected: FAIL — a `changeSubject` brief renders "Could not resolve …", because `subject` is null.

- [ ] **Step 3: Branch the subject line**

Replace `renderWhySubjectLine` in `packages/gateway/src/agents/_lib/render.ts`:

```ts
function renderWhySubjectLine(brief: WhyBrief): string {
  // Branch BEFORE the null check: on the prUrl arm `subject` is always null, and
  // the old line would report a resolved pull request as an unresolvable ref.
  if (brief.changeSubject !== undefined) {
    const cs = brief.changeSubject;
    if (cs === null) {
      return `_\`${brief.query.ref}\` is not in your index._`;
    }
    const num = cs.number === null ? "" : `#${String(cs.number)}`;
    return [
      `\`${cs.repo}${num}\` — ${cs.title}`,
      "",
      "_Asked about a change: authorship needs a line (`nimbus why <file>:<line>`), " +
        "and downstream impact is `nimbus impact <url>`._",
    ].join("\n");
  }
  if (brief.subject === null) {
    return `_Could not resolve \`${brief.query.ref}\` to an indexed location._`;
  }
  const lineSuffix = brief.subject.lineNo === null ? "" : `:${String(brief.subject.lineNo)}`;
  return `\`${brief.subject.filePath}${lineSuffix}\` in \`${brief.subject.repoRoot}\``;
}
```

The two absent lanes need no gap note: `renderWhy` already skips a lane with no findings, and `GapCategory` is a closed SDK union whose every member describes an absence in the *index*, not a question shape (spec §4).

- [ ] **Step 4: Run to verify they pass**

Run: `bun test packages/gateway/src/agents/_lib/render.why.test.ts`

Expected: PASS, pre-existing render tests included.

- [ ] **Step 5: Let the CLI take a URL**

In `packages/cli/src/commands/why.ts`, send `{ prUrl }` when the positional argument parses as an `http`/`https` URL, and `{ ref }` otherwise:

```ts
/**
 * Two call sites need this: choosing the params arm, and refusing `--peek` on a
 * URL. The `catch` returns rather than being empty — `resolve-by-url.ts:133` is
 * the repo's idiom, and an empty block is a lint risk for no gain.
 */
function isHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

function whyParamsFor(ref: string, line: number | undefined): Record<string, unknown> {
  if (isHttpUrl(ref)) {
    return { prUrl: ref };
  }
  return line === undefined ? { ref } : { ref, line };
}
```

The `--peek` guard uses the same predicate, so the two cannot disagree about what a URL is:

```ts
if (args.peek && isHttpUrl(args.ref)) {
  throw new Error("--peek takes a path or symbol, not a pull request URL");
}
```

Update `USAGE` to `"Usage: nimbus why <path[:line] | symbol | pr-url> [--line <n>] [--peek] [--json]"`. `--peek` keeps sending `{ ref }` — `whyPeek` rejects `prUrl`, and a peek of a whole change is not a thing; if `--peek` is combined with a URL, fail with that message rather than sending a request that will be refused.

Add a test in the command's existing test file asserting the URL and non-URL branches produce the right params, and that `--peek` with a URL errors.

- [ ] **Step 6: Full gates and commit**

Run, from the repo root:

```bash
bun run typecheck
bun run lint
bun run lint:markdown
bun test
```

All must be green. `lint:markdown` matters because this branch adds a file under `docs/` — a locally-green branch still fails CI without it.

```bash
git add packages/gateway/src/agents/_lib/render.ts packages/gateway/src/agents/_lib/render.why.test.ts packages/cli/src/commands/why.ts packages/cli/src/commands/why.test.ts
git commit -m "feat(agents): the why brief says which change it is about, and what it cannot answer

The subject line branches on changeSubject BEFORE the null check, because on
the prUrl arm subject is always null and the old line would have reported a
resolved pull request as an unresolvable ref.

Two lanes are absent on this arm and renderWhy skips empty lanes silently, so
the line names them and says where to get them. No new gap category: GapCategory
is a closed SDK union and every member describes an absence in the index, not a
question shape — widening it for copy would have cost a major.

nimbus why now takes a pull request URL. --peek does not: whyPeek is line-level
and rejects prUrl, so combining them fails locally rather than round-tripping."
```

---

## Self-review

**Spec coverage.** §1.1 the SDK types (consumed via the `findings.ts` re-export, Task 1) · §1.2 the params XOR (Task 3) · §2 the shared resolver and the impact fix (Tasks 1-2) · §2.1 the trim ladder, inherited from `resolveItemByUrl` and pinned by Task 1's sub-tab test · §2.2 a miss is a brief not an error (Task 4) plus the miss render (Task 5) · §3 the lane table (Tasks 4-5) · §4 the disclosure without a new gap category (Task 5) · §6 the `findings.ts` re-export (Task 1 Step 1). §5 is the clipper's slice and is not in this plan.

**No placeholders.** Every step carries the command or the literal code. Three steps say "reuse the file's existing helper" rather than pasting a fixture builder — those are `impact.test.ts`, `agents-rpc.why.test.ts` and `render.why.test.ts`, where inventing a second helper beside an existing one would be the defect.

**Type consistency.** `WhyChangeSubject`'s seven members are spelled identically in Task 1's resolver, Task 4's `pr` mapping and Task 5's render fixture. `PrForSha` (`why.ts:171`) has five members — `entityId`, `number`, `title`, `url`, `modifiedAt` — and Task 4's mapping supplies exactly those. `resolvePrSubject` returns `PrResolveHit | PrResolveMiss` in Task 1 and is consumed as `.ok`-discriminated in Tasks 2 and 4.

**Deliberately not here.** The `agents.why` HTTP allow-list (already open), `whyPeek`'s exclusion (unchanged), abort/cancellation (no upstream primitive), and the browser lane (the clipper's own slice, after this ships).

**Review response (2026-08-19).** The plan review asked for a tidier URL check in Task 5: taken, but as a named `isHttpUrl` predicate with a returning `catch` rather than the suggested empty `catch {}` — the repo's own idiom returns from the catch, and the predicate has two call sites (the params arm and the `--peek` refusal), so extracting it is not gold-plating. It also asked whether an item can have several `pr` graph entities: it cannot, and the answer is now a comment in Task 1 — `graph_entity` declares `UNIQUE(type, external_id)`. The two remaining points (join casing, and `#0` rendering when `number` is `0`) were verified correct by the review and need no change; `=== null` is deliberately not a truthiness check, so a `0` would render rather than silently vanish.
