import { describe, expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  type SyncTestFetchParams,
  syncTestContext,
  urlFromFetchInput,
} from "../../connector-sync-test-helpers.ts";
import { syncGitlabPipelinesForIndexedProjects } from "./pipelines.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const API_BASE = "https://gitlab.example.com/api/v4";
const WEB_ORIGIN = "https://gitlab.example.com";
const PAT = "glpat-test";

/**
 * Seed a gitlab item row directly into the DB so that
 * listGitlabProjectsFromIndex can discover it.
 */
function seedGitlabProject(
  db: ReturnType<typeof createMemoryIndexDb>,
  project: string,
  externalId = `${project}#mr-1`,
): void {
  const now = Date.now();
  db.run(
    `INSERT OR REPLACE INTO item
       (id, service, type, external_id, title, body_preview, url, canonical_url,
        modified_at, author_id, metadata, synced_at, pinned)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      `gitlab:${externalId}`,
      "gitlab",
      "mr",
      externalId,
      "title",
      "",
      null,
      null,
      now,
      null,
      JSON.stringify({ project }),
      now,
      0,
    ],
  );
}

/** Build a minimal pipeline object */
function makePipeline(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const nowIso = new Date(Date.now() - 1000).toISOString();
  return {
    id: 1001,
    status: "success",
    ref: "main",
    sha: "abc123",
    web_url: `${WEB_ORIGIN}/group/proj/-/pipelines/1001`,
    created_at: nowIso,
    duration: 42,
    ...overrides,
  };
}

function makePipelineResponse(pipelines: unknown[]): Response {
  return new Response(JSON.stringify(pipelines), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

// ---------------------------------------------------------------------------
// describeWithFetchRestore suites
// ---------------------------------------------------------------------------

describeWithFetchRestore("syncGitlabPipelinesForIndexedProjects — no projects", () => {
  test("returns empty result when no gitlab projects in index", async () => {
    const db = createMemoryIndexDb();
    const vault = createStubVault({});
    const ctx = syncTestContext(db, vault, "gitlab");

    // fetch should never be called
    globalThis.fetch = (() => {
      throw new Error("fetch should not be called when no projects");
    }) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(0);
    expect(result.bytes).toBe(0);
    expect(result.pipelines).toEqual({});
  });
});

describeWithFetchRestore("syncGitlabPipelinesForIndexedProjects — happy path", () => {
  test("upserts pipelines and updates cursor", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("/projects/group%2Fproj/pipelines");
      return makePipelineResponse([makePipeline({ id: 2001 })]);
    }) as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(1);
    expect(result.bytes).toBeGreaterThan(0);
    expect(result.pipelines["group/proj"]).toBe(2001);
    expectServiceItemCount(db, "gitlab", 2); // 1 seeded MR + 1 pipeline
  });

  test("respects existing pipeline cursor — skips pipelines with id <= lastSeen", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (() =>
      Promise.resolve(
        makePipelineResponse([makePipeline({ id: 500 })]),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      { "group/proj": 500 }, // lastSeen = 500 → id 500 <= 500 → break
      0,
    );

    expect(result.upserted).toBe(0);
    expect(result.pipelines["group/proj"]).toBe(500);
  });

  test("cursor defaults to 0 for projects not in pipelineCursor (??0 branch)", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/new-proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (() =>
      Promise.resolve(
        makePipelineResponse([makePipeline({ id: 300 })]),
      )) as unknown as typeof fetch;

    // pass an empty cursor — group/new-proj is absent → next["group/new-proj"] ?? 0
    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {}, // no entry for group/new-proj
      0,
    );

    expect(result.upserted).toBe(1);
    expect(result.pipelines["group/new-proj"]).toBe(300);
  });
});

describeWithFetchRestore("syncGitlabPipelinesForIndexedProjects — MAX project cap", () => {
  test("processes at most 15 projects (MAX_PIPELINE_PROJECTS_PER_SYNC)", async () => {
    const db = createMemoryIndexDb();
    // Seed 17 distinct projects
    for (let i = 1; i <= 17; i++) {
      seedGitlabProject(db, `group/p${i}`, `group/p${i}#mr-1`);
    }
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    let fetchCount = 0;
    globalThis.fetch = (() => {
      fetchCount += 1;
      return Promise.resolve(makePipelineResponse([]));
    }) as unknown as typeof fetch;

    await syncGitlabPipelinesForIndexedProjects(ctx, PAT, API_BASE, WEB_ORIGIN, {}, 0);

    // Should have made exactly 15 fetch calls, not 17
    expect(fetchCount).toBe(15);
  });
});

describeWithFetchRestore("syncGitlabPipelinesForIndexedProjects — HTTP error paths", () => {
  test("handles 429 rate-limit without retry-after header — uses 60s default", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (() =>
      Promise.resolve(new Response("", { status: 429 }))) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(0);
    expect(result.pipelines["group/proj"]).toBe(0);
  });

  test("handles 429 rate-limit with numeric retry-after header", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("", {
          status: 429,
          headers: { "retry-after": "30" },
        }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(0);
  });

  test("handles non-200/non-429 HTTP error status", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (() =>
      Promise.resolve(new Response("Not Found", { status: 404 }))) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(0);
    expect(result.pipelines["group/proj"]).toBe(0);
  });

  test("handles non-JSON response body gracefully (JSON parse failure)", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (() =>
      Promise.resolve(new Response("not-json!!!", { status: 200 }))) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(0);
  });

  test("handles non-array JSON response (object instead of array)", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "not an array" }), { status: 200 }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(0);
  });
});

describeWithFetchRestore("tryUpsertGitlabPipelineItem — item shape branches", () => {
  test("skips null / non-object item (asRecord returns undefined)", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    // null element in the array
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([null, "string-not-obj", 42]), { status: 200 }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(0);
  });

  test("skips item with no numeric id field", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([{ status: "success" }]), { status: 200 }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(0);
  });

  test("skips pipeline older than floorMs (createdMs < floorMs)", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    // created 2 days ago; floor is 1 day ago → should be skipped
    const oldCreatedAt = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000).toISOString();
    const floorMs = Date.now() - 1 * 24 * 60 * 60 * 1000;

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([makePipeline({ id: 9001, created_at: oldCreatedAt })]), {
          status: 200,
        }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      floorMs,
    );

    expect(result.upserted).toBe(0);
  });

  test("uses now as modifiedAt when created_at is missing (NaN branch)", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    // No created_at field → createdRaw === undefined → createdMs = NaN
    // → not finite → modifiedAt = now
    const pipeline = { id: 7777, status: "running", ref: "develop", sha: "aaa" };

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([pipeline]), { status: 200 }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(1);
    const row = db
      .prepare("SELECT modified_at FROM item WHERE service = 'gitlab' AND type = 'ci_run' LIMIT 1")
      .get() as { modified_at: number } | undefined;
    expect(row?.modified_at).toBeGreaterThan(0);
  });

  test("title uses Pipeline #id when ref is absent", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const pipeline = {
      id: 8888,
      status: "failed",
      created_at: new Date(Date.now() - 1000).toISOString(),
    };

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([pipeline]), { status: 200 }),
      )) as unknown as typeof fetch;

    await syncGitlabPipelinesForIndexedProjects(ctx, PAT, API_BASE, WEB_ORIGIN, {}, 0);

    const row = db
      .prepare("SELECT title FROM item WHERE service = 'gitlab' AND type = 'ci_run' LIMIT 1")
      .get() as { title: string } | undefined;
    expect(row?.title).toContain("Pipeline #8888");
    expect(row?.title).toContain("failed");
  });

  test("title uses Pipeline on <ref> when ref is present", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const pipeline = {
      id: 9999,
      ref: "feature/my-branch",
      created_at: new Date(Date.now() - 1000).toISOString(),
    };

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([pipeline]), { status: 200 }),
      )) as unknown as typeof fetch;

    await syncGitlabPipelinesForIndexedProjects(ctx, PAT, API_BASE, WEB_ORIGIN, {}, 0);

    const row = db
      .prepare("SELECT title FROM item WHERE service = 'gitlab' AND type = 'ci_run' LIMIT 1")
      .get() as { title: string } | undefined;
    expect(row?.title).toContain("Pipeline on feature/my-branch");
    // No status → just titleBase (no "— status" suffix)
    expect(row?.title).not.toContain("—");
  });

  test("title omits status suffix when status is empty string", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const pipeline = {
      id: 1234,
      ref: "main",
      status: "",
      created_at: new Date(Date.now() - 1000).toISOString(),
    };

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([pipeline]), { status: 200 }),
      )) as unknown as typeof fetch;

    await syncGitlabPipelinesForIndexedProjects(ctx, PAT, API_BASE, WEB_ORIGIN, {}, 0);

    const row = db
      .prepare("SELECT title FROM item WHERE service = 'gitlab' AND type = 'ci_run' LIMIT 1")
      .get() as { title: string } | undefined;
    expect(row?.title).toBe("Pipeline on main");
  });

  test("canonicalUrl falls back to webOrigin+path when web_url absent", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const pipeline = {
      id: 4321,
      ref: "main",
      status: "success",
      created_at: new Date(Date.now() - 1000).toISOString(),
      // no web_url field
    };

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([pipeline]), { status: 200 }),
      )) as unknown as typeof fetch;

    await syncGitlabPipelinesForIndexedProjects(ctx, PAT, API_BASE, WEB_ORIGIN, {}, 0);

    const row = db
      .prepare(
        "SELECT canonical_url, url FROM item WHERE service = 'gitlab' AND type = 'ci_run' LIMIT 1",
      )
      .get() as { canonical_url: string; url: string | null } | undefined;
    expect(row?.canonical_url).toContain(`${WEB_ORIGIN}/group/proj/-/pipelines/4321`);
    expect(row?.url).toBeNull(); // url column is null when web_url absent
  });

  test("truncates title exceeding 512 characters", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const longRef = "a".repeat(600);
    const pipeline = {
      id: 5555,
      ref: longRef,
      status: "pending",
      created_at: new Date(Date.now() - 1000).toISOString(),
    };

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify([pipeline]), { status: 200 }),
      )) as unknown as typeof fetch;

    await syncGitlabPipelinesForIndexedProjects(ctx, PAT, API_BASE, WEB_ORIGIN, {}, 0);

    const row = db
      .prepare("SELECT title FROM item WHERE service = 'gitlab' AND type = 'ci_run' LIMIT 1")
      .get() as { title: string } | undefined;
    expect(row?.title?.length).toBeLessThanOrEqual(512);
  });

  test("multiple pipelines: accumulates upserted count and picks highest id as maxId", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const now = Date.now();
    const pipelines = [
      makePipeline({ id: 300, created_at: new Date(now - 3000).toISOString() }),
      makePipeline({ id: 200, created_at: new Date(now - 2000).toISOString() }),
      makePipeline({ id: 100, created_at: new Date(now - 1000).toISOString() }),
    ];

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(pipelines), { status: 200 }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.upserted).toBe(3);
    expect(result.pipelines["group/proj"]).toBe(300);
    // 1 seeded row + 3 pipelines
    expectServiceItemCount(db, "gitlab", 4);
  });

  test("break stops processing further items when id <= lastSeen", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const now = Date.now();
    const pipelines = [
      makePipeline({ id: 500, created_at: new Date(now - 5000).toISOString() }),
      // id=500 is > lastSeen=400 → upserted
      makePipeline({ id: 399, created_at: new Date(now - 3000).toISOString() }),
      // id=399 <= lastSeen=400 → break; item below should NOT be processed
      makePipeline({ id: 100, created_at: new Date(now - 1000).toISOString() }),
    ];

    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(JSON.stringify(pipelines), { status: 200 }),
      )) as unknown as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      { "group/proj": 400 },
      0,
    );

    expect(result.upserted).toBe(1);
    expect(result.pipelines["group/proj"]).toBe(500);
  });
});

describeWithFetchRestore("listGitlabProjectsFromIndex — project deduplication", () => {
  test("deduplicates projects with the same path", async () => {
    const db = createMemoryIndexDb();
    // Insert two rows with the same project path
    seedGitlabProject(db, "group/dup", "group/dup#mr-1");
    seedGitlabProject(db, "group/dup", "group/dup#mr-2");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    let fetchCount = 0;
    globalThis.fetch = (() => {
      fetchCount += 1;
      return Promise.resolve(makePipelineResponse([]));
    }) as unknown as typeof fetch;

    await syncGitlabPipelinesForIndexedProjects(ctx, PAT, API_BASE, WEB_ORIGIN, {}, 0);

    // Duplicate project → only 1 fetch call
    expect(fetchCount).toBe(1);
  });

  test("ignores rows where project metadata is null or empty", async () => {
    const db = createMemoryIndexDb();
    const now = Date.now();
    // Row with null project
    db.run(
      `INSERT OR REPLACE INTO item
         (id, service, type, external_id, title, body_preview, url, canonical_url,
          modified_at, author_id, metadata, synced_at, pinned)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        "gitlab:nullproj#mr-1",
        "gitlab",
        "mr",
        "nullproj#mr-1",
        "title",
        "",
        null,
        null,
        now,
        null,
        JSON.stringify({ project: null }),
        now,
        0,
      ],
    );
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    let fetchCount = 0;
    globalThis.fetch = (() => {
      fetchCount += 1;
      return Promise.resolve(makePipelineResponse([]));
    }) as unknown as typeof fetch;

    await syncGitlabPipelinesForIndexedProjects(ctx, PAT, API_BASE, WEB_ORIGIN, {}, 0);

    // null project → SQL WHERE filters it → no fetches
    expect(fetchCount).toBe(0);
  });
});

describeWithFetchRestore("multiple projects — bytes accumulate", () => {
  test("accumulates bytes across multiple project syncs", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/a", "group/a#mr-1");
    seedGitlabProject(db, "group/b", "group/b#mr-1");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      const u = urlFromFetchInput(input);
      if (u.includes("group%2Fa")) {
        return new Response(JSON.stringify([makePipeline({ id: 10 })]), { status: 200 });
      }
      return new Response(JSON.stringify([makePipeline({ id: 20 })]), { status: 200 });
    }) as typeof fetch;

    const result = await syncGitlabPipelinesForIndexedProjects(
      ctx,
      PAT,
      API_BASE,
      WEB_ORIGIN,
      {},
      0,
    );

    expect(result.bytes).toBeGreaterThan(0);
    expect(result.upserted).toBe(2);
  });
});

describe("syncGitlabPipelinesForIndexedProjects — 429 retry-after NaN (non-numeric header)", () => {
  test("treats non-numeric retry-after as 60s default", async () => {
    const db = createMemoryIndexDb();
    seedGitlabProject(db, "group/proj");
    const ctx = syncTestContext(db, createStubVault({}), "gitlab");

    const origFetch = globalThis.fetch;
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("", {
          status: 429,
          headers: { "retry-after": "nan-value" },
        }),
      )) as unknown as typeof fetch;

    try {
      const result = await syncGitlabPipelinesForIndexedProjects(
        ctx,
        PAT,
        API_BASE,
        WEB_ORIGIN,
        {},
        0,
      );
      expect(result.upserted).toBe(0);
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
