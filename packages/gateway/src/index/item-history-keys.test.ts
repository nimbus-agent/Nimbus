import { afterEach, describe, expect, test } from "bun:test";

import { gitlabMrMetadata } from "../connectors/_lib/gitlab/events.ts";
import { mapBigeyeIssueToItem } from "../connectors/bigeye-dq-mapping.ts";
import { bitbucketPrMetadata } from "../connectors/bitbucket-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "../connectors/connector-sync-test-helpers.ts";
import { extractPrMetadataForIndex, processEvent } from "../connectors/github-sync.ts";
import { createJiraSyncable } from "../connectors/jira-sync.ts";
import { createLinearSyncable } from "../connectors/linear-sync.ts";
import { mapMonteCarloIncidentToItem } from "../connectors/monte-carlo-dq-mapping.ts";
import { encodeNimbusJsonCursor } from "../connectors/nimbus-json-cursor.ts";
import { syncPagerdutyIncidentItems } from "../connectors/pagerduty-sync.ts";
import { mapSentryIssueToItem } from "../connectors/sentry-issue-mapping.ts";
import {
  HISTORY_VALUE_MAX,
  historyKeysOf,
  ITEM_HISTORY_SPECS,
  normalizeHistoryValue,
  sourceAtFor,
  specFor,
} from "./item-history-keys.ts";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

type Meta = Record<string, unknown>;

function storedMetadata(db: ReturnType<typeof createMemoryIndexDb>, service: string): Meta {
  const row = db.prepare("SELECT metadata FROM item WHERE service = ? LIMIT 1").get(service) as {
    metadata: string;
  };
  return JSON.parse(row.metadata) as Meta;
}

/** A real metadata object from the real writer, keyed by `<service>:<type>`. */
const WRITERS: Record<string, () => Promise<Meta>> = {
  "pagerduty:incident": async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "pagerduty");
    syncPagerdutyIncidentItems(
      ctx,
      [
        {
          id: "P1",
          status: "resolved",
          created_at: "2026-11-11T08:00:00Z",
          updated_at: "2026-11-11T09:00:00Z",
          urgency: "high",
          priority: { name: "P1" },
          service: { id: "SVC" },
          assignments: [],
        },
      ],
      "",
      Date.now(),
      new Map(),
    );
    return storedMetadata(db, "pagerduty");
  },
  "github:pr": async () =>
    extractPrMetadataForIndex("o/r", {
      state: "closed",
      merged: true,
      draft: false,
      number: 1,
      created_at: "2026-11-11T08:00:00Z",
      merged_at: "2026-11-11T09:00:00Z",
    }),
  "gitlab:pr": async () =>
    gitlabMrMetadata(
      {
        pathWithNamespace: "g/p",
        iid: 1,
        actionName: "accepted",
        eventCreatedAt: "2026-11-11T09:00:00Z",
        mr: {
          state: "merged",
          createdAt: "2026-11-11T08:00:00Z",
          mergedAt: "2026-11-11T09:00:00Z",
        },
      },
      null,
    ),
  "bitbucket:pr": async () =>
    bitbucketPrMetadata(
      "w/r",
      { id: 1, state: "MERGED", created_on: "2026-11-11T08:00:00Z" },
      "Dev",
    ),
  "github:issue": async () => {
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({}), "github");
    processEvent(
      ctx,
      {
        type: "IssuesEvent",
        repo: { full_name: "o/r" },
        payload: {
          issue: {
            number: 7,
            state: "open",
            title: "t",
            updated_at: "2026-11-11T08:00:00Z",
            milestone: { title: "m", due_on: "2026-12-01T00:00:00Z" },
          },
        },
      },
      Date.now(),
    );
    return storedMetadata(db, "github");
  },
  "jira:issue": async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          issues: [
            {
              id: "1",
              key: "NIM-1",
              fields: {
                summary: "s",
                updated: "2026-04-01T12:00:00.000+0000",
                created: "2026-03-01T12:00:00.000+0000",
                resolutiondate: "2026-04-01T12:00:00.000+0000",
                duedate: "2026-04-05",
                status: { name: "Done", statusCategory: { key: "done" } },
              },
            },
          ],
          startAt: 0,
          maxResults: 50,
          total: 1,
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    const vault = createStubVault({
      "jira.email": "u@example.com",
      "jira.api_token": "tok",
      "jira.base_url": "https://example.atlassian.net",
    });
    await createJiraSyncable({ ensureJiraMcpRunning: async () => {} }).sync(
      syncTestContext(db, vault, "jira"),
      encodeNimbusJsonCursor("nimbus-jra1:", {
        v: 1,
        floorJql: null,
        snapAt: Date.now(),
        ocAt: Date.now(),
      }),
    );
    return storedMetadata(db, "jira");
  },
  "linear:issue": async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          data: {
            issues: {
              nodes: [
                {
                  id: "uuid-1",
                  identifier: "NIM-1",
                  title: "t",
                  updatedAt: "2026-04-01T12:00:00.000Z",
                  createdAt: "2026-03-01T12:00:00.000Z",
                  completedAt: "2026-04-01T12:00:00.000Z",
                  dueDate: "2026-04-05",
                  state: { name: "Done", type: "completed" },
                  url: "https://linear.example/NIM-1",
                },
              ],
              pageInfo: { hasNextPage: false, endCursor: null },
            },
          },
        }),
        { status: 200 },
      )) as unknown as typeof fetch;
    await createLinearSyncable({ ensureLinearMcpRunning: async () => {} }).sync(
      syncTestContext(db, createStubVault({ "linear.api_key": "k" }), "linear"),
      `nimbus-lnr1:${Buffer.from(
        JSON.stringify({ since: "2026-01-01T00:00:00.000Z", snapAt: Date.now() }),
        "utf8",
      ).toString("base64url")}`,
    );
    return storedMetadata(db, "linear");
  },
  "sentry:error_issue": async () => {
    const m = mapSentryIssueToItem(
      {
        id: "1",
        status: "unresolved",
        level: "error",
        lastSeen: "2026-11-11T09:00:00Z",
        firstSeen: "2026-11-10T09:00:00Z",
        assignedTo: { id: "u1", name: "U" },
      },
      { org: "o", syncedAt: 1 },
    );
    return (m?.metadata ?? {}) as Meta;
  },
  "montecarlo:data_quality_test": async () =>
    (mapMonteCarloIncidentToItem(
      { incidentId: "i", status: "open", severity: "SEV1", firstSeenAt: "2026-11-11T09:00:00Z" },
      { syncedAt: 1 },
    )?.metadata ?? {}) as Meta,
  "bigeye:data_quality_test": async () =>
    (mapBigeyeIssueToItem({ issueId: "i", slaStatus: "ok", anomaly: "a" }, { syncedAt: 1 })
      ?.metadata ?? {}) as Meta,
};

describe("ITEM_HISTORY_SPECS - derived from the real writers", () => {
  test("every spec row has a writer fixture, and nothing else is fixtured", () => {
    const byCodeUnit = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
    expect([...ITEM_HISTORY_SPECS.keys()].sort(byCodeUnit)).toEqual(
      Object.keys(WRITERS).sort(byCodeUnit),
    );
  });

  for (const [id, build] of Object.entries(WRITERS)) {
    test(`${id}: every tracked key and the born key is one the real writer produces`, async () => {
      const spec = ITEM_HISTORY_SPECS.get(id);
      if (spec === undefined) throw new Error(`no spec for ${id}`);
      const meta = await build();
      for (const key of historyKeysOf(spec)) {
        expect(Object.hasOwn(meta, key), `${id} writes no "${key}"`).toBe(true);
      }
      if (spec.born !== null) {
        expect(Object.hasOwn(meta, spec.born.key), `${id} writes no born key`).toBe(true);
      }
      for (const rule of spec.sourceAt) {
        expect(Object.hasOwn(meta, rule.metadataKey), `${id} writes no ${rule.metadataKey}`).toBe(
          true,
        );
      }
    });
  }

  test("keys are closed-shape, unique and frozen", () => {
    for (const [id, s] of ITEM_HISTORY_SPECS) {
      expect(id).toMatch(/^[a-z_]+:[a-z_]+$/);
      const keys = historyKeysOf(s);
      expect(new Set(keys).size).toBe(keys.length);
      expect(Object.isFrozen(s)).toBe(true);
    }
  });
});

describe("specFor", () => {
  test("returns the spec for a tracked pair and undefined otherwise", () => {
    expect(specFor("github", "pr")).toBe(ITEM_HISTORY_SPECS.get("github:pr"));
    expect(specFor("slack", "message")).toBeUndefined();
  });
});

describe("normalizeHistoryValue", () => {
  test("scalars", () => {
    expect(normalizeHistoryValue("open")).toBe("open");
    expect(normalizeHistoryValue(3)).toBe("3");
    expect(normalizeHistoryValue(false)).toBe("false");
    expect(normalizeHistoryValue(null)).toBeNull();
    expect(normalizeHistoryValue(undefined)).toBeUndefined();
  });

  test("arrays are sorted by code unit and joined, so order is not a change", () => {
    expect(normalizeHistoryValue(["b@x", "a@x"])).toBe("a@x,b@x");
    expect(normalizeHistoryValue(["a@x", "b@x"])).toBe("a@x,b@x");
    expect(normalizeHistoryValue([])).toBe("");
    expect(normalizeHistoryValue([2, 10])).toBe("10,2");
    expect(normalizeHistoryValue(["a", "a"])).toBe("a,a");
  });

  test("an array holding a non-scalar is NULL", () => {
    expect(normalizeHistoryValue([{ a: 1 }])).toBeNull();
    expect(normalizeHistoryValue(["a", null])).toBeNull();
  });

  test("objects: id, then name, else NULL; a nested object is NULL", () => {
    expect(normalizeHistoryValue({ id: "u1", name: "U" })).toBe("u1");
    expect(normalizeHistoryValue({ id: 7 })).toBe("7");
    expect(normalizeHistoryValue({ name: "Only" })).toBe("Only");
    expect(normalizeHistoryValue({ other: 1 })).toBeNull();
    expect(normalizeHistoryValue({ id: { x: 1 } })).toBeNull();
  });

  test("a long value is cut at 256 code points, never inside a surrogate pair", () => {
    expect(normalizeHistoryValue("a".repeat(300))).toBe("a".repeat(HISTORY_VALUE_MAX));
    const emoji = "\u{1F600}";
    const cut = normalizeHistoryValue(emoji.repeat(300)) as string;
    expect(Array.from(cut)).toHaveLength(HISTORY_VALUE_MAX);
    expect(cut).toBe(emoji.repeat(HISTORY_VALUE_MAX));
    const mixed = normalizeHistoryValue(`${"a".repeat(255)}${emoji}${emoji}`) as string;
    expect(mixed).toBe(`${"a".repeat(255)}${emoji}`);
    expect(normalizeHistoryValue({ name: "n".repeat(300) })).toBe("n".repeat(HISTORY_VALUE_MAX));
  });

  test("a function is NULL", () => {
    expect(normalizeHistoryValue(() => 1)).toBeNull();
  });
});

describe("sourceAtFor", () => {
  test("merged_at only for a merged transition", () => {
    const pr = specFor("github", "pr");
    if (pr === undefined) throw new Error("no spec");
    expect(sourceAtFor(pr, "state", "merged", { merged_at: 99 })).toBe(99);
    expect(sourceAtFor(pr, "merged", "true", { merged_at: 99 })).toBe(99);
    expect(sourceAtFor(pr, "state", "closed", { merged_at: 99 })).toBeNull();
    expect(sourceAtFor(pr, "draft", "true", { merged_at: 99 })).toBeNull();
    expect(sourceAtFor(pr, "state", "merged", {})).toBeNull();
    expect(sourceAtFor(pr, "state", "merged", { merged_at: "x" })).toBeNull();
    expect(sourceAtFor(pr, "state", null, { merged_at: 99 })).toBeNull();
  });
});
