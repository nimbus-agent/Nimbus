import type { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { createMemoryIndexDb } from "../connectors/connector-sync-test-helpers.ts";
import type { StandupIdentity } from "./_lib/standup-types.ts";
import {
  buildStandupBrief,
  emitStandupBrief,
  STANDUP_CATEGORY_CAP,
  StandupIdentityUnresolvedError,
} from "./standup.ts";

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ME = "person-me";

/**
 * The REAL migrated schema, not a hand-written `CREATE TABLE item`.
 *
 * `selectIncidentsResponded` JOINs `graph_relation`, `graph_entity` and `item`, and
 * `selectPersonDisplayName` reads `person` — a hand-written `item`-only schema turns the
 * "an empty index yields zero counts, not an error" test below into an SQLite error that
 * happens to be caught, proving nothing. `test/integration/standup-queries.test.ts` found two
 * real column mismatches on the graph tables this way.
 */
function emptyDb(): Database {
  return createMemoryIndexDb();
}

function identity(overrides: Partial<StandupIdentity> = {}): StandupIdentity {
  return { personId: ME, source: "git", displayName: "Ada Lovelace", ...overrides };
}

function build(opts: { db?: Database; identity?: StandupIdentity; lookbackMs?: number } = {}) {
  return buildStandupBrief({
    db: opts.db ?? emptyDb(),
    nowMs: NOW,
    lookbackMs: opts.lookbackMs ?? DAY,
    identity: opts.identity ?? identity(),
    // A `performance.now()` ORIGIN, not an elapsed duration: the builder measures against it
    // AFTER running its lanes. Passing a pre-computed elapsed time is the defect
    // `BuildStandupArgs.startedAtMs` exists to make impossible — it shipped on `changelog`.
    startedAtMs: performance.now(),
  });
}

function insertItem(
  db: Database,
  row: {
    id: string;
    type: string;
    service?: string;
    title?: string;
    modifiedAt?: number;
    authorId?: string | null;
    meta?: unknown;
    externalId?: string;
  },
): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, url, modified_at, author_id, metadata, synced_at)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?)`,
    [
      row.id,
      row.service ?? "github",
      row.type,
      row.externalId ?? row.id,
      row.title ?? row.id,
      row.modifiedAt ?? NOW - HOUR,
      row.authorId === undefined ? ME : row.authorId,
      row.meta === undefined ? null : JSON.stringify(row.meta),
      NOW,
    ],
  );
}

describe("buildStandupBrief", () => {
  test("an empty index yields zero counts and a brief, not an error", () => {
    const db = emptyDb();
    try {
      const b = build({ db });
      expect(b.kind).toBe("standup");
      expect(b.counts).toEqual({
        prsActive: 0,
        prsMerged: 0,
        reviews: 0,
        ticketsOpened: 0,
        incidents: 0,
        messages: 0,
      });
      expect(b.threadCount).toBe(0);
      expect(b.approximateCount).toBe(0);
      expect(b.truncatedCount).toBe(0);
    } finally {
      db.close();
    }
  });

  test("query.sinceMs is the ABSOLUTE cutoff, converted from the lookback duration", () => {
    const db = emptyDb();
    try {
      const b = build({ db, lookbackMs: 6 * HOUR });
      // If the duration ever reached SQL unconverted, `created_at_ms >= 21600000` would be
      // January 1970 and every lane would return the whole index as today's work.
      expect(b.query.sinceMs).toBe(NOW - 6 * HOUR);
      expect(b.query.nowMs).toBe(NOW);
    } finally {
      db.close();
    }
  });

  test("latencyMs is measured after the lanes run, so it is never a fabricated ~0", () => {
    const db = emptyDb();
    try {
      // `changelog` shipped a `latencyMs: Date.now() - started` in the CALLER's object literal,
      // which is evaluated before the function body and published ~0 ms in the rendered footer.
      // Asserting non-negative + finite is the strongest claim available without a fake clock;
      // the shape that prevents the defect is `startedAtMs` being an ORIGIN, not a duration.
      const b = build({ db });
      expect(Number.isFinite(b.latencyMs)).toBe(true);
      expect(b.latencyMs).toBeGreaterThanOrEqual(0);
    } finally {
      db.close();
    }
  });

  test("counts are TRUE pre-cap totals while entry lists are capped", () => {
    const db = emptyDb();
    try {
      const over = STANDUP_CATEGORY_CAP + 11;
      for (let i = 0; i < over; i++) {
        insertItem(db, {
          id: `msg-${String(i).padStart(3, "0")}`,
          type: "message",
          service: "slack",
          externalId: `C1:${String(1000 + i)}.0`,
          modifiedAt: NOW - HOUR - i,
          meta: { channel: "C1", thread_ts: null },
        });
      }
      const b = build({ db });
      // The difference between these two IS the point: `counts.messages - messages.length`
      // recovers exactly what the cap dropped. A count that quietly meant "shown" would reach
      // the synthesis prompt as authoritative and become prose claiming 50 messages when 61
      // were posted.
      expect(b.counts.messages).toBe(over);
      expect(b.messages).toHaveLength(STANDUP_CATEGORY_CAP);
      expect(b.truncatedCount).toBe(11);
    } finally {
      db.close();
    }
  });

  test("approximateCount counts last_touch rows only, never event_column ones", () => {
    const db = emptyDb();
    try {
      // One active PR (last_touch) + one review and one Slack message (event_column). Only the
      // PR can sit in the wrong window, so only it may be counted — otherwise the disclosure's
      // number would include entries its warning does not apply to.
      insertItem(db, { id: "pr-1", type: "pr", meta: { state: "open" } });
      insertItem(db, { id: "rev-1", type: "review" });
      insertItem(db, {
        id: "msg-1",
        type: "message",
        service: "slack",
        externalId: "C1:1.0",
        meta: { channel: "C1", thread_ts: null },
      });
      const b = build({ db });
      expect(b.counts.prsActive).toBe(1);
      expect(b.counts.reviews).toBe(1);
      expect(b.counts.messages).toBe(1);
      expect(b.approximateCount).toBe(1);
    } finally {
      db.close();
    }
  });

  test("approximateCount is on the PRE-cap basis, like counts", () => {
    const db = emptyDb();
    try {
      const over = STANDUP_CATEGORY_CAP + 5;
      for (let i = 0; i < over; i++) {
        insertItem(db, {
          id: `pr-${String(i).padStart(3, "0")}`,
          type: "pr",
          modifiedAt: NOW - HOUR - i,
          meta: { state: "open" },
        });
      }
      const b = build({ db });
      // Counting only the LISTED rows would make the time-basis disclosure quietly mean "of the
      // entries shown", putting it on a different basis from `counts` in the same brief.
      expect(b.approximateCount).toBe(over);
      expect(b.prsActive).toHaveLength(STANDUP_CATEGORY_CAP);
    } finally {
      db.close();
    }
  });

  test("the two substrate gaps are UNCONDITIONAL, present even on an empty day", () => {
    const db = emptyDb();
    try {
      const details = build({ db }).gaps.map((g) => g.detail);
      // `ownership`'s standing-disclaimer precedent: a conditional note is absent exactly when
      // the reader needs it. A standup with no deploy line must say that means "not indexed".
      expect(details.some((d) => d.includes("Deployments you triggered are absent"))).toBe(true);
      expect(details.some((d) => d.includes("Tickets you moved or commented on"))).toBe(true);
      expect(details.some((d) => d.includes("attributed through the single indexed person"))).toBe(
        true,
      );
    } finally {
      db.close();
    }
  });

  test("the review/message time-basis gap appears only when those lanes have entries", () => {
    const db = emptyDb();
    try {
      const anchor = "Reviews and Slack messages are placed by";
      expect(build({ db }).gaps.some((g) => g.detail.includes(anchor))).toBe(false);
      insertItem(db, { id: "rev-1", type: "review" });
      expect(build({ db }).gaps.some((g) => g.detail.includes(anchor))).toBe(true);
    } finally {
      db.close();
    }
  });

  test("a non-GitHub merged PR is counted and disclosed, and the note says it is an estimate", () => {
    const db = emptyDb();
    try {
      insertItem(db, {
        id: "mr-1",
        type: "pr",
        service: "gitlab",
        meta: { state: "merged" },
      });
      const b = build({ db });
      expect(b.nonGithubMergedPrs).toBe(1);
      const gap = b.gaps.find((g) => g.detail.includes("non-GitHub forge"));
      expect(gap).toBeDefined();
      // The count is itself windowed on `modified_at`, so presenting it beside event-windowed
      // numbers without saying so would read as the same kind of figure.
      expect(gap?.detail).toContain("estimate");
      // And it must not also appear as an ACTIVE PR — it is merged.
      expect(b.counts.prsActive).toBe(0);
    } finally {
      db.close();
    }
  });

  test("an identity naming no person row gets its own gap explaining the empty brief", () => {
    const db = emptyDb();
    try {
      const b = build({ db, identity: identity({ displayName: null, source: "override" }) });
      const gap = b.gaps.find((g) => g.detail.includes("No indexed person record"));
      expect(gap).toBeDefined();
      expect(gap?.detail).toContain(ME);
      // Remediation is source-specific: an override is taken verbatim and never validated, so
      // "confirm the id" is the action — not "check your connectors have synced".
      expect(gap?.remediation).toContain("verbatim");
    } finally {
      db.close();
    }
  });

  test("an OS-username resolution is disclosed as a heuristic that can hit a colleague", () => {
    const db = emptyDb();
    try {
      const b = build({ db, identity: identity({ source: "os" }) });
      expect(b.gaps.some((g) => g.detail.includes("operating-system username"))).toBe(true);
      // A git-resolved identity makes no such claim.
      const git = build({ db, identity: identity({ source: "git" }) });
      expect(git.gaps.some((g) => g.detail.includes("operating-system username"))).toBe(false);
    } finally {
      db.close();
    }
  });

  test("a merged PR appears under merged and NOT under active, exactly once", () => {
    const db = emptyDb();
    try {
      insertItem(db, {
        id: "pr-merged",
        type: "pr",
        meta: { state: "closed", merged_at: NOW - 2 * HOUR },
      });
      const b = build({ db });
      expect(b.prsMerged.map((r) => r.id)).toEqual(["pr-merged"]);
      expect(b.prsActive).toEqual([]);
    } finally {
      db.close();
    }
  });
});

/**
 * The `standup.briefReady` payload, or a failure that says the notification never arrived.
 *
 * Replaces three `(ready?.params as {...}).findings` casts. Biome rejected one of those as unsafe
 * optional chaining, correctly: when the notification is absent, `ready` is `undefined` and the
 * cast-then-access throws a bare `TypeError: Cannot read properties of undefined` from the line
 * AFTER the real problem, so a missing brief reads as a malformed one. Throwing here names the
 * actual failure.
 */
function briefReadyPayload(events: ReadonlyArray<{ method: string; params: unknown }>): {
  brief: string;
  findings: { identity: StandupIdentity; gaps: unknown[] };
} {
  const ready = events.find((e) => e.method === "standup.briefReady");
  if (ready === undefined) {
    throw new Error(
      `no standup.briefReady among [${events.map((e) => e.method).join(", ") || "<none>"}]`,
    );
  }
  return ready.params as {
    brief: string;
    findings: { identity: StandupIdentity; gaps: unknown[] };
  };
}

describe("emitStandupBrief identity resolution", () => {
  /** A `GitRunner` returning a fixed email, so no `git` subprocess runs in tests. */
  function gitEmail(email: string | null) {
    return async () => email;
  }

  test("refuses when no person resolves, and names the remediation", async () => {
    const db = emptyDb();
    try {
      const notified: string[] = [];
      // An empty standup would assert the author did nothing, in output meant to be pasted into
      // a channel. Refusing is the only honest answer — see `StandupIdentityUnresolvedError`.
      // `.catch`-and-inspect rather than `expect(...).rejects.toThrow(...)`: that form typechecks
      // as returning a non-promise here, so `await` on it is a no-op the compiler flags — and an
      // un-awaited rejection assertion passes whether or not the call rejects at all.
      const err = await emitStandupBrief({
        db,
        sessionId: "s-1",
        lookbackMs: DAY,
        runGit: gitEmail(null),
        osUsername: "",
        notify: (m) => notified.push(m),
      }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(StandupIdentityUnresolvedError);
      // And it refuses BEFORE any brief work, so no notification is emitted at all — not even a
      // `standup.briefError` carrying an empty brief.
      expect(notified).toEqual([]);
    } finally {
      db.close();
    }
  });

  test("the refusal message names both resolution routes and the config fix", async () => {
    const db = emptyDb();
    try {
      const err = await emitStandupBrief({
        db,
        sessionId: "s-1",
        lookbackMs: DAY,
        runGit: gitEmail(null),
        osUsername: "",
        notify: () => {},
      }).catch((e: unknown) => e);
      const message = err instanceof Error ? err.message : String(err);
      expect(message).toContain("ERR_STANDUP_IDENTITY_UNRESOLVED");
      expect(message).toContain("git config user.email");
      expect(message).toContain("[user] mePersonId");
      expect(message).toContain("nimbus people list");
    } finally {
      db.close();
    }
  });

  test("resolves via git email and emits standup.briefReady with findings", async () => {
    const db = emptyDb();
    try {
      db.run(`INSERT INTO person (id, display_name, canonical_email) VALUES (?, ?, ?)`, [
        ME,
        "Ada Lovelace",
        "ada@example.com",
      ]);
      insertItem(db, { id: "pr-1", type: "pr", meta: { state: "open" } });

      const events: Array<{ method: string; params: unknown }> = [];
      const { sessionId } = await emitStandupBrief({
        db,
        sessionId: "s-42",
        lookbackMs: DAY,
        runGit: gitEmail("ada@example.com"),
        notify: (method, params) => events.push({ method, params }),
      });
      expect(sessionId).toBe("s-42");

      // `emitBriefWithSynthesis` does its work without being awaited by the caller, so the
      // notification lands on a later tick. Awaiting a microtask drain rather than a timer keeps
      // this off the wall clock, which CI runs 13-18x slower.
      for (let i = 0; i < 50 && events.length === 0; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));

      const params = briefReadyPayload(events);
      expect(params.brief).toContain("# Standup");
      expect(params.findings.identity.personId).toBe(ME);
      expect(params.findings.identity.source).toBe("git");
      expect(params.findings.identity.displayName).toBe("Ada Lovelace");
    } finally {
      db.close();
    }
  });

  test("the override short-circuits git entirely and is used verbatim", async () => {
    const db = emptyDb();
    try {
      let gitCalled = false;
      const events: Array<{ method: string; params: unknown }> = [];
      await emitStandupBrief({
        db,
        sessionId: "s-7",
        lookbackMs: DAY,
        // Names no `person` row on purpose: `self-person.ts` short-circuits on the override
        // before either lookup, so a brief IS produced and its own gap note explains the
        // emptiness. Refusing here instead would make a typo in nimbus.toml indistinguishable
        // from having no identity at all.
        mePersonIdOverride: "person-typo",
        runGit: async () => {
          gitCalled = true;
          return "ada@example.com";
        },
        notify: (method, params) => events.push({ method, params }),
      });
      for (let i = 0; i < 50 && events.length === 0; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));

      expect(gitCalled).toBe(false);
      const { findings } = briefReadyPayload(events);
      expect(findings.identity.personId).toBe("person-typo");
      expect(findings.identity.source).toBe("override");
      expect(findings.identity.displayName).toBeNull();
    } finally {
      db.close();
    }
  });

  test("falls back to the OS username when git resolves nothing", async () => {
    const db = emptyDb();
    try {
      db.run(`INSERT INTO person (id, display_name, github_login) VALUES (?, ?, ?)`, [
        ME,
        "Ada Lovelace",
        "ada",
      ]);
      const events: Array<{ method: string; params: unknown }> = [];
      await emitStandupBrief({
        db,
        sessionId: "s-9",
        lookbackMs: DAY,
        runGit: gitEmail(null),
        osUsername: "ada",
        notify: (method, params) => events.push({ method, params }),
      });
      for (let i = 0; i < 50 && events.length === 0; i++) await Promise.resolve();
      await new Promise((r) => setTimeout(r, 0));

      const { findings } = briefReadyPayload(events);
      expect(findings.identity.personId).toBe(ME);
      expect(findings.identity.source).toBe("os");
    } finally {
      db.close();
    }
  });
});
