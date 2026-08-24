import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";

import { buildSyncCapabilities, type SyncCapabilityDeps } from "./sync-capabilities.ts";

function deps(entries: Record<string, string>): SyncCapabilityDeps {
  const asked: string[] = [];
  const vault = {
    get: (key: string) => {
      asked.push(key);
      return Promise.resolve(entries[key] ?? null);
    },
  } as unknown as SyncCapabilityDeps["vault"];
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  return { vault, db, depth: "full", asked } as SyncCapabilityDeps & {
    asked: string[];
  };
}

describe("getSecret is scoped to the calling service", () => {
  test("prefixes the bound service id", async () => {
    const d = deps({ "jira.api_token": "tok" });
    const caps = buildSyncCapabilities(d, "jira");
    expect(await caps.getSecret("api_token")).toBe("tok");
  });

  test("cannot reach another service's secret by naming it", async () => {
    // Today `ctx.vault.get("slack.token")` returns this. That is the capability being removed.
    const d = deps({ "slack.token": "other" });
    const caps = buildSyncCapabilities(d, "jira");
    // The name is prefixed, becoming "jira.slack.token", which does not exist.
    expect(await caps.getSecret("slack.token" as never)).toBeNull();
  });

  test("the bound service decides which vault key is read", async () => {
    // linear's key is `api_key`, not `api_token` — and passing the wrong one here is a COMPILE
    // error, not a runtime null. That is the compile-time checking `readConnectorSecret` gives
    // today, preserved rather than widened to `string`.
    const d = deps({ "jira.api_token": "J", "linear.api_key": "L" });
    expect(await buildSyncCapabilities(d, "jira").getSecret("api_token")).toBe("J");
    expect(await buildSyncCapabilities(d, "linear").getSecret("api_key")).toBe("L");
  });

  test("a missing key is null, not a throw", async () => {
    const caps = buildSyncCapabilities(deps({}), "jira");
    expect(await caps.getSecret("api_token")).toBeNull();
  });
});

describe("the capability set exposes no raw handle", () => {
  test("neither vault nor db is reachable from the returned object", () => {
    const caps = buildSyncCapabilities(deps({}), "jira");
    expect(Object.keys(caps).sort()).toEqual(["getSecret", "resolvePerson", "upsertItem"]);
  });
});

describe("resolvePerson", () => {
  test("is synchronous and returns the id, not void", () => {
    // The first draft of this design had `linkPeople(): Promise<void>`, which would have made the
    // resolved id unreachable — callers set it as `authorId` on the item they are building.
    const caps = buildSyncCapabilities(deps({}), "jira");
    const out = caps.resolvePerson({ githubLogin: "octocat", displayName: "octocat" });
    expect(typeof out).toBe("string");
  });
});
