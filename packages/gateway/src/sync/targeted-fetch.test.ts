// packages/gateway/src/sync/targeted-fetch.test.ts
import { afterEach, describe, expect, test } from "bun:test";
import pino from "pino";

import { createMemoryVault, openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import type { FetchableService } from "./fetch-host-boundary.ts";
import { type TargetedFetchDeps, targetedFetch } from "./targeted-fetch.ts";
import type { FetchOneResult, Syncable, SyncContext } from "./types.ts";

type EgressRow = {
  readonly destination: FetchableService;
  readonly sourceType: "sync";
  readonly method: string;
};

type DepsOverrides = {
  hostMap?: ReadonlyMap<string, FetchableService>;
  /** Full override — takes precedence over `syncable` when both are given. */
  syncableFor?: (service: FetchableService) => Syncable | undefined;
  /** Shorthand: builds a trivial fixture `Syncable` with this `fetchOne` (or none at all). */
  syncable?: { fetchOne?: Syncable["fetchOne"] };
  appendEgress?: (row: EgressRow) => undefined;
  sleep?: (ms: number) => Promise<void>;
  /** Fake for `ctx.rateLimiter.tryAcquire`. Defaults to always-succeeds-immediately. */
  tryAcquire?: (service: FetchableService) => Promise<boolean>;
  httpOriginFor?: (service: FetchableService) => string | null;
  /** Defaults to always-supported, matching the pre-fix behavior every existing test relies on. */
  urlIsSupported?: (service: FetchableService, url: string) => boolean;
};

/**
 * `depsWith()` opens a fresh `:memory:` index database per call (`openMemoryIndexDatabase`) that
 * nothing previously closed — ~28 leaked handles across this file's test run. Tracked here and
 * closed in the module-level `afterEach` below.
 */
const openedDbs: SyncContext["db"][] = [];

afterEach(() => {
  for (const db of openedDbs.splice(0)) {
    db.close();
  }
});

function depsWith(overrides: DepsOverrides = {}): TargetedFetchDeps {
  const hostMap = overrides.hostMap ?? new Map<string, FetchableService>();
  const tryAcquire = overrides.tryAcquire ?? (async () => true);
  const db = openMemoryIndexDatabase();
  openedDbs.push(db);
  const fakeCtx: SyncContext = {
    db,
    vault: createMemoryVault(),
    logger: pino({ level: "silent" }),
    // A plain object structurally satisfies `SyncContext["rateLimiter"]` for the fields this
    // module actually calls (`tryAcquire`) — the same pattern used elsewhere for a fake rate
    // limiter (see connectors/mendeley-sync.test.ts).
    rateLimiter: { tryAcquire } as unknown as SyncContext["rateLimiter"],
    sandboxCwd: "/tmp",
    credentialFor: () => ({ credential: "personal" }),
    runTeamList: async () => [],
    depth: "full",
  };

  let syncableFor = overrides.syncableFor;
  if (syncableFor === undefined && overrides.syncable !== undefined) {
    const { fetchOne } = overrides.syncable;
    const fixture: Syncable = {
      serviceId: "fixture",
      defaultIntervalMs: 60_000,
      initialSyncDepthDays: 30,
      async sync() {
        throw new Error("sync() is not exercised by targeted-fetch tests");
      },
      // Spread rather than a direct key so `exactOptionalPropertyTypes` sees the property as
      // ABSENT (not present-with-value-undefined) when no `fetchOne` override is given.
      ...(fetchOne !== undefined ? { fetchOne } : {}),
    };
    syncableFor = () => fixture;
  }

  return {
    hostMap,
    syncableFor: syncableFor ?? (() => undefined),
    contextFor: () => fakeCtx,
    httpOriginFor: overrides.httpOriginFor ?? (() => null),
    appendEgress: overrides.appendEgress ?? (() => undefined),
    sleep: overrides.sleep ?? (() => Promise.resolve()),
    urlIsSupported: overrides.urlIsSupported ?? (() => true),
  };
}

describe("targetedFetch", () => {
  test("an unconfigured host (empty boundary) is not_configured, and no connector is called", async () => {
    let called = false;
    const deps = depsWith({
      hostMap: new Map(),
      syncable: {
        fetchOne: async () => {
          called = true;
          return { status: "not_found" };
        },
      },
    });
    const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
    expect(out).toEqual({ status: "not_configured" });
    expect(called).toBe(false);
  });

  // Requirement A: prove the host gate runs BEFORE fetchOne, with a test — not call-site
  // discipline. `github` IS wired up and reachable for its OWN host; the point is that a URL
  // naming a host the boundary never claimed must never reach it, even though the connector
  // itself would happily answer for a constructed API URL if it were ever called directly.
  test("a host the boundary never claimed never reaches fetchOne, even though a syncable exists", async () => {
    let called = false;
    const rows: EgressRow[] = [];
    const deps = depsWith({
      hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
      appendEgress: (r) => {
        rows.push(r);
        return undefined;
      },
      syncableFor: (service) => ({
        serviceId: service,
        defaultIntervalMs: 60_000,
        initialSyncDepthDays: 30,
        async sync() {
          throw new Error("not exercised");
        },
        fetchOne: async (): Promise<FetchOneResult> => {
          called = true;
          return { status: "indexed", itemId: "github:o/r#1" };
        },
      }),
    });
    const out = await targetedFetch(deps, "https://evil.example/o/r/pull/1");
    expect(out).toEqual({ status: "not_configured" });
    expect(called).toBe(false);
    // MINOR 7: hoisting the egress append above the host check would leave every OTHER
    // assertion in this file green — this is what actually catches it.
    expect(rows).toHaveLength(0);
  });

  test("a claimed host whose connector is not wired up in this binary is also not_configured", async () => {
    const deps = depsWith({
      hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
      syncableFor: () => undefined,
    });
    const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
    expect(out).toEqual({ status: "not_configured" });
  });

  test("a configured service with no fetchOne answers no_targeted_fetch", async () => {
    const deps = depsWith({
      hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
      syncable: {},
    });
    const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
    expect(out).toEqual({ status: "no_targeted_fetch", service: "github" });
  });

  test("an unparseable url is unsupported_url and never consults the host map", async () => {
    const out = await targetedFetch(
      depsWith({ hostMap: new Map<string, FetchableService>([["github.com", "github"]]) }),
      "not a url",
    );
    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("a non-http(s) scheme is unsupported_url", async () => {
    const out = await targetedFetch(
      depsWith({ hostMap: new Map<string, FetchableService>([["github.com", "github"]]) }),
      "ftp://github.com/o/r/pull/1",
    );
    expect(out).toEqual({ status: "unsupported_url" });
  });

  test("userinfo (user:pass@host) is stripped before the URL reaches fetchOne", async () => {
    let seenUrl: string | undefined;
    const deps = depsWith({
      hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
      syncable: {
        fetchOne: async (_ctx, url) => {
          seenUrl = url;
          return { status: "indexed", itemId: "github:o/r#1" };
        },
      },
    });
    const out = await targetedFetch(deps, "https://evil.example:pw@github.com/o/r/pull/1");
    expect(out).toEqual({ status: "indexed", itemId: "github:o/r#1" });
    expect(seenUrl).toBe("https://github.com/o/r/pull/1");
    expect(seenUrl).not.toContain("evil.example");
    expect(seenUrl).not.toContain("pw");
  });

  // Requirement B: pin https: before fetching.
  describe("scheme pinning", () => {
    test("an http: URL is rejected when the service has no self-hosted http origin", async () => {
      let called = false;
      const rows: EgressRow[] = [];
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        httpOriginFor: () => null,
        appendEgress: (r) => {
          rows.push(r);
          return undefined;
        },
        syncable: {
          fetchOne: async () => {
            called = true;
            return { status: "indexed", itemId: "x" };
          },
        },
      });
      const out = await targetedFetch(deps, "http://github.com/o/r/pull/1");
      expect(out).toEqual({ status: "unsupported_url" });
      expect(called).toBe(false);
      // MINOR 7: proves the scheme gate also runs before any egress row, not merely before
      // fetchOne.
      expect(rows).toHaveLength(0);
    });

    test("an http: URL is accepted when it matches the service's own self-hosted origin exactly", async () => {
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["jenkins.internal", "jenkins"]]),
        httpOriginFor: (service) => (service === "jenkins" ? "http://jenkins.internal" : null),
        syncable: {
          fetchOne: async (_ctx, url) => ({
            status: "indexed",
            itemId: `jenkins:${url}`,
          }),
        },
      });
      const out = await targetedFetch(deps, "http://jenkins.internal/job/x/1");
      expect(out).toEqual({ status: "indexed", itemId: "jenkins:http://jenkins.internal/job/x/1" });
    });

    test("an http: URL whose origin differs from the configured one (port mismatch) is rejected", async () => {
      let called = false;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["jenkins.internal", "jenkins"]]),
        httpOriginFor: () => "http://jenkins.internal:8080",
        syncable: {
          fetchOne: async () => {
            called = true;
            return { status: "indexed", itemId: "x" };
          },
        },
      });
      const out = await targetedFetch(deps, "http://jenkins.internal/job/x/1");
      expect(out).toEqual({ status: "unsupported_url" });
      expect(called).toBe(false);
    });

    test("https: never needs the exception, regardless of httpOriginFor", async () => {
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        httpOriginFor: () => null,
        syncable: { fetchOne: async () => ({ status: "indexed", itemId: "x" }) },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(out).toEqual({ status: "indexed", itemId: "x" });
    });
  });

  // Requirement C: canonicalize before dispatch, retry once query-stripped.
  describe("canonicalize + retry", () => {
    test("a fragment URL resolves via canonicalizeUrl alone — exactly one fetchOne call", async () => {
      let calls = 0;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        syncable: {
          fetchOne: async (_ctx, url): Promise<FetchOneResult> => {
            calls++;
            const u = new URL(url);
            if (u.search !== "") {
              return { status: "unsupported_url" };
            }
            return { status: "indexed", itemId: "github:o/r#1" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1#note_123");
      expect(out).toEqual({ status: "indexed", itemId: "github:o/r#1" });
      expect(calls).toBe(1);
    });

    test("a non-tracking query URL fails rung 1 and succeeds rung 2 — exactly one network attempt", async () => {
      let fetchOneCalls = 0;
      let networkCalls = 0;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        syncable: {
          fetchOne: async (_ctx, url): Promise<FetchOneResult> => {
            fetchOneCalls++;
            const u = new URL(url);
            if (u.search !== "") {
              // The regex rejects before any outbound call — no network attempt here.
              return { status: "unsupported_url" };
            }
            networkCalls++;
            return { status: "indexed", itemId: "github:o/r#1" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1?focusedCommentId=1");
      expect(out).toEqual({ status: "indexed", itemId: "github:o/r#1" });
      expect(fetchOneCalls).toBe(2);
      expect(networkCalls).toBe(1);
    });

    test("both rungs unsupported_url surfaces unsupported_url without a third attempt", async () => {
      let calls = 0;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        syncable: {
          fetchOne: async (): Promise<FetchOneResult> => {
            calls++;
            return { status: "unsupported_url" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1?focusedCommentId=1");
      expect(out).toEqual({ status: "unsupported_url" });
      expect(calls).toBe(2);
    });

    // MINOR 6: rung 1's URL already has nothing left to strip (no query at all), so the
    // `stripped === canonicalUrl` short-circuit inside `fetchOneWithRetry` must fire and skip a
    // pointless, identical second call.
    test("a query-less unsupported_url short-circuits — no second, identical fetchOne call", async () => {
      let calls = 0;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        syncable: {
          fetchOne: async (): Promise<FetchOneResult> => {
            calls++;
            // Rejects for a reason unrelated to the query string (there isn't one) — models a
            // malformed-path rejection.
            return { status: "unsupported_url" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(out).toEqual({ status: "unsupported_url" });
      expect(calls).toBe(1);
    });

    test("not_found is never retried, even though a query remains to strip", async () => {
      let calls = 0;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        syncable: {
          fetchOne: async (): Promise<FetchOneResult> => {
            calls++;
            return { status: "not_found" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1?focusedCommentId=1");
      expect(out).toEqual({ status: "not_found" });
      expect(calls).toBe(1);
    });

    test("a trailing slash resolves via canonicalizeUrl alone", async () => {
      let calls = 0;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        syncable: {
          fetchOne: async (_ctx, url): Promise<FetchOneResult> => {
            calls++;
            if (url.endsWith("/")) {
              return { status: "unsupported_url" };
            }
            return { status: "indexed", itemId: "github:o/r#1" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1/");
      expect(out).toEqual({ status: "indexed", itemId: "github:o/r#1" });
      expect(calls).toBe(1);
    });
  });

  describe("egress append", () => {
    test("an egress append failure aborts BEFORE the outbound call", async () => {
      let called = false;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        appendEgress: () => {
          throw new Error("ledger down");
        },
        syncable: {
          fetchOne: async () => {
            called = true;
            return { status: "not_found" };
          },
        },
      });
      await expect(targetedFetch(deps, "https://github.com/o/r/pull/1")).rejects.toThrow(
        "ledger down",
      );
      expect(called).toBe(false);
    });

    test("exactly one sync egress row is appended before a successful fetch, keyed on the service id", async () => {
      const rows: EgressRow[] = [];
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        appendEgress: (r) => {
          rows.push(r);
          return undefined;
        },
        syncable: {
          fetchOne: async () => ({ status: "indexed", itemId: "github:o/r#1" }),
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(out).toEqual({ status: "indexed", itemId: "github:o/r#1" });
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ destination: "github", sourceType: "sync" });
    });

    test("no egress row is appended when the connector has no fetchOne", async () => {
      const rows: EgressRow[] = [];
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        appendEgress: (r) => {
          rows.push(r);
          return undefined;
        },
        syncable: {},
      });
      await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(rows).toHaveLength(0);
    });

    // CRITICAL 2: `unsupported_url` (e.g. a PR's "Files changed" tab, `/pull/7/files`) makes ZERO
    // outbound requests by contract — appending an `authorized` row for it is the exact
    // over-claim this fix removes. `urlIsSupported` false on BOTH the plain and query-stripped
    // canonical forms is what proves `fetchOne` would never even be reached — its own `called`
    // flag would stay false, but this test's fixture always returns `unsupported_url` regardless,
    // so `rows` is the only assertion doing real work here.
    test("no egress row is appended when the URL shape is unsupported (fetchOne never called)", async () => {
      const rows: EgressRow[] = [];
      let called = false;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        urlIsSupported: () => false,
        appendEgress: (r) => {
          rows.push(r);
          return undefined;
        },
        syncable: {
          fetchOne: async () => {
            called = true;
            return { status: "unsupported_url" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/7/files");
      expect(out).toEqual({ status: "unsupported_url" });
      expect(called).toBe(false);
      expect(rows).toHaveLength(0);
    });

    // The query-stripped retry form must ALSO be checked before deciding "unsupported" — a URL
    // that `urlIsSupported` rejects in its plain form but accepts once query-stripped must still
    // append (exactly once) and still let `fetchOneWithRetry` run its normal two-rung sequence.
    test("a URL unsupported in its plain form but supported query-stripped still appends and retries", async () => {
      const rows: EgressRow[] = [];
      let fetchOneCalls = 0;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        urlIsSupported: (_service, u) => new URL(u).search === "",
        appendEgress: (r) => {
          rows.push(r);
          return undefined;
        },
        syncable: {
          fetchOne: async (_ctx, u): Promise<FetchOneResult> => {
            fetchOneCalls++;
            if (new URL(u).search !== "") {
              return { status: "unsupported_url" };
            }
            return { status: "indexed", itemId: "github:o/r#1" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1?focusedCommentId=1");
      expect(out).toEqual({ status: "indexed", itemId: "github:o/r#1" });
      // rung 1 (query present) declines, rung 2 (query-stripped) succeeds — the normal
      // canonicalize+retry sequence, unaffected by the new pre-check.
      expect(fetchOneCalls).toBe(2);
      expect(rows).toHaveLength(1);
    });

    // MINOR fix (Task 11 review): the append moved to AFTER acquireWithinTimeout. Before this fix
    // a rate-limit timeout still recorded an `authorized` egress row for a call that
    // deterministically never reached `fetchOne` — a fabricated-egress bug in miniature, the same
    // shape as the CRITICAL over-count this same review round fixed for local-only syncables.
    test("no egress row is appended when the rate-limit acquire times out — fetchOne never runs, so nothing to record", async () => {
      const rows: EgressRow[] = [];
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        appendEgress: (r) => {
          rows.push(r);
          return undefined;
        },
        tryAcquire: async () => false, // always saturated
        sleep: async () => {},
        syncable: {
          fetchOne: async () => ({ status: "indexed", itemId: "x" }),
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(out).toEqual({ status: "rate_limited" });
      expect(rows).toHaveLength(0);
    });
  });

  describe("rate limiting", () => {
    test("a saturated bucket that never yields a token within the timeout answers rate_limited, and fetchOne is never called", async () => {
      let fetched = false;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        tryAcquire: async () => false, // always saturated
        sleep: async () => {}, // each poll's wait resolves instantly
        syncable: {
          fetchOne: async () => {
            fetched = true;
            return { status: "not_found" };
          },
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(out).toEqual({ status: "rate_limited" });
      expect(fetched).toBe(false);
    });

    test("a token available on the first poll fetches normally without ever sleeping", async () => {
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        tryAcquire: async () => true,
        // Never resolves — if the poll loop slept even once, this test would hang and fail on
        // its own timeout, which is exactly what proves `tryAcquire` succeeding on attempt 1
        // never needs to.
        sleep: () => new Promise(() => {}),
        syncable: {
          fetchOne: async () => ({ status: "indexed", itemId: "github:o/r#1" }),
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(out).toEqual({ status: "indexed", itemId: "github:o/r#1" });
    });

    // IMPORTANT 2: N concurrent abandoned attempts must not leave any pending low-level acquire
    // behind them — with the non-blocking `tryAcquire` design there is nothing to leave pending
    // at all (every call settles synchronously under the mutex), which is the property this
    // test pins at the orchestrator level. The rate-limiter-level regression proof (no real timer
    // is ever awaited) lives in `rate-limiter.test.ts`.
    test("N concurrent rate_limited outcomes against a saturated bucket each poll independently and fetchOne is never called", async () => {
      let pollCalls = 0;
      let fetchOneCalls = 0;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        tryAcquire: async () => {
          pollCalls++;
          return false;
        },
        sleep: async () => {},
        syncable: {
          fetchOne: async () => {
            fetchOneCalls++;
            return { status: "indexed", itemId: "x" };
          },
        },
      });
      const outcomes = await Promise.all(
        Array.from({ length: 12 }, () => targetedFetch(deps, "https://github.com/o/r/pull/1")),
      );
      expect(outcomes.every((o) => o.status === "rate_limited")).toBe(true);
      expect(fetchOneCalls).toBe(0);
      // Each of the 12 calls polled independently (no shared, cached "give up early" state) —
      // this is a sanity check that the fix didn't accidentally starve legitimate polling, only
      // the linear mutex backlog the old blocking-`acquire()` design created.
      expect(pollCalls).toBeGreaterThan(0);
    });
  });
});
