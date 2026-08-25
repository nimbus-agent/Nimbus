import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { createSnykSyncable } from "../../../src/connectors/snyk-sync.ts";
import {
  type ConnectorSyncFixture,
  createConnectorSyncFixture,
} from "../../helpers/connector-sync-harness.ts";

const ENSURE_MCP = { ensureSnykMcpRunning: async (): Promise<void> => {} };
const CURSOR_PREFIX = "nimbus-snyk1:";

const ORGS_URL_RE = /^https:\/\/api\.snyk\.io\/v1\/orgs$/;
const PROJECTS_URL_RE = /^https:\/\/api\.snyk\.io\/v1\/org\/[^/]+\/projects$/;
const AGG_ISSUES_URL_RE =
  /^https:\/\/api\.snyk\.io\/v1\/org\/[^/]+\/project\/[^/]+\/aggregated-issues$/;

async function withIsolatedFixture(
  fn: (fixture: ConnectorSyncFixture) => Promise<void>,
): Promise<void> {
  const isolated = createConnectorSyncFixture();
  isolated.fetchMock.install();
  try {
    await fn(isolated);
  } finally {
    isolated.cleanup();
  }
}

describe("snyk-sync — credential short-circuit", () => {
  test("returns noop when snyk.token is unset", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createSnykSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("snyk"), null);
      expect(res.itemsUpserted).toBe(0);
      expect(res.hasMore).toBe(false);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("returns noop when snyk.token is whitespace-only", async () => {
    await withIsolatedFixture(async (iso) => {
      await iso.vault.set("snyk.token", "    ");
      const syncable = createSnykSyncable(ENSURE_MCP);
      await syncable.sync(iso.createSyncContext("snyk"), null);
      expect(iso.fetchMock.calls).toHaveLength(0);
    });
  });

  test("noop preserves the incoming cursor", async () => {
    await withIsolatedFixture(async (iso) => {
      const syncable = createSnykSyncable(ENSURE_MCP);
      const res = await syncable.sync(iso.createSyncContext("snyk"), "preserved");
      expect(res.cursor).toBe("preserved");
    });
  });
});

describe("snyk-sync — with token", () => {
  let fixture: ConnectorSyncFixture;

  beforeEach(async () => {
    fixture = createConnectorSyncFixture();
    fixture.fetchMock.install();
    await fixture.vault.set("snyk.token", "snyk-stub-token");
  });

  afterEach(() => {
    fixture.cleanup();
  });

  test("sends Authorization: token <value> on every request", async () => {
    fixture.fetchMock.respond("GET", ORGS_URL_RE, { orgs: [{ id: "org-1", name: "Acme" }] });
    fixture.fetchMock.respond("GET", PROJECTS_URL_RE, { projects: [] });
    await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    expect(fixture.fetchMock.firstCall().headers["authorization"]).toBe("token snyk-stub-token");
  });

  test("HTTP 5xx on /orgs short-circuits to http-empty pass cursor", async () => {
    fixture.fetchMock.respond("GET", ORGS_URL_RE, { error: "boom" }, { status: 500 });
    const res = await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).not.toBeNull();
    if (res.cursor === null) throw new Error("unexpected null cursor");
    expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
  });

  test("invalid JSON on /orgs returns parse-empty pass cursor", async () => {
    fixture.fetchMock.respondWithText("GET", ORGS_URL_RE, "<html>not json</html>");
    const res = await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).not.toBeNull();
    if (res.cursor === null) throw new Error("unexpected null cursor");
    expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
  });

  test("zero orgs → success cursor, zero upserts", async () => {
    fixture.fetchMock.respond("GET", ORGS_URL_RE, { orgs: [] });
    const res = await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    expect(res.itemsUpserted).toBe(0);
    expect(res.cursor).not.toBeNull();
    if (res.cursor === null) throw new Error("unexpected null cursor");
    expect(res.cursor.startsWith(CURSOR_PREFIX)).toBe(true);
  });

  test("full cycle: orgs → projects → aggregated-issues → upserted rows", async () => {
    fixture.fetchMock.respond("GET", ORGS_URL_RE, {
      orgs: [{ id: "org-1", name: "Acme" }],
    });
    fixture.fetchMock.respond("GET", PROJECTS_URL_RE, {
      projects: [{ id: "proj-1", name: "acme/web" }],
    });
    fixture.fetchMock.respond("POST", AGG_ISSUES_URL_RE, {
      issues: [
        {
          id: "SNYK-JS-LODASH-1018905",
          issueType: "vuln",
          pkgName: "lodash",
          pkgVersions: ["4.17.20"],
          issueData: {
            id: "SNYK-JS-LODASH-1018905",
            title: "Prototype Pollution in lodash",
            severity: "high",
            url: "https://security.snyk.io/vuln/SNYK-JS-LODASH-1018905",
            description: "Affected versions of this package are vulnerable to prototype pollution.",
            identifiers: { CVE: ["CVE-2020-8203"] },
            publicationTime: "2020-07-16T12:00:00.000Z",
            disclosureTime: "2020-07-15T00:00:00.000Z",
          },
          fixInfo: {
            isFixable: true,
            isUpgradable: true,
            isPatchable: false,
            fixedIn: ["4.17.21"],
          },
        },
      ],
    });
    const res = await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    expect(res.itemsUpserted).toBe(1);
    const rows = fixture.db
      .query<{ external_id: string; title: string; metadata: string }, []>(
        "SELECT external_id, title, metadata FROM item WHERE service = 'snyk' ORDER BY external_id",
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.external_id).toBe("org-1/proj-1/SNYK-JS-LODASH-1018905");
    const meta = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(meta["severity"]).toBe("high");
    expect(meta["cve_id"]).toBe("CVE-2020-8203");
    expect(meta["affected_package"]).toBe("lodash");
    expect(meta["fix_available"]).toBe(true);
    expect(meta["fix_version"]).toBe("4.17.21");
  });

  test("skips non-record issues + missing-id issues", async () => {
    fixture.fetchMock.respond("GET", ORGS_URL_RE, { orgs: [{ id: "org-1" }] });
    fixture.fetchMock.respond("GET", PROJECTS_URL_RE, { projects: [{ id: "proj-1" }] });
    fixture.fetchMock.respond("POST", AGG_ISSUES_URL_RE, {
      issues: [
        42,
        null,
        { id: "" },
        {
          id: "OK",
          issueType: "vuln",
          issueData: { id: "OK", title: "Kept", severity: "low" },
          fixInfo: {},
        },
      ],
    });
    const res = await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    expect(res.itemsUpserted).toBe(1);
  });

  test("walks multiple orgs in one pass", async () => {
    fixture.fetchMock.respond("GET", ORGS_URL_RE, {
      orgs: [{ id: "org-1" }, { id: "org-2" }],
    });
    fixture.fetchMock.respond("GET", PROJECTS_URL_RE, {
      projects: [{ id: "proj-x" }],
    });
    fixture.fetchMock.respond("POST", AGG_ISSUES_URL_RE, {
      issues: [
        {
          id: "ISSUE-1",
          issueType: "vuln",
          issueData: { id: "ISSUE-1", title: "T1", severity: "low" },
          fixInfo: {},
        },
      ],
    });
    const res = await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    expect(res.itemsUpserted).toBe(2);
    const ids = fixture.db
      .query<{ external_id: string }, []>(
        "SELECT external_id FROM item WHERE service = 'snyk' ORDER BY external_id",
      )
      .all()
      .map((r) => r.external_id);
    expect(ids).toEqual(["org-1/proj-x/ISSUE-1", "org-2/proj-x/ISSUE-1"]);
  });

  test("cursor decodes to { pass: 1 } on success", async () => {
    fixture.fetchMock.respond("GET", ORGS_URL_RE, { orgs: [] });
    const res = await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    if (res.cursor === null) throw new Error("unexpected null cursor");
    const decoded = JSON.parse(
      Buffer.from(res.cursor.slice(CURSOR_PREFIX.length), "base64url").toString("utf8"),
    ) as { pass: number };
    expect(decoded.pass).toBe(1);
  });

  test("emits no notifications", async () => {
    fixture.fetchMock.respond("GET", ORGS_URL_RE, { orgs: [] });
    await createSnykSyncable(ENSURE_MCP).sync(fixture.createSyncContext("snyk"), null);
    expect(fixture.notifications.emitted).toHaveLength(0);
  });
});
