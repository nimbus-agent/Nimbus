import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  DEFAULT_MAX_BACKOFF_ATTEMPTS,
  getConnectorHealth,
  getConnectorHealthHistory,
  type HealthHistoryRow,
  pruneConnectorHealthHistory,
  transitionHealth,
} from "../../../src/connectors/health.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";

let db: Database;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  db.run(
    `INSERT OR IGNORE INTO sync_state (connector_id, last_sync_at, next_sync_token)
     VALUES ('github', NULL, NULL)`,
  );
});

afterEach(() => {
  db.close();
});

describe("transitionHealth — basic transitions", () => {
  test("sync_success sets state to healthy and clears error fields", () => {
    transitionHealth(db, "github", { type: "transient_error", error: "timeout", attempt: 1 });
    const snap = transitionHealth(db, "github", { type: "sync_success" });

    expect(snap.state).toBe("healthy");
    expect(snap.backoffAttempt).toBe(0);
    expect(snap.lastError).toBeUndefined();
    expect(snap.backoffUntil).toBeUndefined();
  });

  test("rate_limited sets state and persists retryAfter", () => {
    const retryAfter = new Date(Date.now() + 60_000);
    const snap = transitionHealth(db, "github", { type: "rate_limited", retryAfter });

    expect(snap.state).toBe("rate_limited");
    expect(snap.retryAfter).toBeDefined();
    expect(snap.retryAfter?.getTime()).toBeCloseTo(retryAfter.getTime(), -2);
  });

  test("unauthenticated sets state and records error", () => {
    const snap = transitionHealth(db, "github", { type: "unauthenticated" });

    expect(snap.state).toBe("unauthenticated");
    expect(snap.lastError).toContain("401");
  });

  test("transient_error below max → degraded", () => {
    const snap = transitionHealth(db, "github", {
      type: "transient_error",
      error: "ETIMEDOUT",
      attempt: 1,
    });

    expect(snap.state).toBe("degraded");
    expect(snap.backoffAttempt).toBe(1);
    expect(snap.lastError).toBe("ETIMEDOUT");
    expect(snap.backoffUntil).toBeDefined();
  });

  test("transient_error at maxAttempts → error", () => {
    const snap = transitionHealth(
      db,
      "github",
      {
        type: "transient_error",
        error: "persistent timeout",
        attempt: DEFAULT_MAX_BACKOFF_ATTEMPTS,
      },
      DEFAULT_MAX_BACKOFF_ATTEMPTS,
    );

    expect(snap.state).toBe("error");
  });

  test("persistent_error → error", () => {
    const snap = transitionHealth(db, "github", {
      type: "persistent_error",
      error: "SSL certificate expired",
    });

    expect(snap.state).toBe("error");
    expect(snap.lastError).toBe("SSL certificate expired");
  });

  test("paused → paused", () => {
    const snap = transitionHealth(db, "github", { type: "paused" });
    expect(snap.state).toBe("paused");
  });

  test("resumed after paused → healthy", () => {
    transitionHealth(db, "github", { type: "paused" });
    const snap = transitionHealth(db, "github", { type: "resumed" });
    expect(snap.state).toBe("healthy");
    expect(snap.backoffAttempt).toBe(0);
  });

  test("reauthenticated clears unauthenticated and the stale auth error", () => {
    transitionHealth(db, "github", { type: "unauthenticated" });
    expect(getConnectorHealth(db, "github").state).toBe("unauthenticated");

    const snap = transitionHealth(db, "github", { type: "reauthenticated" });

    expect(snap.state).toBe("healthy");
    // The unauthenticated transition writes a hardcoded lastError (health.ts:196);
    // leaving it behind would show a stale "token expired" next to a healthy state.
    expect(getConnectorHealth(db, "github").lastError).toBeUndefined();
  });

  test("reauthenticated records its own history reason, not 'connector resumed'", () => {
    transitionHealth(db, "github", { type: "unauthenticated" });
    transitionHealth(db, "github", { type: "reauthenticated" });

    const [latest] = getConnectorHealthHistory(db, "github", 1);
    expect(latest?.toState).toBe("healthy");
    expect(latest?.reason).toBe("credential re-verified");
  });
});

describe("LocalIndex.markConnectorReauthenticated — guarded transition", () => {
  test("from unauthenticated → becomes healthy", () => {
    const idx = new LocalIndex(db);
    transitionHealth(db, "github", { type: "unauthenticated" });
    expect(getConnectorHealth(db, "github").state).toBe("unauthenticated");

    idx.markConnectorReauthenticated("github");

    expect(getConnectorHealth(db, "github").state).toBe("healthy");
  });

  test("from paused → stays paused", () => {
    const idx = new LocalIndex(db);
    transitionHealth(db, "github", { type: "paused" });
    expect(getConnectorHealth(db, "github").state).toBe("paused");

    idx.markConnectorReauthenticated("github");

    expect(getConnectorHealth(db, "github").state).toBe("paused");
  });

  test("from rate_limited → stays rate_limited and retryAfter is unchanged", () => {
    const idx = new LocalIndex(db);
    const retryAfter = new Date(Date.now() + 60_000);
    transitionHealth(db, "github", { type: "rate_limited", retryAfter });
    const before = getConnectorHealth(db, "github");
    expect(before.state).toBe("rate_limited");

    idx.markConnectorReauthenticated("github");

    const after = getConnectorHealth(db, "github");
    expect(after.state).toBe("rate_limited");
    expect(after.retryAfter?.getTime()).toBe(before.retryAfter?.getTime());
  });
});

describe("transitionHealth — skipped_offline", () => {
  test("does not change health_state", () => {
    transitionHealth(db, "github", {
      type: "rate_limited",
      retryAfter: new Date(Date.now() + 60_000),
    });
    const before = getConnectorHealth(db, "github");

    transitionHealth(db, "github", { type: "skipped_offline" });
    const after = getConnectorHealth(db, "github");

    expect(after.state).toBe(before.state);
    expect(after.retryAfter?.getTime()).toBe(before.retryAfter?.getTime());
  });

  test("still appends a history row for offline skip", () => {
    transitionHealth(db, "github", { type: "skipped_offline" });
    const history = getConnectorHealthHistory(db, "github");
    expect(history.length).toBeGreaterThanOrEqual(1);
    expect(history[0]?.reason).toContain("offline");
  });
});

describe("getConnectorHealth", () => {
  test("returns not_configured for a connector that was never observed", () => {
    // Was `healthy`, which is the F6 defect stated as a test: with no `sync_state` row nothing
    // has ever been observed about this connector, and calling that healthy is an assertion the
    // index cannot support. A fresh install claimed ~90 healthy connectors this way.
    const snap = getConnectorHealth(db, "unknown-connector");
    expect(snap.state).toBe("not_configured");
    expect(snap.backoffAttempt).toBe(0);
  });
});

describe("history", () => {
  test("appends one row per transition", () => {
    transitionHealth(db, "github", { type: "transient_error", error: "err", attempt: 1 });
    transitionHealth(db, "github", { type: "sync_success" });

    const history = getConnectorHealthHistory(db, "github");
    expect(history).toHaveLength(2);
  });

  test("returns rows most-recent-first", () => {
    transitionHealth(db, "github", { type: "transient_error", error: "err", attempt: 1 });
    transitionHealth(db, "github", { type: "sync_success" });

    const history = getConnectorHealthHistory(db, "github");
    expect(history[0]?.toState).toBe("healthy");
    expect(history[1]?.toState).toBe("degraded");
  });

  test("limits rows by limit param", () => {
    for (let i = 1; i <= 5; i++) {
      transitionHealth(db, "github", {
        type: "transient_error",
        error: `err ${String(i)}`,
        attempt: i,
      });
    }
    const history = getConnectorHealthHistory(db, "github", 2);
    expect(history).toHaveLength(2);
  });
});

describe("pruneConnectorHealthHistory", () => {
  test("removes rows older than maxAgeDays", () => {
    const oldMs = Date.now() - 10 * 24 * 60 * 60 * 1000;
    db.run(
      `INSERT INTO connector_health_history (connector_id, from_state, to_state, reason, occurred_at)
       VALUES ('github', 'healthy', 'degraded', 'old', ?)`,
      [oldMs],
    );
    transitionHealth(db, "github", { type: "sync_success" });

    const removed = pruneConnectorHealthHistory(db, 7);
    expect(removed).toBe(1);

    const remaining = getConnectorHealthHistory(db, "github");
    expect(
      remaining.every(
        (r: HealthHistoryRow) => r.occurredAt.getTime() >= Date.now() - 8 * 24 * 60 * 60 * 1000,
      ),
    ).toBe(true);
  });
});

describe("last_error truncation", () => {
  test("truncates errors longer than 512 chars", () => {
    const longError = "x".repeat(600);
    const snap = transitionHealth(db, "github", {
      type: "persistent_error",
      error: longError,
    });
    expect(snap.lastError?.length).toBeLessThanOrEqual(512);
    expect(snap.lastError?.endsWith("...")).toBe(true);
  });
});
