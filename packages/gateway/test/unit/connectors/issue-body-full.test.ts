import { describe, expect, test } from "bun:test";
import { createBitbucketSyncable } from "../../../src/connectors/bitbucket-sync.ts";
import type { ConnectorServiceId } from "../../../src/connectors/connector-catalog.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  type SyncTestFetchParams,
  syncTestContext,
  urlFromFetchInput,
} from "../../../src/connectors/connector-sync-test-helpers.ts";
import { createGithubSyncable } from "../../../src/connectors/github-sync.ts";
import { createJiraSyncable } from "../../../src/connectors/jira-sync.ts";
import { createLinearSyncable } from "../../../src/connectors/linear-sync.ts";
import { mapSnykAggregatedIssueToItem } from "../../../src/connectors/snyk-issue-mapping.ts";

/**
 * Task 10: the five issue-tracker / vulnerability connectors now pass the
 * declared-full `body:` field (instead of a pre-clamped `bodyPreview:`) to
 * `upsertIndexedItem*`, so the store — not the connector — is the single
 * place that applies the per-type length cap (`body-caps.ts`). These tests
 * drive each connector's real mapping path with a 4,000-character
 * description/body and assert what actually lands in `item`.
 *
 * `linear:issue`, `jira:issue`, `github:issue`, and `snyk:vulnerability` are
 * all in `PROSE_HEAVY_TYPES` (cap = `BODY_MAX_PROSE` = 16,384), so a
 * 4,000-char body fits whole and `body_complete` becomes 1.
 *
 * `bitbucket-sync.ts`'s only item type at this call site is `"pr"` — and
 * only `"bitbucket:issue"` (not `"bitbucket:pr"`) is in `PROSE_HEAVY_TYPES` —
 * so the store applies `BODY_MAX_DEFAULT` (512) there, exactly as it already
 * does for `github:pr`. The substitution is still correct (it stops the
 * connector from pre-truncating to 512 before the store gets a say), but the
 * *observable* row for Bitbucket stays a 512-char, `body_complete = 0`
 * preview until Bitbucket has a prose-heavy item type. That test is written
 * to match this real behaviour rather than the four-way "identical" shape.
 */

type ItemBodyRow = {
  title: string;
  body: string;
  body_preview: string;
  body_complete: number;
};

function readBodyRow(
  db: ReturnType<typeof createMemoryIndexDb>,
  service: string,
  type: string,
): ItemBodyRow {
  const row = db
    .query(
      "SELECT title, body, body_preview, body_complete FROM item WHERE service = ? AND type = ?",
    )
    .get(service, type) as ItemBodyRow | null;
  if (row === null) {
    throw new Error(`expected a ${service}:${type} row`);
  }
  return row;
}

const LONG_DESC = "A".repeat(4000);
const FIXTURE_TITLE = "the fixture summary";

describe("issue-body-full — linear:issue", () => {
  test("indexes the full 4000-char description; title unaffected", async () => {
    const db = createMemoryIndexDb();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            data: {
              issues: {
                nodes: [
                  {
                    id: "uuid-1",
                    identifier: "NIM-1",
                    title: FIXTURE_TITLE,
                    description: LONG_DESC,
                    updatedAt: "2026-04-01T12:00:00.000Z",
                    url: "https://linear.example/NIM-1",
                    creator: { id: "lin-user-1", name: "Lin User", email: "lin@example.com" },
                  },
                ],
                pageInfo: { hasNextPage: false, endCursor: null },
              },
            },
          }),
          { status: 200 },
        )) as unknown as typeof fetch;

      const sync = createLinearSyncable({ ensureLinearMcpRunning: async () => {} });
      const r = await sync.sync(
        syncTestContext(
          db,
          createStubVault({ "linear.api_key": "lin_api_test" }),
          sync.serviceId as ConnectorServiceId,
        ),
        null,
      );
      expect(r.itemsUpserted).toBe(1);

      const row = readBodyRow(db, "linear", "issue");
      expect(row.body).toHaveLength(4000);
      expect(row.body_preview).toBe(row.body.slice(0, 512));
      expect(row.body_complete).toBe(1);
      expect(row.title).toBe(FIXTURE_TITLE);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("issue-body-full — jira:issue", () => {
  test("indexes the full 4000-char description; title unaffected", async () => {
    const db = createMemoryIndexDb();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (): Promise<Response> =>
        new Response(
          JSON.stringify({
            issues: [
              {
                id: "10001",
                key: "NIM-1",
                fields: {
                  summary: FIXTURE_TITLE,
                  updated: "2026-04-01T12:00:00.000+0000",
                  description: LONG_DESC,
                  creator: {
                    accountId: "acct-1",
                    displayName: "Author",
                    emailAddress: "author@example.com",
                  },
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
      const sync = createJiraSyncable({ ensureJiraMcpRunning: async () => {} });
      const r = await sync.sync(
        syncTestContext(db, vault, sync.serviceId as ConnectorServiceId),
        null,
      );
      expect(r.itemsUpserted).toBe(1);

      const row = readBodyRow(db, "jira", "issue");
      expect(row.body).toHaveLength(4000);
      expect(row.body_preview).toBe(row.body.slice(0, 512));
      expect(row.body_complete).toBe(1);
      expect(row.title).toBe(FIXTURE_TITLE);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("issue-body-full — github:issue", () => {
  test("indexes the full 4000-char body; title unaffected", async () => {
    const db = createMemoryIndexDb();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
        const u = urlFromFetchInput(input);
        if (u === "https://api.github.com/user") {
          return new Response(JSON.stringify({ login: "octocat" }), { status: 200 });
        }
        return new Response(
          JSON.stringify([
            {
              id: "e1",
              type: "IssuesEvent",
              repo: { full_name: "acme/app" },
              payload: {
                issue: {
                  number: 11,
                  title: FIXTURE_TITLE,
                  body: LONG_DESC,
                  html_url: "https://github.com/acme/app/issues/11",
                  updated_at: "2026-04-02T12:00:00Z",
                  state: "open",
                  user: { login: "bob" },
                },
              },
            },
          ]),
          { status: 200, headers: { etag: '"e1"' } },
        );
      }) as unknown as typeof fetch;

      const vault = createStubVault({ "github.pat": "github-stub-pat" });
      const sync = createGithubSyncable({ ensureGithubMcpRunning: async () => {} });
      const r = await sync.sync(
        syncTestContext(db, vault, sync.serviceId as ConnectorServiceId),
        null,
      );
      expect(r.itemsUpserted).toBe(1);

      const row = readBodyRow(db, "github", "issue");
      expect(row.body).toHaveLength(4000);
      expect(row.body_preview).toBe(row.body.slice(0, 512));
      expect(row.body_complete).toBe(1);
      expect(row.title).toBe(FIXTURE_TITLE);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("issue-body-full — bitbucket:pr (only item type this call site emits)", () => {
  const WORKSPACE_RE = /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\?[^/]*role=member[^/]*$/;
  const PR_LIST_RE =
    /^https:\/\/api\.bitbucket\.org\/2\.0\/repositories\/[^/]+\/[^/]+\/pullrequests\?/;

  test("body is store-clamped to 512 / body_complete stays 0 — bitbucket:pr is not prose-heavy; title unaffected", async () => {
    const db = createMemoryIndexDb();
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async (input: SyncTestFetchParams[0]): Promise<Response> => {
        const u = urlFromFetchInput(input);
        if (WORKSPACE_RE.test(u)) {
          return new Response(
            JSON.stringify({ values: [{ full_name: "acme/repo" }], next: null }),
            { status: 200 },
          );
        }
        if (PR_LIST_RE.test(u)) {
          return new Response(
            JSON.stringify({
              values: [
                {
                  id: 500,
                  title: FIXTURE_TITLE,
                  description: LONG_DESC,
                  updated_on: "2026-04-02T12:00:00Z",
                  state: "OPEN",
                  links: {
                    html: { href: "https://bitbucket.org/acme/repo/pull-requests/500" },
                  },
                  author: { display_name: "Author", uuid: "{abc-uuid}" },
                },
              ],
              next: null,
            }),
            { status: 200 },
          );
        }
        throw new Error(`unexpected bitbucket fetch: ${u}`);
      }) as unknown as typeof fetch;

      const vault = createStubVault({
        "bitbucket.username": "bitbucket-stub-username",
        "bitbucket.app_password": "bitbucket-stub-pass",
      });
      const sync = createBitbucketSyncable({ ensureBitbucketMcpRunning: async () => {} });
      const r = await sync.sync(
        syncTestContext(db, vault, sync.serviceId as ConnectorServiceId),
        null,
      );
      expect(r.itemsUpserted).toBe(1);

      const row = readBodyRow(db, "bitbucket", "pr");
      // Not 4000 / not complete: "bitbucket:pr" is absent from PROSE_HEAVY_TYPES
      // (only "bitbucket:issue" is listed there, and this connector never emits
      // that type), so the store applies BODY_MAX_DEFAULT — the same automatic
      // clamp that already applies to github:pr.
      expect(row.body).toHaveLength(512);
      expect(row.body_preview).toBe(row.body);
      expect(row.body_complete).toBe(0);
      expect(row.title).toBe(FIXTURE_TITLE);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe("issue-body-full — snyk:vulnerability", () => {
  test("indexes the full 4000-char description; title unaffected", () => {
    const db = createMemoryIndexDb();
    const mapped = mapSnykAggregatedIssueToItem(
      {
        id: "SNYK-JS-LODASH-1018905",
        issueData: {
          title: FIXTURE_TITLE,
          description: LONG_DESC,
          url: "https://security.snyk.io/vuln/SNYK-JS-LODASH-1018905",
          severity: "high",
          identifiers: { CVE: ["CVE-2020-8203"] },
        },
        fixInfo: { isFixable: true, fixedIn: ["4.17.19"] },
        pkgName: "lodash",
        pkgVersions: ["4.17.15"],
      },
      { orgId: "org-uuid-1", projectId: "proj-uuid-1", syncedAt: Date.now() },
    );
    if (mapped === null) {
      throw new Error("expected mapping to succeed");
    }

    const ctx = syncTestContext(db, createStubVault({}), "linear");
    ctx.upsertItem(mapped);

    const row = readBodyRow(db, "snyk", "vulnerability");
    expect(row.body).toHaveLength(4000);
    expect(row.body_preview).toBe(row.body.slice(0, 512));
    expect(row.body_complete).toBe(1);
    expect(row.title).toBe(FIXTURE_TITLE);
  });
});
