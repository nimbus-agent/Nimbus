/**
 * End-to-end tests for `GET /v1/items/resolve` — one of the small family of bearer-authed HTTP
 * routes mounted INLINE in the `fetch` handler, ahead of the unauthenticated GET table
 * (http-server.ts's `if (req.method === "GET")` block that already intercepts `BRIEF_GET_RE` /
 * `/v1/agents` / `AGENT_RUN_GET_RE`).
 *
 * The harness (`startServerWithClipToken` / `startServerWithoutClipsVault`) lives at
 * `src/ipc/http-api-test-server.ts`, not in this file — see that file's header for why, and for
 * the seam a later task (`POST /v1/items/fetch`) reuses rather than duplicating.
 */

import { describe, expect, test } from "bun:test";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import {
  startServerWithClipToken,
  startServerWithoutClipsVault,
} from "../../../src/ipc/http-api-test-server.ts";

describe("GET /v1/items/resolve (integration)", () => {
  test("returns a match for a resolve-scoped token (query-stripped rung)", async () => {
    const { port, token, db, stop } = await startServerWithClipToken(["resolve"]);
    try {
      upsertIndexedItem(db, {
        service: "github",
        type: "pull_request",
        externalId: "pr-1",
        title: "PR one",
        bodyPreview: "x",
        url: "https://github.com/o/r/pull/1",
        canonicalUrl: "https://github.com/o/r/pull/1",
        modifiedAt: 99,
        syncedAt: 99,
      });
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/items/resolve?url=${encodeURIComponent("https://github.com/o/r/pull/1?tab=files")}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({
        found: true,
        matchKind: "query_stripped",
        item: { id: "github:pr-1", service: "github", type: "pull_request", modified_at: 99 },
      });
    } finally {
      stop();
    }
  });

  // IMPORTANT 1: `handleItemsResolve` used to call `resolveItemByUrl(db, raw)` with NO `opts`, so
  // `fetchable` was always the hardcoded default `false` — a client following the documented
  // resolve-then-fetch handshake would NEVER fetch, even with the host fully configured. This
  // pins the fix: a host `resolveFetchable` claims answers `fetchable: true`, and an unclaimed
  // host answers `false`, even for the SAME not-found response shape.
  test("reports fetchable: true for a host the wired predicate claims, on a not_indexed miss", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      resolveFetchable: async () => (host: string) => host === "github.com",
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/items/resolve?url=${encodeURIComponent("https://github.com/o/r/pull/999")}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        found: false,
        reason: "not_indexed",
        service: null,
        fetchable: true,
      });
    } finally {
      stop();
    }
  });

  test("reports fetchable: false for a host the wired predicate does not claim", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      resolveFetchable: async () => (host: string) => host === "github.com",
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/items/resolve?url=${encodeURIComponent("https://gitlab.com/g/p/-/merge_requests/1")}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        found: false,
        reason: "not_indexed",
        service: null,
        fetchable: false,
      });
    } finally {
      stop();
    }
  });

  // FIX A: `resolveFetchable()` calls `deriveFetchHostMap(vault)` in production, which reads
  // several Vault keys. A locked keychain / transient backend error must degrade to the
  // documented default (`fetchable: false`), not fail the whole resolve request — before this
  // branch wired `fetchable` in, this route could not fail for a Vault reason at all.
  test("degrades to fetchable: false (still 200) when resolveFetchable rejects", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      resolveFetchable: async () => {
        throw new Error("vault locked: base https://acme.example.invalid");
      },
    });
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/items/resolve?url=${encodeURIComponent("https://github.com/o/r/pull/999")}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        found: false,
        reason: "not_indexed",
        service: null,
        fetchable: false,
      });
    } finally {
      stop();
    }
  });

  test("defaults to fetchable: false when resolveFetchable is not wired", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/items/resolve?url=${encodeURIComponent("https://github.com/o/r/pull/999")}`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(200);
      expect(await res.json()).toMatchObject({ fetchable: false });
    } finally {
      stop();
    }
  });

  test("403s a legacy-scoped token", async () => {
    const { port, token, stop } = await startServerWithClipToken(["clip", "briefs"]);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fo%2Fr`,
        { headers: { authorization: `Bearer ${token}` } },
      );
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "insufficient_scope", required: "resolve" });
    } finally {
      stop();
    }
  });

  test("401s an unknown token", async () => {
    // The mount-ordering guard: if `/v1/items/resolve` were ever reachable through the
    // unauthenticated `/v1/items/*` GET table, this would come back 200 (verified by hand during
    // review — that table's item-by-id handler responds 200 `{data:null}` for an unknown id,
    // never a 404), not 401. This must keep asserting exactly 401.
    const { port, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fo%2Fr`,
        { headers: { authorization: "Bearer nope" } },
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    } finally {
      stop();
    }
  });

  test("400s a missing url param", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"]);
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/items/resolve`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "missing_url" });
    } finally {
      stop();
    }
  });

  test("404s a named 'resolve_disabled' when the clip-token surface is not mounted", async () => {
    // Sibling precedent: agent-runs/agent-http-e2e.test.ts:200-216 pins `agents_disabled` for the
    // exact same "surface absent" shape on the agents seam. Without this test, a future refactor
    // that replaced handleItemsResolve's named 404 with a fall-through to the unauthenticated
    // `/v1/items/*` table would regress to serving 200 `{data:null}` with no bearer check at all,
    // and nothing here would fail.
    const { port, stop } = await startServerWithoutClipsVault();
    try {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/items/resolve?url=https%3A%2F%2Fgithub.com%2Fo%2Fr`,
      );
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "resolve_disabled" });
    } finally {
      stop();
    }
  });
});
