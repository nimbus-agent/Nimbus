/**
 * Figma paths the existing suites do not reach: an access token that resolves to "", a project
 * with no `name` at all, and the per-cycle `MAX_FILES` (2000) budget running out — mid-project,
 * and then before the next project is even requested.
 *
 * The budget test records upserts through the context's own `upsertItem` capability instead of
 * writing 2000 rows to SQLite: the cap is the connector's logic, not the store's.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createFigmaSyncable } from "./figma-sync.ts";

const PROJECTS_URL = "https://api.figma.com/v1/teams/TEAM9/projects";
const FILES_RE = /^https:\/\/api\.figma\.com\/v1\/projects\/([^/]+)\/files$/;
/** Mirrors `MAX_FILES` in figma-sync.ts. */
const MAX_FILES = 2000;

let fetchStub: StubFetch;
let db: Database;

beforeEach(() => {
  fetchStub = new StubFetch();
  fetchStub.install();
  db = createMemoryIndexDb();
});

afterEach(() => {
  fetchStub.restore();
  db.close();
});

function ctx(token = "figma-token"): SyncContext {
  return {
    ...syncTestContext(
      db,
      createStubVault({ "figma.oauth": "stored-oauth-blob", "figma.team_id": " TEAM9 " }),
      "figma",
    ),
    accessToken: () => Promise.resolve(token),
  };
}

function sync(c: SyncContext, cursor: string | null = null) {
  return createFigmaSyncable({ ensureFigmaMcpRunning: async () => {} }).sync(c, cursor);
}

function filesRequestedFor(): string[] {
  return fetchStub.calls
    .map((c) => FILES_RE.exec(c.url)?.[1])
    .filter((p): p is string => p !== undefined);
}

describe("figma-sync — empty access token", () => {
  test("a token that resolves to the empty string is a no-op: no request, cursor kept", async () => {
    const res = await sync(ctx(""), "prev-figma-cursor");

    expect(res.cursor).toBe("prev-figma-cursor");
    expect(res.itemsUpserted).toBe(0);
    expect(fetchStub.calls).toHaveLength(0);
  });
});

describe("figma-sync — projects without a name", () => {
  test("files of a nameless project are indexed with a null project_name", async () => {
    fetchStub.respond("GET", PROJECTS_URL, { projects: [{ id: "p-nameless" }] });
    fetchStub.respond("GET", FILES_RE, {
      files: [{ key: "FILEKEY1", name: "Wireframes", last_modified: "2026-04-01T12:00:00.000Z" }],
    });

    const res = await sync(ctx());

    expect(res.itemsUpserted).toBe(1);
    const row = db
      .query("SELECT body_preview, metadata FROM item WHERE service = 'figma'")
      .get() as { body_preview: string; metadata: string };
    expect(row.body_preview).toBe("Wireframes");
    expect((JSON.parse(row.metadata) as Record<string, unknown>)["project_name"]).toBeNull();
  });
});

describe("figma-sync — MAX_FILES budget", () => {
  test("stops mid-project at the cap and never requests the next project's files", async () => {
    fetchStub.respond("GET", PROJECTS_URL, {
      projects: [
        { id: "p-big", name: "Big" },
        { id: "p-late", name: "Late" },
      ],
    });
    fetchStub.respond("GET", /\/projects\/p-big\/files$/, {
      files: Array.from({ length: MAX_FILES + 1 }, (_, i) => ({
        key: `K${String(i).padStart(4, "0")}`,
        name: `File ${String(i)}`,
      })),
    });
    fetchStub.respond("GET", /\/projects\/p-late\/files$/, { files: [{ key: "LATE", name: "x" }] });

    const written: string[] = [];
    const recording: SyncContext = {
      ...ctx(),
      upsertItem: (row) => {
        written.push(row.externalId);
      },
    };

    const res = await sync(recording);

    expect(res.itemsUpserted).toBe(MAX_FILES);
    expect(written).toHaveLength(MAX_FILES);
    expect(written.at(-1)).toBe("K1999");
    expect(written).not.toContain("K2000");
    expect(filesRequestedFor()).toEqual(["p-big"]);
  });
});
