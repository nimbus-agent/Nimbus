import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import {
  markExtracted,
  setConfidence,
  upsertCandidate,
  writePassState,
} from "../decisions/decision-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { runDecisions } from "./decisions.ts";

let db: Database;

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function extracted(id: string, decidedAt: number, confidence: number): void {
  upsertCandidate(db, {
    id,
    sourceItemId: `item-${id}`,
    cueTier: "explicit",
    cueText: "we decided",
    priority: 0.5,
    decidedAt,
    nowMs: 1_000,
  });
  markExtracted(
    db,
    id,
    {
      statement: `Decision ${id}`,
      rationale: "because",
      alternatives: ["alt"],
      extractionSource: "llm",
    },
    1_000,
  );
  setConfidence(db, id, confidence, false, 1_000);
}

const ctx = () => ({ db, notify: () => {}, sessionId: "s1" });

const DAY_MS = 24 * 60 * 60 * 1000;

// `sinceMs` is a DURATION looking back from now, so a window wider than the
// current epoch reaches these 1970-era fixtures. `sinceMs: 0` means "the last
// zero milliseconds" — it excludes everything, which is exactly the ambiguity
// that let the CLI↔agent unit mismatch survive.
const ALL_TIME_MS = 4_000_000_000_000;

/**
 * Byte-for-byte what `packages/cli/src/commands/decisions.ts` sends for
 * `--since 30d`: `parseDurationToMs("30d")`. The gateway cannot import CLI
 * source (IPC-only rule), so the seam is pinned from both sides — the CLI's
 * `parseDecisionsArgs` test asserts the same literal.
 */
const CLI_SINCE_30D_MS = 30 * 24 * 60 * 60 * 1000;

test("returns extracted decisions newest first", async () => {
  extracted("a", 1_000, 0.9);
  extracted("b", 9_000, 0.9);
  writePassState(db, {
    watermarkMs: 9_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 2,
    scannedItems: 2,
  });
  const brief = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(brief.entries.map((e) => e.id)).toEqual(["b", "a"]);
});

test("filters by minConfidence", async () => {
  extracted("low", 1_000, 0.1);
  extracted("high", 2_000, 0.9);
  writePassState(db, {
    watermarkMs: 2_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 2,
    scannedItems: 2,
  });
  const brief = await runDecisions({ sinceMs: ALL_TIME_MS, minConfidence: 0.5 }, ctx());
  expect(brief.entries.map((e) => e.id)).toEqual(["high"]);
});

test("reports a gap when no pass has run", async () => {
  // Seed one item so the index is not empty — gap 1 (empty_index) and gap 2
  // (pass never ran) are mutually exclusive (else if), and this test targets
  // gap 2 specifically.
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["seed:1", "jira", "issue", "seed:1", "seed item", 0, 0],
  );
  const brief = await runDecisions({}, ctx());
  expect(brief.gaps.some((g) => g.detail.includes("has not run"))).toBe(true);
});

test("reports the empty index only when also returning nothing", async () => {
  const brief = await runDecisions({}, ctx());
  expect(brief.gaps.some((g) => g.category === "empty_index")).toBe(true);
});

// The spec's standing honesty note.
test("always reports the 512-character body cap", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, {
    watermarkMs: 1_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 1,
    scannedItems: 1,
  });
  const brief = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(brief.gaps.some((g) => g.detail.includes("512"))).toBe(true);
});

test("includes the confidence breakdown only when explain is requested", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, {
    watermarkMs: 1_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 1,
    scannedItems: 1,
  });
  expect(
    (await runDecisions({ sinceMs: ALL_TIME_MS, explain: true }, ctx())).entries[0]?.explain.length,
  ).toBeGreaterThan(0);
  expect((await runDecisions({ sinceMs: ALL_TIME_MS }, ctx())).entries[0]?.explain).toEqual([]);
});

// The CLI↔agent seam, end to end. Every other test in this file pins one side
// of it; this one feeds the CLI's own `--since 30d` value through the agent and
// checks WHICH ROWS come back. Reading that duration as an absolute epoch
// cutoff (the shipped bug) filtered on `decided_at >= 2_592_000_000` — 1970 —
// so both fixtures returned and `--since` was inert.
test("--since is a duration: a 30d window excludes a 60-day-old decision and keeps a 10-day-old one", async () => {
  const now = Date.now();
  extracted("old", now - 60 * DAY_MS, 0.9);
  extracted("recent", now - 10 * DAY_MS, 0.9);
  writePassState(db, {
    watermarkMs: now,
    watermarkId: "z",
    lastPassAt: now,
    lastPassNew: 2,
    scannedItems: 2,
  });

  const brief = await runDecisions({ sinceMs: CLI_SINCE_30D_MS }, ctx());
  expect(brief.entries.map((e) => e.id)).toEqual(["recent"]);
});

test("the brief's window header reports the requested window, not a 1970-derived one", async () => {
  const brief = await runDecisions({ sinceMs: CLI_SINCE_30D_MS }, ctx());
  // `renderDecisions` prints `Math.round((generatedAt - query.sinceMs) / 86_400_000)`.
  expect(Math.round((brief.generatedAt - brief.query.sinceMs) / DAY_MS)).toBe(30);
});

test("an omitted --since defaults to a 90-day window", async () => {
  const brief = await runDecisions({}, ctx());
  expect(Math.round((brief.generatedAt - brief.query.sinceMs) / DAY_MS)).toBe(90);
});

// Finding 2: `[decisions].min_confidence` reaches the read path as the default
// floor, resolved by `ipc/agents-rpc.ts` from `nimbus.toml`.
test("the configured min_confidence is the default floor when the caller omits one", async () => {
  extracted("low", 1_000, 0.1);
  extracted("high", 2_000, 0.9);
  const brief = await runDecisions(
    { sinceMs: ALL_TIME_MS },
    { ...ctx(), defaultMinConfidence: 0.3 },
  );
  expect(brief.entries.map((e) => e.id)).toEqual(["high"]);
  expect(brief.query.minConfidence).toBe(0.3);
});

test("an explicit minConfidence overrides the configured default, including 0", async () => {
  extracted("low", 1_000, 0.1);
  extracted("high", 2_000, 0.9);
  const brief = await runDecisions(
    { sinceMs: ALL_TIME_MS, minConfidence: 0 },
    { ...ctx(), defaultMinConfidence: 0.3 },
  );
  expect(brief.entries.map((e) => e.id)).toEqual(["high", "low"]);
});

// Finding 3: the 0.86 ceiling was claimed in the docs and the spec but emitted
// nowhere. Unconditional, exactly like the 512-character note above it.
test("always reports the 0.86 confidence ceiling", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, {
    watermarkMs: 1_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 1,
    scannedItems: 1,
  });
  const withRows = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(withRows.gaps.some((g) => g.detail.includes("0.86"))).toBe(true);
  // Also present on the empty brief — "every brief" means every brief.
  const empty = await runDecisions({}, ctx());
  expect(empty.gaps.some((g) => g.detail.includes("0.86"))).toBe(true);
});
