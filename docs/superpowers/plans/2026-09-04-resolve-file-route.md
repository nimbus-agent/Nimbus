# `GET /v1/items/resolve-file` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a bearer-authed HTTP read that resolves a forge file coordinate (`service`, `repo`, `refAndPath`) to a repo-relative path in the reader's own checkout, unblocking the three file lanes already shipped in `nimbus-web-clipper`.

**Architecture:** A thin read in front of `resolveFileByRemote`, which already exists and already returns the needed shape. It mirrors `handleItemsResolve` next door: surface gate → scoped bearer gate → parameters → answer. The only non-mechanical part is the response projection, which names `path` field by field so the reader's local filesystem root can never cross the wire.

**Tech Stack:** TypeScript on Bun; `bun:sqlite`; `bun:test`; Biome for lint.

**Spec:** [`docs/superpowers/specs/2026-09-04-resolve-file-route-design.md`](../specs/2026-09-04-resolve-file-route-design.md)

## Global Constraints

Every task inherits these. They come from the spec; the values are verbatim.

- **The response body on a hit is exactly `{ ok: true, path }`.** `ResolveFileResult` also carries `repoRoot` (the reader's local filesystem path) and `fileEntityId`. Neither may ever appear in a response. Build the object field by field — never a spread, never a destructured rest.
- **The response body on a miss is exactly `{ ok: false, reason, repo }`**, where `reason` is `"remote_not_tracked"` or `"file_not_indexed"`. The two are different facts with different remediations and must never be collapsed.
- **The route must be matched as a bare `url.pathname === "/v1/items/resolve-file"` with double quotes.** A `switch`, a template literal or a shared path constant is invisible to `http-route-auth.test.ts`'s source scanner, and the auth-table entry would then fail its stale-entry test even though the route works.
- **Scope is `resolve`, not `agents`.** The route resolves; it runs nothing.
- **No egress row.** Nothing leaves the machine.
- **No version floor constant.** The route's presence is the capability signal.
- **Do not add the route to `HTTP_ROUTES` or `openapi/v1.yaml`.** That list is the documented public surface, and no clip-scoped bearer read is in it.
- **Do not touch `packages/gateway/src/ipc/agents-rpc.ts`.** This change is additive and deprecates nothing.
- **Do not extract a shared gate helper** from `handleItemsResolve` / `requireEgressRead`. Explicitly out of scope; the 404 bodies differ.

**Commands** (run from the repo root):

- Single test file: `bun test packages/gateway/test/integration/http/items-resolve-file-route.test.ts`
- Gateway suite: `bun test packages/gateway`
- Types: `bun run typecheck`
- Lint: `bun run lint`
- Docs lint: `bun run lint:markdown`

---

## File Structure

| File | Change | Responsibility |
| --- | --- | --- |
| `packages/gateway/src/ipc/http-route-auth.ts` | Modify | The route key constant, its `HTTP_ROUTE_AUTH` row, and its arm of the `ClipReadRouteKey` union |
| `packages/gateway/src/ipc/http-server.ts` | Modify | The `resolveFileByRemote` import, the `coordinateParam` helper, `handleItemsResolveFile`, and one line in `tryBearerAuthedGet` |
| `packages/gateway/test/integration/http/items-resolve-file-route.test.ts` | Create | Every assertion about the route: hit, disclosure guard, both misses, gates, encoding |
| `packages/gateway/src/egress/egress-coverage.ts` | Modify | One doc comment — the `http` narrowing's named example |
| `docs/architecture.md` | Modify | The read-only HTTP API row |
| `docs/CHANGELOG.md` | Modify | One dated delivery entry |

Nothing else. `resolve-file-by-remote.ts` is used as-is and is not edited.

---

### Task 1: The route

The auth-table row and the `url.pathname` literal **must land in the same commit**. `http-route-auth.test.ts` runs two tests in opposite directions: a literal with no table entry fails one, and a table entry with no literal fails the other ("no table entry is a route that no longer exists"). Neither half is independently green.

**Files:**

- Modify: `packages/gateway/src/ipc/http-route-auth.ts`
- Modify: `packages/gateway/src/ipc/http-server.ts`
- Test: `packages/gateway/test/integration/http/items-resolve-file-route.test.ts` (create)

**Interfaces:**

- Consumes: `resolveFileByRemote(db, { service, repo, refAndPath })` from `../index/resolve-file-by-remote.ts`, returning `{ ok: true; fileEntityId: string; repoRoot: string; path: string } | { ok: false; reason: "remote_not_tracked" | "file_not_indexed"; repo: string }`. Also `startServerWithClipToken(scopes, extraOpts?)` from `../../../src/ipc/http-api-test-server.ts`, which returns `{ port, token, db, stop }`. (Its sibling `startServerWithoutClipsVault(extraOpts?)` returns the same minus `token`, and is Task 2's to import.)
- Produces: `ROUTE_KEY_ITEMS_RESOLVE_FILE` (exported const, value `"GET /v1/items/resolve-file"`), the module-private `handleItemsResolveFile`, and the module-private `coordinateParam(url: URL, name: string): string | null`. Tasks 2 and 3 add tests against the route only; they add no new exports.

- [ ] **Step 1: Write the failing test file**

Create `packages/gateway/test/integration/http/items-resolve-file-route.test.ts`:

```ts
/**
 * End-to-end tests for `GET /v1/items/resolve-file` — the forge-coordinate read the browser
 * client's C7 file lanes are gated on. Sibling of `items-resolve-route.test.ts`: same harness,
 * same inline-bearer-read seam, same `resolve` scope.
 */

import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
// `startServerWithoutClipsVault` is deliberately NOT imported yet: Task 2 adds it together with
// the test that uses it. Biome fails an unused import, so Step 7's lint would go red here.
import { startServerWithClipToken } from "../../../src/ipc/http-api-test-server.ts";

/**
 * The bridge the route walks, as `ownership-pass.ts` and the symbol sync write it:
 *
 *   workspace(filesystem:<root>) --tracks_remote--> repo(<service>:<owner>/<name>)
 *   source_file(file:<root>:<path>)
 *
 * Seeded by hand rather than by running the passes: those need a real git checkout and a spawn
 * seam, and the traversal under test is the same either way. Duplicated from
 * `src/index/resolve-file-by-remote.test.ts` rather than shared — that copy is file-local and
 * unexported, and promoting a unit test's fixture into an exported cross-boundary helper is a
 * larger change than the twenty lines it saves.
 */
function seedTrackedRepo(
  db: Database,
  args: { remote: string; root: string; files: readonly string[] },
): void {
  const wsId = `ws:${args.root}`;
  const repoId = `repo:${args.remote}`;
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'workspace', ?, ?, 'filesystem', '{}')",
    [wsId, `filesystem:${args.root}`, args.root],
  );
  db.run(
    "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'repo', ?, ?, 'github', '{}')",
    [repoId, args.remote, args.remote.split(":")[1] ?? ""],
  );
  db.run(
    "INSERT INTO graph_relation (from_id, to_id, type, created_at) VALUES (?, ?, 'tracks_remote', 0)",
    [wsId, repoId],
  );
  for (const f of args.files) {
    db.run(
      "INSERT INTO graph_entity (id, type, external_id, label, service, metadata) VALUES (?, 'source_file', ?, ?, 'filesystem', '{}')",
      [`file:${args.root}:${f}`, `file:${args.root}:${f}`, f],
    );
  }
}

/**
 * Built with the SAME serialiser the browser client uses (`gateway-client.ts`'s `getJson` calls
 * `new URLSearchParams(query).toString()`), so these tests exercise the real round-trip rather
 * than a hand-rolled encoding that could agree with a bug on both sides.
 */
function coord(service: string, repo: string, refAndPath: string): string {
  return new URLSearchParams({ service, repo, refAndPath }).toString();
}

function get(port: number, token: string | undefined, query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/items/resolve-file?${query}`, {
    headers: token === undefined ? {} : { authorization: `Bearer ${token}` },
  });
}

describe("GET /v1/items/resolve-file (integration)", () => {
  test("resolves a tracked file, and answers with ONLY ok and path", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "main/src/foo.ts"));
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      expect(body).toEqual({ ok: true, path: "src/foo.ts" });
      // The disclosure guard, as an EXACT key set. `repoRoot` is the reader's local filesystem
      // path and must never cross this boundary; an exact set also fails on a field a later edit
      // adds that nobody has thought of yet, which "no repoRoot key" would not.
      expect(Object.keys(body).sort()).toEqual(["ok", "path"]);
    } finally {
      stop();
    }
  });

  test.each(["service", "repo", "refAndPath"])(
    "400s when %s is blank, rather than answering a coordinate it was not given",
    async (blank) => {
      const { port, token, stop } = await startServerWithClipToken(["resolve"]);
      try {
        const params: Record<string, string> = {
          service: "github",
          repo: "acme/web",
          refAndPath: "main/src/foo.ts",
        };
        params[blank] = "";
        const res = await get(port, token, new URLSearchParams(params).toString());
        expect(res.status).toBe(400);
        expect(await res.json()).toEqual({ error: "missing_coordinate" });
      } finally {
        stop();
      }
    },
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun test packages/gateway/test/integration/http/items-resolve-file-route.test.ts`

Expected: FAIL. The route does not exist, so the request falls through to the public `/v1/items/*` table and the assertions on status `200` / `400` do not hold.

- [ ] **Step 3: Add the route key, the auth row, and the union arm**

In `packages/gateway/src/ipc/http-route-auth.ts`, add the constant beside its neighbours (after `ROUTE_KEY_ITEMS_RESOLVE`):

```ts
export const ROUTE_KEY_ITEMS_RESOLVE_FILE = "GET /v1/items/resolve-file";
```

Add the row to `HTTP_ROUTE_AUTH`, directly under the `ROUTE_KEY_ITEMS_RESOLVE` row, with its own comment:

```ts
  // Resolves a forge file coordinate against the local graph. Same `resolve` scope as the read
  // above and for the same reason: it reads, it runs nothing, and it appends NO egress row.
  [ROUTE_KEY_ITEMS_RESOLVE_FILE]: { kind: "clip", scope: "resolve" },
```

Add the arm to the `ClipReadRouteKey` union, after `typeof ROUTE_KEY_ITEMS_RESOLVE`:

```ts
  | typeof ROUTE_KEY_ITEMS_RESOLVE_FILE
```

- [ ] **Step 4: Add the handler and its routing line**

In `packages/gateway/src/ipc/http-server.ts`:

Add the import immediately after the `resolve-by-url.ts` import on line 26 (the import block is alphabetical by path):

```ts
import { resolveFileByRemote } from "../index/resolve-file-by-remote.ts";
```

Add `ROUTE_KEY_ITEMS_RESOLVE_FILE` to the existing named import from `./http-route-auth.ts`.

Add the parameter helper next to the other query-parameter helpers (beside `intParam`):

```ts
/**
 * A REQUIRED `?name=` coordinate, or `null` when absent or blank.
 *
 * Blank is refused rather than passed through. `resolveFileByRemote` builds `":acme/web"` from an
 * empty `service`, matches no workspace, and answers `remote_not_tracked` — telling the caller
 * they have no local checkout of a repository they never named. A confident wrong answer is worse
 * than a refusal, and that one is the panel's most permanent-sounding miss sentence.
 *
 * Returns the value UNTRIMMED, matching `handleItemsResolve`'s treatment of `?url=`: the blankness
 * test is a guard, not a normalisation, and a path segment's own whitespace is not ours to edit.
 */
function coordinateParam(url: URL, name: string): string | null {
  const raw = url.searchParams.get(name);
  return raw === null || raw.trim() === "" ? null : raw;
}
```

Add the handler directly below `handleItemsResolve`:

```ts
// GET /v1/items/resolve-file?service=&repo=&refAndPath= — bearer-authed read under the `resolve`
// scope, mounted inline for exactly the reason handleItemsResolve is: the "/v1/items/*" entry in
// dispatchReadOnlyDataGet's table is PUBLIC, so routing this through it would serve the reader's
// indexed-file set to any local process on the machine.
//
// Appends NO egress row. Nothing leaves the machine — it reads the local graph and answers.
async function handleItemsResolveFile(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const clipsVault = opts.clipsVault;
  if (clipsVault === undefined) {
    // The same "surface not mounted" shape as handleItemsResolve. Load-bearing beyond tidiness:
    // the shipped browser client reads a 404 from this route as "gateway older than the route"
    // and withholds its file lanes silently. A 500 here would turn a correct, quiet degradation
    // into a visible error on every gateway that does not mount the clips surface.
    return json({ error: "resolve_disabled" }, 404);
  }
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_ITEMS_RESOLVE_FILE);
  if (!auth.ok) return auth.response;

  const service = coordinateParam(url, "service");
  const repo = coordinateParam(url, "repo");
  const refAndPath = coordinateParam(url, "refAndPath");
  if (service === null || repo === null || refAndPath === null) {
    return json({ error: "missing_coordinate" }, 400);
  }

  const result = resolveFileByRemote(db, { service, repo, refAndPath });
  return json(
    result.ok
      ? // Field by field, naming `path` alone. NOT a spread and NOT a destructured rest:
        // `ResolveFileResult` also carries `repoRoot` — the reader's local filesystem path — and
        // `fileEntityId`, and this route is reachable by any holder of a clip token over HTTP. A
        // field added to that type later cannot leak here unnamed.
        { ok: true, path: result.path }
      : { ok: false, reason: result.reason, repo: result.repo },
  );
}
```

Add one line in `tryBearerAuthedGet`, directly under the `/v1/items/resolve` line:

```ts
  if (url.pathname === "/v1/items/resolve-file")
    return await handleItemsResolveFile(req, url, db, opts);
```

- [ ] **Step 5: Run the new test to verify it passes**

Run: `bun test packages/gateway/test/integration/http/items-resolve-file-route.test.ts`

Expected: PASS — 4 tests (the hit plus three parameterised blank-coordinate cases).

- [ ] **Step 6: Run the route-auth suite, which gates both directions**

Run: `bun test packages/gateway/src/ipc/http-route-auth.test.ts`

Expected: PASS. If "every route literal in http-server.ts has an auth decision" fails, Step 3's table row is missing or misspelled. If "no table entry is a route that no longer exists" fails, Step 4's literal is missing or was written in a form the scanner cannot see — check it is a bare `url.pathname === "/v1/items/resolve-file"` with double quotes.

- [ ] **Step 7: Typecheck and lint**

Run: `bun run typecheck && bun run lint`

Expected: PASS. A `ClipReadRouteKey` error at the `requireScopedClipToken` call means Step 3's union arm was not added.

`tryBearerAuthedGet` was split out of the `fetch` handler because Sonar scored it S3776 = 17, and
Step 4 adds one branch to it. That is expected and is not a reason to restructure a function that
was only just restructured — if the SonarCloud gate flags it on the PR, raise it there rather than
pre-emptively refactoring.

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/ipc/http-route-auth.ts packages/gateway/src/ipc/http-server.ts packages/gateway/test/integration/http/items-resolve-file-route.test.ts
git commit -m "feat(http): resolve a forge file coordinate to a path in the reader's checkout"
```

---

### Task 2: The gates

Three tests, no production code. Every gate here is inherited from Task 1's wiring, so **these should pass on the first run** — that is the point. A failure means Task 1 wired a gate wrong, and each of the three is a distinct client-visible behaviour that must not regress silently.

**Files:**

- Test: `packages/gateway/test/integration/http/items-resolve-file-route.test.ts` (modify)

**Interfaces:**

- Consumes: the route from Task 1, plus `seedTrackedRepo`, `coord` and `get` already defined in this file.
- Produces: nothing.

- [ ] **Step 1: Widen the harness import**

The 404 test needs the no-vault harness. Replace the single-name import at the top of the file:

```ts
import {
  startServerWithClipToken,
  startServerWithoutClipsVault,
} from "../../../src/ipc/http-api-test-server.ts";
```

- [ ] **Step 2: Add the three gate tests**

Append inside the existing `describe` block:

```ts
  test("401s an unknown token", async () => {
    const { port, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await get(port, "not-a-real-token", coord("github", "acme/web", "main/a.ts"));
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    } finally {
      stop();
    }
  });

  // A browser paired before scopes existed holds LEGACY_SCOPES = ["clip", "briefs"]. The body's
  // `required` / `granted` are what the panel turns into a `nimbus clip scopes` line, so they are
  // asserted by value, not merely by status.
  test("403s a legacy-scoped token, naming the gap", async () => {
    const { port, token, stop } = await startServerWithClipToken(["clip", "briefs"]);
    try {
      const res = await get(port, token, coord("github", "acme/web", "main/a.ts"));
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "insufficient_scope",
        required: "resolve",
        granted: ["clip", "briefs"],
      });
    } finally {
      stop();
    }
  });

  // The branch the shipped browser client reads as "this gateway is older than the route": it
  // resolves to `unsupported`, withholds the file lanes and says nothing. It must stay a 404 and
  // must never fall through to the PUBLIC /v1/items/* table.
  test("404s a named refusal when the clips surface is not mounted", async () => {
    const { port, stop } = await startServerWithoutClipsVault();
    try {
      const res = await get(port, undefined, coord("github", "acme/web", "main/a.ts"));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "resolve_disabled" });
    } finally {
      stop();
    }
  });
```

- [ ] **Step 3: Run the file**

Run: `bun test packages/gateway/test/integration/http/items-resolve-file-route.test.ts`

Expected: PASS — 7 tests. If the 404 test instead sees a 200 with an item-shaped body, the routing line from Task 1 was added *after* the public GET table rather than inside `tryBearerAuthedGet`.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/test/integration/http/items-resolve-file-route.test.ts
git commit -m "test(http): pin resolve-file's auth, scope and surface gates"
```

---

### Task 3: The resolution pins

Five tests, no production code. These pin behaviour inherited from `resolveFileByRemote`, and like Task 2 they should pass immediately. They exist because each one is a property a later "improvement" could quietly break — particularly the traversal test, which would fail the moment someone adds path sanitisation the route must not have.

**Files:**

- Test: `packages/gateway/test/integration/http/items-resolve-file-route.test.ts` (modify)

**Interfaces:**

- Consumes: everything already in the file.
- Produces: nothing.

- [ ] **Step 1: Add the five resolution tests**

Append inside the existing `describe` block:

```ts
  test("remote_not_tracked when no workspace tracks the remote", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await get(port, token, coord("github", "other/unknown", "main/src/foo.ts"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        reason: "remote_not_tracked",
        repo: "other/unknown",
      });
    } finally {
      stop();
    }
  });

  // Asserted separately from the case above, and never folded into one "miss" test: the two are
  // different facts with different remediations, and the panel prints a different sentence for
  // each. Collapsing them is the one thing the client cannot survive.
  test("file_not_indexed when the repo is tracked and the path is not in it", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "main/src/missing.ts"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        reason: "file_not_indexed",
        repo: "acme/web",
      });
    } finally {
      stop();
    }
  });

  // The reason the coordinate crosses the wire UNSPLIT: a branch name may contain slashes, and
  // only the side holding the file list can tell where the ref ends. A browser that tried would
  // have to call the forge to learn the branch list.
  test("a branch name containing slashes still resolves", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "feat/auth-v2/src/foo.ts"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, path: "src/foo.ts" });
    } finally {
      stop();
    }
  });

  // Traversal is a non-issue BY CONSTRUCTION, not by sanitisation: resolution never touches the
  // filesystem, it matches `source_file` external ids in SQLite. A `..` segment simply produces a
  // candidate no indexed entity matches. This test fails the day someone adds path normalisation
  // the route must not have.
  test("a traversal attempt is an ordinary miss, not an error", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "main/../../secret.txt"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        ok: false,
        reason: "file_not_indexed",
        repo: "acme/web",
      });
    } finally {
      stop();
    }
  });

  // The space and the `+` are in the FILENAME, not the ref, on purpose: the resolver tries every
  // ref/path split, so a mangled ref would still leave a matching candidate and the test would
  // pass while decoding was broken. Put them in the path and only an exact round-trip resolves.
  // That round-trip holds because both ends use URLSearchParams — the client writes with it
  // (`gateway-client.ts`'s `getJson`), this route reads with it — so a space travels as `+` and a
  // literal `+` as `%2B`.
  test("a path carrying a space and a + survives the round trip", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/my file+v2.ts"],
      });
      const res = await get(port, token, coord("github", "acme/web", "main/src/my file+v2.ts"));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, path: "src/my file+v2.ts" });
    } finally {
      stop();
    }
  });

  // A GitLab project nests arbitrarily deep, so `repo` ITSELF carries slashes. A different
  // parameter from the slashy ref above and a different risk: `/` has to survive URLSearchParams
  // encoding it as `%2F` and this route decoding it back. A truncated `repo` would answer
  // `remote_not_tracked` and read as an ordinary miss rather than a bug.
  test("a deep GitLab subgroup survives as the repo coordinate", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "gitlab:org/team/subgroup/repo",
        root: "/home/d/sub",
        files: ["src/foo.ts"],
      });
      const res = await get(
        port,
        token,
        coord("gitlab", "org/team/subgroup/repo", "main/src/foo.ts"),
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ ok: true, path: "src/foo.ts" });
    } finally {
      stop();
    }
  });

  // Nothing leaves the machine, so nothing belongs in the ledger of what did. Asserted as a
  // DELTA rather than `=== 0`: what must hold is that RESOLVING appends nothing, and a test
  // pinned to an empty table would start failing for an unrelated row the server wrote at boot.
  test("appends no egress row", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      seedTrackedRepo(db, {
        remote: "github:acme/web",
        root: "/home/d/web",
        files: ["src/foo.ts"],
      });
      const ledgerRows = (): number =>
        (db.query("SELECT COUNT(*) AS n FROM egress_ledger").get() as { n: number }).n;
      const before = ledgerRows();
      const res = await get(port, token, coord("github", "acme/web", "main/src/foo.ts"));
      expect(res.status).toBe(200);
      expect(ledgerRows()).toBe(before);
    } finally {
      stop();
    }
  });
```

**Two things deliberately not tested here, neither of them a gap.** Both are resolver properties
already pinned at the unit level in `packages/gateway/src/index/resolve-file-by-remote.test.ts`,
and the route neither overrides nor exposes either, so an HTTP-level copy would assert nothing the
unit test does not:

- **Multi-worktree precedence** (spec §4.5) — "two worktrees on one remote resolve to the one that
  has the file, stably" and "the more recently indexed checkout wins".
- **Remote casing** — "remote casing does not decide the answer", covering the resolver's
  `LOWER(r.external_id) = LOWER(?)` comparison.

The GitLab-subgroup and encoding tests above are a different matter and DO belong here: both are
about what survives the query string, which is this route's own boundary, not the resolver's.

- [ ] **Step 2: Run the file**

Run: `bun test packages/gateway/test/integration/http/items-resolve-file-route.test.ts`

Expected: PASS — 14 tests.

- [ ] **Step 3: Run the whole gateway suite for regressions**

Run: `bun test packages/gateway`

Expected: PASS. Nothing existing should move; this change is additive.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/test/integration/http/items-resolve-file-route.test.ts
git commit -m "test(http): pin resolve-file's miss discriminants, slashy refs, traversal and encoding"
```

---

### Task 4: The prose that has to move

A comment in `egress-coverage.ts` names `GET /v1/items/resolve` **by name** as the newest local read and the one most likely to be mistaken for egress. After this change that sentence is wrong about which is newest, and it is not decoration — it is the justification attached to the machine-readable coverage claim.

**Files:**

- Modify: `packages/gateway/src/egress/egress-coverage.ts:78-85`
- Modify: `docs/architecture.md:1851`
- Modify: `docs/CHANGELOG.md`

**Interfaces:**

- Consumes: nothing.
- Produces: nothing.

- [ ] **Step 1: Update the `http` narrowing comment**

In `packages/gateway/src/egress/egress-coverage.ts`, the `http` paragraph currently reads (in part):

```text
 * NOT "everything on the HTTP API". `GET /v1/items`, `GET /v1/items/resolve`, `GET /v1/people`,
 * `GET /v1/audit` and the rest of the read surface hand index rows to a local process and append
 * NO row. `GET /v1/items/resolve` is called out by name because it is the newest of them and the
 * one most likely to be mistaken for egress: it takes a URL from an external caller and answers
 * from the LOCAL index without any outbound request.
```

Replace the "called out by name" sentence so the newest read is the one named:

```text
 * NOT "everything on the HTTP API". `GET /v1/items`, `GET /v1/items/resolve`, `GET /v1/people`,
 * `GET /v1/audit` and the rest of the read surface hand index rows to a local process and append
 * NO row. `GET /v1/items/resolve-file` is called out by name because it is the newest of them and
 * the one most likely to be mistaken for egress: it takes a forge coordinate from an external
 * caller — a `github.com` repository and a ref — and answers it entirely from the LOCAL graph,
 * without any outbound request to that forge. `GET /v1/items/resolve` beside it does the same
 * with a URL.
```

- [ ] **Step 2: Update the architecture table row**

In `docs/architecture.md` line 1851, the "Read-only HTTP API" row ends with the `GET /v1/items/resolve` clause. Append a sibling clause to the same cell, immediately after it:

```text
, `GET /v1/items/resolve-file` (C7 forge-file resolution; same `resolve` clip-token scope; maps a `{service, repo, refAndPath}` coordinate to a repo-relative path via the `tracks_remote` graph edge, answering from the local index only — never an outbound request, and never returning the local `repoRoot`)
```

- [ ] **Step 3: Add the CHANGELOG entry**

In `docs/CHANGELOG.md`, add a new first bullet under `## Post-Phase-6 deliveries`:

```text
- **2026-09-04 — `GET /v1/items/resolve-file`: the forge-file read the browser client already
  calls.** `nimbus-web-clipper` shipped C7.1 — *what breaks if this changes*, *who knows this
  file*, *who owns this*, on a GitHub/GitLab/Bitbucket blob page — against a route no gateway
  served, so the lanes were inert everywhere rather than broken. This is the read in front of
  `resolveFileByRemote`, which already existed: a `{service, repo, refAndPath}` coordinate walks
  `workspace --tracks_remote--> repo` to a `source_file` in the reader's own checkout. The
  coordinate arrives **unsplit** by design — a branch name may contain slashes, and only this side
  holds the file list. Under the existing `resolve` scope, not `agents`: it resolves, it runs
  nothing. **The response never carries `repoRoot`** — the reader's local filesystem path — nor
  `fileEntityId`; the projection names `path` field by field so a field added to
  `ResolveFileResult` later cannot leak unnamed. A blank coordinate is a `400`, not a
  pass-through: an empty `service` would otherwise answer `remote_not_tracked`, telling the caller
  they have no checkout of a repository they never named. **No egress row** (nothing leaves the
  machine) and **no version floor** — the route's presence IS the capability signal the client
  probes, which cannot drift the way a floor constant needs raising. Additive: `agents-rpc.ts`
  keeps its `-32602` for the terminal surface and for any client that skips the probe. No schema
  change, no new invariant. Design:
  [`docs/superpowers/specs/2026-09-04-resolve-file-route-design.md`](./superpowers/specs/2026-09-04-resolve-file-route-design.md).
```

- [ ] **Step 4: Run the docs and code gates**

Run: `bun run lint:markdown && bun run lint && bun test packages/gateway`

Expected: PASS on all three.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/egress/egress-coverage.ts docs/architecture.md docs/CHANGELOG.md
git commit -m "docs(egress): resolve-file is now the newest local read most mistaken for egress"
```

---

## After the plan

The client half is **not** in this plan and is not blocked by it — see the spec's §8. On its own branch in `nimbus-web-clipper`: a `file-lanes.e2e.ts` against the mock gateway that already serves this route, the `docs/development.md` manual step that currently says only one side can be run, and the ROADMAP C7.1 flip from 🟡 to 🟢 once this ships in a release. Two defects in that repo's committed C7 review ride along there too: its `< 7.8.1` version guess (the gateway is already at 7.9.0 with no route) and its 32 absolute `file:///C:/gitrep/...` links.

---

## Review responses

The [plan review](./2026-09-04-resolve-file-route-review.md) raised six items. Two changed the
plan; four did not.

| Item | Disposition |
| --- | --- |
| Q2.1 coordinate trimming | **No change** — the review reaches the plan's own conclusion: uniform across all three params, untrimmed, matching `handleItemsResolve` |
| Q2.2 casing over the wire | **Deferred** — already pinned by a resolver unit test; recorded in Task 3's "not a gap" note |
| Q2.3 zero-egress assertion | **Accepted, mechanism corrected** — Task 3 |
| I3.1 Sonar S3776 | **No change** — Task 1 Step 4 already shows the one-line guard, Step 7 already carries the note |
| I3.2 Biome import order | **No change** — Task 1 Step 4 already names the insertion point and why |
| I3.3 GitLab deep subgroup | **Accepted** — Task 3 |

Two notes on the two that changed.

**Q2.3 is right about the invariant and wrong about where it lives.** It proposes asserting over
`graph_entity WHERE type = 'egress_item'`. There is no such row type: the ledger is its own table,
`egress_ledger` (V44), written by `egress/egress-ledger.ts`. The test in Task 3 queries that table
instead, and asserts a **delta across the request** rather than a count of zero — an absolute zero
would be a test pinned to whatever the server happens not to write at boot today, which is not the
property being defended.

**I3.3 earns its place where Q2.2 does not**, and the distinction is worth stating because it
decides both. Casing is resolved entirely inside `resolveFileByRemote`'s SQL, so an HTTP test of it
re-proves a unit test through a slower path. A deep GitLab subgroup puts slashes in the `repo`
**parameter**, which has to survive `URLSearchParams` encoding `/` as `%2F` and this route decoding
it back — that is the route's own boundary, and no unit test touches it. A truncated `repo` would
answer `remote_not_tracked` and read as an ordinary miss rather than a bug, which is exactly the
kind of silent wrong answer §4.3 exists to prevent.
