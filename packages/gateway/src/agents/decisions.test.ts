import { Database } from "bun:sqlite";
import { beforeEach, expect, test } from "bun:test";
import { runDecisionPass } from "../decisions/decision-extract.ts";
import {
  markExtracted,
  replaceEvidence,
  setConfidence,
  upsertCandidate,
  writePassState,
} from "../decisions/decision-store.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import type { SynthesisRunner } from "./_lib/synthesis-llm.ts";
import { emitDecisionsBrief, runDecisions } from "./decisions.ts";

let db: Database;

function runMigrations(db: Database): void {
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
}

beforeEach(() => {
  db = new Database(":memory:");
  runMigrations(db);
});

function extracted(
  id: string,
  decidedAt: number,
  confidence: number,
  extractionSource: "llm" | "snippet" = "llm",
): void {
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
      extractionSource,
    },
    1_000,
  );
  setConfidence(db, id, confidence, false, 1_000);
}

function seedItem(id: string, service: string, type: string, metadata: string | null): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, metadata, pinned)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0)`,
    [id, service, type, id, `item ${id}`, 1_000, 1_000, metadata],
  );
}

const ctx = () => ({ db, notify: () => {}, sessionId: "s1" });

const PASS_STATE = {
  watermarkMs: 2_000,
  watermarkId: "z",
  lastPassAt: 1_000,
  lastPassNew: 1,
  scannedItems: 1,
};

/** Drives `emitDecisionsBrief` to its first notification and returns it. */
async function collectBrief(
  runner?: SynthesisRunner,
): Promise<{ method: string; params: unknown }> {
  const seen: Array<{ method: string; params: unknown }> = [];
  let settle: () => void = () => undefined;
  const emitted = new Promise<void>((res) => {
    settle = res;
  });
  await emitDecisionsBrief(
    { sinceMs: ALL_TIME_MS },
    {
      db,
      sessionId: "s1",
      notify: (method: string, params: unknown) => {
        seen.push({ method, params });
        settle();
      },
      ...(runner === undefined ? {} : { runner }),
    },
  );
  await emitted;
  const first = seen[0];
  if (first === undefined) throw new Error("emitDecisionsBrief notified nothing");
  return first;
}

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

// The user-visible half of the `last_pass_at` regression: a real pass over an
// index with nothing new to scan must clear this gap note. It previously did
// not, so a successful `nimbus decisions --refresh` was answered with
// "run `nimbus decisions --refresh`".
test("a completed pass that found nothing new clears the 'has not run yet' gap", async () => {
  // A `github:pr` is NOT a decision source (see DECISION_SOURCE_TYPES), so the
  // index is non-empty — which is what selects gap 2 over gap 1 — while the
  // pass's delta scan is genuinely EMPTY. That is exactly the shape that used
  // to leave `last_pass_at` null forever.
  db.run(
    "INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ["seed:1", "github", "pr", "seed:1", "seed item", 0, 0],
  );
  const before = await runDecisions({}, ctx());
  expect(before.gaps.some((g) => g.detail.includes("has not run"))).toBe(true);

  // A pass with an empty delta: no candidates discovered, but it DID run.
  await runDecisionPass(db, {
    nowMs: 50_000,
    useLlm: false,
    maxLlmCalls: 0,
    retryCooldownMs: 0,
  });

  const after = await runDecisions({}, ctx());
  expect(after.gaps.some((g) => g.detail.includes("has not run"))).toBe(false);
  expect(after.stats.lastPassAt).toBe(50_000);
});

test("reports the empty index only when also returning nothing", async () => {
  const brief = await runDecisions({}, ctx());
  expect(brief.gaps.some((g) => g.category === "empty_index")).toBe(true);
});

// Replaces the spec's former blanket "512-character cap" note: with every
// source in the window declared complete, the brief states nothing false by
// staying silent, and the honesty count itself reads zero.
test("reports zero truncated sources and no truncation gap when the window is all complete", async () => {
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "full-body-item",
    title: "t",
    body: "We decided to move billing to Postgres because the pool kept exhausting connections.",
    modifiedAt: 1_000,
    syncedAt: 1_000,
  });
  extracted("a", 1_000, 0.9);
  writePassState(db, {
    watermarkMs: 1_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 1,
    scannedItems: 1,
  });
  const brief = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(brief.stats.truncatedSources).toBe(0);
  expect(brief.gaps.some((g) => g.detail.includes("truncated"))).toBe(false);
});

// The point of this feature: a vague global caveat replaced with a precise
// per-brief count — "1 of 2 source(s)", not "bodies are indexed to 512
// characters".
test("reports a precise truncated-source count instead of a blanket cap disclaimer", async () => {
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "complete-item",
    title: "t1",
    body: "We decided to move billing to Postgres because the pool kept exhausting connections.",
    modifiedAt: 1_000,
    syncedAt: 1_000,
  });
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "truncated-item",
    title: "t2",
    bodyPreview: "We decided to shard instead; alternatives were read replicas.",
    modifiedAt: 2_000,
    syncedAt: 2_000,
  });
  extracted("a", 1_000, 0.9);
  writePassState(db, {
    watermarkMs: 2_000,
    watermarkId: "z",
    lastPassAt: 1_000,
    lastPassNew: 1,
    scannedItems: 2,
  });
  const brief = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(brief.stats.truncatedSources).toBe(1);
  expect(brief.gaps.some((g) => g.detail.includes("1 of 2 source(s)"))).toBe(true);
  expect(brief.gaps.some((g) => g.detail.includes("512"))).toBe(false);
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

// --explain must resolve the score's inputs from the STORE, not restate the
// request: the authority term needs the source item's real `service:type` and
// the corroboration term needs the row's real evidence kinds. Both were only
// ever exercised with a missing item and zero evidence, where every term
// degrades to its fallback.
test("--explain resolves the real source authority and the evidence behind the score", async () => {
  seedItem("item-a", "notion", "page", null);
  extracted("a", 1_000, 0.9);
  replaceEvidence(db, "a", [
    {
      kind: "source",
      entityId: null,
      itemId: "item-a",
      label: "the page",
      url: null,
      occurredAt: 1_000,
    },
    {
      kind: "pr",
      entityId: "e-pr",
      itemId: "github:acme/billing#412",
      label: "Move billing to Postgres",
      url: null,
      occurredAt: 1_000,
    },
  ]);

  const brief = await runDecisions({ sinceMs: ALL_TIME_MS, explain: true }, ctx());
  const terms = brief.entries[0]?.explain ?? [];
  expect(terms.find((t) => t.term === "authority")?.detail).toBe("notion:page");
  // `source` is excluded from the corroboration term by construction — every
  // decision has one, so counting it would corroborate everything.
  expect(terms.find((t) => t.term === "corroboration")?.detail).toBe("pr");
});

test("reports still-pending candidates as a gap, and stays silent when there are none", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, { ...PASS_STATE, lastPassNew: 1, scannedItems: 1 });

  const clean = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(clean.gaps.some((g) => g.detail.includes("awaiting extraction"))).toBe(false);

  upsertCandidate(db, {
    id: "p1",
    sourceItemId: "item-p1",
    cueTier: "weak",
    cueText: "we'll use",
    priority: 0.1,
    decidedAt: 1_000,
    nowMs: 1_000,
  });
  const withPending = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(withPending.stats.pending).toBe(1);
  expect(
    withPending.gaps.some((g) => g.detail.includes("1 candidate(s) are still awaiting extraction")),
  ).toBe(true);
});

// The negative half of the empty-index note. Asserting only that it FIRES on an
// empty store cannot catch the self-contradiction it exists to prevent —
// "the local index is empty" printed above a list of decisions.
test("never claims an empty index while returning decisions", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, { ...PASS_STATE, lastPassNew: 1, scannedItems: 1 });
  const brief = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(brief.entries).toHaveLength(1);
  expect(brief.gaps.some((g) => g.category === "empty_index")).toBe(false);
});

// `--service` route 2: the ticket-key path, which exists because a repo-only
// filter silently drops process decisions. The rows it cannot place are counted
// and disclosed rather than dropped silently.
test("--service keeps ticket-key matches and discloses how many it could not place", async () => {
  seedItem("item-match", "jira", "issue", JSON.stringify({ key: "BILLING-12" }));
  seedItem("item-other", "slack", "message", null);
  extracted("match", 2_000, 0.9);
  extracted("other", 1_000, 0.9);
  writePassState(db, { ...PASS_STATE, lastPassNew: 2, scannedItems: 2 });

  const scoped = await runDecisions({ sinceMs: ALL_TIME_MS, service: "billing" }, ctx());
  expect(scoped.entries.map((e) => e.id)).toEqual(["match"]);
  expect(scoped.entries[0]?.matchedVia).toBe("ticket-key");
  expect(scoped.query.service).toBe("billing");
  expect(
    scoped.gaps.some((g) =>
      g.detail.includes("1 decision(s) match neither a repository nor a ticket project key"),
    ),
  ).toBe(true);

  // Without a filter nothing is unmatched, so the note must not appear and no
  // route is claimed for any entry.
  const unscoped = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(unscoped.entries.map((e) => e.matchedVia)).toEqual([null, null]);
  expect(unscoped.gaps.some((g) => g.detail.includes("match neither a repository"))).toBe(false);
});

// Every gap note has to describe the brief the reader is holding. The snippet
// note was derived from the unfiltered rows while `entries` and the
// service-unmatched count were derived from the matched subset, so a `--service
// billing` brief could announce "1 decision(s) are verbatim snippets" about a
// Slack decision that was filtered out and never shown.
test("the snippet gap note counts only decisions the brief actually returns", async () => {
  seedItem("item-match", "jira", "issue", JSON.stringify({ key: "BILLING-12" }));
  seedItem("item-snippet", "slack", "message", null);
  extracted("match", 2_000, 0.9, "llm");
  extracted("snippet", 1_000, 0.9, "snippet");
  writePassState(db, { ...PASS_STATE, lastPassNew: 2, scannedItems: 2 });

  const scoped = await runDecisions({ sinceMs: ALL_TIME_MS, service: "billing" }, ctx());
  expect(scoped.entries.map((e) => e.id)).toEqual(["match"]);
  expect(scoped.gaps.some((g) => g.detail.includes("verbatim snippets"))).toBe(false);

  // The same store WITHOUT the filter still reports it — the note is scoped, not
  // deleted, so this pins the fix as a filter fix rather than a silencing.
  const unscoped = await runDecisions({ sinceMs: ALL_TIME_MS }, ctx());
  expect(unscoped.gaps.some((g) => g.detail.includes("1 decision(s) are verbatim snippets"))).toBe(
    true,
  );
});

test("emitDecisionsBrief renders deterministically alone and defers to a configured synthesizer", async () => {
  extracted("a", 1_000, 0.9);
  writePassState(db, { ...PASS_STATE, lastPassNew: 1, scannedItems: 1 });

  const plain = await collectBrief();
  expect(plain.method).toBe("decisions.briefReady");
  expect((plain.params as { brief: string }).brief).toContain("Rendered deterministically");

  const synth = await collectBrief({
    run: async () => ({
      ok: true,
      markdown: "# Synthesized decisions",
      model: "test-model",
      remote: false,
    }),
  });
  expect((synth.params as { brief: string }).brief).toContain("# Synthesized decisions");
  // The typed brief travels alongside the prose, so a client never has to
  // re-parse the Markdown.
  expect((synth.params as { findings: { kind: string } }).findings.kind).toBe("decisions");
});

// Finding 3: the 0.86 ceiling was claimed in the docs and the spec but emitted
// nowhere. Unconditional — unlike the truncated-source note above it, this one
// is not data-dependent, so it never has a silent-when-clean case.
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
