import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { startAgentTestServer } from "../../../src/agent-runs/agent-test-server.ts";
import { emitOwnershipBrief } from "../../../src/agents/ownership.ts";
import { DEFAULT_NIMBUS_OWNERSHIP_TOML } from "../../../src/config/nimbus-toml.ts";
import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchAgentsRpc } from "../../../src/ipc/agents-rpc.ts";
import { runOwnershipPass } from "../../../src/ownership/ownership-pass.ts";

/** Narrows the `ownership.briefReady` payload instead of casting it into shape. */
function isBriefReadyParams(v: unknown): v is { brief: string; findings: { kind: string } } {
  if (v === null || typeof v !== "object") return false;
  const o = v as { brief?: unknown; findings?: unknown };
  if (typeof o.brief !== "string") return false;
  if (o.findings === null || typeof o.findings !== "object") return false;
  return typeof (o.findings as { kind?: unknown }).kind === "string";
}

const NOW = 1_800_000_000_000;
const ROOT = "/repo/alpha";

/** The REAL V44+ `egress_ledger` (and the rest of the shipped schema), built by the migration
 * runner rather than a hand-copied `CREATE TABLE` — a local copy would drift from the shipped
 * schema silently, and the egress assertions below only mean something against the real table. */
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

/** Seeds one blamed file with two owners and runs the real ownership pass over it, exactly like
 * `agents/ownership.test.ts`'s `seedAndRun` — a spawn that throws proves the pass makes no real git
 * calls in this fixture. */
async function seedOwnership(db: Database): Promise<void> {
  for (const [line, email, name] of [
    [1, "a@x.com", "Ann"],
    [2, "a@x.com", "Ann"],
    [3, "b@x.com", "Bob"],
  ] as const) {
    db.run(
      `INSERT INTO git_blame_line
         (repo_root, file_path, line_no, commit_sha, author_name, author_email, author_time_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [ROOT, "src/a.ts", line, `sha${String(line)}`, name, email, NOW - 86_400_000],
    );
  }
  await runOwnershipPass(db, {
    nowMs: NOW,
    roots: [ROOT],
    config: { ...DEFAULT_NIMBUS_OWNERSHIP_TOML, ignoreGlobs: [] },
    serviceRepoUrns: new Map<string, readonly string[]>(),
    spawn: (() => {
      throw new Error("git unavailable");
    }) as unknown as typeof Bun.spawn,
  });
}

describe("nimbus ownership (e2e, in-process)", () => {
  test("seeded index -> pass -> brief: briefReady fires with markdown, an ownership-kind finding, and zero HITL side-channel notifications", async () => {
    const db = freshDb();
    await seedOwnership(db);

    const seen: Array<{ method: string; params: unknown }> = [];
    const result = await emitOwnershipBrief(
      { path: "src/a.ts" },
      {
        db,
        roots: [ROOT],
        notify: (method, params) => seen.push({ method, params }),
        sessionId: "e2e-ownership",
      },
    );
    expect(result).toEqual({ sessionId: "e2e-ownership" });

    // Poll to a terminal notification rather than a fixed sleep — emitOwnershipBrief is
    // fire-and-forget, and a fixed wait is the classic CI flake on a slow runner.
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      if (
        seen.some((s) => s.method === "ownership.briefReady" || s.method === "ownership.briefError")
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    // Zero HITL, proven at runtime rather than by re-reading the source (agents/ownership.test.ts
    // already covers that structurally): `emitBriefWithSynthesis` calls `notify` exactly once, for
    // the brief lifecycle event, and never for a consent/HITL side channel. If the agent were changed
    // to route through the executor gate, a pending-consent notification would show up here alongside
    // (or instead of) `ownership.briefReady`, and this exact-equality would fail.
    expect(seen.map((s) => s.method)).toEqual(["ownership.briefReady"]);

    const ready = seen.find((s) => s.method === "ownership.briefReady");
    expect(ready).toBeDefined();
    const params: unknown = ready?.params;
    expect(isBriefReadyParams(params)).toBe(true);
    if (!isBriefReadyParams(params)) return;
    expect(params.brief.length).toBeGreaterThan(0);
    expect(params.findings.kind).toBe("ownership");
  });
});

// I29/D22(c) — the agent-brief egress chokepoint, for `agents.ownership` specifically.
// `agents-rpc.test.ts` already proves the chokepoint is correct in general (using `agents.expert`);
// this proves `agents.ownership` — being a member of `AGENTS_RPC_HANDLERS` — actually inherits it,
// on all three transports the agent is served over. `freshDb()` runs the real migration set, so
// `egress_ledger` is the shipped table, not a fixture copy.
describe("I29 — agents.ownership egress-ledger coverage", () => {
  test("an MCP-declared caller appends EXACTLY ONE source_type='mcp' row", async () => {
    const db = freshDb();
    const out = await dispatchAgentsRpc(
      "agents.ownership",
      {},
      { db, notify: () => {}, caller: { clientId: "c1", kind: "mcp" as const } },
    );
    expect(out.kind).toBe("hit");

    const rows = db
      .query(`SELECT source_type, source_id, method FROM egress_ledger`)
      .all() as Array<{ source_type: string; source_id: string | null; method: string }>;
    expect(rows).toEqual([{ source_type: "mcp", source_id: "c1", method: "agents.ownership" }]);
  });

  test("a CLI-declared caller appends ZERO egress rows", async () => {
    const db = freshDb();
    const out = await dispatchAgentsRpc(
      "agents.ownership",
      {},
      { db, notify: () => {}, caller: { clientId: "c1", kind: "cli" as const } },
    );
    expect(out.kind).toBe("hit");

    const n = db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});

// The second transport: a REAL Bun.serve HTTP server (`startAgentTestServer`, the same harness
// `agent-http-e2e.test.ts` uses for `agents.expert`) rather than a direct `dispatchAgentsRpc` call —
// this exercises the bearer-token verification and `buildAgentHttpInvoker` wiring too, not just the
// dispatch chokepoint.
describe("I29 — agents.ownership over HTTP", () => {
  test("POST /v1/agents/ownership appends EXACTLY ONE source_type='http' row", async () => {
    const s = await startAgentTestServer();
    try {
      const res = await fetch(`http://127.0.0.1:${String(s.port)}/v1/agents/ownership`, {
        method: "POST",
        headers: { authorization: `Bearer ${s.token}`, "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(res.status).toBe(202);
      const { runId } = (await res.json()) as { runId: string };
      expect(runId).toMatch(/^ownership_\d+_[0-9a-f]{8}$/);

      // Unfiltered — the whole table, not `WHERE source_type='http'` — so this pins the ledger's
      // total content, not merely the http-typed slice of it. A spurious row of a different
      // source_type would be invisible to a filtered query but must fail this one.
      const rows = s.db
        .query(`SELECT source_type, source_id, method FROM egress_ledger`)
        .all() as Array<{ source_type: string; source_id: string | null; method: string }>;
      expect(rows).toEqual([
        { source_type: "http", source_id: "agent-test-harness", method: "agents.ownership" },
      ]);
    } finally {
      s.stop();
    }
  });
});
