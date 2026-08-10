import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { CURRENT_SCHEMA_VERSION } from "../../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../../src/index/migrations/runner.ts";
import { dispatchAgentsRpc } from "../../../src/ipc/agents-rpc.ts";
import { seedEpicWithServices } from "../../../src/premortem/cohort.test-helpers.ts";

const DAY_MS = 86_400_000;
const NOW = 1_800_000_000_000;
const SERVICE = "acme/billing";

/** Narrows the `premortem.briefReady` payload instead of casting it into shape. */
function isBriefReadyParams(v: unknown): v is {
  brief: string;
  findings: {
    kind: string;
    epic: { key: string } | null;
    services: string[];
    cohort: { members: unknown[] };
    watchers: Array<{ state: string }>;
    gaps: unknown[];
  };
} {
  if (v === null || typeof v !== "object") return false;
  const o = v as { brief?: unknown; findings?: unknown };
  if (typeof o.brief !== "string") return false;
  if (o.findings === null || typeof o.findings !== "object") return false;
  return typeof (o.findings as { kind?: unknown }).kind === "string";
}

/** The REAL V44+ `egress_ledger` (and the rest of the shipped schema), built by the migration
 * runner rather than a hand-copied `CREATE TABLE` — mirrors `ownership.e2e.test.ts`. */
function freshDb(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
  return db;
}

/** A target epic sharing SERVICE with one closed comparable epic — enough for a real cohort,
 * real risks, and a real watcher proposal, not just the empty-services degraded path. */
function seedComparableHistory(db: Database): void {
  seedEpicWithServices(db, {
    key: "TARGET-1",
    services: [SERVICE],
    resolvedAtMs: NOW,
    createdAtMs: NOW - 5 * DAY_MS,
  });
  seedEpicWithServices(db, {
    key: "PAST-1",
    services: [SERVICE],
    resolvedAtMs: NOW - 10 * DAY_MS,
    createdAtMs: NOW - 20 * DAY_MS,
  });
}

describe("nimbus pre-mortem (e2e, in-process)", () => {
  test("the premortem agent source is read-only", () => {
    // Anchored to this file, not the CWD — mirrors decisions.e2e.test.ts/glossary.e2e.test.ts.
    // A CWD-relative read resolves when the suite starts at the repo root but throws ENOENT
    // under the sharded coverage runner, which starts elsewhere.
    const src = readFileSync(
      path.join(__dirname, "..", "..", "..", "src", "agents", "premortem.ts"),
      "utf8",
    );
    expect(src).not.toContain("ToolExecutor");
    expect(src).not.toContain("HITL_REQUIRED");
    expect(src).not.toContain("connectors.dispatch");
  });

  test(
    "seeded index -> agents.premortem over IPC -> briefReady fires with markdown, a premortem-kind " +
      "finding, a real cohort member, a paused watcher proposal, and ZERO HITL side-channel notifications",
    async () => {
      const db = freshDb();
      seedComparableHistory(db);

      const seen: Array<{ method: string; params: unknown }> = [];
      const out = await dispatchAgentsRpc(
        "agents.premortem",
        { epicRef: "TARGET-1" },
        { db, notify: (method, params) => seen.push({ method, params }) },
      );
      expect(out.kind).toBe("hit");

      // Poll to a terminal notification rather than a fixed sleep — emitPremortemBrief is
      // fire-and-forget, and a fixed wait is the classic CI flake on a slow runner.
      const deadline = performance.now() + 5_000;
      while (performance.now() < deadline) {
        if (
          seen.some(
            (s) => s.method === "premortem.briefReady" || s.method === "premortem.briefError",
          )
        ) {
          break;
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
      }

      // Zero HITL: `emitBriefWithSynthesis` calls `notify` exactly once, for the brief lifecycle
      // event, never for a consent/HITL side channel. If pre-mortem were changed to route a
      // watcher write through the executor gate instead of `insertWatcherIfAbsent`, a
      // pending-consent notification would show up here alongside (or instead of)
      // `premortem.briefReady`, and this exact-equality would fail.
      expect(seen.map((s) => s.method)).toEqual(["premortem.briefReady"]);

      const ready = seen.find((s) => s.method === "premortem.briefReady");
      expect(ready).toBeDefined();
      const params: unknown = ready?.params;
      expect(isBriefReadyParams(params)).toBe(true);
      if (!isBriefReadyParams(params)) return;

      expect(params.brief.length).toBeGreaterThan(0);
      expect(params.findings.kind).toBe("premortem");
      expect(params.findings.epic?.key).toBe("TARGET-1");
      expect(params.findings.services).toContain(SERVICE);
      // A real cohort member (PAST-1), not the empty degraded path.
      expect(params.findings.cohort.members.length).toBeGreaterThan(0);
      // A first-run watcher proposal is paused ("created"), never auto-armed.
      expect(params.findings.watchers.length).toBeGreaterThan(0);
      expect(params.findings.watchers.every((w) => w.state === "created")).toBe(true);
      // The unconditional honesty gaps are always present, regardless of branch.
      expect(params.findings.gaps.length).toBeGreaterThan(0);
    },
  );
});

// I29/D22(c) — the agent-brief egress chokepoint, for `agents.premortem` specifically.
// `agents-rpc.test.ts` already proves the chokepoint is correct in general (using `agents.expert`);
// this proves `agents.premortem` — being a member of `AGENTS_RPC_HANDLERS` — actually inherits it.
// `freshDb()` runs the real migration set, so `egress_ledger` is the shipped table, not a fixture copy.
describe("I29 — agents.premortem egress-ledger coverage", () => {
  test("an MCP-declared caller appends EXACTLY ONE source_type='mcp' row", async () => {
    const db = freshDb();
    seedComparableHistory(db);
    const out = await dispatchAgentsRpc(
      "agents.premortem",
      { epicRef: "TARGET-1" },
      { db, notify: () => {}, caller: { clientId: "c1", kind: "mcp" as const } },
    );
    expect(out.kind).toBe("hit");

    const rows = db
      .query(`SELECT source_type, source_id, method FROM egress_ledger`)
      .all() as Array<{ source_type: string; source_id: string | null; method: string }>;
    expect(rows).toEqual([{ source_type: "mcp", source_id: "c1", method: "agents.premortem" }]);
  });

  test("a CLI-declared caller appends ZERO egress rows", async () => {
    const db = freshDb();
    seedComparableHistory(db);
    const out = await dispatchAgentsRpc(
      "agents.premortem",
      { epicRef: "TARGET-1" },
      { db, notify: () => {}, caller: { clientId: "c1", kind: "cli" as const } },
    );
    expect(out.kind).toBe("hit");

    const n = db.query(`SELECT COUNT(*) AS n FROM egress_ledger`).get() as { n: number };
    expect(n.n).toBe(0);
  });
});
