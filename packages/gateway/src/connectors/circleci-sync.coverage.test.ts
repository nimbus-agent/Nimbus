/**
 * CircleCI paths `test/unit/connectors/circleci-sync.test.ts` does not reach: a cursor whose
 * per-project counters are not numbers, a pipeline with no branch/tag/revision, a repo name whose
 * owner is blank (no app URL can be built), and a pipeline list that is JSON but not an object.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import type { SyncContext } from "../sync/types.ts";
import { createCircleciSyncable } from "./circleci-sync.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const CURSOR_PREFIX = "nimbus-cci1:";
const ENSURE = { ensureCircleciMcpRunning: async (): Promise<void> => {} };
const PIPELINES_RE = /^https:\/\/circleci\.com\/api\/v2\/project\/.+\/pipeline$/;

let mock: StubFetch;

beforeEach(() => {
  mock = new StubFetch();
  mock.install();
});

afterEach(() => {
  mock.restore();
});

function ctxFor(db: Database, repos: readonly string[]): SyncContext {
  return {
    ...syncTestContext(db, createStubVault({ "circleci.api_token": "tok" }), "circleci"),
    listIndexedMetadataValues: () => [...repos],
  };
}

const recentIso = (): string => new Date(Date.now() - 60 * 60 * 1000).toISOString();

function projectsOf(cursor: string | null): Record<string, unknown> {
  const p = decodeNimbusJsonCursorPayload(cursor ?? "", CURSOR_PREFIX) as {
    projects: Record<string, unknown>;
  };
  return p.projects;
}

type CiRow = { external_id: string; url: string | null; metadata: string };

function ciRows(db: Database): CiRow[] {
  return db
    .query(
      "SELECT external_id, url, metadata FROM item WHERE service = 'circleci' ORDER BY external_id",
    )
    .all() as CiRow[];
}

describe("cursor counters", () => {
  test("a non-numeric counter is dropped, so that project is re-read from pipeline 0", async () => {
    mock.respond("GET", PIPELINES_RE, {
      items: [{ number: 5, id: "p5", state: "created", created_at: recentIso(), vcs: {} }],
    });
    const db = createMemoryIndexDb();
    const cursor = encodeNimbusJsonCursor(CURSOR_PREFIX, { projects: { "gh/acme/app": "7" } });

    const r = await createCircleciSyncable(ENSURE).sync(ctxFor(db, ["acme/app"]), cursor);

    // With the string counter honoured as 7, pipeline #5 would have been skipped as already seen.
    expect(r.itemsUpserted).toBe(1);
    expect(projectsOf(r.cursor)).toEqual({ "gh/acme/app": 5 });
    // A pipeline with no branch, tag or revision records each as null.
    const meta = JSON.parse(ciRows(db)[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["branch"]).toBeNull();
    expect(meta["revision"]).toBeNull();
    db.close();
  });
});

describe("pipeline lists and URLs", () => {
  test("a repo whose owner is blank still syncs, but its pipelines carry no app URL", async () => {
    mock.respond("GET", PIPELINES_RE, {
      items: [{ number: 1, state: "success", created_at: recentIso(), vcs: { tag: "v1.0.0" } }],
    });
    const db = createMemoryIndexDb();

    const r = await createCircleciSyncable(ENSURE).sync(ctxFor(db, [" /app"]), null);

    // The blank owner segment is dropped from the API path...
    expect(mock.calls.map((c) => c.url)).toEqual([
      "https://circleci.com/api/v2/project/gh/app/pipeline",
    ]);
    expect(r.itemsUpserted).toBe(1);
    const row = ciRows(db)[0];
    // ...and with only two segments left there is no owner/repo to build the app link from.
    expect(row?.url).toBeNull();
    // A tag stands in for a missing branch.
    expect((JSON.parse(row?.metadata ?? "{}") as { branch: unknown }).branch).toBe("v1.0.0");
    db.close();
  });

  test.each([
    ["an array of pipelines", [{ number: 9 }]],
    // An array has no `items` to read, so only `null` — which throws on a property read — shows
    // the object guard is what keeps a non-object body from reaching the item walk.
    ["null", null],
  ])(
    "a pipeline list that is %s, not an object, indexes nothing and keeps the counter",
    async (_label, body) => {
      mock.respond("GET", PIPELINES_RE, body);
      const db = createMemoryIndexDb();
      const cursor = encodeNimbusJsonCursor(CURSOR_PREFIX, { projects: { "gh/acme/app": 4 } });

      const r = await createCircleciSyncable(ENSURE).sync(ctxFor(db, ["acme/app"]), cursor);

      expect(r.itemsUpserted).toBe(0);
      expect(projectsOf(r.cursor)).toEqual({ "gh/acme/app": 4 });
      db.close();
    },
  );
});
