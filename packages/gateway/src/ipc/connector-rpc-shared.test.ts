import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";

import { GATEWAY_SYNCABLE_SERVICE_IDS } from "../connectors/gateway-syncable-ids.ts";
import { LocalIndex } from "../index/local-index.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  ConnectorRpcError,
  parseAtlassianSiteCredentials,
  parseServiceArg,
  registerAtlassianApiConnectorAuth,
  requireRegisteredConnector,
  requireRegisteredSchedulerServiceId,
  requireServiceId,
  resolveConnectorListFilterServiceId,
  sumItemsSiblingServices,
} from "./connector-rpc-shared.ts";

let db: Database;
let localIndex: LocalIndex;

beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  localIndex = new LocalIndex(db);
});

/** Records every write so a test can assert WHICH vault keys a handler touched. */
function recordingVault(): { vault: NimbusVault; writes: Array<[string, string]> } {
  const writes: Array<[string, string]> = [];
  const vault: NimbusVault = {
    get: async () => null,
    set: async (k, v) => {
      writes.push([k, v]);
    },
    delete: async () => {},
    listKeys: async () => [],
  };
  return { vault, writes };
}

function seedItem(service: string, id: string): void {
  db.run(
    `INSERT INTO item (id, service, type, external_id, title, modified_at, synced_at, pinned)
     VALUES (?, ?, 'doc', ?, 't', 1, 1, 0)`,
    [id, service, id],
  );
}

describe("requireServiceId", () => {
  test("normalizes a catalog id and returns it", () => {
    expect(requireServiceId({ serviceId: "GitHub" })).toBe("github");
  });

  test("accepts the hyphenated spelling of a catalog id", () => {
    // `normalizeConnectorServiceId` maps `-` to `_`; the RPC surface must accept
    // the form a user types on the command line.
    expect(requireServiceId({ serviceId: "github-actions" })).toBe("github_actions");
  });

  test("rejects an unknown service with -32602", () => {
    let caught: unknown;
    try {
      requireServiceId({ serviceId: "not-a-connector" });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ConnectorRpcError);
    expect((caught as ConnectorRpcError).rpcCode).toBe(-32602);
  });

  test("rejects a missing params object", () => {
    expect(() => requireServiceId(undefined)).toThrow(ConnectorRpcError);
  });

  test("rejects a non-string serviceId rather than coercing it", () => {
    // A JSON-RPC caller can send any JSON value here. Coercion would turn `42`
    // into the string "42" and let it reach the catalog lookup.
    expect(() => requireServiceId({ serviceId: 42 })).toThrow(ConnectorRpcError);
  });
});

describe("requireRegisteredConnector", () => {
  test("passes for a connector registered with the scheduler", () => {
    localIndex.ensureConnectorSchedulerRegistration("github", 60_000, Date.now());
    expect(() => requireRegisteredConnector(localIndex, "github")).not.toThrow();
  });

  test("rejects a catalog id that was never registered on this machine", () => {
    expect(() => requireRegisteredConnector(localIndex, "github")).toThrow(/Unknown connector/u);
  });
});

describe("requireRegisteredSchedulerServiceId", () => {
  test("accepts a registered catalog id", () => {
    localIndex.ensureConnectorSchedulerRegistration("jira", 60_000, Date.now());
    expect(requireRegisteredSchedulerServiceId({ serviceId: "Jira" }, localIndex)).toBe("jira");
  });

  // The regression this widening exists for: `nimbus init` and the README both
  // tell a first-time user to run `nimbus connector sync filesystem`, and all
  // four gateway-side syncables were rejected as "Invalid serviceId" because
  // they have no catalog entry.
  test.each([...GATEWAY_SYNCABLE_SERVICE_IDS])("accepts the gateway syncable %s", (id) => {
    localIndex.ensureConnectorSchedulerRegistration(id, 60_000, Date.now());
    expect(requireRegisteredSchedulerServiceId({ serviceId: id }, localIndex)).toBe(id);
  });

  test("accepts a registered user-MCP id", () => {
    localIndex.ensureConnectorSchedulerRegistration("mcp_local_notes", 60_000, Date.now());
    expect(requireRegisteredSchedulerServiceId({ serviceId: "MCP_Local_Notes" }, localIndex)).toBe(
      "mcp_local_notes",
    );
  });

  test("rejects a blank serviceId with 'Missing serviceId'", () => {
    expect(() => requireRegisteredSchedulerServiceId({ serviceId: "   " }, localIndex)).toThrow(
      "Missing serviceId",
    );
  });

  test("rejects an absent serviceId with 'Missing serviceId'", () => {
    expect(() => requireRegisteredSchedulerServiceId({}, localIndex)).toThrow("Missing serviceId");
  });

  test("rejects a name that is neither catalog, gateway syncable, nor mcp_*", () => {
    expect(() => requireRegisteredSchedulerServiceId({ serviceId: "bogus" }, localIndex)).toThrow(
      "Invalid serviceId",
    );
  });

  // Membership in the widened NAME set is not authorisation: the registration
  // check is still what admits the sync.
  test("rejects a well-formed gateway syncable that was never registered", () => {
    expect(() =>
      requireRegisteredSchedulerServiceId({ serviceId: "filesystem" }, localIndex),
    ).toThrow("Unknown connector: filesystem");
  });

  test("rejects a well-formed user-MCP id that was never registered", () => {
    expect(() =>
      requireRegisteredSchedulerServiceId({ serviceId: "mcp_never_added" }, localIndex),
    ).toThrow("Unknown connector: mcp_never_added");
  });
});

describe("resolveConnectorListFilterServiceId", () => {
  test("resolves a catalog id", () => {
    expect(resolveConnectorListFilterServiceId(" GitHub ")).toBe("github");
  });

  test("resolves a user-MCP id, lowercased", () => {
    expect(resolveConnectorListFilterServiceId("MCP_My_Server")).toBe("mcp_my_server");
  });

  test("returns null for an unknown filter rather than throwing", () => {
    expect(resolveConnectorListFilterServiceId("nope")).toBeNull();
  });

  // A list FILTER is not a sync target: the gateway syncables are deliberately
  // outside this resolver's vocabulary, unlike `requireRegisteredSchedulerServiceId`.
  test("does not resolve a gateway syncable id", () => {
    expect(resolveConnectorListFilterServiceId("filesystem")).toBeNull();
  });
});

describe("sumItemsSiblingServices", () => {
  test("sums the family's items excluding the named service", () => {
    seedItem("google_drive", "gd1");
    seedItem("google_drive", "gd2");
    seedItem("gmail", "gm1");
    seedItem("github", "gh1");
    const family = new Set(["google_drive", "gmail"]);
    expect(sumItemsSiblingServices(db, "google_drive", family)).toBe(1);
    expect(sumItemsSiblingServices(db, "gmail", family)).toBe(2);
  });

  test("is zero when the family holds only the named service", () => {
    seedItem("gmail", "gm1");
    expect(sumItemsSiblingServices(db, "gmail", new Set(["gmail"]))).toBe(0);
  });
});

describe("parseServiceArg", () => {
  test("prefers `service` over `serviceId`", () => {
    expect(parseServiceArg({ service: "jira", serviceId: "github" })).toBe("jira");
  });

  test("falls back to `serviceId` when `service` is absent", () => {
    expect(parseServiceArg({ serviceId: "github" })).toBe("github");
  });

  test("falls back to `serviceId` when `service` is present but not a string", () => {
    expect(parseServiceArg({ service: null, serviceId: "github" })).toBe("github");
  });

  test("rejects an absent params object", () => {
    expect(() => parseServiceArg(undefined)).toThrow("Invalid or unknown service");
  });
});

describe("parseAtlassianSiteCredentials", () => {
  const messages = {
    missingEmail: "jira requires atlassianEmail",
    missingToken: "jira requires personalAccessToken",
    missingBase: "jira requires apiBaseUrl",
  };

  test("accepts the canonical field names and strips trailing slashes from the base", () => {
    expect(
      parseAtlassianSiteCredentials(
        {
          atlassianEmail: " a@example.com ",
          personalAccessToken: " tok ",
          apiBaseUrl: " https://acme.atlassian.net/// ",
        },
        messages,
      ),
    ).toEqual({
      email: "a@example.com",
      apiToken: "tok",
      baseNormalized: "https://acme.atlassian.net",
    });
  });

  // Each field has aliases the IPC surface has always accepted. An alias that
  // silently stops working looks to the user like a rejected credential.
  test("accepts the `email` / `token` / `baseUrl` aliases", () => {
    expect(
      parseAtlassianSiteCredentials(
        { email: "b@example.com", token: "t2", baseUrl: "https://b.atlassian.net" },
        messages,
      ),
    ).toEqual({
      email: "b@example.com",
      apiToken: "t2",
      baseNormalized: "https://b.atlassian.net",
    });
  });

  test("accepts `apiToken` as the third token alias", () => {
    expect(
      parseAtlassianSiteCredentials(
        { email: "c@example.com", apiToken: "t3", baseUrl: "https://c.atlassian.net" },
        messages,
      ).apiToken,
    ).toBe("t3");
  });

  test("rejects a whitespace-only email with the caller's message", () => {
    expect(() =>
      parseAtlassianSiteCredentials(
        { atlassianEmail: "   ", personalAccessToken: "t", apiBaseUrl: "https://x" },
        messages,
      ),
    ).toThrow(messages.missingEmail);
  });

  test("rejects a whitespace-only token with the caller's message", () => {
    expect(() =>
      parseAtlassianSiteCredentials(
        { email: "a@example.com", token: "  ", baseUrl: "https://x" },
        messages,
      ),
    ).toThrow(messages.missingToken);
  });

  test("rejects a missing base URL with the caller's message", () => {
    expect(() =>
      parseAtlassianSiteCredentials({ email: "a@example.com", token: "t" }, messages),
    ).toThrow(messages.missingBase);
  });

  test("rejects a non-string token rather than coercing it", () => {
    expect(() =>
      parseAtlassianSiteCredentials(
        { email: "a@example.com", token: 12345, baseUrl: "https://x" },
        messages,
      ),
    ).toThrow(messages.missingToken);
  });

  test("rejects an entirely absent params object", () => {
    expect(() => parseAtlassianSiteCredentials(undefined, messages)).toThrow(messages.missingEmail);
  });
});

describe("registerAtlassianApiConnectorAuth", () => {
  test("writes exactly the three service-scoped vault keys and registers the scheduler", async () => {
    const { vault, writes } = recordingVault();
    const result = await registerAtlassianApiConnectorAuth({
      vault,
      localIndex,
      serviceId: "confluence",
      creds: {
        email: "a@example.com",
        apiToken: "tok",
        baseNormalized: "https://acme.atlassian.net",
      },
    });

    expect(writes).toEqual([
      ["confluence.email", "a@example.com"],
      ["confluence.api_token", "tok"],
      ["confluence.base_url", "https://acme.atlassian.net"],
    ]);
    expect(result).toEqual({ ok: true, serviceId: "confluence", scopesGranted: [] });
    expect(localIndex.persistedConnectorStatuses("confluence")).toHaveLength(1);
  });

  test("registers jira under its own service id, with a positive sync interval", async () => {
    const { vault } = recordingVault();
    await registerAtlassianApiConnectorAuth({
      vault,
      localIndex,
      serviceId: "jira",
      creds: { email: "a@example.com", apiToken: "t", baseNormalized: "https://acme" },
    });
    const [status] = localIndex.persistedConnectorStatuses("jira");
    expect(status?.serviceId).toBe("jira");
    expect(status?.intervalMs).toBeGreaterThan(0);
    // The confluence keyspace must be untouched — a cross-service write here
    // would hand one connector's credential to another.
    expect(localIndex.persistedConnectorStatuses("confluence")).toHaveLength(0);
  });
});
