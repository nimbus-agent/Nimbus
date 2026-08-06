import { describe, expect, test } from "bun:test";
import { HTTP_ROUTE_AUTH, hasScope, insufficientScopeBody } from "./http-route-auth.ts";
import { WRITE_ROUTE_ALLOWLIST } from "./http-write-routes.ts";

const SERVER_SRC = "packages/gateway/src/ipc/http-server.ts";

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
    // The scanner reads two forms: `path === "…"` and `path.startsWith("…")`. Any OTHER way of
    // matching a path is invisible to it, which would make the completeness guard fail OPEN for
    // that route — it would pass while protecting nothing.
    //
    // So the unseen forms are themselves forbidden, with the known exceptions named. A comment
    // asking developers to remember this would not fail; this does.
    const src = await Bun.file(SERVER_SRC).text();
    const UNSEEN_FORMS = [/path\.includes\(/, /path\.match\(/, /\.test\(path\)/];
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
});
