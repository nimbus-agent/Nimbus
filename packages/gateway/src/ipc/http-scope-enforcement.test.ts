import { describe, expect, test } from "bun:test";
import { startBriefTestServer } from "../briefs/brief-test-server.ts";

const SCOPED_TOKEN = "scoped-test-token-0123456789abcdef0123456789abcd";

/** Seeds the harness vault with one token carrying exactly `scopes`. */
function scopedTokens(scopes: readonly string[]): string {
  return JSON.stringify({ "scoped-client": { token: SCOPED_TOKEN, scopes } });
}

async function postBriefs(port: number, token: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}/v1/briefs`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    // NOTE (deviation from the brief's literal snippet): validateCreateInput
    // (brief-validate.ts) unconditionally rejects an empty `sources` array regardless of
    // `useIndex` ("sources must be a non-empty array"), so `sources: []` 400s on body
    // validation before auth/scope is even relevant. This test's purpose is to exercise scope
    // enforcement, not brief-create body validation, so it supplies one valid declared source.
    body: JSON.stringify({
      brief: "why is the sky blue",
      sources: [{ url: "https://example.com/sky", title: "Sky" }],
      useIndex: false,
    }),
  });
}

describe("HTTP scope enforcement", () => {
  test("a LEGACY token still reaches POST /v1/briefs", async () => {
    // The no-regression assertion. The harness default IS the legacy bare-string shape, so this
    // exercises the real upgrade path: no scopes on disk => clip+briefs.
    const s = await startBriefTestServer();
    try {
      const res = await postBriefs(s.port, s.token);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(300);
    } finally {
      s.stop();
    }
  });

  test("a clip-only token is REFUSED on a briefs route with 403 insufficient_scope", async () => {
    const s = await startBriefTestServer({ tokensJson: scopedTokens(["clip"]) });
    try {
      const res = await postBriefs(s.port, SCOPED_TOKEN);
      expect(res.status).toBe(403);
      const body = (await res.json()) as { error: string; required: string; granted: string[] };
      expect(body.error).toBe("insufficient_scope");
      expect(body.required).toBe("briefs");
      expect(body.granted).toEqual(["clip"]);
    } finally {
      s.stop();
    }
  });

  test("a briefs-scoped token is allowed on the same route", async () => {
    // The positive half: without it, a handler that 403s unconditionally would pass the test above.
    const s = await startBriefTestServer({ tokensJson: scopedTokens(["briefs"]) });
    try {
      const res = await postBriefs(s.port, SCOPED_TOKEN);
      expect(res.status).not.toBe(403);
      expect(res.status).toBeLessThan(300);
    } finally {
      s.stop();
    }
  });

  test("an unknown token is 401, NOT 403", async () => {
    // Authentication failure must stay distinguishable from authorization failure: a client that
    // sees 401 re-pairs, a client that sees 403 asks for a scope. Collapsing them misroutes both.
    const s = await startBriefTestServer({ tokensJson: scopedTokens(["briefs"]) });
    try {
      const res = await postBriefs(s.port, "not-a-real-token");
      expect(res.status).toBe(401);
    } finally {
      s.stop();
    }
  });

  test("the 403 body never contains the token value", async () => {
    const s = await startBriefTestServer({ tokensJson: scopedTokens(["clip"]) });
    try {
      const res = await postBriefs(s.port, SCOPED_TOKEN);
      expect(await res.text()).not.toContain(SCOPED_TOKEN);
    } finally {
      s.stop();
    }
  });
});
