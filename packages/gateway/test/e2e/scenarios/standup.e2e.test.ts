import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import type { StandupIdentity } from "../../../src/agents/_lib/standup-types.ts";
import { emitStandupBrief } from "../../../src/agents/standup.ts";
import { itemPrimaryKey } from "../../../src/index/item-key.ts";
import { upsertIndexedItem } from "../../../src/index/item-store.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

const NOW = Date.now();
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ME = "person-me";
const MY_EMAIL = "ada@example.com";

/**
 * The REAL migrated schema, exactly as `expert.e2e.test.ts` and `changelog.e2e.test.ts` build it.
 * `graph_entity` / `graph_relation` / `graph_relation_type` (V7) and `person` (V3) only exist on
 * it, and `selectIncidentsResponded` joins three of them — a hand-written `item`-only schema
 * would throw rather than proving what this test claims.
 */
function freshDb(): Database {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return db;
}

/** A `GitRunner` returning a fixed email, so no `git` subprocess runs in this test. */
function gitEmail(email: string | null) {
  return async () => email;
}

/**
 * One row per lane, so every section renders a real entry rather than the
 * `_None in this window._` placeholder — closer to what a real standup looks like, and the only
 * way a single silent lane can be distinguished from a quiet day.
 */
function seedOneOfEach(db: Database): void {
  db.run(`INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)`, [
    ME,
    "Ada Lovelace",
    MY_EMAIL,
  ]);

  // Active PR — mine, unmerged, touched inside the window. Windows on `modified_at`, which is
  // what the "Pull requests active" heading (never "opened") is honest about.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/payments#901",
    title: "WIP: retry backoff tuning",
    modifiedAt: NOW - 2 * HOUR,
    syncedAt: NOW,
    authorId: ME,
    metadata: { state: "open", repo: "acme/payments" },
  });

  // Merged PR — mine, windows on `metadata.merged_at`, the real event field GitHub writes.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/payments#900",
    title: "Ship faster retry backoff",
    modifiedAt: NOW - 3 * HOUR,
    syncedAt: NOW,
    authorId: ME,
    metadata: { state: "closed", merged_at: NOW - 4 * HOUR, repo: "acme/payments" },
  });

  // Review — a `review` ITEM, whose `modified_at` IS its `submitted_at` (one row per review id).
  upsertIndexedItem(db, {
    service: "github",
    type: "review",
    externalId: "acme/payments#880#55501",
    title: "Review on acme/payments#880",
    modifiedAt: NOW - 5 * HOUR,
    syncedAt: NOW,
    authorId: ME,
    metadata: { repo: "acme/payments", pr_number: 880, state: "APPROVED" },
  });

  // Ticket opened — windows on `metadata.created_at_ms`, written by both ticket connectors.
  upsertIndexedItem(db, {
    service: "jira",
    type: "issue",
    externalId: "PAY-412",
    title: "Retry storm on payment callbacks",
    modifiedAt: NOW - 6 * HOUR,
    syncedAt: NOW,
    authorId: ME,
    metadata: { created_at_ms: NOW - 7 * HOUR, status: "In Progress" },
  });

  // Incident responded to — attribution lives ONLY in the graph: an incident's `author_id` is
  // its creator, not its responder. Built exactly as `graph-populator.ts` builds it, from
  // `metadata.resolved_by_email`.
  const incidentService = "pagerduty";
  const incidentExternalId = "PD-7";
  upsertIndexedItem(db, {
    service: incidentService,
    type: "incident",
    externalId: incidentExternalId,
    title: "Elevated 5xx on checkout",
    modifiedAt: NOW - 8 * HOUR,
    syncedAt: NOW,
    metadata: {
      status: "resolved",
      opened_at_ms: NOW - 10 * HOUR,
      resolved_by_email: MY_EMAIL,
      pagerduty_service_id: "PD1",
    },
  });
  // NO manual graph seeding. `upsertIndexedItem` runs the production graph populator, which
  // reads `metadata.resolved_by_email`, resolves it against the `person` row seeded above and
  // writes the `person --resolves--> incident` edge itself. Hand-building that edge here was the
  // first version of this seed, and it failed on a UNIQUE violation precisely BECAUSE the real
  // populator had already created it — so the attribution path this lane depends on is exercised
  // end to end rather than simulated. The `person` insert must therefore come FIRST: the
  // populator resolves the actor by email at upsert time, and with no matching person row it
  // writes no edge and the Incidents section goes silently empty.
  const incidentItemId = itemPrimaryKey(incidentService, incidentExternalId);
  const edge = db
    .query(
      `SELECT COUNT(*) AS n
         FROM graph_relation r
         JOIN graph_entity pe ON pe.id = r.from_id AND pe.type = 'person'
         JOIN graph_entity ie ON ie.id = r.to_id   AND ie.type = 'incident'
        WHERE r.type = 'resolves' AND pe.external_id = ? AND ie.external_id = ?`,
    )
    .get(ME, incidentItemId) as { n: number };
  // Asserted in the SEED, not the test body: if a future populator change stops writing this
  // edge, the failure should name the missing edge rather than surface as an empty Incidents
  // section that reads like a standup lane regression.
  if (edge.n !== 1) {
    throw new Error(
      `expected the graph populator to write 1 resolves edge for ${ME} -> ${incidentItemId}, got ${String(edge.n)}`,
    );
  }

  // Slack — two messages in ONE thread, so the brief's "N messages across M threads" summary has
  // a case where the two numbers genuinely differ. A single message would let a thread count
  // that simply echoed the message count pass.
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C123:1700000001.000100",
    title: "kicking off the retry investigation",
    modifiedAt: NOW - 9 * HOUR,
    syncedAt: NOW,
    authorId: ME,
    metadata: { channel: "C123", thread_ts: "1700000000.000000" },
  });
  upsertIndexedItem(db, {
    service: "slack",
    type: "message",
    externalId: "C123:1700000002.000200",
    title: "found it — backoff was linear",
    modifiedAt: NOW - 8.5 * HOUR,
    syncedAt: NOW,
    authorId: ME,
    metadata: { channel: "C123", thread_ts: "1700000000.000000" },
  });

  // A COLLEAGUE's activity in the same window. Every lane must exclude it — without this row,
  // a lane that dropped its `author_id` filter entirely would still pass every assertion below.
  upsertIndexedItem(db, {
    service: "github",
    type: "pr",
    externalId: "acme/payments#902",
    title: "SOMEONE ELSES PULL REQUEST",
    modifiedAt: NOW - 2 * HOUR,
    syncedAt: NOW,
    authorId: "person-colleague",
    metadata: { state: "open", repo: "acme/payments" },
  });
}

describe("nimbus standup (e2e, in-process)", () => {
  test("seeded index -> brief: every lane renders a real entry, identity resolves via git, briefReady fires, zero HITL side-channel notifications", async () => {
    const db = freshDb();
    seedOneOfEach(db);

    const seen: Array<{ method: string; params: unknown }> = [];
    const result = await emitStandupBrief({
      db,
      sessionId: "e2e-standup-1",
      lookbackMs: DAY,
      runGit: gitEmail(MY_EMAIL),
      notify: (method, params) => seen.push({ method, params }),
    });
    expect(result).toEqual({ sessionId: "e2e-standup-1" });

    // Poll to a terminal notification rather than a fixed sleep — `emitStandupBrief` is
    // fire-and-forget, and a fixed wait is the classic CI flake on a runner 13-18x slower at
    // temp-dir SQLite work (see `ownership.e2e.test.ts` for the same pattern).
    const deadline = performance.now() + 5_000;
    while (performance.now() < deadline) {
      if (
        seen.some((s) => s.method === "standup.briefReady" || s.method === "standup.briefError")
      ) {
        break;
      }
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
    }

    // Zero HITL, proven at runtime: `emitBriefWithSynthesis` calls `notify` exactly once, for
    // the brief lifecycle event, never for a consent side channel. If `standup` were ever routed
    // through the executor gate, a pending-consent notification would appear here alongside (or
    // instead of) `standup.briefReady`, and this exact-equality would fail.
    expect(seen.map((s) => s.method)).toEqual(["standup.briefReady"]);

    const ready = seen.find((s) => s.method === "standup.briefReady");
    expect(ready).toBeDefined();
    const params = ready?.params as {
      brief: string;
      findings: {
        kind: string;
        gaps: unknown[];
        counts: Record<string, number>;
        threadCount: number;
        approximateCount: number;
        // The REAL type, not a hand-written stand-in. A local `{ personId; source; displayName }`
        // is what let this drift: adding `personRowExists` to `StandupIdentity` left the
        // stand-in behind, and the `toEqual` below then failed to typecheck (TS2769) — a gate
        // that is ADVISORY on Windows and gating on Linux, so it read as green locally. This
        // test already imports gateway source, so there is no reason to restate the type.
        identity: StandupIdentity;
      };
    };

    expect(params.brief.length).toBeGreaterThan(0);
    expect(params.findings.kind).toBe("standup");
    expect(params.findings.gaps.length).toBeGreaterThan(0);

    // Identity resolved end-to-end through the real `resolveSelfPerson` -> `person` lookup, not
    // injected: the git email matched the seeded `canonical_email` and the display name came off
    // that row.
    // `toEqual`, not `toMatchObject`: the whole identity object, so a field added to
    // `StandupIdentity` without a thought about what it should be end-to-end fails HERE. That is
    // how `personRowExists` got its e2e value rather than defaulting past this assertion.
    expect(params.findings.identity).toEqual({
      personId: ME,
      source: "git",
      displayName: "Ada Lovelace",
      // Resolved against the seeded `person` row by a real query, not asserted from the fixture.
      personRowExists: true,
    });
    expect(params.brief).toContain("_for: `Ada Lovelace` (matched from");

    // Every section heading, plus the reserved `## Gaps` section — guaranteed non-empty by the
    // three unconditional standing notes in `buildStandupBrief`.
    for (const heading of [
      "## Pull requests active",
      "## Pull requests merged",
      "## Reviews given",
      "## Tickets opened",
      "## Incidents responded to",
      "## Slack activity",
      "## Gaps",
    ]) {
      expect(params.brief).toContain(heading);
    }

    // The headings above are NOT evidence anything was found: `renderEntrySection` emits every
    // heading unconditionally by design, so all seven are present over a completely empty index.
    // These title assertions are what a broken graph join, a dropped `created_at_ms` lane or an
    // inverted merge filter actually fails on.
    for (const title of [
      "WIP: retry backoff tuning",
      "Ship faster retry backoff",
      "Review on acme/payments#880",
      "Retry storm on payment callbacks",
      "Elevated 5xx on checkout",
      "found it — backoff was linear",
    ]) {
      expect(params.brief).toContain(title);
    }
    // One row per lane was seeded, so the placeholder must appear NOWHERE. This is the assertion
    // that fails when a single lane goes silent while the other five still populate.
    expect(params.brief).not.toContain("_None in this window._");

    // The colleague's PR was in the window and must be absent from the rendered brief. Without
    // this, a lane that lost its `author_id` filter passes everything above.
    expect(params.brief).not.toContain("SOMEONE ELSES PULL REQUEST");

    // Exact equality rather than `> 0`, so a lane that double-counts is caught as surely as one
    // that returns nothing — the incident carries one graph edge and must appear once.
    expect(params.findings.counts).toEqual({
      prsActive: 1,
      prsMerged: 1,
      reviews: 1,
      ticketsOpened: 1,
      incidents: 1,
      messages: 2,
    });
    // Two messages, ONE thread. A `threadCount` that echoed the message count would read 2.
    expect(params.findings.threadCount).toBe(1);
    expect(params.brief).toContain("_2 messages across 1 thread._");

    // The active PR and the incident are `last_touch`; the review, the ticket, the merged PR and
    // both Slack messages are not. So exactly two entries can sit in the wrong window, and the
    // preamble disclosure must say so with that number.
    expect(params.findings.approximateCount).toBe(2);
    expect(params.brief).toContain("2 entries are placed by when the index last wrote the row");
    expect(params.brief).toContain("under-reports by sync lag");

    // Closed after the assertions, not in a `finally`: a cleanup error thrown from `finally`
    // REPLACES the real assertion failure in the report, which is how a one-line diagnosis
    // becomes a re-run. An in-memory database holds no file lock, so there is nothing to leak
    // if an assertion above throws first.
    db.close();
  });

  test("an unresolvable identity refuses rather than emitting an empty standup", async () => {
    // The honesty property this agent is built around: every lane keys on the resolved person,
    // so an empty brief would assert the author did nothing — in output meant to be pasted into
    // a channel. Asserted end-to-end because the refusal must happen BEFORE any notification.
    const db = freshDb();
    const seen: string[] = [];
    const err = await emitStandupBrief({
      db,
      sessionId: "e2e-standup-2",
      lookbackMs: DAY,
      runGit: gitEmail(null),
      osUsername: "",
      notify: (method) => seen.push(method),
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("ERR_STANDUP_IDENTITY_UNRESOLVED");
    // No `briefReady` AND no `briefError`: nothing was emitted at all.
    expect(seen).toEqual([]);
    db.close();
  });

  test("zero HITL actions fired (structural)", () => {
    const source = require("node:fs").readFileSync(
      require("node:path").resolve(__dirname, "../../../src/agents/standup.ts"),
      "utf8",
    ) as string;
    expect(source).not.toContain("ToolExecutor");
    expect(source).not.toContain("HITL_REQUIRED");
  });
});
