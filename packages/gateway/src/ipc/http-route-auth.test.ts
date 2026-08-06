import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import {
  clipScopeFor,
  enforceClipScope,
  HTTP_ROUTE_AUTH,
  hasScope,
  insufficientScopeBody,
} from "./http-route-auth.ts";
import { WRITE_ROUTE_ALLOWLIST } from "./http-write-routes.ts";

/**
 * Resolved from THIS FILE's directory, never from the process CWD.
 *
 * A CWD-relative path (`"packages/gateway/src/ipc/http-server.ts"`) resolves when the suite is
 * run from the repo root — which is what happens locally — and throws ENOENT under CI's sharded
 * runner, which runs from elsewhere. That is not a cosmetic difference: every scanner-backed test
 * below then fails on CI, so the completeness guard this file exists to provide would be dead in
 * the only place it has to work. `security-invariants.test.ts:47` and `entry-graph.test.ts:5` use
 * `import.meta.dir` for exactly this reason.
 */
const SERVER_SRC = resolve(import.meta.dir, "http-server.ts");

/**
 * Routes matched by a REGEX rather than a path literal, so the scan below cannot see them.
 *
 * Listed explicitly rather than silently tolerated: each entry is a route the guard does not
 * protect, and naming them is what keeps that list from growing unnoticed.
 */
const REGEX_ROUTED_GET = new Set<string>([
  "/v1/briefs/*", // matched by BRIEF_GET_RE in http-server.ts
]);

/**
 * Routes whose matcher lives in ANOTHER FILE, so no literal for them appears in http-server.ts.
 *
 * `GET /scim/v2/Users[/{id}]` is bearer-gated at http-server.ts:743-751 via `isScimPath(url)`,
 * whose body (`identity/scim-http-routes.ts`) the scanner never reads. Without this list the route
 * is invisible to every guard here — which is precisely the silent hole this task exists to make
 * impossible, so it is named rather than tolerated.
 */
const EXTERNALLY_ROUTED = new Set<string>(["/scim/v2/Users", "/scim/v2/Users/{id}"]);

/**
 * Every `path === "/…"` / `path.startsWith("/…")` literal in the HTTP server.
 *
 * Source-scanned rather than hand-mirrored ON PURPOSE. A hand-written second list of routes is
 * exactly the drift that produced four wrong param shapes in #1059 — it agrees with reality on
 * the day it is written and never again. A scan self-updates: add a route, and this test demands
 * a decision about it.
 *
 * Separate regexes, not one with a branch: the `startsWith` form has NO space after `path`, so a
 * single pattern with `path ` in it silently matches only the `===` form — a scan that finds
 * half the routes and reports success.
 *
 * BOTH `path` and `url.pathname` are scanned. `dispatchReadOnlyDataGet` narrows to a local `path`,
 * but the `fetch` handler matches several routes on `url.pathname` directly (`/v1/clips/related`
 * at http-server.ts:754 is one). Scanning only `path` leaves those invisible: their table entry
 * could be deleted or given the wrong scope and nothing would fail.
 *
 * Returns PATHS ONLY, with no method inferred. An earlier draft prefixed every hit with `GET `,
 * which silently mis-keyed the POST-matched routes. Membership is checked against the path portion
 * of the table's keys instead.
 */
async function routeLiteralsInServer(): Promise<string[]> {
  const src = await Bun.file(SERVER_SRC).text();
  const out = new Set<string>();
  for (const m of src.matchAll(/(?:^|[^.\w])(?:path|url\.pathname)\s*===\s*"(\/[^"]*)"/g)) {
    out.add(m[1] as string);
  }
  // `startsWith` literals are prefixes; the table keys them with a trailing `*`.
  for (const m of src.matchAll(/(?:path|url\.pathname)\.startsWith\("(\/[^"]*)"\)/g)) {
    out.add(`${m[1] as string}*`);
  }
  return [...out];
}

/** The path portion of every table key, e.g. "POST /v1/clips" -> "/v1/clips". */
function tablePaths(): string[] {
  return Object.keys(HTTP_ROUTE_AUTH).map((k) => k.slice(k.indexOf(" ") + 1));
}

describe("http-route-auth", () => {
  test("every WRITE_ROUTE_ALLOWLIST entry has an auth decision", () => {
    const missing = WRITE_ROUTE_ALLOWLIST.filter((r) => !(r in HTTP_ROUTE_AUTH));
    expect(missing).toEqual([]);
  });

  test("every route literal in http-server.ts has an auth decision", async () => {
    const literals = await routeLiteralsInServer();
    // Guard the guard, twice over: if the scan finds nothing the regex has rotted, and if it
    // finds no `*` entry the startsWith half has rotted while the `===` half still passes.
    expect(literals.length).toBeGreaterThan(8);
    expect(literals.some((p) => p.endsWith("*"))).toBe(true);
    const known = new Set(tablePaths());
    expect(literals.filter((p) => !known.has(p))).toEqual([]);
  });

  test("no table entry is a route that no longer exists", async () => {
    const literals = new Set(await routeLiteralsInServer());
    // Write routes (POST/PATCH/DELETE/PUT dispatched to dispatchWriteRoute) are matched by their
    // own literals in http-write-routes.ts, NOT http-server.ts — SERVER_SRC cannot see them, and
    // never will, because handleWrite dispatches generically by method. Their reality is already
    // guaranteed by the WRITE_ROUTE_ALLOWLIST-forward test above (they are read live from the
    // ROUTE_* constants), so they're excluded here rather than producing a permanent false stale.
    const writeAllowlisted = new Set(WRITE_ROUTE_ALLOWLIST);
    const stale = Object.keys(HTTP_ROUTE_AUTH)
      .filter((k) => !writeAllowlisted.has(k))
      .map((k) => k.slice(k.indexOf(" ") + 1))
      .filter((p) => !literals.has(p) && !REGEX_ROUTED_GET.has(p) && !EXTERNALLY_ROUTED.has(p));
    expect(stale).toEqual([]);
  });

  test("every REGEX_ROUTED_GET and EXTERNALLY_ROUTED path has an auth decision", () => {
    // REGEX_ROUTED_GET and EXTERNALLY_ROUTED exist to keep the scanner from mis-flagging these
    // paths as EXTRA/stale — but exemption from that check says nothing about whether the table
    // actually has an entry for them. Without this test, deleting "GET /scim/v2/Users" (or the
    // brief-get entry) from the table passes every other test in this file: the literal scanner
    // never sees them (that is the whole reason they are on these lists), so no test currently
    // requires their presence — only their absence-from-"stale". This closes that gap.
    //
    // Checked by EXACT KEY, not by tablePaths() path-only membership: "/scim/v2/Users" is also
    // the path half of the unrelated write-route key "POST /scim/v2/Users", which stays in the
    // table regardless — a path-only check would silently pass with the GET entry missing.
    const missing = [...REGEX_ROUTED_GET, ...EXTERNALLY_ROUTED]
      .map((p) => `GET ${p}`)
      .filter((k) => !(k in HTTP_ROUTE_AUTH));
    expect(missing).toEqual([]);
  });

  test("the SCIM read seam is still mounted the way EXTERNALLY_ROUTED assumes", async () => {
    // EXTERNALLY_ROUTED exempts the SCIM GETs from the scan because their matcher lives in
    // another file. That exemption is only safe while this is still true — if the seam is ever
    // rewired, the exemption must be re-examined rather than silently kept.
    const src = await Bun.file(SERVER_SRC).text();
    expect(src).toContain("isScimPath(url)");
  });

  test("no route is matched by a form the scanner cannot see", async () => {
    // The scanner reads two forms — `path === "…"` and `path.startsWith("…")` — and only on
    // `path`/`url.pathname`, and only double-quoted. Any OTHER way of matching a path is invisible
    // to it, which would make the completeness guard fail OPEN for that route — it would pass
    // while protecting nothing.
    //
    // So the unseen forms are themselves forbidden, with the known exceptions named. A comment
    // asking developers to remember this would not fail; this does.
    const src = await Bun.file(SERVER_SRC).text();
    const UNSEEN_FORMS = [
      /path\.includes\(/,
      /path\.match\(/,
      /\.test\(path\)/,
      // The scanner's regexes hardcode `path` — `url.pathname` matched the SAME way (`===` /
      // `.includes`/`.match`/`.test`) is just as invisible. `/v1/clips/related` already matches on
      // `url.pathname` directly (the `===`/`startsWith` forms of that ARE scanned — see
      // `routeLiteralsInServer`'s doc comment — but the other four forms are not).
      /url\.pathname\.includes\(/,
      /url\.pathname\.match\(/,
      /\.test\(url\.pathname\)/,
      // Single-quoted route comparisons: `routeLiteralsInServer`'s regexes only match a
      // double-quoted string literal (`"…"`). A route written `path === '/v1/whatever'` (or the
      // `url.pathname` equivalent) would compile, run, and never appear in `tablePaths()`.
      /(?:path|url\.pathname)\s*===\s*'\//,
      // Template-literal route comparisons: same blind spot, backtick-delimited.
      /(?:path|url\.pathname)\s*===\s*`\//,
    ];
    for (const form of UNSEEN_FORMS) {
      expect(src).not.toMatch(form);
    }
    // `RE.exec(...)` IS used (BRIEF_GET_RE). Pin the count so a SECOND regex-matched route has to
    // be added to REGEX_ROUTED_GET deliberately rather than joining the surface unguarded.
    const execMatches = [...src.matchAll(/\w+_RE\.exec\(/g)];
    expect(execMatches.length).toBe(REGEX_ROUTED_GET.size);
  });

  test("hasScope is exact membership, never a prefix or superset match", () => {
    expect(hasScope(["clip", "briefs"], "clip")).toBe(true);
    expect(hasScope(["clip", "briefs"], "agents")).toBe(false);
    expect(hasScope([], "clip")).toBe(false);
  });

  test("the 403 body names what was required and what was granted, and no token value", () => {
    const body = insufficientScopeBody("agents", ["clip"]);
    expect(body).toEqual({ error: "insufficient_scope", required: "agents", granted: ["clip"] });
  });

  test("clipScopeFor returns null for a route key with no auth decision at all", () => {
    // Every other call site only ever passes a key that IS in the table (a route it is actually
    // guarding), so without this the "auth !== undefined" false arm never fires.
    expect(clipScopeFor("GET /v1/this-route-does-not-exist")).toBeNull();
  });

  test("clipScopeFor returns null for a route key present but not clip-kind", () => {
    expect(HTTP_ROUTE_AUTH["GET /v1/health"]).toEqual({ kind: "public" });
    expect(clipScopeFor("GET /v1/health")).toBeNull();
    expect(HTTP_ROUTE_AUTH["PUT /v1/admin/policy"]).toEqual({ kind: "admin" });
    expect(clipScopeFor("PUT /v1/admin/policy")).toBeNull();
  });

  test("clipScopeFor returns the table's scope for a clip-kind route key", () => {
    // The positive case: a wrong null here would silently drop the scope check for a route that
    // is supposed to have one — just as dangerous as a wrong non-null on the negative cases above.
    expect(clipScopeFor("POST /v1/clips")).toBe("clip");
    expect(clipScopeFor("POST /v1/briefs")).toBe("briefs");
  });

  describe("enforceClipScope — fail-closed on a misconfigured table entry", () => {
    // Every caller of enforceClipScope (requireScopedClipToken in http-server.ts, scopeRefusal in
    // http-write-routes.ts) is ONLY ever invoked for a route it already knows is clip-authenticated.
    // clipScopeFor returning null for such a key is therefore never "this route needs no scope" —
    // it can only mean the HTTP_ROUTE_AUTH entry was removed, mistyped, or its `kind` was changed
    // away from "clip" (e.g. flipped to `{kind:"public"}`). These tests prove enforceClipScope
    // refuses (500) rather than allows in that situation — the exact regression this function
    // exists to close: both former call sites read a null scope as "no refusal needed".
    //
    // "GET /v1/health" is a REAL table entry that is legitimately `{kind:"public"}` today. Its
    // clipScopeFor() output — null — is byte-for-byte what a maliciously-flipped clip-kind entry
    // would also produce, so exercising enforceClipScope against it is equivalent to flipping
    // "POST /v1/clips" itself (verified directly below, and by hand during review — see the PR
    // description's red-proof: temporarily changing "POST /v1/clips" to `{kind:"public"}` in
    // HTTP_ROUTE_AUTH makes the "allows...POST /v1/clips" test below fail with ok:false/500).

    test("a route key present but not clip-kind FAILS CLOSED (500), never allows", () => {
      expect(HTTP_ROUTE_AUTH["GET /v1/health"]).toEqual({ kind: "public" });
      const verdict = enforceClipScope("GET /v1/health", ["clip", "briefs", "agents"]);
      expect(verdict).toEqual({ ok: false, status: 500, body: { error: "internal_error" } });
    });

    test("a route key absent from the table entirely FAILS CLOSED (500), never allows", () => {
      const verdict = enforceClipScope("GET /v1/this-route-does-not-exist", ["clip"]);
      expect(verdict).toEqual({ ok: false, status: 500, body: { error: "internal_error" } });
    });

    test("a sufficiently-scoped grant on a REAL clip-kind route key is allowed", () => {
      // The positive control: without it, a version that fails closed on EVERY key (including
      // real clip-kind ones) would pass the two tests above for the wrong reason.
      expect(enforceClipScope("POST /v1/clips", ["clip"])).toEqual({ ok: true });
      expect(enforceClipScope("POST /v1/briefs", ["briefs", "clip"])).toEqual({ ok: true });
    });

    test("an insufficiently-scoped grant on a REAL clip-kind route key is refused with 403, not 500", () => {
      // Distinguishes "misconfigured table" (500) from "valid route, wrong scope" (403) — the two
      // failure modes must not collapse into one status code.
      const verdict = enforceClipScope("POST /v1/briefs", ["clip"]);
      expect(verdict).toEqual({
        ok: false,
        status: 403,
        body: { error: "insufficient_scope", required: "briefs", granted: ["clip"] },
      });
    });
  });
});
