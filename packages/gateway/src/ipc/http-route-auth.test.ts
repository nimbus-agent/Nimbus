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
 * Every `path === "/…"` / `path.startsWith("/…")` literal in the HTTP server.
 *
 * Source-scanned rather than hand-mirrored ON PURPOSE. A hand-written second list of routes is
 * exactly the drift that produced four wrong param shapes in #1059 — it agrees with reality on
 * the day it is written and never again. A scan self-updates: add a route, and this test demands
 * a decision about it.
 *
 * Two regexes, not one with a branch: the `startsWith` form has NO space after `path`, so a
 * single pattern with `path ` in it silently matches only the `===` form — a scan that finds
 * half the routes and reports success.
 */
async function routeLiteralsInServer(): Promise<string[]> {
  const src = await Bun.file(SERVER_SRC).text();
  const out = new Set<string>();
  for (const m of src.matchAll(/path\s*===\s*"(\/[^"]*)"/g)) {
    out.add(m[1] as string);
  }
  // `startsWith` literals are prefixes; the table keys them with a trailing `*`.
  for (const m of src.matchAll(/path\.startsWith\("(\/[^"]*)"\)/g)) {
    out.add(`${m[1] as string}*`);
  }
  return [...out];
}

describe("http-route-auth", () => {
  test("every WRITE_ROUTE_ALLOWLIST entry has an auth decision", () => {
    const missing = WRITE_ROUTE_ALLOWLIST.filter((r) => !(r in HTTP_ROUTE_AUTH));
    expect(missing).toEqual([]);
  });

  test("every GET route literal in http-server.ts has an auth decision", async () => {
    const literals = await routeLiteralsInServer();
    // Guard the guard, twice over: if the scan finds nothing the regex has rotted, and if it
    // finds no `*` entry the startsWith half has rotted while the `===` half still passes.
    expect(literals.length).toBeGreaterThan(8);
    expect(literals.some((p) => p.endsWith("*"))).toBe(true);
    const missing = literals.filter((p) => !(`GET ${p}` in HTTP_ROUTE_AUTH));
    expect(missing).toEqual([]);
  });

  test("no table entry is a route that no longer exists", async () => {
    const literals = new Set(await routeLiteralsInServer());
    const stale = Object.keys(HTTP_ROUTE_AUTH)
      .filter((k) => k.startsWith("GET "))
      .map((k) => k.slice("GET ".length))
      .filter((p) => !literals.has(p) && !REGEX_ROUTED_GET.has(p));
    expect(stale).toEqual([]);
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
