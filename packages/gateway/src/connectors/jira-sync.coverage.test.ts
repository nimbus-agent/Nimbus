/**
 * The Jira connector's targeted-fetch predicates (`jiraConfiguredBaseUrl`,
 * `jiraUrlMatchesConfiguredBase`, `jiraFetchOneUrlIsSupported`) and the sparse-creator / sparse-issue
 * shapes of the periodic sync that `jira-sync.test.ts` does not reach.
 */
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { StubFetch } from "../../test/helpers/stub-fetch.ts";
import type { PersonSyncHints } from "../people/person-types.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  createStubVault,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import {
  createJiraSyncable,
  jiraConfiguredBaseUrl,
  jiraFetchOneUrlIsSupported,
  jiraUrlMatchesConfiguredBase,
} from "./jira-sync.ts";

const BASE = "https://acme.atlassian.net";

describe("jiraConfiguredBaseUrl", () => {
  test.each([
    ["absent", {}, null],
    ["empty", { "jira.base_url": "" }, null],
    ["only slashes (normalizes to nothing)", { "jira.base_url": "///" }, null],
    ["a bare host with a trailing slash", { "jira.base_url": "acme.atlassian.net/" }, BASE],
    [
      "an explicit http URL",
      { "jira.base_url": "http://jira.local:8080" },
      "http://jira.local:8080",
    ],
  ])("a base_url that is %s → %p", async (_label, entries, expected) => {
    expect(await jiraConfiguredBaseUrl(createStubVault(entries))).toBe(expected);
  });
});

describe("jiraUrlMatchesConfiguredBase", () => {
  test.each([
    ["an unparseable configured base", "https://acme.atlassian.net/browse/ENG-1", "not a url"],
    ["an unparseable request", "::not a url::", BASE],
    ["a scheme mismatch", "http://acme.atlassian.net/browse/ENG-1", BASE],
    ["a host mismatch", "https://evil.example.com/browse/ENG-1", BASE],
    ["a port mismatch", "https://acme.atlassian.net:8443/browse/ENG-1", BASE],
  ])("%s does not match", (_label, url, base) => {
    expect(jiraUrlMatchesConfiguredBase(url, base)).toBe(false);
  });

  test("the same origin under a root base matches (control)", () => {
    expect(jiraUrlMatchesConfiguredBase(`${BASE}/browse/ENG-1`, BASE)).toBe(true);
  });
});

describe("jiraFetchOneUrlIsSupported", () => {
  const browse = `${BASE}/browse/ENG-1`;

  test.each([
    ["an unparseable URL", "not a url at all", undefined, false],
    [
      "a non-http scheme with a selectedIssue",
      "ftp://acme/board?selectedIssue=ENG-2",
      undefined,
      false,
    ],
    [
      "a board link with no selectedIssue",
      `${BASE}/jira/software/projects/ENG/boards/1`,
      undefined,
      false,
    ],
    ["a browse URL with no base to check", browse, undefined, true],
    ["a browse URL with a null base", browse, null, true],
    ["a browse URL under the configured base", browse, BASE, true],
    [
      "a board deep link with a selectedIssue",
      `${BASE}/jira/software/boards/1?selectedIssue=ENG-2`,
      BASE,
      true,
    ],
    ["a browse URL outside the base's context path", browse, `${BASE}/jira`, false],
    ["a browse URL on another host", "https://other.atlassian.net/browse/ENG-1", BASE, false],
  ])("%s → %p", (_label, url, base, expected) => {
    expect(jiraFetchOneUrlIsSupported(url, base)).toBe(expected);
  });
});

describe("periodic sync — sparse issues and creators", () => {
  let mock: StubFetch;

  beforeEach(() => {
    mock = new StubFetch();
    mock.install();
  });

  afterEach(() => {
    mock.restore();
  });

  function ctxFor(db: Database, seen: PersonSyncHints[]): SyncContext {
    const base = syncTestContext(
      db,
      createStubVault({
        "jira.email": "u@example.com",
        "jira.api_token": "tok",
        "jira.base_url": BASE,
      }),
      "jira",
    );
    return {
      ...base,
      resolvePerson: (hints) => {
        seen.push(hints);
        return `person-${String(seen.length)}`;
      },
    };
  }

  test("a creator with no displayName is named by its email, or by its account id when it has no email", async () => {
    mock.respond("POST", `${BASE}/rest/api/3/search`, {
      issues: [
        {
          id: "1",
          key: "ENG-1",
          fields: { summary: "a", creator: { accountId: "acc-1", emailAddress: "dev@acme.test" } },
        },
        { id: "2", key: "ENG-2", fields: { summary: "b", creator: { accountId: "acc-2" } } },
      ],
      total: 2,
    });
    const db = createMemoryIndexDb();
    const seen: PersonSyncHints[] = [];

    const r = await createJiraSyncable({ ensureJiraMcpRunning: async () => {} }).sync(
      ctxFor(db, seen),
      null,
    );

    expect(r.itemsUpserted).toBe(2);
    expect(seen).toEqual([
      { jiraAccountId: "acc-1", canonicalEmail: "dev@acme.test", displayName: "dev@acme.test" },
      { jiraAccountId: "acc-2", displayName: "acc-2" },
    ]);
    db.close();
  });

  test("an issue with no summary is titled by its key, and with no id is identified by its key", async () => {
    mock.respond("POST", `${BASE}/rest/api/3/search`, {
      issues: [
        { key: "ENG-7", fields: { updated: "2026-05-01T10:00:00.000+0000" } },
        { id: "8", key: "ENG-8", fields: { summary: "Has both" } },
      ],
      total: 2,
    });
    const db = createMemoryIndexDb();

    await createJiraSyncable({ ensureJiraMcpRunning: async () => {} }).sync(ctxFor(db, []), null);

    const rows = db
      .query(
        "SELECT external_id, title, metadata FROM item WHERE service = 'jira' ORDER BY external_id",
      )
      .all() as { external_id: string; title: string; metadata: string }[];
    expect(rows.map((r) => [r.external_id, r.title])).toEqual([
      ["ENG-7", "ENG-7"],
      ["ENG-8", "Has both"],
    ]);
    const jiraIds = rows.map((r) => (JSON.parse(r.metadata) as { jiraId: unknown }).jiraId);
    expect(jiraIds).toEqual(["ENG-7", "8"]);
    db.close();
  });
});
