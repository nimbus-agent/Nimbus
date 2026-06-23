import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { transitionHealth } from "../connectors/health.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { RankedIndexItem } from "../index/ranked-item.ts";

import {
  buildSearchLocalIndexHealthExtras,
  collectConnectorHealthCaveatsForServices,
  formatConnectorHealthCaveatForIndexSearch,
} from "./connector-health-caveat.ts";

function seedSyncState(db: Database, connectorId: string): void {
  db.run(
    `INSERT OR IGNORE INTO sync_state (connector_id, last_sync_at, next_sync_token) VALUES (?, NULL, NULL)`,
    [connectorId],
  );
}

function seedPausedGithubUnauthSlack(db: Database): void {
  for (const id of ["github", "slack"]) {
    seedSyncState(db, id);
  }
  transitionHealth(db, "github", { type: "paused" });
  transitionHealth(db, "slack", { type: "unauthenticated" });
}

function stubRankedItem(service: string): RankedIndexItem {
  return {
    id: `${service}:1`,
    service,
    itemType: "file",
    name: "n",
    modifiedAt: 1,
    score: 1,
    indexPrimaryKey: `${service}:1`,
    indexedType: "file",
  };
}

describe("formatConnectorHealthCaveatForIndexSearch", () => {
  test("returns undefined when healthy", () => {
    expect(
      formatConnectorHealthCaveatForIndexSearch("github", {
        connectorId: "github",
        state: "healthy",
        backoffAttempt: 0,
      }),
    ).toBeUndefined();
  });

  test("includes degraded state and last sync", () => {
    const t = new Date("2026-01-02T12:00:00.000Z");
    const s = formatConnectorHealthCaveatForIndexSearch("github", {
      connectorId: "github",
      state: "degraded",
      backoffAttempt: 1,
      lastSuccessfulSync: t,
      lastError: "timeout",
    });
    expect(s).toContain("github");
    expect(s).toContain("degraded");
    expect(s).toContain("2026-01-02T12:00:00.000Z");
    expect(s).toContain("timeout");
  });

  test("rate_limited includes retry after", () => {
    const ra = new Date("2026-01-03T15:00:00.000Z");
    const s = formatConnectorHealthCaveatForIndexSearch("slack", {
      connectorId: "slack",
      state: "rate_limited",
      backoffAttempt: 0,
      retryAfter: ra,
    });
    expect(s).toContain("rate limited");
    expect(s).toContain("2026-01-03T15:00:00.000Z");
  });

  test("paused mentions resume", () => {
    const s = formatConnectorHealthCaveatForIndexSearch("gitlab", {
      connectorId: "gitlab",
      state: "paused",
      backoffAttempt: 0,
    });
    expect(s).toContain("paused");
    expect(s).toContain("nimbus connector resume");
  });
});

describe("collectConnectorHealthCaveatsForServices", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedPausedGithubUnauthSlack(db);
  });

  afterEach(() => {
    db.close();
  });

  test("preserves caller order and respects max", () => {
    const caveats = collectConnectorHealthCaveatsForServices(db, ["slack", "github"], 1);
    expect(caveats).toHaveLength(1);
    expect(caveats[0]).toContain("slack");
  });

  test("dedupes duplicate service ids", () => {
    const caveats = collectConnectorHealthCaveatsForServices(
      db,
      ["github", "github", " slack "],
      5,
    );
    expect(caveats).toHaveLength(2);
  });
});

describe("buildSearchLocalIndexHealthExtras", () => {
  let db: Database;

  beforeEach(() => {
    db = new Database(":memory:");
    LocalIndex.ensureSchema(db);
    seedPausedGithubUnauthSlack(db);
  });

  afterEach(() => {
    db.close();
  });

  test("scoped filter returns single connectorHealthCaveat", () => {
    const extras = buildSearchLocalIndexHealthExtras(
      db,
      {
        items: [stubRankedItem("github")],
        sourceSummary: [],
        totalMatches: 1,
      },
      "github",
    );
    expect(extras.connectorHealthCaveat).toContain("github");
    expect(extras.connectorHealthCaveat).toContain("paused");
    expect(extras.connectorHealthCaveats).toBeUndefined();
  });

  test("unscoped search unions items and sourceSummary (sorted caveats)", () => {
    const extras = buildSearchLocalIndexHealthExtras(
      db,
      {
        items: [stubRankedItem("slack")],
        sourceSummary: [
          {
            service: "github",
            type: "pr",
            count: 2,
            oldestModifiedAt: 1,
            newestModifiedAt: 2,
          },
        ],
        totalMatches: 3,
      },
      undefined,
    );
    expect(extras.connectorHealthCaveat).toBeUndefined();
    expect(extras.connectorHealthCaveats).toBeDefined();
    expect(extras.connectorHealthCaveats).toHaveLength(2);
    expect(extras.connectorHealthCaveats?.[0]).toContain("github");
    expect(extras.connectorHealthCaveats?.[1]).toContain("slack");
  });

  test("returns empty object when all connectors healthy", () => {
    const fresh = new Database(":memory:");
    LocalIndex.ensureSchema(fresh);
    seedSyncState(fresh, "github");
    transitionHealth(fresh, "github", { type: "sync_success" });
    try {
      const extras = buildSearchLocalIndexHealthExtras(
        fresh,
        {
          items: [stubRankedItem("github")],
          sourceSummary: [],
          totalMatches: 1,
        },
        undefined,
      );
      expect(extras).toEqual({});
    } finally {
      fresh.close();
    }
  });

  test("empty filteredService string uses multi-service path", () => {
    const extras = buildSearchLocalIndexHealthExtras(
      db,
      {
        items: [stubRankedItem("github")],
        sourceSummary: [],
        totalMatches: 1,
      },
      "",
    );
    expect(extras.connectorHealthCaveats).toHaveLength(1);
    expect(extras.connectorHealthCaveat).toBeUndefined();
  });
});
