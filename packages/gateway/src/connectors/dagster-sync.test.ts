import { expect, test } from "bun:test";

import {
  createMemoryIndexDb,
  createStubVault,
  describeWithFetchRestore,
  expectServiceItemCount,
  type SyncTestFetchParams,
  syncTestContext,
  testConnectorSyncNoop,
  urlFromFetchInput,
} from "./connector-sync-test-helpers.ts";
import { createDagsterSyncable, flattenJobs } from "./dagster-sync.ts";

// ──────────────────────────────────────────────────────────────────────────────
// Response builder helpers
// ──────────────────────────────────────────────────────────────────────────────

/** Build a valid repositories-or-error GraphQL response. */
function makeRepoResponse(nodes: unknown[]): string {
  return JSON.stringify({
    data: {
      repositoriesOrError: {
        __typename: "RepositoryConnection",
        nodes,
      },
    },
  });
}

/** A minimal pipeline entry with all required fields. */
const FULL_PIPELINE = {
  id: "pipeline-id-1",
  name: "my_job",
  description: "A test job",
  isJob: true,
  tags: [{ key: "team", value: "eng" }],
};

/** A minimal valid repo node carrying one pipeline. */
const FULL_REPO_NODE = {
  name: "my_repo",
  location: { name: "my_location" },
  pipelines: [FULL_PIPELINE],
};

describeWithFetchRestore("dagster-sync", () => {
  // ─── No-op when credentials are missing ─────────────────────────────────────
  testConnectorSyncNoop(
    "no-op when base_url missing",
    () => createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} }),
    createStubVault({ "dagster.base_url": null, "dagster.api_token": "tok" }),
  );

  testConnectorSyncNoop(
    "no-op when api_token missing",
    () => createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} }),
    createStubVault({
      "dagster.base_url": "https://acme.dagster.cloud",
      "dagster.api_token": null,
    }),
  );

  testConnectorSyncNoop(
    "no-op when both credentials missing",
    () => createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} }),
    createStubVault({ "dagster.base_url": null, "dagster.api_token": null }),
  );

  // ─── Happy path: indexes jobs and returns cursor ─────────────────────────────
  test("indexes jobs from valid GraphQL response and advances cursor", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (async (
      input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const u = urlFromFetchInput(input);
      expect(u).toContain("/graphql");
      const body =
        init?.body !== undefined && typeof init.body === "string" ? JSON.parse(init.body) : {};
      expect(typeof body.query).toBe("string");
      expect(body.query).toContain("repositoriesOrError");
      return new Response(makeRepoResponse([FULL_REPO_NODE]), { status: 200 });
    }) as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "mytoken",
        }),
        "dagster",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(1);
    expect(r.cursor).toContain("nimbus-dagster1:");
    expectServiceItemCount(db, "dagster", 1);
  });

  // ─── base_url with trailing slash is trimmed ─────────────────────────────────
  test("trims trailing slash from base_url before posting", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(makeRepoResponse([FULL_REPO_NODE]), { status: 200 });
    }) as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud/",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    // Should NOT have double slash before /graphql
    expect(capturedUrl).toBe("https://acme.dagster.cloud/graphql");
  });

  // ─── base_url without trailing slash (trimTrailingSlash false branch) ────────
  test("base_url without trailing slash is used as-is", async () => {
    const db = createMemoryIndexDb();
    let capturedUrl = "";
    globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
      capturedUrl = urlFromFetchInput(input);
      return new Response(makeRepoResponse([FULL_REPO_NODE]), { status: 200 });
    }) as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    expect(capturedUrl).toBe("https://acme.dagster.cloud/graphql");
  });

  // ─── HTTP error degrades gracefully ──────────────────────────────────────────
  test("returns http_error result on non-ok HTTP response (500)", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("Internal Server Error", { status: 500 }),
      )) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    // HTTP error degrades: no items, cursor preserved/advanced
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).not.toBeNull();
    expectServiceItemCount(db, "dagster", 0);
  });

  test("preserves incoming cursor on HTTP error", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(new Response("Bad Gateway", { status: 502 }))) as unknown as typeof fetch;

    const incomingCursor = "nimbus-dagster1:someoldcursor";
    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      incomingCursor,
    );
    // syncPassCursorHttpEmpty returns incoming cursor when non-null
    expect(r.cursor).toBe(incomingCursor);
    expect(r.itemsUpserted).toBe(0);
  });

  // ─── Parse error degrades gracefully ─────────────────────────────────────────
  test("returns parse_error result on invalid JSON body", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response("not-json-at-all", {
          status: 200,
          headers: { "Content-Type": "text/plain" },
        }),
      )) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dagster1:");
    expectServiceItemCount(db, "dagster", 0);
  });

  // ─── GraphQL errors array → parse_error ──────────────────────────────────────
  test("degrades gracefully on GraphQL errors array in response", async () => {
    const db = createMemoryIndexDb();
    const body = JSON.stringify({
      errors: [{ message: "Access denied" }],
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    // GraphQL errors → parse_error → syncPassCursorParseEmpty
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dagster1:");
    expectServiceItemCount(db, "dagster", 0);
  });

  // ─── Missing data field → envelope.data ?? {} → empty result ────────────────
  test("handles response with no data field (falls back to empty object)", async () => {
    const db = createMemoryIndexDb();
    // Valid JSON but no "data" key — envelope.data is undefined, ?? {} applies
    const body = JSON.stringify({ meta: "something" });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    // No jobs found → 0 upserted, cursor still advances
    expect(r.itemsUpserted).toBe(0);
    expect(r.cursor).toContain("nimbus-dagster1:");
    expectServiceItemCount(db, "dagster", 0);
  });

  // ─── Empty nodes array → 0 items ─────────────────────────────────────────────
  test("returns 0 upserted when repositories nodes is empty", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeRepoResponse([]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "dagster", 0);
  });

  // ─── PythonError typename → 0 items ──────────────────────────────────────────
  test("returns 0 upserted when repositoriesOrError is a PythonError", async () => {
    const db = createMemoryIndexDb();
    const body = JSON.stringify({
      data: {
        repositoriesOrError: {
          __typename: "PythonError",
          message: "Workspace error",
        },
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(0);
    expectServiceItemCount(db, "dagster", 0);
  });

  // ─── mapDagsterJobToItem returns null → skipped (line 180) ───────────────────
  test("skips jobs where mapDagsterJobToItem returns null (empty name after trim)", async () => {
    const db = createMemoryIndexDb();
    // A pipeline with name consisting only of whitespace → trimmed to "" → mapDagsterJobToItem returns null
    const body = JSON.stringify({
      data: {
        repositoriesOrError: {
          __typename: "RepositoryConnection",
          nodes: [
            {
              name: "my_repo",
              location: { name: "my_location" },
              pipelines: [
                // name is only spaces: flattenRepoPipelines strips in stringField, "" is caught by name===""
                // Actually stringField returns the raw string; name === "" check in flattenRepoPipelines
                // will skip it. We need to pass a pipeline that gets past flattenRepoPipelines but
                // has empty name after trim in mapDagsterJobToItem.
                // flattenRepoPipelines checks name === "" already, so we need repo name to be whitespace.
                { id: "p1", name: "valid_pipeline", description: "test", isJob: true, tags: [] },
              ],
            },
            {
              name: "   ", // repo name is all whitespace → mapDagsterJobToItem trims → "" → return null
              location: { name: "loc" },
              pipelines: [
                { id: "p2", name: "another_pipeline", description: "d", isJob: false, tags: [] },
              ],
            },
          ],
        },
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    // Only the first valid job upserted; the second repo's job is skipped (null mapping)
    expect(r.itemsUpserted).toBe(1);
    expectServiceItemCount(db, "dagster", 1);
  });

  // ─── Multiple repos → multiple jobs upserted ─────────────────────────────────
  test("upserts jobs from multiple repo nodes", async () => {
    const db = createMemoryIndexDb();
    const body = JSON.stringify({
      data: {
        repositoriesOrError: {
          __typename: "RepositoryConnection",
          nodes: [
            {
              name: "repo_a",
              location: { name: "loc_a" },
              pipelines: [
                { id: "p1", name: "job_alpha", isJob: true, tags: [] },
                { id: "p2", name: "job_beta", isJob: true, tags: [] },
              ],
            },
            {
              name: "repo_b",
              location: { name: "loc_b" },
              pipelines: [{ id: "p3", name: "job_gamma", isJob: false, tags: [] }],
            },
          ],
        },
      },
    });
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      null,
    );
    expect(r.itemsUpserted).toBe(3);
    expectServiceItemCount(db, "dagster", 3);
  });

  // ─── cursor round-trip ────────────────────────────────────────────────────────
  test("cursor is encoded as nimbus-dagster1: prefix on success", async () => {
    const db = createMemoryIndexDb();
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(makeRepoResponse([FULL_REPO_NODE]), { status: 200 }),
      )) as unknown as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    // pass existing cursor — should be replaced by pass1Cursor on success
    const r = await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "tok",
        }),
        "dagster",
      ),
      "nimbus-dagster1:oldcursor",
    );
    expect(r.cursor).toMatch(/^nimbus-dagster1:/);
  });

  // ─── Dagster-Cloud-Api-Token header is sent ───────────────────────────────────
  test("sends Dagster-Cloud-Api-Token header", async () => {
    const db = createMemoryIndexDb();
    let capturedToken = "";
    globalThis.fetch = (async (
      _input: SyncTestFetchParams[0],
      init?: SyncTestFetchParams[1],
    ): Promise<Response> => {
      const headers = init?.headers as Record<string, string> | undefined;
      capturedToken = headers?.["Dagster-Cloud-Api-Token"] ?? "";
      return new Response(makeRepoResponse([]), { status: 200 });
    }) as typeof fetch;

    const sync = createDagsterSyncable({ ensureDagsterMcpRunning: async () => {} });
    await sync.sync(
      syncTestContext(
        db,
        createStubVault({
          "dagster.base_url": "https://acme.dagster.cloud",
          "dagster.api_token": "secret-token-123",
        }),
        "dagster",
      ),
      null,
    );
    expect(capturedToken).toBe("secret-token-123");
  });
});

// ──────────────────────────────────────────────────────────────────────────────
// Unit tests for flattenJobs (exported pure function)
// ──────────────────────────────────────────────────────────────────────────────

test("flattenJobs: returns empty array for non-record input (null)", () => {
  // asRecord(null) → undefined → ?? {} → repos = {}
  const result = flattenJobs(null);
  expect(result).toEqual([]);
});

test("flattenJobs: returns empty array for non-record input (primitive)", () => {
  // asRecord(42) → undefined → ?? {}
  const result = flattenJobs(42);
  expect(result).toEqual([]);
});

test("flattenJobs: returns empty array when repositoriesOrError is missing", () => {
  // asRecord({}) = {} → repos = {} → nodes is undefined → !Array.isArray → []
  const result = flattenJobs({});
  expect(result).toEqual([]);
});

test("flattenJobs: returns empty array when repositoriesOrError is not a record", () => {
  // asRecord("string") → undefined → ?? {}
  const result = flattenJobs({ repositoriesOrError: "not-a-record" });
  expect(result).toEqual([]);
});

test("flattenJobs: returns empty array on PythonError typename", () => {
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "PythonError",
      message: "boom",
    },
  });
  expect(result).toEqual([]);
});

test("flattenJobs: returns empty array when nodes is not an array", () => {
  // nodes is a string → !Array.isArray → return []
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: "not-an-array",
    },
  });
  expect(result).toEqual([]);
});

test("flattenJobs: returns empty array when nodes is an object (not array)", () => {
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: { 0: FULL_REPO_NODE },
    },
  });
  expect(result).toEqual([]);
});

test("flattenJobs: skips non-record node entries (null in nodes array)", () => {
  // flattenRepoPipelines: asRecord(null) → undefined → return false (skipped)
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [null, FULL_REPO_NODE],
    },
  });
  // null node is skipped; FULL_REPO_NODE contributes 1 job
  expect(result).toHaveLength(1);
  expect(result[0]!.name).toBe("my_job");
});

test("flattenJobs: skips non-record node entries (string in nodes array)", () => {
  // flattenRepoPipelines: asRecord("string") → undefined → return false
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: ["not-an-object"],
    },
  });
  expect(result).toEqual([]);
});

test("flattenJobs: skips node where pipelines is not an array", () => {
  // flattenRepoPipelines: !Array.isArray(pipelines) → return false
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_x",
          location: { name: "loc" },
          pipelines: "not-an-array",
        },
      ],
    },
  });
  expect(result).toEqual([]);
});

test("flattenJobs: skips node where pipelines is null (not an array)", () => {
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_x",
          location: { name: "loc" },
          pipelines: null,
        },
      ],
    },
  });
  expect(result).toEqual([]);
});

test("flattenJobs: skips non-record pipeline entries (primitive in pipelines)", () => {
  // flattenRepoPipelines inner loop: asRecord(p) → undefined → continue (line 116)
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_x",
          location: { name: "loc" },
          pipelines: [42, "a-string", FULL_PIPELINE],
        },
      ],
    },
  });
  // 42 and "a-string" skipped; FULL_PIPELINE valid
  expect(result).toHaveLength(1);
  expect(result[0]!.name).toBe("my_job");
});

test("flattenJobs: skips pipeline with empty name", () => {
  // name === "" → continue
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_x",
          location: { name: "loc" },
          pipelines: [{ id: "bad", name: "" }, FULL_PIPELINE],
        },
      ],
    },
  });
  expect(result).toHaveLength(1);
  expect(result[0]!.name).toBe("my_job");
});

test("flattenJobs: skips pipeline with no name field (stringField returns undefined)", () => {
  // stringField returns undefined for missing key → name === undefined → continue
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_x",
          location: { name: "loc" },
          pipelines: [{ id: "no-name-field" }, FULL_PIPELINE],
        },
      ],
    },
  });
  expect(result).toHaveLength(1);
});

test("flattenJobs: location is null when location field is absent", () => {
  // locationRow === undefined → null (line 109 false branch)
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_x",
          // no location field
          pipelines: [FULL_PIPELINE],
        },
      ],
    },
  });
  expect(result).toHaveLength(1);
  expect(result[0]!.location).toBeNull();
});

test("flattenJobs: location is null when location field is a primitive", () => {
  // asRecord("string") → undefined → null
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_x",
          location: "not-an-object",
          pipelines: [FULL_PIPELINE],
        },
      ],
    },
  });
  expect(result).toHaveLength(1);
  expect(result[0]!.location).toBeNull();
});

test("flattenJobs: location is populated when location object has name field", () => {
  // locationRow defined → stringField → location string (line 109 true branch)
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_x",
          location: { name: "prod_location" },
          pipelines: [FULL_PIPELINE],
        },
      ],
    },
  });
  expect(result).toHaveLength(1);
  expect(result[0]!.location).toBe("prod_location");
  expect(result[0]!.repository).toBe("repo_x");
});

test("flattenJobs: returns correct raw record on each flat job", () => {
  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [FULL_REPO_NODE],
    },
  });
  expect(result).toHaveLength(1);
  const job = result[0]!;
  expect(job.name).toBe("my_job");
  expect(job.repository).toBe("my_repo");
  expect(job.location).toBe("my_location");
  expect(job.raw).toBeDefined();
});

test("flattenJobs: caps at MAX_JOBS (2000) and breaks early", () => {
  // Generate 2001 pipelines; flattenRepoPipelines should return true after 2000
  // causing the outer loop to break and stopping at exactly 2000
  const pipelines: unknown[] = [];
  for (let i = 0; i < 2001; i++) {
    pipelines.push({ id: `p${i}`, name: `job_${i}`, isJob: true, tags: [] });
  }

  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "big_repo",
          location: { name: "loc" },
          pipelines,
        },
      ],
    },
  });
  // Capped at MAX_JOBS=2000
  expect(result).toHaveLength(2000);
});

test("flattenJobs: MAX_JOBS cap breaks outer nodes loop (multiple repos exceeding cap)", () => {
  // First repo has exactly 2000 pipelines → flattenRepoPipelines returns true → outer break
  const pipelines: unknown[] = [];
  for (let i = 0; i < 2000; i++) {
    pipelines.push({ id: `p${i}`, name: `job_${i}`, isJob: true, tags: [] });
  }

  const result = flattenJobs({
    repositoriesOrError: {
      __typename: "RepositoryConnection",
      nodes: [
        {
          name: "repo_a",
          location: { name: "loc_a" },
          pipelines,
        },
        {
          // This second repo should NOT be visited due to the break
          name: "repo_b",
          location: { name: "loc_b" },
          pipelines: [FULL_PIPELINE],
        },
      ],
    },
  });
  // Exactly 2000: second repo's job not included
  expect(result).toHaveLength(2000);
});
