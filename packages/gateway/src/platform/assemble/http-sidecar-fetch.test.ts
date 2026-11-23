import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { LocalIndex } from "../../index/local-index.ts";
import type { SyncScheduler } from "../../sync/scheduler.ts";
import type { TargetedFetchOutcome } from "../../sync/targeted-fetch.ts";
import type { FetchOneResult, Syncable, SyncContext } from "../../sync/types.ts";
import { createMemoryVault } from "../../testing/bun-test-support.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import type { HttpSidecarOpts } from "./http-sidecar.ts";
import { bootTargetedFetchIntoHttpSidecar } from "./http-sidecar-boot.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
});
afterEach(() => {
  db.close();
});

type LedgerRow = {
  destination: string;
  source_type: string;
  source_id: string | null;
  method: string;
};
const ledger = (): LedgerRow[] =>
  db
    .query(`SELECT destination, source_type, source_id, method FROM egress_ledger ORDER BY id`)
    .all() as LedgerRow[];

async function vaultWith(entries: Record<string, string>): Promise<NimbusVault> {
  const vault = createMemoryVault();
  for (const [k, v] of Object.entries(entries)) await vault.set(k, v);
  return vault;
}

/** The wired closure also takes the caller's label, which `HttpSidecarOpts` types as optional-by-omission. */
type FetchItem = (url: string, callerLabel?: string) => Promise<TargetedFetchOutcome>;

type Harness = {
  fetchItem: FetchItem;
  fetched: string[];
  warnings: unknown[][];
};

/**
 * Boots the targeted-fetch closure over a stub scheduler whose connectors answer `result` for
 * every URL they accept, recording the URLs `fetchOne` actually saw.
 */
function boot(
  vault: NimbusVault,
  opts: {
    result?: FetchOneResult;
    registered?: boolean;
    withFetchOne?: boolean;
    /** How many `tryAcquire` polls fail before a token is granted. */
    deniedPolls?: number;
  } = {},
): Harness {
  const fetched: string[] = [];
  const warnings: unknown[][] = [];
  const syncable = (service: string): Syncable =>
    ({
      serviceId: service,
      ...(opts.withFetchOne === false
        ? {}
        : {
            fetchOne: async (_ctx: SyncContext, url: string) => {
              fetched.push(url);
              return opts.result ?? { status: "indexed", itemId: `item-${service}` };
            },
          }),
    }) as unknown as Syncable;
  let polls = 0;
  const ctx = {
    rateLimiter: { tryAcquire: async () => ++polls > (opts.deniedPolls ?? 0) },
  } as unknown as SyncContext;
  const scheduler = {
    syncableFor: (service: string) => (opts.registered === false ? undefined : syncable(service)),
    syncContextFor: () => ctx,
  } as unknown as SyncScheduler;
  const httpSidecarOpts: HttpSidecarOpts = {};
  bootTargetedFetchIntoHttpSidecar({
    db,
    vault,
    syncScheduler: scheduler,
    httpSidecarOpts,
    logger: { warn: (...args: unknown[]) => warnings.push(args) } as never,
  });
  const fetchItem = httpSidecarOpts.fetchItem as FetchItem | undefined;
  if (fetchItem === undefined) throw new Error("fetchItem was not wired");
  return { fetchItem, fetched, warnings };
}

const GITHUB_PR = "https://github.com/acme/widgets/pull/7";

describe("bootTargetedFetchIntoHttpSidecar", () => {
  test("a host no configured service claims is not_configured and writes no ledger row", async () => {
    const h = boot(await vaultWith({}));
    expect(await h.fetchItem(GITHUB_PR)).toEqual({ status: "not_configured" });
    expect(h.fetched).toEqual([]);
    expect(ledger()).toEqual([]);
  });

  test("a configured GitHub PR is fetched, ledgered with the caller's label, and its outcome marked", async () => {
    const h = boot(await vaultWith({ "github.pat": "ghp_x" }));
    expect(await h.fetchItem(GITHUB_PR, "clipper-1")).toEqual({
      status: "indexed",
      itemId: "item-github",
    });
    expect(h.fetched).toEqual([GITHUB_PR]);
    const rows = ledger();
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      destination: "github",
      source_type: "sync",
      source_id: "clipper-1",
      method: "items.fetch",
    });
    expect(rows[1]).toMatchObject({ destination: "github", source_type: "outcome" });
  });

  test("with no caller label the sync row is unattributed", async () => {
    const h = boot(await vaultWith({ "github.pat": "ghp_x" }));
    await h.fetchItem(GITHUB_PR);
    expect(ledger()[0]?.source_id).toBeNull();
  });

  test("a URL shape the service's connector would decline is unsupported_url and unledgered", async () => {
    const h = boot(await vaultWith({ "github.pat": "ghp_x" }));
    expect(await h.fetchItem("https://github.com/acme/widgets/pull/7/files")).toEqual({
      status: "unsupported_url",
    });
    expect(h.fetched).toEqual([]);
    expect(ledger()).toEqual([]);
  });

  test("a bucket that refills after a few polls waits (with the real sleep) and then fetches", async () => {
    const h = boot(await vaultWith({ "github.pat": "ghp_x" }), { deniedPolls: 2 });
    const started = Date.now();
    expect(await h.fetchItem(GITHUB_PR)).toEqual({ status: "indexed", itemId: "item-github" });
    // Two denied polls = two 100 ms sleeps through the closure this module supplies.
    expect(Date.now() - started).toBeGreaterThanOrEqual(150);
    expect(h.fetched).toEqual([GITHUB_PR]);
  });

  test("a service the scheduler has no connector for is not_configured, naming the service", async () => {
    const h = boot(await vaultWith({ "github.pat": "ghp_x" }), { registered: false });
    expect(await h.fetchItem(GITHUB_PR)).toEqual({ status: "not_configured", service: "github" });
  });

  test("a connector without a targeted fetch is no_targeted_fetch", async () => {
    const h = boot(await vaultWith({ "github.pat": "ghp_x" }), { withFetchOne: false });
    expect(await h.fetchItem(GITHUB_PR)).toEqual({
      status: "no_targeted_fetch",
      service: "github",
    });
  });

  test("a failing outcome append is swallowed and warned, never turned into a failed fetch", async () => {
    const h = boot(await vaultWith({ "github.pat": "ghp_x" }));
    // Break only the outcome row: drop the table's ability to accept a second insert.
    db.run(
      `CREATE TRIGGER fail_outcome BEFORE INSERT ON egress_ledger WHEN NEW.source_type = 'outcome'
       BEGIN SELECT RAISE(ABORT, 'outcome refused'); END`,
    );
    expect(await h.fetchItem(GITHUB_PR)).toEqual({ status: "indexed", itemId: "item-github" });
    expect(h.warnings).toHaveLength(1);
    expect(String(h.warnings[0]?.[1])).toContain("outcome marker");
    expect(ledger()).toHaveLength(1);
  });

  describe("per-service URL support decides whether anything is ledgered", () => {
    test.each([
      ["gitlab", { "gitlab.pat": "glpat" }, "https://gitlab.com/group/proj/-/merge_requests/3"],
      [
        "bitbucket",
        { "bitbucket.app_password": "pw", "bitbucket.username": "u" },
        "https://bitbucket.org/ws/repo/pull-requests/9",
      ],
      [
        "jenkins",
        {
          "jenkins.api_token": "t",
          "jenkins.username": "u",
          "jenkins.base_url": "https://ci.example.com",
        },
        "https://ci.example.com/job/build/12",
      ],
      [
        "jira",
        {
          "jira.api_token": "t",
          "jira.email": "a@b.c",
          "jira.base_url": "https://acme.atlassian.net",
        },
        "https://acme.atlassian.net/browse/ENG-42",
      ],
    ])("%s: a supported URL is fetched and ledgered", async (service, secrets, url) => {
      const h = boot(await vaultWith(secrets));
      expect(await h.fetchItem(url)).toEqual({ status: "indexed", itemId: `item-${service}` });
      expect(ledger()[0]).toMatchObject({ destination: service, source_type: "sync" });
    });

    test.each([
      ["gitlab", { "gitlab.pat": "glpat" }, "https://gitlab.com/group/proj/-/issues/3"],
      [
        "bitbucket",
        { "bitbucket.app_password": "pw", "bitbucket.username": "u" },
        "https://bitbucket.org/ws/repo/src/main",
      ],
      [
        "jenkins",
        {
          "jenkins.api_token": "t",
          "jenkins.username": "u",
          "jenkins.base_url": "https://ci.example.com",
        },
        "https://ci.example.com/view/all",
      ],
      [
        "jira",
        {
          "jira.api_token": "t",
          "jira.email": "a@b.c",
          "jira.base_url": "https://acme.atlassian.net",
        },
        "https://acme.atlassian.net/projects/ENG",
      ],
    ])(
      "%s: an unsupported URL is declined before any ledger row",
      async (_service, secrets, url) => {
        const h = boot(await vaultWith(secrets));
        expect(await h.fetchItem(url)).toEqual({ status: "unsupported_url" });
        expect(ledger()).toEqual([]);
      },
    );

    test("jira: a URL on a different host than the configured base is declined", async () => {
      const h = boot(
        await vaultWith({
          "jira.api_token": "t",
          "jira.email": "a@b.c",
          "jira.base_url": "https://acme.atlassian.net",
        }),
      );
      // The host boundary does not claim another host at all.
      expect(await h.fetchItem("https://other.atlassian.net/browse/ENG-1")).toEqual({
        status: "not_configured",
      });
      expect(ledger()).toEqual([]);
    });
  });

  describe("the http exception", () => {
    const gitlabHttp = {
      "gitlab.pat": "glpat",
      "gitlab.api_base": "http://gitlab.internal:8080/api/v4",
    };

    test("a self-hosted service's own http origin is accepted", async () => {
      const h = boot(await vaultWith(gitlabHttp));
      const url = "http://gitlab.internal:8080/group/proj/-/merge_requests/3";
      expect(await h.fetchItem(url)).toEqual({ status: "indexed", itemId: "item-gitlab" });
    });

    test("an http URL on another port of the same host is refused", async () => {
      const h = boot(await vaultWith(gitlabHttp));
      const url = "http://gitlab.internal:9999/group/proj/-/merge_requests/3";
      const out = await h.fetchItem(url);
      expect(["not_configured", "unsupported_url"]).toContain(out.status);
      expect(h.fetched).toEqual([]);
      expect(ledger()).toEqual([]);
    });

    test("a caller-chosen http URL for an https-only service is refused", async () => {
      const h = boot(await vaultWith({ "github.pat": "ghp_x" }));
      expect(await h.fetchItem("http://github.com/acme/widgets/pull/7")).toEqual({
        status: "unsupported_url",
      });
      expect(ledger()).toEqual([]);
    });

    test("revoking the credential removes the exception on the next call (nothing is cached)", async () => {
      const vault = await vaultWith(gitlabHttp);
      const h = boot(vault);
      const url = "http://gitlab.internal:8080/group/proj/-/merge_requests/3";
      expect((await h.fetchItem(url)).status).toBe("indexed");
      await vault.delete("gitlab.pat");
      expect(await h.fetchItem(url)).toEqual({ status: "not_configured" });
    });
  });
});
