// packages/gateway/src/sync/targeted-fetch.test.ts
import { describe, expect, test } from "bun:test";
import pino from "pino";

import { createMemoryVault, openMemoryIndexDatabase } from "../testing/bun-test-support.ts";
import type { FetchableService } from "./fetch-host-boundary.ts";
import { type TargetedFetchDeps, targetedFetch } from "./targeted-fetch.ts";
import type { FetchOneResult, Syncable, SyncContext } from "./types.ts";

type EgressRow = {
  readonly destination: string;
  readonly sourceType: "sync";
  readonly method: string;
};

type DepsOverrides = {
  hostMap?: ReadonlyMap<string, FetchableService>;
  /** Full override — takes precedence over `syncable` when both are given. */
  syncableFor?: (service: FetchableService) => Syncable | undefined;
  /** Shorthand: builds a trivial fixture `Syncable` with this `fetchOne` (or none at all). */
  syncable?: { fetchOne?: Syncable["fetchOne"] };
  appendEgress?: (row: EgressRow) => void;
  sleep?: (ms: number) => Promise<void>;
  acquire?: (service: FetchableService) => Promise<void>;
  httpOriginFor?: (service: FetchableService) => string | null;
};

/** Never resolves — models a saturated bucket whose token is still pending. */
function hangingAcquire(): Promise<void> {
  return new Promise<void>(() => {});
}

function depsWith(overrides: DepsOverrides = {}): TargetedFetchDeps {
  const hostMap = overrides.hostMap ?? new Map<string, FetchableService>();
  const acquire = overrides.acquire ?? (async () => {});
  const fakeCtx: SyncContext = {
    db: openMemoryIndexDatabase(),
    vault: createMemoryVault(),
    logger: pino({ level: "silent" }),
    // A plain object structurally satisfies `SyncContext["rateLimiter"]` for the fields this
    // module actually calls (`acquire`) — the same pattern used elsewhere for a fake rate
    // limiter (see connectors/mendeley-sync.test.ts).
    rateLimiter: { acquire } as unknown as SyncContext["rateLimiter"],
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
    appendEgress: overrides.appendEgress ?? (() => {}),
    sleep: overrides.sleep ?? (() => Promise.resolve()),
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
    const deps = depsWith({
      hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
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

  // Requirement B: pin https: before fetching.
  describe("scheme pinning", () => {
    test("an http: URL is rejected when the service has no self-hosted http origin", async () => {
      let called = false;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        httpOriginFor: () => null,
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
        },
        syncable: {},
      });
      await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(rows).toHaveLength(0);
    });
  });

  describe("rate limiting", () => {
    test("a rate-limit wait past the timeout answers rate_limited, not a hang, and fetchOne is never called", async () => {
      let fetched = false;
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        acquire: hangingAcquire,
        sleep: async () => {}, // timeout fires immediately
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

    test("an acquire that resolves well within the timeout still fetches normally", async () => {
      const deps = depsWith({
        hostMap: new Map<string, FetchableService>([["github.com", "github"]]),
        acquire: async () => {},
        sleep: () => new Promise(() => {}), // never fires — acquire must win the race
        syncable: {
          fetchOne: async () => ({ status: "indexed", itemId: "github:o/r#1" }),
        },
      });
      const out = await targetedFetch(deps, "https://github.com/o/r/pull/1");
      expect(out).toEqual({ status: "indexed", itemId: "github:o/r#1" });
    });
  });
});
