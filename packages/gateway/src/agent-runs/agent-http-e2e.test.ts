// packages/gateway/src/agent-runs/agent-http-e2e.test.ts
//
// End-to-end over a REAL Bun.serve HTTP server, a real run store and the real invoker. The unit
// suites cover each piece; this proves the pieces are wired to each other.

import { describe, expect, test } from "bun:test";
import { GATEWAY_VERSION } from "../version.ts";
import { startAgentTestServer } from "./agent-test-server.ts";

const LEGACY_TOKEN = "legacy-bare-string-token-0123456789abcdef";
const LEGACY_TOKENS = JSON.stringify({ chrome: LEGACY_TOKEN });

async function invoke(
  port: number,
  agent: string,
  token: string,
  body: unknown = { topicOrFile: "auth.ts" },
): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}/v1/agents/${agent}`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function pollRun(port: number, token: string, runId: string): Promise<Response> {
  return await fetch(`http://127.0.0.1:${String(port)}/v1/agents/runs/${runId}`, {
    headers: { authorization: `Bearer ${token}` },
  });
}

function ledgerRows(
  db: { query: (sql: string) => { all: () => unknown } },
  sql: string,
): Array<Record<string, unknown>> {
  return db.query(sql).all() as Array<Record<string, unknown>>;
}

describe("agents over HTTP — end to end", () => {
  test("an agents-scoped token invokes an agent and polls its run to completion", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "expert", s.token);
      expect(res.status).toBe(202);
      const { runId } = (await res.json()) as { runId: string };
      // The gateway's own sessionId, reused as the run id — one name for the ledger row, the brief
      // and the poll.
      expect(runId).toMatch(/^expert_\d+_[0-9a-f]{8}$/);

      // Poll to a terminal state rather than sleeping a fixed interval: the run is fire-and-forget
      // and a fixed sleep is the classic CI flake.
      type RunBody = { status: string; brief?: string; failureReason?: string };
      const statuses: string[] = [];
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        const poll = await pollRun(s.port, s.token, runId);
        expect(poll.status).toBe(200);
        const body = (await poll.json()) as RunBody;
        statuses.push(body.status);
        if (body.status !== "running") break;
        await Bun.sleep(20);
      }
      expect(statuses.at(-1)).toBe("done");
    } finally {
      s.stop();
    }
  });

  test("the poll body carries the synthesis provenance once the run is done", async () => {
    // Task 6 fix: GET /v1/agents/runs/{id} previously never surfaced `synthesis` at all, so a
    // caller could never learn why a rewrite was, or was not, used. This harness wires no LLM
    // router, so provenance is the "no runner" shape — still a REAL object, not absent.
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "expert", s.token);
      const { runId } = (await res.json()) as { runId: string };
      type RunBody = { status: string; synthesis?: { attempted: boolean; reason?: string } };
      let body: RunBody = { status: "running" };
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline && body.status === "running") {
        const poll = await pollRun(s.port, s.token, runId);
        body = (await poll.json()) as RunBody;
        if (body.status === "running") await Bun.sleep(20);
      }
      expect(body.status).toBe("done");
      expect(body.synthesis).toEqual({ attempted: false, reason: "disabled" });
    } finally {
      s.stop();
    }
  });

  test("the invocation appended exactly one source_type='http' egress row", async () => {
    const s = await startAgentTestServer();
    try {
      await invoke(s.port, "expert", s.token);
      expect(
        ledgerRows(
          s.db,
          "SELECT source_type, source_id, method FROM egress_ledger WHERE source_type='http'",
        ),
      ).toEqual([
        { source_type: "http", source_id: "agent-test-harness", method: "agents.expert" },
      ]);
    } finally {
      s.stop();
    }
  });

  test("a LEGACY token is refused with 403 insufficient_scope and ledgers NOTHING", async () => {
    // The scope story end to end: a token minted before scopes existed parses as exactly
    // clip+briefs and must not reach any agent. This is the assertion the previous PR was built to
    // make possible — and the zero-row check is what proves the refusal happens BEFORE the append.
    const s = await startAgentTestServer({ tokensJson: LEGACY_TOKENS });
    try {
      const res = await invoke(s.port, "expert", LEGACY_TOKEN);
      expect(res.status).toBe(403);
      expect(await res.json()).toEqual({
        error: "insufficient_scope",
        required: "agents",
        granted: ["clip", "briefs"],
      });
      expect(ledgerRows(s.db, "SELECT id FROM egress_ledger")).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("a legacy token is refused on BOTH reads too", async () => {
    const s = await startAgentTestServer({ tokensJson: LEGACY_TOKENS });
    try {
      const list = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents`, {
        headers: { authorization: `Bearer ${LEGACY_TOKEN}` },
      });
      expect(list.status).toBe(403);
      const poll = await pollRun(s.port, LEGACY_TOKEN, "expert_1_deadbeef");
      // 403 BEFORE 404: an out-of-scope caller must not be able to probe which run ids exist.
      expect(poll.status).toBe(403);
    } finally {
      s.stop();
    }
  });

  test("an unknown token is 401, not 403", async () => {
    const s = await startAgentTestServer();
    try {
      expect((await invoke(s.port, "expert", "not-a-real-token")).status).toBe(401);
      expect((await pollRun(s.port, "not-a-real-token", "expert_1_x")).status).toBe(401);
    } finally {
      s.stop();
    }
  });

  test("agents.preflight is not reachable over HTTP (I24)", async () => {
    // A 404 here is the whole point: an external caller must not be able to queue a consent prompt
    // on the owner's machine, and no egress row is written for a route that does not exist.
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "preflight", s.token, { ref: "HEAD", namespace: "n" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown_agent" });
      expect(ledgerRows(s.db, "SELECT id FROM egress_ledger")).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("agents.premortem is not reachable over HTTP", async () => {
    // pre-mortem writes paused watcher rows with no HITL gate (see the `nimbus-agent-patterns`
    // skill for the exact bounds of that exception). A 404 here is the whole point, same as
    // preflight above: an external caller must not be able to trigger those writes unprompted,
    // and no egress row is written for a route that does not exist.
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "premortem", s.token, { epicRef: "PROJ-1" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown_agent" });
      expect(ledgerRows(s.db, "SELECT id FROM egress_ledger")).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("agents.negotiate is not reachable over HTTP", async () => {
    // Unlike preflight/premortem above, negotiate is a pure read with no side effects — it is
    // excluded for a different reason: combined with `--person`, HTTP exposure would let any
    // holder of the `agents` token assemble a contribution dossier on any indexed person without
    // the owner initiating it. A 404 here is the whole point, same as preflight/premortem above,
    // and no egress row is written for a route that does not exist.
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "negotiate", s.token, { personId: "person-1" });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown_agent" });
      expect(ledgerRows(s.db, "SELECT id FROM egress_ledger")).toEqual([]);
    } finally {
      s.stop();
    }
  });

  test("GET /v1/agents publishes exactly the invokable set", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      const { agents } = (await res.json()) as { agents: string[] };
      expect(agents).not.toContain("preflight");
      expect(agents).not.toContain("premortem");
      expect(agents).not.toContain("whyPeek");
      expect(agents).not.toContain("negotiate");
      expect(agents).toContain("expert");
      expect(agents).toHaveLength(11);
    } finally {
      s.stop();
    }
  });

  test("GET /v1/agents publishes the gateway version alongside the names", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents`, {
        headers: { authorization: `Bearer ${s.token}` },
      });
      expect(res.status).toBe(200);
      // A NAME does not imply an ARM, which is why this field exists. `why`, `expert` and
      // `ownership` have been published for releases and their `itemUrl` arms have not, so a
      // client gating on the arm cannot learn what it needs from the roster alone. It rides on
      // THIS response rather than getting a route of its own because this is the request such a
      // client already makes at the moment it needs the answer — so it learns both facts in one
      // round trip, with no version to cache and go stale the next time the owner upgrades.
      //
      // The web clipper is the first consumer: it withholds the item-scoped lanes below a floor
      // and fails closed when no version is reported, so an absent field here is not cosmetic —
      // it keeps those lanes dark.
      const { version } = (await res.json()) as { version: string };
      expect(version).toBe(GATEWAY_VERSION);
    } finally {
      s.stop();
    }
  });

  test("an unknown run id is 404 and an expired one is 410", async () => {
    const s = await startAgentTestServer({ ttlMs: 5_000 });
    try {
      expect((await pollRun(s.port, s.token, "expert_1_deadbeef")).status).toBe(404);
      const res = await invoke(s.port, "expert", s.token);
      const { runId } = (await res.json()) as { runId: string };
      s.advance(5_001);
      expect((await pollRun(s.port, s.token, runId)).status).toBe(410);
    } finally {
      s.stop();
    }
  });

  test("malformed params are 400 invalid_params", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await invoke(s.port, "expert", s.token, { topicOrFile: "" });
      expect(res.status).toBe(400);
      expect((await res.json()) as { error: string }).toMatchObject({ error: "invalid_params" });
    } finally {
      s.stop();
    }
  });

  test("the busy 429 carries Retry-After, like the rate-limited 429 on the same route", async () => {
    // Two different 429s reach a client from this route: the per-token rate limiter's and the run
    // store's capacity refusal. A client backing off by Retry-After must not have to know which one
    // it got. This is the assertion that keeps them consistent as either side changes.
    const s = await startAgentTestServer();
    try {
      s.fillRunCapacity();
      const res = await invoke(s.port, "expert", s.token);
      expect(res.status).toBe(429);
      expect(res.headers.get("retry-after")).toBe("1");
      expect((await res.json()) as { error: string }).toMatchObject({ error: "busy" });
    } finally {
      s.stop();
    }
  });

  test("every /v1/agents route 404s with a named cause when the seam is absent", async () => {
    const s = await startAgentTestServer({ enabled: false });
    try {
      for (const res of [
        await invoke(s.port, "expert", s.token),
        await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents`, {
          headers: { authorization: `Bearer ${s.token}` },
        }),
        await pollRun(s.port, s.token, "expert_1_x"),
      ]) {
        expect(res.status).toBe(404);
        expect((await res.json()) as { error: string }).toMatchObject({ error: "agents_disabled" });
      }
    } finally {
      s.stop();
    }
  });

  test("the run poll is NOT reachable through the unauthenticated GET table", async () => {
    // The reads are mounted in the fetch handler ahead of that table precisely because it is
    // documented "no bearer gate". A missing Authorization header must 401, never fall through to
    // an ungated read of a brief synthesised from the private index.
    const s = await startAgentTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents/runs/expert_1_x`);
      expect(res.status).toBe(401);
      const list = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents`);
      expect(list.status).toBe(401);
    } finally {
      s.stop();
    }
  });
});
