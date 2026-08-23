# Egress Read Routes over HTTP (U1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a browser read the egress ledger it already writes to — four bearer-authed HTTP reads over the four `egress.*` IPC verbs that already exist, under a new `egress` scope.

**Architecture:** No new record, no new table, no new appender. `egress.list`, `egress.head`, `egress.verify` and `egress.proveWindow` shipped as IPC verbs in `ipc/egress-rpc.ts` (I29, #698); this adds an HTTP surface over the same primitives, following the `GET /v1/items/resolve` precedent exactly — mounted in the fetch handler, gated by `requireScopedClipToken`, listed in `HTTP_ROUTE_AUTH`, appending no egress row of its own. `listEgress` gains opt-in newest-first ordering and a cursor, so a UI can page a long ledger without pretending a page is the window.

**Tech Stack:** Bun 1.2+, TypeScript strict, `bun:test`, Biome, markdownlint-cli2.

**Spec:** The cross-repo design lives in the consumer repo: `nimbus-web-clipper/docs/superpowers/specs/2026-08-23-gateway-activity-ledger-design.md`. It argues the whole case — why the browser needs this, what the client does with it, and which parts (U2 caller attribution, U3 outcome rows) are deliberately NOT in this slice. Read its "Findings" and "U1" sections before Task 1.

**Consumer:** `nimbus-web-clipper` slices S1–S3 build against this contract. They ship version-gated — a gateway without these routes 404s and the extension says so — so this landing is what makes that feature visible, and the route shapes here are the ones it codes to.

## Scope

**In:** the `egress` scope, four read routes, `listEgress` ordering + cursor + totals, a rate limit on the one route that signs, and the I29 documentation note.

**Out:** caller attribution on targeted-fetch rows (U2), outcome rows (U3), and any change to `egress.prune`, which stays owner-gated and off the LAN allowlist.

## Global Constraints

- **No `any`.** `unknown` for external data, narrowed by a guard. TypeScript strict is non-negotiable.
- **Never commit on `main`.** This work lands on `dev/asafgolombek/egress-read-routes` in `.claude/worktrees/egress-read-routes`. Verify with `git rev-parse --abbrev-ref HEAD` before the first commit.
- **Biome false-fails in worktrees.** `bun run lint` reports "0 files processed" and exits 1 inside `.claude/worktrees/`. Validate with `bunx biome check packages scripts` instead.
- **`docs/**` is markdownlint-gated.** Validate with `bunx markdownlint-cli2 <files>` before committing. Trailing whitespace fails (MD009); every fenced block needs a language (MD040); no bare URLs (MD034); internal link fragments must resolve (MD051).
- **Honesty guardrail (`docs/launch-messaging.md`).** Never describe the egress ledger as capturing raw network traffic. It records the agent's dispatched actions at the I29 executor chokepoint. Any copy, comment or doc line this plan adds must respect that.
- **Reads append no egress row.** These four routes read the local ledger. Adding an appender to them would inflate the very number they exist to report.
- **`egress.prune` is not exposed.** It is the ledger's one sanctioned mutation, an I2 frozen-set member requiring owner HITL. It stays absent here, as it is absent from the LAN allowlist.
- **Commit messages are discarded on merge.** The PR title and description become the squash commit; put the conventional-commit type in the PR title.

---

## Task 1: The `egress` scope

**Files:**

- Modify: `packages/gateway/src/clips/api-scopes.ts`
- Modify: `packages/gateway/src/clips/api-scopes.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `"egress"` as a member of `API_SCOPES` / `ApiScope`, consumed by Task 3's route-auth entries.

- [ ] **Step 1: Write the failing test**

In `packages/gateway/src/clips/api-scopes.test.ts`, update the vocabulary test and extend the legacy test. The existing test asserts the exact five-element list, so it must be edited, not appended to:

```ts
  test("the vocabulary is exactly the six scopes, in declaration order", () => {
    expect([...API_SCOPES]).toEqual(["clip", "briefs", "agents", "resolve", "fetch", "egress"]);
  });

  test("LEGACY_SCOPES grants exactly what a pre-scopes token could already do", () => {
    // The whole point of the migration: a token in the wild gains NOTHING.
    expect([...LEGACY_SCOPES]).toEqual(["clip", "briefs"]);
    expect(LEGACY_SCOPES).not.toContain("agents");
    expect(LEGACY_SCOPES).not.toContain("resolve");
    expect(LEGACY_SCOPES).not.toContain("fetch");
    // `egress` reads the record of everything this gateway sent on the owner's
    // behalf. A token minted before the scope existed must not silently acquire
    // it — the owner grants it deliberately with `nimbus clip scopes`.
    expect(LEGACY_SCOPES).not.toContain("egress");
  });
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/clips/api-scopes.test.ts`
Expected: FAIL — the vocabulary test reports the five-element array against the expected six.

- [ ] **Step 3: Add the scope**

In `packages/gateway/src/clips/api-scopes.ts`, extend the tuple and the doc comment:

```ts
/**
 * `clip` and `briefs` are the surfaces that shipped before scopes existed; `agents`, `resolve` and
 * `fetch` are the ones the scopes design added. `egress` is the read over the ledger itself — it is
 * last because it is the newest, and it is deliberately absent from LEGACY_SCOPES for the same
 * reason the other three are: a token already in the wild must gain nothing.
 */
export const API_SCOPES = ["clip", "briefs", "agents", "resolve", "fetch", "egress"] as const;
```

`LEGACY_SCOPES` is unchanged.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/clips`
Expected: PASS. If `security-invariants.test.ts` asserts anything about the scope vocabulary, run it too and update it deliberately — never widen an assertion to make it pass.

Run: `bun test packages/gateway/src/security-invariants.test.ts`

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print dev/asafgolombek/egress-read-routes
git add packages/gateway/src/clips/api-scopes.ts packages/gateway/src/clips/api-scopes.test.ts
git commit -m "feat(clips): an egress scope, granted deliberately and never inherited"
```

---

## Task 2: Ordering, cursor and totals on `listEgress`

**Files:**

- Modify: `packages/gateway/src/egress/egress-verify.ts`
- Modify: `packages/gateway/src/egress/egress-verify.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `listEgress(db, { since?, until?, limit?, order?, before? })` and `countEgressRows` (already exported), both consumed by Task 3's list handler.

**The hazard this task exists to avoid.** `proveWindow` calls `listEgress` at `egress-verify.ts:459`, and `digestEgressWindow` hashes the ordered row hashes (`rows.map((r) => r.rowHash).join("|")`). **Flipping `listEgress`'s default order would silently change the digest of every window**, so an existing receipt would no longer match a freshly computed one for the same window. Ordering is therefore a NEW, opt-in parameter that defaults to today's `id ASC`. Task 3's list route passes `order: "desc"` explicitly; `proveWindow` passes nothing and is byte-for-byte unaffected.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/egress/egress-verify.test.ts`:

```ts
describe("listEgress ordering and cursor", () => {
  test("defaults to id ASC — the order proveWindow's digest is built on", () => {
    const db = seedLedger(5); // helper already in this file; append 5 rows
    expect(listEgress(db, {}).map((r) => r.id)).toEqual([1, 2, 3, 4, 5]);
  });

  test("order: desc returns the NEWEST rows first", () => {
    const db = seedLedger(5);
    expect(listEgress(db, { order: "desc" }).map((r) => r.id)).toEqual([5, 4, 3, 2, 1]);
  });

  test("order: desc with a limit keeps the newest, not the oldest", () => {
    // The whole point. `id ASC` + LIMIT drops the most recent rows, which is the
    // worst direction for a surface whose job is to say what just left.
    const db = seedLedger(5);
    expect(listEgress(db, { order: "desc", limit: 2 }).map((r) => r.id)).toEqual([5, 4]);
  });

  test("before is an exclusive cursor, paging backwards without gaps or repeats", () => {
    const db = seedLedger(5);
    const page1 = listEgress(db, { order: "desc", limit: 2 });
    const page2 = listEgress(db, { order: "desc", limit: 2, before: page1[1]?.id });
    expect(page1.map((r) => r.id)).toEqual([5, 4]);
    expect(page2.map((r) => r.id)).toEqual([3, 2]);
  });

  test("before composes with the since/until window rather than replacing it", () => {
    const db = seedLedger(5);
    const rows = listEgress(db, { order: "desc", before: 4, limit: 10 });
    expect(rows.map((r) => r.id)).toEqual([3, 2, 1]);
  });

  test("the existing limit clamp still applies to a descending read", () => {
    const db = seedLedger(3);
    expect(listEgress(db, { order: "desc", limit: 999_999 }).length).toBe(3);
  });

  test("proveWindow's digest is unchanged by this task", () => {
    // Pin the coupling explicitly: proveWindow must keep receiving ascending
    // rows, or every previously issued receipt stops matching.
    const db = seedLedger(4);
    expect(proveWindow(db, {}).rows.map((r) => r.id)).toEqual([1, 2, 3, 4]);
  });
});
```

If `seedLedger` does not already exist in that file, write it using the module's own append helper — never by raw `INSERT`, which would produce rows whose `row_hash` does not chain and make `verifyEgressChain` fail for an unrelated reason.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/egress/egress-verify.test.ts`
Expected: FAIL — `order` and `before` are not accepted; the descending cases return ascending ids.

- [ ] **Step 3: Implement**

In `egress-verify.ts`, extend `listEgress`'s options and SQL. Keep the existing clamp and the existing default:

```ts
export function listEgress(
  db: Database,
  opts: {
    since?: number | undefined;
    until?: number | undefined;
    limit?: number | undefined;
    /**
     * Newest-first is OPT-IN. `proveWindow` relies on the ascending default:
     * `digestEgressWindow` hashes the rows in the order this returns them, so
     * changing the default would invalidate every receipt already issued.
     */
    order?: "asc" | "desc" | undefined;
    /** Exclusive cursor — return rows with a LOWER id than this. Pages backwards. */
    before?: number | undefined;
  },
): EgressRow[] {
  const since = opts.since ?? 0;
  const until = opts.until ?? Number.MAX_SAFE_INTEGER;
  const requested = opts.limit !== undefined && opts.limit > 0 ? Math.floor(opts.limit) : 1000;
  const limit = Math.min(requested, MAX_EGRESS_LIST_LIMIT);
  const before = opts.before !== undefined && opts.before > 0 ? Math.floor(opts.before) : null;
  const direction = opts.order === "desc" ? "DESC" : "ASC";
  const rows = db
    .query(
      `SELECT id, timestamp, source_type, source_id, destination, method, payload_summary,
              hitl_status, result_status, row_hash, prev_hash
       FROM egress_ledger
       WHERE timestamp >= ? AND timestamp <= ? AND (? IS NULL OR id < ?)
       ORDER BY id ${direction} LIMIT ?`,
    )
    .all(since, until, before, before, limit) as RawRow[];
  return rows.map(toRow);
}
```

`${direction}` is interpolated from a two-value union that never touches caller input — it is `"ASC"` unless the caller passed exactly `"desc"`. Every genuine parameter stays bound.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/egress`
Expected: PASS, including the existing `proveWindow` and `countOutboundEgress` suites — those must not change.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/egress/egress-verify.ts packages/gateway/src/egress/egress-verify.test.ts
git commit -m "feat(egress): opt-in newest-first paging, leaving prove receipts byte-identical"
```

---

## Task 3: The four read routes

**Files:**

- Modify: `packages/gateway/src/ipc/http-route-auth.ts`
- Modify: `packages/gateway/src/ipc/http-server.ts`
- Modify: `packages/gateway/src/ipc/http-route-auth.test.ts`
- Create: `packages/gateway/src/ipc/http-egress-routes.test.ts`

**Interfaces:**

- Consumes: Task 1's `"egress"` scope; Task 2's `listEgress` options.
- Produces: `ROUTE_KEY_EGRESS_LIST`, `ROUTE_KEY_EGRESS_HEAD`, `ROUTE_KEY_EGRESS_VERIFY`, `ROUTE_KEY_EGRESS_PROVE`.

**The trap.** `GET /v1/items/resolve` is mounted in the fetch handler and NOT in `dispatchReadOnlyDataGet`, with a comment saying why: that table's `/v1/items/*` entry is **public, with no bearer gate at all**, so routing a scoped read through it would serve scoped output to any local process on the machine. The ledger is strictly more sensitive than resolve. **Mount these four exactly where resolve is mounted.** Routing them through the public table would hand every local process the record of everything the gateway ever sent.

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/src/ipc/http-egress-routes.test.ts`. Model the harness on the existing agent-run HTTP suite (a real server, a real Vault, a real labelled token). Assert:

```ts
describe("GET /v1/egress", () => {
  test("401 without a bearer token", async () => { /* ... */ });

  test("403 with a token lacking the egress scope, naming the gap", async () => {
    // The body must carry { required, granted } — the consumer builds a
    // `nimbus clip scopes` command out of it, and cannot without both fields.
    const res = await get("/v1/egress", tokenWithScopes(["clip"]));
    expect(res.status).toBe(403);
    expect(await res.json()).toMatchObject({ required: "egress", granted: ["clip"] });
  });

  test("200 with an egress-scoped token, newest-first, carrying window totals", async () => {
    const body = await (await get("/v1/egress", egressToken)).json();
    expect(body.rows.map((r) => r.id)).toEqual([3, 2, 1]);
    expect(body.rowsTotal).toBe(3);
    expect(body.rowsTruncated).toBe(false);
  });

  test("rowsTotal counts the WHOLE window, not the page", async () => {
    // The reason totals are in the response at all: a consumer that counted the
    // page would under-report, and would drop the newest rows while doing it.
    seed(5);
    const body = await (await get("/v1/egress?limit=2", egressToken)).json();
    expect(body.rows.length).toBe(2);
    expect(body.rowsTotal).toBe(5);
    expect(body.rowsTruncated).toBe(true);
  });

  test("before pages backwards", async () => { /* ... */ });

  test("the route appends NO egress row", async () => {
    // A read that ledgered itself would inflate the number it exists to report.
    const before = countEgressRows(db, {});
    await get("/v1/egress", egressToken);
    expect(countEgressRows(db, {})).toBe(before);
  });

  test("404 named, not a public fall-through, when the clips surface is unmounted", async () => {
    // The /v1/items/* table entry is PUBLIC. A fall-through here would serve the
    // ledger to any local process — the exact trap handleItemsResolve documents.
    const res = await get("/v1/egress", egressToken, { clipsVault: undefined });
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "egress_disabled" });
  });
});

describe("the other three routes", () => {
  test("GET /v1/egress/head returns the head hash and count", async () => { /* ... */ });
  test("GET /v1/egress/verify returns an intact verdict on a clean chain", async () => { /* ... */ });
  test("GET /v1/egress/verify reports the first bad row on a broken chain", async () => { /* ... */ });
  test("GET /v1/egress/prove returns digest, sigB64, pubkeyB64 and truncation flags", async () => { /* ... */ });
  test("all three enforce the same scope gate as the list route", async () => { /* ... */ });
});
```

Extend `http-route-auth.test.ts` only if its scanner needs the new literals declared; the totality tests should otherwise pass unchanged once the table entries exist.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/http-egress-routes.test.ts`
Expected: FAIL — every route 404s; `http-route-auth.test.ts` fails its "every literal route has an auth decision" scan once the handlers are mounted without table entries.

- [ ] **Step 3a: Declare the routes and their auth**

In `packages/gateway/src/ipc/http-route-auth.ts`, beside `ROUTE_KEY_ITEMS_RESOLVE`:

```ts
export const ROUTE_KEY_EGRESS_LIST = "GET /v1/egress";
export const ROUTE_KEY_EGRESS_HEAD = "GET /v1/egress/head";
export const ROUTE_KEY_EGRESS_VERIFY = "GET /v1/egress/verify";
export const ROUTE_KEY_EGRESS_PROVE = "GET /v1/egress/prove";
```

and in `HTTP_ROUTE_AUTH`, in the client-token reads block:

```ts
  // The egress-ledger reads. Bearer reads under their own scope, appending no egress row of
  // their own — they READ the record. `egress.prune`, the ledger's one sanctioned mutation, has
  // no HTTP surface at all and keeps its owner-HITL gate (I2 frozen set).
  [ROUTE_KEY_EGRESS_LIST]: { kind: "clip", scope: "egress" },
  [ROUTE_KEY_EGRESS_HEAD]: { kind: "clip", scope: "egress" },
  [ROUTE_KEY_EGRESS_VERIFY]: { kind: "clip", scope: "egress" },
  [ROUTE_KEY_EGRESS_PROVE]: { kind: "clip", scope: "egress" },
```

- [ ] **Step 3b: Mount the handlers**

In `packages/gateway/src/ipc/http-server.ts`, beside `handleItemsResolve`, add four handlers following its shape exactly: the `clipsVault === undefined` named-404 guard, then `requireScopedClipToken(req, clipsVault, ROUTE_KEY_*)`, then the call into `egress-verify.ts`. Sketch for the list route:

```ts
// GET /v1/egress — bearer-authed read under the `egress` scope. Mounted HERE, not in
// dispatchReadOnlyDataGet: that table's "/v1/items/*" entry is PUBLIC, so routing this through it
// would serve the record of everything this gateway ever sent to any local process on the machine.
// Appends NO egress row: it reads the ledger, and a read that ledgered itself would inflate the
// number it exists to report.
async function handleEgressList(
  req: Request,
  url: URL,
  db: Database,
  opts: ReadOnlyHttpServerOptions,
): Promise<Response> {
  const clipsVault = opts.clipsVault;
  if (clipsVault === undefined) return json({ error: "egress_disabled" }, 404);
  const auth = await requireScopedClipToken(req, clipsVault, ROUTE_KEY_EGRESS_LIST);
  if (!auth.ok) return auth.response;
  const window = { since: intParam(url, "since"), until: intParam(url, "until") };
  const rows = listEgress(db, {
    ...window,
    order: "desc",
    limit: intParam(url, "limit"),
    before: intParam(url, "before"),
  });
  // Counted in SQL over the WHOLE window — never derived from `rows`, which is a page.
  const rowsTotal = countEgressRows(db, window);
  return json({ rows, rowsTotal, rowsTruncated: rows.length < rowsTotal });
}
```

Write `intParam(url, name)` as a small local helper returning `number | undefined`, rejecting anything that is not a non-negative integer by returning `undefined` rather than throwing — an unparseable query value should fall back to the default, not 500.

Register all four in the fetch handler beside the `"/v1/items/resolve"` line at `http-server.ts:927`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc`
Expected: PASS, including `http-route-auth.test.ts`'s totality scans.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/http-route-auth.ts packages/gateway/src/ipc/http-server.ts packages/gateway/src/ipc/http-egress-routes.test.ts packages/gateway/src/ipc/http-route-auth.test.ts
git commit -m "feat(http): read the egress ledger over HTTP, gated by its own scope"
```

---

## Task 4: A rate limit on the one route that signs

**Files:**

- Modify: `packages/gateway/src/ipc/http-server.ts`
- Modify: `packages/gateway/src/ipc/http-egress-routes.test.ts`

**Interfaces:**

- Consumes: Task 3's `ROUTE_KEY_EGRESS_PROVE` handler.
- Produces: nothing other tasks depend on.

**Why only this route.** `GET /v1/egress/prove` is the only one of the four that does asymmetric crypto per call — `signWindowDigest` derives an Ed25519 keypair from the Vault share seed and signs (`egress/egress-sign.ts:43`). List, head and verify are SQLite reads. A hot loop on `prove` therefore costs meaningfully more than a read, and it is the route an upstream reviewer will ask about.

`HttpWriteRateLimiter` (`ipc/http-rate-limit.ts:13`) already implements the per-token budget; the write surface instantiates it at `http-server.ts:961` with `{ maxRequests: 60, windowMs: 60_000 }`. Reuse the **class** with a **separate instance** and a tighter budget. Do not rename the class to drop "Write" — that touches every write call site for no functional gain, and this plan is not the place for it.

- [ ] **Step 1: Write the failing test**

```ts
test("prove is rate-limited per token, and the other three are not", async () => {
  for (let i = 0; i < 10; i++) {
    expect((await get("/v1/egress/prove", egressToken)).status).toBe(200);
  }
  expect((await get("/v1/egress/prove", egressToken)).status).toBe(429);
  // A signing budget must not throttle plain reads.
  expect((await get("/v1/egress", egressToken)).status).toBe(200);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/http-egress-routes.test.ts`
Expected: FAIL — the eleventh `prove` returns 200.

- [ ] **Step 3: Implement**

Instantiate a second limiter beside the write one:

```ts
// `prove` signs with the Vault share key on every call — the only one of the four egress reads
// that does asymmetric crypto. Its own budget, well below the write surface's 60/min, so a hot
// loop cannot spend the gateway's CPU through a read-shaped route.
const proveRateLimiter = new HttpWriteRateLimiter({ maxRequests: 10, windowMs: 60_000 });
```

Consult it inside `handleEgressProve` after the scope gate passes, returning the same 429 shape the write surface returns.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc`

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/http-server.ts packages/gateway/src/ipc/http-egress-routes.test.ts
git commit -m "feat(http): give the signing route its own budget"
```

---

## Task 5: Document the new surface against I29

**Files:**

- Modify: `docs/SECURITY-INVARIANTS.md` (the I29 section)
- Modify: `packages/gateway/src/security-invariants.test.ts` if its I29 block asserts anything this changes

**Interfaces:**

- Consumes: everything above.
- Produces: nothing.

- [ ] **Step 1: Check what the I29 block asserts**

Run:

```bash
bun test packages/gateway/src/security-invariants.test.ts
```

Expected: PASS after Tasks 1–4. If it fails, the failure is the specification of what to write — read it before editing prose.

- [ ] **Step 2: Write the doc note**

In the I29 section of `docs/SECURITY-INVARIANTS.md`, record three things and no more:

1. The ledger now has an HTTP **read** surface — four routes under the `egress` scope — and the reads append nothing, so I29's completeness argument and its counts are untouched.
2. `egress.prune` remains without an HTTP surface and keeps its owner-HITL gate. The mutation/read split the LAN allowlist already draws is now drawn identically over HTTP.
3. `GET /v1/egress/prove` exposes `signWindowDigest` to a labelled clip token. State the bound plainly: the caller supplies only `since`/`until` integers, so the signed message is always the BLAKE3 digest of a gateway-built payload, never caller-chosen bytes; the `nimbus-egress-window-v2` tag is inside that hashed payload, so a digest built under a different rule cannot collide with one built under this one; and share files sign `canonicalizeBody(body)` — canonical JSON — so a signature harvested here is not replayable as a share file. Note that the two artifacts do verify under the same public key, which `share.pubkey` already publishes.

Respect the launch-messaging guardrail: the ledger records dispatched actions at the executor chokepoint, not raw network traffic.

- [ ] **Step 3: Lint the docs**

Run: `bunx markdownlint-cli2 docs/SECURITY-INVARIANTS.md docs/superpowers/plans/2026-08-23-egress-read-routes.md`
Expected: no findings.

- [ ] **Step 4: Full verification**

Run:

```bash
bun test packages/gateway packages/cli packages/mcp-connectors scripts
bunx biome check packages scripts
bun run typecheck
```

Expected: all pass. Remember `bun run lint` false-fails inside a worktree — use the `bunx biome check` form.

- [ ] **Step 5: Commit**

```bash
git add docs/SECURITY-INVARIANTS.md packages/gateway/src/security-invariants.test.ts
git commit -m "docs(security): record the ledger's read surface against I29"
```

---

## Self-Review

**Spec coverage.** The clipper spec's U1 asks for five things: the `egress` scope (Task 1), newest-first ordering with a cursor and window totals on the list route (Tasks 2 and 3), the four read routes with a route-auth entry (Task 3), a per-token rate limit on `prove` (Task 4), and the I29 documentation note (Task 5). U2 and U3 are explicitly out of scope and are named as such at the top.

**Placeholder scan.** Task 3's test bodies are sketched with `/* ... */` for the harness-heavy cases, because the harness (a real server, real Vault, real labelled token) is established by the existing agent-run HTTP suite and copying it verbatim into a plan would be worse than naming it. Every assertion those tests must make is stated. All other code is complete.

**Type consistency.** `ROUTE_KEY_EGRESS_*` constants are declared in Task 3 and used unchanged in Tasks 3 and 4. `listEgress`'s new `order` and `before` options are defined in Task 2 and consumed with those exact names in Task 3. `countEgressRows` is pre-existing and used unrenamed.

**The one coupling worth re-stating.** `proveWindow` shares `listEgress` with the new list route. Task 2's ordering parameter is opt-in *specifically* so `proveWindow` keeps receiving ascending rows and every previously issued receipt keeps matching. If a later change makes `desc` the default, it breaks receipts silently — there is a test pinning it, and that test's failure means "you changed a signed artifact", not "update the expectation".
