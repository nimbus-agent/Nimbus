import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { LocalIndex } from "../index/local-index.ts";

import {
  buildLocalOnlySyncCapabilities,
  buildSyncCapabilities,
  type SyncCapabilityDeps,
  unboundSyncCapabilities,
} from "./sync-capabilities.ts";

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
    // Pinned deliberately: adding a capability should be a considered act, so this list is the
    // review surface. `getSharedSecret` was added for the four connectors that authenticate with a
    // shared gcp.*/github.* credential, and this assertion is what made that visible.
    expect(Object.keys(caps).sort()).toEqual([
      "accessToken",
      "bodyFetchState",
      "countItems",
      "deleteItem",
      "getSecret",
      "getSharedSecret",
      "itemExists",
      "itemMetadata",
      "listIndexedMetadataValues",
      "prEnrichCandidates",
      "prFileCandidates",
      "pruneBlameForFile",
      "recordPrChangedFiles",
      "resolvePerson",
      "scopedVaultView",
      "upsertBlameLines",
      "upsertItem",
      "writeApiEndpointsForSpec",
      "writeObsidianVault",
    ]);
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

describe("shared-credential grants", () => {
  test("a granted family resolves that family's key", async () => {
    const d = deps({ "gcp.project_id": "acme-prod" });
    const caps = buildSyncCapabilities(d, "bigquery");
    expect(await caps.getSharedSecret("gcp", "project_id")).toBe("acme-prod");
  });

  test("an UNGRANTED family throws rather than returning null", async () => {
    // Returning null would be indistinguishable from an unconfigured connector, which is how a
    // missing grant would go unnoticed for a release. The throw names the fix.
    const caps = buildSyncCapabilities(deps({ "gcp.project_id": "acme-prod" }), "jira");
    expect(() => caps.getSharedSecret("gcp", "project_id")).toThrow(
      /no shared-credential grant for "gcp"/,
    );
  });

  test("the grant is per service, not global", async () => {
    const d = deps({ "github.pat": "p" });
    expect(await buildSyncCapabilities(d, "github_actions").getSharedSecret("github", "pat")).toBe(
      "p",
    );
    expect(() => buildSyncCapabilities(d, "bigquery").getSharedSecret("github", "pat")).toThrow();
  });
});

describe("every capability routes to its gateway function", () => {
  // The wrappers are one-liners, which is exactly why they need calling: a typo in any of them
  // (wrong argument order, wrong helper) is invisible until a connector misbehaves at runtime.
  function caps() {
    const d = deps({});
    return { caps: buildSyncCapabilities(d, "github"), db: d.db };
  }

  test("upsertItem writes through the depth chokepoint", () => {
    const { caps: c, db } = caps();
    c.upsertItem({
      service: "github",
      type: "pull_request",
      externalId: "o/r#1",
      title: "PR",
      bodyPreview: "b",
      modifiedAt: 1,
      metadata: {},
      syncedAt: 1,
    });
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 1 });
  });

  test("deleteItem removes what upsertItem wrote", () => {
    const { caps: c, db } = caps();
    const row = {
      service: "github",
      type: "pull_request",
      externalId: "o/r#2",
      title: "PR",
      bodyPreview: "b",
      modifiedAt: 1,
      metadata: {},
      syncedAt: 1,
    };
    c.upsertItem(row);
    c.deleteItem("github", "o/r#2");
    expect(db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 0 });
  });

  test("countItems and itemExists agree with what was written", () => {
    const { caps: c } = caps();
    expect(c.countItems("github", "pull_request")).toBe(0);
    expect(c.itemExists("github:nope")).toBe(false);
    c.upsertItem({
      service: "github",
      type: "pull_request",
      externalId: "o/r#3",
      title: "PR",
      bodyPreview: "b",
      modifiedAt: 1,
      metadata: {},
      syncedAt: 1,
    });
    expect(c.countItems("github", "pull_request")).toBe(1);
    expect(c.countItems("github", "issue")).toBe(0);
  });

  test("itemMetadata returns the stored JSON, and null for an absent item", () => {
    const { caps: c } = caps();
    expect(c.itemMetadata("github:missing")).toBeNull();
    c.upsertItem({
      service: "github",
      type: "pull_request",
      externalId: "o/r#4",
      title: "PR",
      bodyPreview: "b",
      modifiedAt: 1,
      metadata: { repo: "o/r" },
      syncedAt: 1,
    });
    expect(c.itemMetadata("github:o/r#4")).toContain("o/r");
  });

  test("bodyFetchState is null until an item exists", () => {
    const { caps: c } = caps();
    expect(c.bodyFetchState("github:absent")).toBeNull();
  });

  test("listIndexedMetadataValues returns distinct non-empty values", () => {
    const { caps: c } = caps();
    for (const [i, repo] of ["o/a", "o/a", "o/b"].entries()) {
      c.upsertItem({
        service: "github",
        type: "pull_request",
        externalId: `o/r#${String(10 + i)}`,
        title: "PR",
        bodyPreview: "b",
        modifiedAt: 1,
        metadata: { repo },
        syncedAt: 1,
      });
    }
    expect(c.listIndexedMetadataValues("github", "repo").sort()).toEqual(["o/a", "o/b"]);
  });

  test("listIndexedMetadataValues refuses a metadata key it cannot bind", () => {
    // The key is interpolated into a JSON path, the one place a bound parameter cannot do the job.
    const { caps: c } = caps();
    expect(() => c.listIndexedMetadataValues("github", "a'; DROP TABLE item; --")).toThrow(
      /unsafe metadata key/,
    );
  });

  test("prEnrichCandidates and prFileCandidates return empty on an empty index", () => {
    const { caps: c } = caps();
    expect(c.prEnrichCandidates(10)).toEqual([]);
    expect(c.prFileCandidates("github", 10)).toEqual([]);
  });

  test("the blame writers round-trip", () => {
    const { caps: c, db } = caps();
    c.upsertBlameLines("/repo", "a.ts", [
      { lineNo: 1, commitSha: "abc", authorName: "A", authorEmail: "a@b.c", authorTimeMs: 1 },
    ]);
    expect(db.query("SELECT COUNT(*) AS n FROM git_blame_line").get()).toEqual({ n: 1 });
    c.pruneBlameForFile("/repo", "a.ts");
    expect(db.query("SELECT COUNT(*) AS n FROM git_blame_line").get()).toEqual({ n: 0 });
  });

  test("scopedVaultView is scoped to the service it was asked for", () => {
    const { caps: c } = caps();
    expect(c.scopedVaultView("github")).toBeDefined();
  });
});

describe("unbound and local-only capability sets", () => {
  test("EVERY unbound capability throws, and names itself in the message", () => {
    // Iterating the whole set rather than a sample: the property is meant to hold for every
    // member, and a sampled test would let a newly added capability ship silently returning
    // undefined — which is the exact fail-open this design exists to remove.
    const u = unboundSyncCapabilities() as unknown as Record<string, (...a: unknown[]) => unknown>;
    const names = Object.keys(u);
    expect(names.length).toBeGreaterThan(15);
    for (const name of names) {
      expect(() => u[name]?.()).toThrow(
        new RegExp(`^${name} was called on an unbound SyncContext`),
      );
    }
  });

  test("a local-only syncable gets the db capabilities but no credentials", () => {
    const d = deps({});
    const c = buildLocalOnlySyncCapabilities(d, "obsidian");
    // Local-only means no outbound request, therefore no credentials at all — and that must hold
    // for every credential capability, not just the one a test happened to pick.
    const asAny = c as unknown as Record<string, (...a: unknown[]) => unknown>;
    for (const name of ["getSecret", "getSharedSecret", "accessToken"]) {
      expect(() => asAny[name]?.()).toThrow(/local-only syncable/);
    }
    // ...but it still writes to the index, which is its whole job.
    c.upsertItem({
      service: "obsidian",
      type: "obsidian_note",
      externalId: "v1/a.md",
      title: "a",
      body: "x",
      modifiedAt: 1,
      metadata: {},
      syncedAt: 1,
    });
    expect(d.db.query("SELECT COUNT(*) AS n FROM item").get()).toEqual({ n: 1 });
  });
});
