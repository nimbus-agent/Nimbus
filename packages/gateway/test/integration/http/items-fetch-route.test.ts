/**
 * End-to-end tests for `POST /v1/items/fetch` — the targeted fetch-on-miss write route, mounted
 * on the I13 write dispatcher (`http-write-routes.ts`) under its own `fetch` scope, distinct from
 * `GET /v1/items/resolve`'s `resolve` scope (that route only reads the local index; this one makes
 * an outbound provider request and writes to the index).
 *
 * The harness (`startServerWithClipToken` / `startServerWithoutClipsVault`) lives at
 * `src/ipc/http-api-test-server.ts` — see that file's header, which named this exact route as the
 * seam it was extracted for. Reused here rather than duplicated.
 */

import { describe, expect, test } from "bun:test";
import {
  startServerWithClipToken,
  startServerWithoutClipsVault,
} from "../../../src/ipc/http-api-test-server.ts";
import type { TargetedFetchOutcome } from "../../../src/sync/targeted-fetch.ts";

async function postFetch(
  port: number,
  token: string | undefined,
  body: unknown,
): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}/v1/items/fetch`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
    body: JSON.stringify(body),
  });
}

describe("POST /v1/items/fetch (integration)", () => {
  test("200 indexed for a fetch-scoped token", async () => {
    const { port, token, stop } = await startServerWithClipToken(["fetch"], {
      fetchItem: async () => ({ status: "indexed", itemId: "github:o/r#1" }),
    });
    try {
      const res = await postFetch(port, token, { url: "https://github.com/o/r/pull/1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({ status: "indexed", itemId: "github:o/r#1" });
    } finally {
      stop();
    }
  });

  test.each<TargetedFetchOutcome>([
    { status: "not_found" },
    { status: "unsupported_url" },
    { status: "no_targeted_fetch", service: "jira" },
    { status: "not_configured" },
    { status: "rate_limited" },
  ])("200 for the miss outcome %j — a miss is not a client error", async (outcome) => {
    const { port, token, stop } = await startServerWithClipToken(["fetch"], {
      fetchItem: async () => outcome,
    });
    try {
      const res = await postFetch(port, token, { url: "https://github.com/o/r/pull/1" });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual(outcome);
    } finally {
      stop();
    }
  });

  test("403s a resolve-only token — proving fetch is a distinct scope", async () => {
    const { port, token, stop } = await startServerWithClipToken(["resolve"], {
      fetchItem: async () => ({ status: "indexed", itemId: "x" }),
    });
    try {
      const res = await postFetch(port, token, { url: "https://github.com/o/r/pull/1" });
      expect(res.status).toBe(403);
      expect(await res.json()).toMatchObject({ error: "insufficient_scope", required: "fetch" });
    } finally {
      stop();
    }
  });

  test("401s an unknown token", async () => {
    const { port, stop } = await startServerWithClipToken(["fetch"], {
      fetchItem: async () => ({ status: "indexed", itemId: "x" }),
    });
    try {
      const res = await postFetch(port, "nope", { url: "https://github.com/o/r/pull/1" });
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthorized" });
    } finally {
      stop();
    }
  });

  test("400s a body with no url", async () => {
    const { port, token, stop } = await startServerWithClipToken(["fetch"], {
      fetchItem: async () => ({ status: "indexed", itemId: "x" }),
    });
    try {
      const res = await postFetch(port, token, {});
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "missing_url" });
    } finally {
      stop();
    }
  });

  test("400s a body whose url is not a string", async () => {
    const { port, token, stop } = await startServerWithClipToken(["fetch"], {
      fetchItem: async () => ({ status: "indexed", itemId: "x" }),
    });
    try {
      const res = await postFetch(port, token, { url: 42 });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "missing_url" });
    } finally {
      stop();
    }
  });

  test("404s when fetchItem is not wired — surface not mounted", async () => {
    const { port, token, stop } = await startServerWithClipToken(["fetch"]); // no fetchItem
    try {
      const res = await postFetch(port, token, { url: "https://github.com/o/r/pull/1" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: "fetch_disabled",
        hint: "targeted fetch disabled — no fetch-on-miss surface is wired",
      });
    } finally {
      stop();
    }
  });

  test("405s (no writable surface at all) when NOTHING is wired, not just the fetch seam", async () => {
    // Without clipsVault (or any other write seam), startReadOnlyHttpServer never opens the I13
    // writable handle at all, so POST falls into the generic "no write surface" 405 rather than
    // this route's own named 404 — a stronger absence than "this one seam is unmounted".
    const { port, stop } = await startServerWithoutClipsVault();
    try {
      const res = await postFetch(port, "irrelevant", { url: "https://github.com/o/r/pull/1" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("GET");
    } finally {
      stop();
    }
  });

  test("413s a 9 KiB body — the 8 KiB control-plane cap, not the 1 MiB article cap", async () => {
    const { port, token, stop } = await startServerWithClipToken(["fetch"], {
      fetchItem: async () => ({ status: "indexed", itemId: "x" }),
    });
    try {
      const oversized = `https://github.com/o/r/pull/1?${"a".repeat(9 * 1024)}`;
      const res = await postFetch(port, token, { url: oversized });
      expect(res.status).toBe(413);
      expect(await res.json()).toEqual({ error: "payload_too_large" });
    } finally {
      stop();
    }
  });

  test("405 on GET with Allow: POST", async () => {
    const { port, stop } = await startServerWithClipToken(["fetch"], {
      fetchItem: async () => ({ status: "indexed", itemId: "x" }),
    });
    try {
      const res = await fetch(`http://127.0.0.1:${port}/v1/items/fetch`, { method: "GET" });
      expect(res.status).toBe(405);
      expect(res.headers.get("Allow")).toBe("POST");
    } finally {
      stop();
    }
  });
});
