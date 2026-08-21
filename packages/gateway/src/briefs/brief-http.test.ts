import { describe, expect, test } from "bun:test";
import type { BriefSynthesizerLlm } from "./brief-synthesis.ts";
import { startBriefTestServer } from "./brief-test-server.ts";
import { pollBriefUntilTerminal } from "./poll-until-terminal.ts";

const OK_LLM: BriefSynthesizerLlm = {
  generateJson: async () =>
    Promise.resolve({
      text: JSON.stringify({
        summary: "The sources agree the sky is blue.",
        findings: [{ text: "The sky is blue.", refs: ["S1"], quotes: { S1: "sky is blue" } }],
        conflicts: [],
        gaps: [],
      }),
      model: "test-model",
      remote: false,
    }),
};

const FAILING_LLM: BriefSynthesizerLlm = {
  generateJson: async () => Promise.resolve(null),
};

async function createAndFeedRun(base: string, token: string): Promise<{ id: string }> {
  const createRes = await fetch(`${base}/v1/briefs`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      brief: "Is the sky blue?",
      sources: [{ url: "https://example.com/sky", title: "Sky facts" }],
      useIndex: false,
    }),
  });
  expect(createRes.status).toBe(200);
  const created = (await createRes.json()) as { id: string; status: string };
  expect(created.status).toBe("collecting");

  const sourceRes = await fetch(`${base}/v1/briefs/${created.id}/sources`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify({
      url: "https://example.com/sky",
      title: "Sky facts",
      body: "The sky appears blue due to Rayleigh scattering.",
      capturedAt: Date.now(),
      truncated: false,
    }),
  });
  expect(sourceRes.status).toBe(200);

  return { id: created.id };
}

describe("GET /v1/briefs/{id} auth", () => {
  test("a tokenless GET is 401, proving briefs are not in the unauthenticated read table", async () => {
    const s = await startBriefTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/briefs/run_doesnotexist`);
      expect(res.status).toBe(401);
    } finally {
      s.stop();
    }
  });

  test("a GET with a wrong (non-empty) bearer token is 401, not 200", async () => {
    const s = await startBriefTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/briefs/run_doesnotexist`, {
        headers: { authorization: "Bearer not-the-real-token" },
      });
      expect(res.status).toBe(401);
    } finally {
      s.stop();
    }
  });
});

describe("GET /v1/briefs/{id} lifecycle", () => {
  test("a done run's GET returns {status:'done', report} with no error field", async () => {
    const s = await startBriefTestServer({ llm: OK_LLM });
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const { id } = await createAndFeedRun(base, s.token);

      const runRes = await fetch(`${base}/v1/briefs/${id}/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(runRes.status).toBe(200);

      const body = await pollBriefUntilTerminal(base, s.token, id);
      expect(body.status).toBe("done");
      expect(body.report).toBeDefined();
      expect("failureReason" in body).toBe(false);
      expect("error" in body).toBe(false);

      // Exercises the `briefSave` seam (makeSave in brief-test-server.ts) end to end:
      // POST /v1/briefs/{id}/save persists the finished report as an indexed item.
      const saveRes = await fetch(`${base}/v1/briefs/${id}/save`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(saveRes.status).toBe(200);
      const saved = (await saveRes.json()) as { itemId: string };
      expect(saved.itemId).toMatch(/^nimbus:/);

      const row = s.db.query("SELECT id, type FROM item WHERE id = ?").get(saved.itemId) as {
        id: string;
        type: string;
      } | null;
      expect(row?.type).toBe("research_brief");
    } finally {
      s.stop();
    }
  });

  test("a failed run's GET returns {status:'failed', failureReason} — NOT `error`", async () => {
    const s = await startBriefTestServer({ llm: FAILING_LLM });
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const { id } = await createAndFeedRun(base, s.token);

      const runRes = await fetch(`${base}/v1/briefs/${id}/run`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(runRes.status).toBe(200);

      const body = await pollBriefUntilTerminal(base, s.token, id);
      expect(body.status).toBe("failed");
      expect(typeof body.failureReason).toBe("string");
      expect((body as Record<string, unknown>)["error"]).toBeUndefined();
    } finally {
      s.stop();
    }
  });

  test("an unknown run id → 404 not_found", async () => {
    const s = await startBriefTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/briefs/run_neverexisted`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("not_found");
    } finally {
      s.stop();
    }
  });

  test("an expired run id → 410 expired", async () => {
    const s = await startBriefTestServer({ ttlMs: 1000 });
    try {
      const base = `http://127.0.0.1:${s.port}`;
      const createRes = await fetch(`${base}/v1/briefs`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${s.token}` },
        body: JSON.stringify({
          brief: "Will this expire?",
          sources: [{ url: "https://example.com/expiring", title: "Expiring source" }],
          useIndex: false,
        }),
      });
      expect(createRes.status).toBe(200);
      const { id } = (await createRes.json()) as { id: string };

      // Past the 1000ms TTL — the run is now expired but was once known.
      s.advance(2000);

      const res = await fetch(`${base}/v1/briefs/${id}`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(410);
      const body = (await res.json()) as { error: string };
      expect(body.error).toBe("expired");
    } finally {
      s.stop();
    }
  });

  test("briefs seam disabled → 404 briefs_disabled with the POST-routes hint string", async () => {
    const s = await startBriefTestServer({ enabled: false });
    try {
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/briefs/run_whatever`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string; hint: string };
      expect(body.error).toBe("briefs_disabled");
      expect(body.hint).toBe("research briefs disabled — enable [briefs] in nimbus.toml");

      // The POST surface reports 404 too, and its 404 body carries the IDENTICAL hint string —
      // one string, two surfaces (http-server.ts BRIEFS_DISABLED_HINT / http-write-routes.ts
      // BRIEF_DISABLED_HINT).
      const postRes = await fetch(`http://127.0.0.1:${s.port}/v1/briefs`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief: "x",
          sources: [{ url: "https://example.com/x", title: "x" }],
          useIndex: false,
        }),
      });
      expect(postRes.status).toBe(404);
      const postBody = (await postRes.json()) as { error: string; hint: string };
      expect(postBody.hint).toBe(body.hint);
    } finally {
      s.stop();
    }
  });

  test("GET with a POST sub-path (/sources) does not match BRIEF_GET_RE and returns 404", async () => {
    const s = await startBriefTestServer();
    try {
      // A path that does NOT match BRIEF_GET_RE (contains a slash) falls through to the
      // generic GET handler, which returns 404 for unknown paths.
      const res = await fetch(`http://127.0.0.1:${s.port}/v1/briefs/run_ok/sources`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(404);
    } finally {
      s.stop();
    }
  });
});
