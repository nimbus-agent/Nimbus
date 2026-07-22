/**
 * End-to-end proof for the research-briefs HTTP surface (Task 14): a real gateway HTTP
 * server, a real migrated SQLite DB, a bearer token, and a STUB LLM, driving the full
 * staged round trip a client performs (create -> feed sources -> run -> poll -> save)
 * plus every failure/cap/auth path. Uses `startBriefTestServer` (Task 12) — the harness
 * is not rebuilt here.
 */

import { expect, test } from "bun:test";
import { MAX_RUN_BYTES, MAX_SOURCE_BYTES, MAX_SOURCES_PER_RUN } from "./brief-constants.ts";
import type { BriefSynthesizerLlm } from "./brief-synthesis.ts";
import { startBriefTestServer } from "./brief-test-server.ts";
import type { Report } from "./brief-types.ts";

type CreateOk = { id: string; status: string; expected: number };
type SourceOk = { accepted: boolean; received: number; expected: number };
type RunOk = { status: string };
type SaveOk = { itemId: string };
type GetOk = { status: string; report?: Report; failureReason?: string };
type ErrorBody = { error: string; hint?: string; detail?: string };

function must<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`expected ${what} to be defined`);
  return v;
}

async function postJson(url: string, token: string, body: unknown): Promise<Response> {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

async function postNoBody(url: string, token: string): Promise<Response> {
  return fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}` } });
}

async function pollUntilTerminal(base: string, token: string, id: string): Promise<GetOk> {
  for (let i = 0; i < 200; i++) {
    const res = await fetch(`${base}/v1/briefs/${id}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    if (res.status !== 200) throw new Error(`unexpected GET status ${res.status}`);
    const body = (await res.json()) as GetOk;
    if (body.status === "done" || body.status === "failed") return body;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error("brief run never reached a terminal state within the poll budget");
}

/**
 * A stub that never talks to a real provider. It reads the source tokens (S1, S2, ...)
 * straight out of the prompt's `<tool_output>` envelope and cites every one of them —
 * this is what lets the "citations resolve to fed sources" assertions hold for any
 * feed-order/count combination the tests below construct.
 */
function citeAllLlm(): BriefSynthesizerLlm {
  return {
    generateJson: async (prompt: string) => {
      const tokens = [
        ...new Set([...prompt.matchAll(/"token":"(S\d+)"/g)].map((m) => must(m[1], "token match"))),
      ];
      const findings = tokens.map((t, i) => ({
        text: `Finding ${i + 1} supported by ${t}.`,
        refs: [t],
      }));
      return Promise.resolve({
        text: JSON.stringify({
          summary:
            tokens.length > 0
              ? "Synthesized summary citing the fed sources."
              : "No sources were cited.",
          findings,
          conflicts: [],
          gaps: [],
        }),
        model: "stub-cite-all",
        remote: false,
      });
    },
  };
}

/** Cites nothing, regardless of prompt content — used by the leak-check test. */
function noCiteLlm(): BriefSynthesizerLlm {
  return {
    generateJson: async () =>
      Promise.resolve({
        text: JSON.stringify({
          summary: "No source was cited.",
          findings: [],
          conflicts: [],
          gaps: [],
        }),
        model: "stub-no-cite",
        remote: false,
      }),
  };
}

test("happy path: create -> feed both -> run -> poll done -> citations resolve -> save -> one research_brief row", async () => {
  const s = await startBriefTestServer({ llm: citeAllLlm() });
  try {
    const base = `http://127.0.0.1:${s.port}`;

    const createRes = await postJson(`${base}/v1/briefs`, s.token, {
      brief: "What color is the sky?",
      sources: [
        { url: "https://example.com/sky-1", title: "Sky One" },
        { url: "https://example.com/sky-2", title: "Sky Two" },
      ],
      useIndex: false,
    });
    expect(createRes.status).toBe(200);
    const created = (await createRes.json()) as CreateOk;
    expect(created.status).toBe("collecting");
    expect(created.expected).toBe(2);

    const feed1Res = await postJson(`${base}/v1/briefs/${created.id}/sources`, s.token, {
      url: "https://example.com/sky-1",
      title: "Sky One",
      body: "The sky looks blue due to Rayleigh scattering of sunlight.",
      capturedAt: Date.now(),
      truncated: false,
    });
    expect(feed1Res.status).toBe(200);
    const feed1 = (await feed1Res.json()) as SourceOk;
    expect(feed1.accepted).toBe(true);
    expect(feed1.received).toBe(1);
    expect(feed1.expected).toBe(2);

    const feed2Res = await postJson(`${base}/v1/briefs/${created.id}/sources`, s.token, {
      url: "https://example.com/sky-2",
      title: "Sky Two",
      body: "At sunset the sky often turns orange and red.",
      capturedAt: Date.now(),
      truncated: false,
    });
    expect(feed2Res.status).toBe(200);
    const feed2 = (await feed2Res.json()) as SourceOk;
    expect(feed2.accepted).toBe(true);
    expect(feed2.received).toBe(2);
    expect(feed2.expected).toBe(2);

    const runRes = await postNoBody(`${base}/v1/briefs/${created.id}/run`, s.token);
    expect(runRes.status).toBe(200);
    const runBody = (await runRes.json()) as RunOk;
    expect(runBody.status).toBe("running");

    const done = await pollUntilTerminal(base, s.token, created.id);
    expect(done.status).toBe("done");
    const report = must(done.report, "done.report");
    expect(report.findings.length).toBeGreaterThan(0);
    for (const finding of report.findings) {
      expect(finding.citations.length).toBeGreaterThan(0);
    }
    const citedUrls = new Set(
      report.findings
        .flatMap((f) => f.citations.map((c) => c.url))
        .filter((u): u is string => u !== undefined),
    );
    expect(citedUrls.has("https://example.com/sky-1")).toBe(true);
    expect(citedUrls.has("https://example.com/sky-2")).toBe(true);

    const saveRes = await postNoBody(`${base}/v1/briefs/${created.id}/save`, s.token);
    expect(saveRes.status).toBe(200);
    const saved = (await saveRes.json()) as SaveOk;
    expect(saved.itemId).toMatch(/^nimbus:/);

    const row = s.db
      .query("SELECT COUNT(*) as c FROM item WHERE type = 'research_brief'")
      .get() as { c: number };
    expect(row.c).toBe(1);
  } finally {
    s.stop();
  }
});

test("idempotent re-feed: feeding the same source twice does not double-count and yields an identical report", async () => {
  const sources = [
    { url: "https://example.com/idem-1", title: "Idem One" },
    { url: "https://example.com/idem-2", title: "Idem Two" },
  ];
  const first = must(sources[0], "sources[0]");
  const body = "First source body for idempotency test.";

  const sA = await startBriefTestServer({ llm: citeAllLlm() });
  const sB = await startBriefTestServer({ llm: citeAllLlm() });
  try {
    const baseA = `http://127.0.0.1:${sA.port}`;
    const createA = (await (
      await postJson(`${baseA}/v1/briefs`, sA.token, {
        brief: "Idempotency check",
        sources,
        useIndex: false,
      })
    ).json()) as CreateOk;

    const feed1Res = await postJson(`${baseA}/v1/briefs/${createA.id}/sources`, sA.token, {
      url: first.url,
      title: first.title,
      body,
      capturedAt: Date.now(),
      truncated: false,
    });
    expect(feed1Res.status).toBe(200);
    const feed1 = (await feed1Res.json()) as SourceOk;
    expect(feed1.accepted).toBe(true);
    expect(feed1.received).toBe(1);

    const feed2Res = await postJson(`${baseA}/v1/briefs/${createA.id}/sources`, sA.token, {
      url: first.url,
      title: first.title,
      body,
      capturedAt: Date.now(),
      truncated: false,
    });
    expect(feed2Res.status).toBe(200);
    const feed2 = (await feed2Res.json()) as SourceOk;
    expect(feed2.accepted).toBe(false);
    expect(feed2.received).toBe(1);
    expect(feed2.expected).toBe(2);

    await postNoBody(`${baseA}/v1/briefs/${createA.id}/run`, sA.token);
    const doneA = await pollUntilTerminal(baseA, sA.token, createA.id);
    expect(doneA.status).toBe("done");

    // A reference run: identical declared sources, fed exactly once — the double-feed above
    // must not have changed anything observable in the finished report.
    const baseB = `http://127.0.0.1:${sB.port}`;
    const createB = (await (
      await postJson(`${baseB}/v1/briefs`, sB.token, {
        brief: "Idempotency check",
        sources,
        useIndex: false,
      })
    ).json()) as CreateOk;
    await postJson(`${baseB}/v1/briefs/${createB.id}/sources`, sB.token, {
      url: first.url,
      title: first.title,
      body,
      capturedAt: Date.now(),
      truncated: false,
    });
    await postNoBody(`${baseB}/v1/briefs/${createB.id}/run`, sB.token);
    const doneB = await pollUntilTerminal(baseB, sB.token, createB.id);
    expect(doneB.status).toBe("done");

    expect(JSON.stringify(doneA.report)).toBe(JSON.stringify(doneB.report));
  } finally {
    sA.stop();
    sB.stop();
  }
});

test("partial run: feeding 1 of 3 sources still finishes, and the report's gaps mention '2 of 3'", async () => {
  const s = await startBriefTestServer({ llm: citeAllLlm() });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const createRes = await postJson(`${base}/v1/briefs`, s.token, {
      brief: "Partial coverage check",
      sources: [
        { url: "https://example.com/partial-1", title: "Partial One" },
        { url: "https://example.com/partial-2", title: "Partial Two" },
        { url: "https://example.com/partial-3", title: "Partial Three" },
      ],
      useIndex: false,
    });
    const created = (await createRes.json()) as CreateOk;
    expect(created.expected).toBe(3);

    const feedRes = await postJson(`${base}/v1/briefs/${created.id}/sources`, s.token, {
      url: "https://example.com/partial-1",
      title: "Partial One",
      body: "Only one of three sources was ever fed to this run.",
      capturedAt: Date.now(),
      truncated: false,
    });
    expect(feedRes.status).toBe(200);
    const feed = (await feedRes.json()) as SourceOk;
    expect(feed.accepted).toBe(true);
    expect(feed.received).toBe(1);

    const runRes = await postNoBody(`${base}/v1/briefs/${created.id}/run`, s.token);
    expect(runRes.status).toBe(200);

    const done = await pollUntilTerminal(base, s.token, created.id);
    expect(done.status).toBe("done");
    const report = must(done.report, "done.report");
    expect(report.gaps.some((g) => g.includes("2 of 3"))).toBe(true);
  } finally {
    s.stop();
  }
});

test("auth: every one of the five routes returns 401 with no Authorization header at all", async () => {
  const s = await startBriefTestServer({ llm: citeAllLlm() });
  try {
    const base = `http://127.0.0.1:${s.port}`;

    // POST /v1/briefs — no header.
    const createRes = await fetch(`${base}/v1/briefs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: "x",
        sources: [{ url: "https://example.com/a", title: "A" }],
        useIndex: false,
      }),
    });
    expect(createRes.status).toBe(401);

    // A real, authenticated run so the remaining four routes hit a genuine id — proving the
    // 401 fires on the auth check itself, never as a side effect of an unknown/expired id.
    const created = (await (
      await postJson(`${base}/v1/briefs`, s.token, {
        brief: "Auth check",
        sources: [{ url: "https://example.com/auth-1", title: "Auth One" }],
        useIndex: false,
      })
    ).json()) as CreateOk;

    // POST /v1/briefs/{id}/sources — no header.
    const sourceRes = await fetch(`${base}/v1/briefs/${created.id}/sources`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        url: "https://example.com/auth-1",
        title: "Auth One",
        body: "body text",
        capturedAt: Date.now(),
        truncated: false,
      }),
    });
    expect(sourceRes.status).toBe(401);

    // POST /v1/briefs/{id}/run — no header.
    const runRes = await fetch(`${base}/v1/briefs/${created.id}/run`, { method: "POST" });
    expect(runRes.status).toBe(401);

    // POST /v1/briefs/{id}/save — no header.
    const saveRes = await fetch(`${base}/v1/briefs/${created.id}/save`, { method: "POST" });
    expect(saveRes.status).toBe(401);

    // GET /v1/briefs/{id} — no header.
    const getRes = await fetch(`${base}/v1/briefs/${created.id}`);
    expect(getRes.status).toBe(401);
  } finally {
    s.stop();
  }
});

test("expiry: advancing past a short TTL turns GET into 410, then an unknown id is 404", async () => {
  const s = await startBriefTestServer({ ttlMs: 1000 });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const created = (await (
      await postJson(`${base}/v1/briefs`, s.token, {
        brief: "Will this expire?",
        sources: [{ url: "https://example.com/expiring", title: "Expiring source" }],
        useIndex: false,
      })
    ).json()) as CreateOk;

    s.advance(2000);

    const expiredRes = await fetch(`${base}/v1/briefs/${created.id}`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(expiredRes.status).toBe(410);
    const expiredBody = (await expiredRes.json()) as ErrorBody;
    expect(expiredBody.error).toBe("expired");

    const freshRes = await fetch(`${base}/v1/briefs/run_never_existed_00000000`, {
      headers: { authorization: `Bearer ${s.token}` },
    });
    expect(freshRes.status).toBe(404);
    const freshBody = (await freshRes.json()) as ErrorBody;
    expect(freshBody.error).toBe("not_found");
  } finally {
    s.stop();
  }
});

test("body cap: a source body over 1 MiB is rejected with 413 payload_too_large", async () => {
  const s = await startBriefTestServer({ llm: citeAllLlm() });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const created = (await (
      await postJson(`${base}/v1/briefs`, s.token, {
        brief: "Body cap check",
        sources: [{ url: "https://example.com/oversized", title: "Oversized" }],
        useIndex: false,
      })
    ).json()) as CreateOk;

    const oversized = "x".repeat(1024 * 1024 + 10);
    const res = await postJson(`${base}/v1/briefs/${created.id}/sources`, s.token, {
      url: "https://example.com/oversized",
      title: "Oversized",
      body: oversized,
      capturedAt: Date.now(),
      truncated: false,
    });
    expect(res.status).toBe(413);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("payload_too_large");
  } finally {
    s.stop();
  }
});

test("run_capacity is distinguishable from source_too_large over the wire, and a saturating sweep still yields a partial report", async () => {
  const s = await startBriefTestServer({ llm: citeAllLlm() });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const sources = Array.from({ length: MAX_SOURCES_PER_RUN }, (_, i) => ({
      url: `https://example.com/cap-${i + 1}`,
      title: `Cap ${i + 1}`,
    }));
    const created = (await (
      await postJson(`${base}/v1/briefs`, s.token, {
        brief: "Capacity sweep",
        sources,
        useIndex: false,
      })
    ).json()) as CreateOk;
    expect(created.expected).toBe(MAX_SOURCES_PER_RUN);

    async function feed(index: number, bytes: number): Promise<Response> {
      const src = must(sources[index], `sources[${index}]`);
      return postJson(`${base}/v1/briefs/${created.id}/sources`, s.token, {
        url: src.url,
        title: src.title,
        body: "y".repeat(bytes),
        capturedAt: Date.now(),
        truncated: false,
      });
    }

    // Source 1 (index 0): deliberately over the PER-SOURCE cap but under the 1 MiB HTTP body
    // cap — a controller-level rejection, distinct from case 6's HTTP-level 413.
    const tooLargeRes = await feed(0, MAX_SOURCE_BYTES + 1);
    expect(tooLargeRes.status).toBe(413);
    const tooLargeBody = (await tooLargeRes.json()) as ErrorBody;
    expect(tooLargeBody.error).toBe("payload_too_large");
    expect(tooLargeBody.detail).toBe("source_too_large");

    // MAX_RUN_BYTES is an exact multiple of MAX_SOURCE_BYTES (4 MiB / 256 KiB = 16): feeding
    // exactly that many sources, each exactly at the per-source cap, lands exactly on the run
    // budget and all of them are accepted.
    const acceptedCount = Math.floor(MAX_RUN_BYTES / MAX_SOURCE_BYTES);
    for (let i = 1; i <= acceptedCount; i++) {
      const res = await feed(i, MAX_SOURCE_BYTES);
      expect(res.status).toBe(200);
      const body = (await res.json()) as SourceOk;
      expect(body.accepted).toBe(true);
    }

    // The next feed pushes the run over its byte budget — capacity, not size.
    const capacityIndex = acceptedCount + 1;
    const capacityRes = await feed(capacityIndex, MAX_SOURCE_BYTES);
    expect(capacityRes.status).toBe(413);
    const capacityBody = (await capacityRes.json()) as ErrorBody;
    expect(capacityBody.error).toBe("payload_too_large");
    expect(capacityBody.detail).toBe("run_capacity");

    // Every remaining declared source (index > capacityIndex) is never even attempted.

    const runRes = await postNoBody(`${base}/v1/briefs/${created.id}/run`, s.token);
    expect(runRes.status).toBe(200);
    const done = await pollUntilTerminal(base, s.token, created.id);
    expect(done.status).toBe("done");
    const report = must(done.report, "done.report");
    const missing = MAX_SOURCES_PER_RUN - acceptedCount;
    expect(report.gaps.some((g) => g.includes(`${missing} of ${MAX_SOURCES_PER_RUN}`))).toBe(true);
  } finally {
    s.stop();
  }
});

test("concurrency: a 4th run while 3 are active returns 503 briefs_busy with no Retry-After", async () => {
  const s = await startBriefTestServer({ llm: citeAllLlm() });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    for (let i = 0; i < 3; i++) {
      const res = await postJson(`${base}/v1/briefs`, s.token, {
        brief: `Concurrent run ${i}`,
        sources: [{ url: `https://example.com/concurrent-${i}`, title: `Concurrent ${i}` }],
        useIndex: false,
      });
      expect(res.status).toBe(200);
    }

    const busyRes = await postJson(`${base}/v1/briefs`, s.token, {
      brief: "One too many",
      sources: [{ url: "https://example.com/concurrent-overflow", title: "Overflow" }],
      useIndex: false,
    });
    expect(busyRes.status).toBe(503);
    const busyBody = (await busyRes.json()) as ErrorBody;
    expect(busyBody.error).toBe("briefs_busy");
    expect(busyRes.headers.get("Retry-After")).toBeNull();
  } finally {
    s.stop();
  }
});

test("disabled seam: without the briefs surface wired, POST /v1/briefs is 404 briefs_disabled with the hint", async () => {
  const s = await startBriefTestServer({ enabled: false });
  try {
    const res = await fetch(`http://127.0.0.1:${s.port}/v1/briefs`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: "x",
        sources: [{ url: "https://example.com/x", title: "x" }],
        useIndex: false,
      }),
    });
    expect(res.status).toBe(404);
    const body = (await res.json()) as ErrorBody;
    expect(body.error).toBe("briefs_disabled");
    expect(body.hint).toBe("research briefs disabled — enable [briefs] in nimbus.toml");
  } finally {
    s.stop();
  }
});

test("leak check: the bearer token, the fed source body, and its URL never appear in any response or audit row", async () => {
  const s = await startBriefTestServer({ llm: noCiteLlm() });
  try {
    const base = `http://127.0.0.1:${s.port}`;
    const SENTINEL_BODY = "SENTINEL_BODY_TEXT_4d8e1a55_must_never_leave_this_gateway";
    const SENTINEL_URL_TOKEN = "SENTINEL_URL_9f2a7c31";
    const sentinelUrl = `https://leak-check.example.com/${SENTINEL_URL_TOKEN}`;
    const bodies: string[] = [];

    async function captureJson<T>(res: Response, expectedStatus: number): Promise<T> {
      const text = await res.text();
      bodies.push(text);
      expect(res.status).toBe(expectedStatus);
      return JSON.parse(text) as T;
    }

    const created = await captureJson<CreateOk>(
      await postJson(`${base}/v1/briefs`, s.token, {
        brief: "Leak check",
        sources: [{ url: sentinelUrl, title: "Sentinel Source" }],
        useIndex: false,
      }),
      200,
    );

    await captureJson<SourceOk>(
      await postJson(`${base}/v1/briefs/${created.id}/sources`, s.token, {
        url: sentinelUrl,
        title: "Sentinel Source",
        body: SENTINEL_BODY,
        capturedAt: Date.now(),
        truncated: false,
      }),
      200,
    );

    // An unauthorized attempt on the same run — generates a rejection audit row too, proving
    // that even the audit-on-rejection path never smuggles request content into the log.
    await captureJson<ErrorBody>(
      await fetch(`${base}/v1/briefs/${created.id}/run`, { method: "POST" }),
      401,
    );

    await captureJson<RunOk>(await postNoBody(`${base}/v1/briefs/${created.id}/run`, s.token), 200);

    let done: GetOk | undefined;
    for (let i = 0; i < 200; i++) {
      const body = await captureJson<GetOk>(
        await fetch(`${base}/v1/briefs/${created.id}`, {
          headers: { authorization: `Bearer ${s.token}` },
        }),
        200,
      );
      if (body.status === "done" || body.status === "failed") {
        done = body;
        break;
      }
      await new Promise((r) => setTimeout(r, 5));
    }
    const finished = must(done, "a terminal GET body within the poll budget");
    expect(finished.status).toBe("done");
    // The stub deliberately cites nothing, so the report legitimately carries zero citations —
    // there is no legitimate path for the fed URL to appear in the report either.
    expect(finished.report?.findings.length ?? 0).toBe(0);

    await captureJson<SaveOk>(
      await postNoBody(`${base}/v1/briefs/${created.id}/save`, s.token),
      200,
    );

    for (const text of bodies) {
      expect(text.includes(s.token)).toBe(false);
      expect(text.includes(SENTINEL_BODY)).toBe(false);
      expect(text.includes(SENTINEL_URL_TOKEN)).toBe(false);
    }

    const auditRows = s.db.query("SELECT action_json FROM audit_log").all() as {
      action_json: string;
    }[];
    // Not vacuous: the unauthorized /run attempt above wrote at least one rejection row.
    expect(auditRows.length).toBeGreaterThan(0);
    for (const row of auditRows) {
      expect(row.action_json.includes(s.token)).toBe(false);
      expect(row.action_json.includes(SENTINEL_BODY)).toBe(false);
      expect(row.action_json.includes(SENTINEL_URL_TOKEN)).toBe(false);
    }
  } finally {
    s.stop();
  }
});
