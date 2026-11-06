/**
 * listFirstPartyServerTools: one first-party server's raw tools. Every guard is tested against the
 * ensure seams: a refused service must never reach its slot's `ensure*Running`, and never another
 * slot's.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { MCPClient } from "@mastra/mcp";
import { serviceOf } from "../../engine/service-of.ts";
import type { PlatformPaths } from "../../platform/paths.ts";
import { createMockVault } from "../../vault/mock.ts";
import { perServiceOAuthVaultKey } from "../connector-vault.ts";
import { CONNECTOR_WRITE_ROWS } from "../connector-writes/index.ts";
import { isModelOfferableRow } from "../connector-writes/model-offerable.ts";
import { LazyDrainTracker } from "./drain.ts";
import { LAZY_MESH } from "./keys.ts";
import { LazyConnectorMesh } from "./mesh.ts";
import { SERVICE_CREDENTIAL_SERVICES } from "./service-credential.ts";
import type { LazyMcpSlot } from "./slot.ts";

const roots: string[] = [];
let mesh: LazyConnectorMesh | undefined;
const realFetch = globalThis.fetch;

function makePaths(): PlatformPaths {
  const root = mkdtempSync(join(tmpdir(), "nimbus-mesh-fp-"));
  roots.push(root);
  return {
    configDir: join(root, "config"),
    dataDir: join(root, "data"),
    logDir: join(root, "log"),
    socketPath: join(root, "sock"),
    extensionsDir: join(root, "ext"),
    tempDir: join(root, "tmp"),
    sandboxDir: join(root, "sandbox"),
  };
}

afterEach(async () => {
  globalThis.fetch = realFetch;
  if (mesh !== undefined) await mesh.disconnect();
  mesh = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const SCHEMA = { type: "object", properties: { name: { type: "string" } } };

function slotWith(m: LazyConnectorMesh, slot: string, tools: Record<string, unknown>): void {
  const client = { listTools: () => Promise.resolve(tools), disconnect: () => Promise.resolve() };
  (m as unknown as { lazySlots: Map<string, LazyMcpSlot> }).lazySlots.set(slot, {
    client: client as unknown as MCPClient,
    idleTimer: undefined,
    drain: new LazyDrainTracker(),
  });
}

/** Every `ensure*Running` the listing map can call, replaced by a counter. */
const ENSURE_METHODS = [
  "ensurePhase3BundleRunning",
  "ensureGoogleDriveRunning",
  "ensureMicrosoftBundleRunning",
  "ensureGithubRunning",
  "ensureGitlabRunning",
  "ensureSlackRunning",
  "ensureLinearRunning",
  "ensureJiraRunning",
  "ensureNotionRunning",
  "ensureConfluenceRunning",
  "ensureDiscordRunning",
  "ensureAppleRunning",
  "ensureObsidianRunning",
  "ensureBitbucketRunning",
  "ensurePagerdutyRunning",
] as const;

async function build(opts: {
  allowed?: (s: string) => boolean;
  secrets?: Record<string, string>;
  /** Slot key -> tools that slot lists. */
  slots?: Record<string, Record<string, unknown>>;
  obsidianVaultPaths?: readonly string[];
}) {
  const vault = createMockVault();
  for (const [k, v] of Object.entries(opts.secrets ?? {})) await vault.set(k, v);
  const m = new LazyConnectorMesh(makePaths(), vault, {
    ...(opts.allowed === undefined ? {} : { isConnectorAllowed: opts.allowed }),
    ...(opts.obsidianVaultPaths === undefined
      ? {}
      : { obsidianVaultPaths: opts.obsidianVaultPaths }),
  });
  mesh = m;
  const calls: string[] = [];
  const rec = m as unknown as Record<string, () => Promise<void>>;
  for (const name of ENSURE_METHODS) {
    rec[name] = async () => {
      calls.push(name);
    };
  }
  for (const [slot, tools] of Object.entries(opts.slots ?? {})) slotWith(m, slot, tools);
  return { m, ensures: () => calls.length, calls };
}

const ARGO = { "argocd.url": "https://argo.example.com", "argocd.token": "t" };
const ARGO_TOOLS = {
  argocd_app_sync: { description: "sync", inputSchema: SCHEMA, execute: async () => ({}) },
  flux_reconcile: { description: "foreign", execute: async () => ({}) },
};

const GOOGLE_TOOLS = {
  google_drive_gdrive_file_create: { description: "create", inputSchema: SCHEMA },
  gmail_gmail_draft_create: { description: "draft", inputSchema: SCHEMA },
};

/** A refresh-shaped token JSON: an expired access token a refresh WOULD exchange. */
const EXPIRED_OAUTH = JSON.stringify({
  access_token: "a",
  refresh_token: "r",
  expires_at: 1,
});

function driveOnly(): Record<string, string> {
  const key = perServiceOAuthVaultKey("google_drive");
  if (key === undefined) throw new Error("google_drive has a per-service key");
  return { [key]: EXPIRED_OAUTH };
}

function failOnFetch(): { calls: () => number } {
  let n = 0;
  globalThis.fetch = (() => {
    n += 1;
    throw new Error("the credential check must never reach the network");
  }) as unknown as typeof fetch;
  return { calls: () => n };
}

describe("listFirstPartyServerTools", () => {
  test("a configured, allowed service lists its raw entries (inputSchema kept), foreign keys filtered", async () => {
    const { m, ensures } = await build({
      secrets: ARGO,
      slots: { [LAZY_MESH.phase3Bundle]: ARGO_TOOLS },
    });
    const out = await m.listFirstPartyServerTools("argocd");
    expect(Object.keys(out ?? {})).toEqual(["argocd_app_sync"]);
    const entry = out?.["argocd_app_sync"] as { inputSchema: unknown } | undefined;
    expect(entry?.inputSchema).toEqual(SCHEMA);
    // The listed `execute` closure would dispatch around the executor chokepoint: never handed out.
    expect(
      Object.keys((out?.["argocd_app_sync"] ?? {}) as object).sort((x, y) => x.localeCompare(y)),
    ).toEqual(["description", "inputSchema"]);
    expect(ensures()).toBe(1);
  });

  test("a policy-blocked service whose credentials ARE present spawns nothing", async () => {
    const asked: string[] = [];
    const { m, ensures } = await build({
      secrets: ARGO,
      slots: { [LAZY_MESH.phase3Bundle]: ARGO_TOOLS },
      allowed: (s) => {
        asked.push(s);
        return false;
      },
    });
    expect(await m.listFirstPartyServerTools("argocd")).toBeUndefined();
    expect(asked).toEqual(["argocd"]);
    expect(ensures()).toBe(0);
  });

  test("an unconfigured service inside an already-running bundle returns undefined", async () => {
    // flux has no credentials; the bundle is up (for argocd) and lists flux tools.
    const { m, ensures } = await build({
      secrets: ARGO,
      slots: { [LAZY_MESH.phase3Bundle]: ARGO_TOOLS },
    });
    expect(await m.listFirstPartyServerTools("flux")).toBeUndefined();
    expect(m.toolsGenerationFor("flux")).toBe(-1);
    expect(ensures()).toBe(0);
  });

  test("a service with write rows but no map entry fails closed, even inside a running bundle", async () => {
    // bitbucket has its own slot and is not in the listing map, so a configured slot never lists it.
    const { m, ensures } = await build({
      secrets: { "bitbucket.username": "u" },
      slots: {
        [LAZY_MESH.bitbucket]: { bitbucket_bitbucket_pr_merge: { inputSchema: SCHEMA } },
      },
    });
    for (const s of ["bitbucket"]) {
      expect(await m.listFirstPartyServerTools(s), s).toBeUndefined();
      expect(m.toolsGenerationFor(s), s).toBe(-1);
    }
    expect(ensures()).toBe(0);
  });

  test("a service without write rows, and user-MCP / extension ids, return undefined", async () => {
    const { m, ensures } = await build({
      secrets: ARGO,
      slots: { [LAZY_MESH.phase3Bundle]: ARGO_TOOLS },
    });
    for (const s of [
      "datadog",
      "discord",
      "mcp_demo",
      "ext_demo",
      "",
      "__proto__",
      "constructor",
    ]) {
      expect(await m.listFirstPartyServerTools(s), s).toBeUndefined();
      expect(m.toolsGenerationFor(s), s).toBe(-1);
    }
    expect(ensures()).toBe(0);
  });
});

describe("listFirstPartyServerTools: wave-2 services on their own slots", () => {
  test("google_drive configured with its bundle running, gmail unconfigured: gmail is undefined and -1", async () => {
    const fetches = failOnFetch();
    const { m, calls } = await build({
      secrets: driveOnly(),
      slots: { [LAZY_MESH.googleBundle]: GOOGLE_TOOLS },
    });
    const drive = await m.listFirstPartyServerTools("google_drive");
    expect(Object.keys(drive ?? {})).toEqual(["google_drive_gdrive_file_create"]);
    expect(m.toolsGenerationFor("google_drive")).toBeGreaterThanOrEqual(0);
    // The bundle is up and lists gmail's tools, but gmail's OWN credential is absent.
    expect(await m.listFirstPartyServerTools("gmail")).toBeUndefined();
    expect(m.toolsGenerationFor("gmail")).toBe(-1);
    expect(calls).toEqual(["ensureGoogleDriveRunning"]);
    // The credential check read stored keys only: no token refresh, no network.
    expect(fetches.calls()).toBe(0);
  });

  test("a configured service whose server is absent from its running slot is undefined, not {}", async () => {
    const gmailKey = perServiceOAuthVaultKey("gmail") ?? "";
    const { m } = await build({
      secrets: { [gmailKey]: EXPIRED_OAUTH },
      // The bundle came up without gmail (its token could not be refreshed at spawn).
      slots: { [LAZY_MESH.googleBundle]: { google_drive_gdrive_file_create: {} } },
    });
    expect(await m.listFirstPartyServerTools("gmail")).toBeUndefined();
    expect(m.toolsGenerationFor("gmail")).toBe(-1);
  });

  test("each service ensures only its own slot and lists only its own server's keys", async () => {
    const { m, calls } = await build({
      secrets: {
        "github.pat": "p",
        "jira.api_token": "t",
        "jira.email": "e",
        "jira.base_url": "u",
      },
      slots: {
        [LAZY_MESH.github]: {
          github_github_issue_create: { inputSchema: SCHEMA },
          github_actions_gha_run_trigger: { inputSchema: SCHEMA },
        },
        [LAZY_MESH.jira]: { jira_jira_issue_create: { inputSchema: SCHEMA } },
      },
    });
    expect(Object.keys((await m.listFirstPartyServerTools("github")) ?? {})).toEqual([
      "github_github_issue_create",
    ]);
    expect(Object.keys((await m.listFirstPartyServerTools("jira")) ?? {})).toEqual([
      "jira_jira_issue_create",
    ]);
    expect(calls).toEqual(["ensureGithubRunning", "ensureJiraRunning"]);
  });

  test("a partial multi-key credential (jira without base_url) is unconfigured", async () => {
    const { m, ensures } = await build({
      secrets: { "jira.api_token": "t", "jira.email": "e" },
      slots: { [LAZY_MESH.jira]: { jira_jira_issue_create: {} } },
    });
    expect(await m.listFirstPartyServerTools("jira")).toBeUndefined();
    expect(ensures()).toBe(0);
  });

  test("onedrive ensures ONLY the Microsoft bundle slot and lists only its own server's keys (C1)", async () => {
    const { m, calls } = await build({
      secrets: { "microsoft.oauth": EXPIRED_OAUTH },
      slots: {
        [LAZY_MESH.microsoftBundle]: {
          onedrive_onedrive_item_move: { inputSchema: SCHEMA },
          outlook_outlook_draft_create: { inputSchema: SCHEMA },
        },
      },
    });
    expect(m.toolsGenerationFor("onedrive")).toBe(-1);
    expect(Object.keys((await m.listFirstPartyServerTools("onedrive")) ?? {})).toEqual([
      "onedrive_onedrive_item_move",
    ]);
    expect(m.toolsGenerationFor("onedrive")).toBeGreaterThanOrEqual(0);
    expect(calls).toEqual(["ensureMicrosoftBundleRunning"]);
  });

  test("pagerduty ensures ONLY its own slot; -1 until a listing confirmed it (C1)", async () => {
    const { m, calls } = await build({
      secrets: { "pagerduty.api_token": "t", "pagerduty.from_email": "a@b.co" },
      slots: {
        [LAZY_MESH.pagerduty]: { pagerduty_pd_incident_acknowledge: { inputSchema: SCHEMA } },
      },
    });
    expect(m.toolsGenerationFor("pagerduty")).toBe(-1);
    expect(Object.keys((await m.listFirstPartyServerTools("pagerduty")) ?? {})).toEqual([
      "pagerduty_pd_incident_acknowledge",
    ]);
    expect(m.toolsGenerationFor("pagerduty")).toBe(0);
    expect(calls).toEqual(["ensurePagerdutyRunning"]);
  });

  test("an unconfigured onedrive or pagerduty (token without from_email) never reaches any ensure*", async () => {
    const { m, ensures } = await build({
      secrets: { "pagerduty.api_token": "t" },
      slots: {
        [LAZY_MESH.microsoftBundle]: { onedrive_onedrive_item_move: {} },
        [LAZY_MESH.pagerduty]: { pagerduty_pd_incident_acknowledge: {} },
      },
    });
    for (const s of ["onedrive", "pagerduty"]) {
      expect(await m.listFirstPartyServerTools(s), s).toBeUndefined();
      expect(m.toolsGenerationFor(s), s).toBe(-1);
    }
    expect(ensures()).toBe(0);
  });

  test("obsidian is configured by its vault paths, never by the Vault", async () => {
    const without = await build({ slots: { [LAZY_MESH.obsidian]: { obsidian_x: {} } } });
    expect(await without.m.listFirstPartyServerTools("obsidian")).toBeUndefined();
    expect(without.ensures()).toBe(0);
    await without.m.disconnect();
    const withPaths = await build({
      obsidianVaultPaths: [join(tmpdir(), "vault")],
      slots: { [LAZY_MESH.obsidian]: { obsidian_obsidian_append_to_daily_note: {} } },
    });
    expect(Object.keys((await withPaths.m.listFirstPartyServerTools("obsidian")) ?? {})).toEqual([
      "obsidian_obsidian_append_to_daily_note",
    ]);
    expect(withPaths.calls).toEqual(["ensureObsidianRunning"]);
  });

  test("a later listing that finds the credential gone takes the generation back to -1", async () => {
    const { m } = await build({
      secrets: { "github.pat": "p" },
      slots: { [LAZY_MESH.github]: { github_github_issue_create: {} } },
    });
    await m.listFirstPartyServerTools("github");
    expect(m.toolsGenerationFor("github")).toBeGreaterThanOrEqual(0);
    await (m as unknown as { vault: { delete(k: string): Promise<void> } }).vault.delete(
      "github.pat",
    );
    expect(await m.listFirstPartyServerTools("github")).toBeUndefined();
    expect(m.toolsGenerationFor("github")).toBe(-1);
  });

  test("every wave-2 service in the listing map has its own credential predicate", () => {
    expect([...SERVICE_CREDENTIAL_SERVICES]).toEqual(
      [
        "apple",
        "confluence",
        "discord",
        "github",
        "gitlab",
        "gmail",
        "google_drive",
        "jira",
        "linear",
        "notion",
        "obsidian",
        "onedrive",
        "outlook",
        "pagerduty",
        "slack",
        "teams",
      ].sort((a, b) => a.localeCompare(b)),
    );
  });
});

describe("every model-offerable write's service can be listed", () => {
  test("it is in the explicit listing map and has a credential check, so the door never says 'not listed' for a shipped row", () => {
    const m = new LazyConnectorMesh(makePaths(), createMockVault(), {});
    mesh = m;
    const listing = (
      m as unknown as { firstPartyListing: Readonly<Record<string, { slot: string }>> }
    ).firstPartyListing;
    const offerable = CONNECTOR_WRITE_ROWS.filter(isModelOfferableRow);
    expect(offerable.length).toBeGreaterThan(0);
    for (const r of offerable) {
      const service = serviceOf(r.actionType);
      expect(
        Object.hasOwn(listing, service),
        `${r.toolId}: ${service} is not in the listing map`,
      ).toBe(true);
      // A phase-3 bundle service is checked by its spawner's own adder; every other one needs a
      // per-service predicate in service-credential.ts.
      const bundled = listing[service]?.slot === LAZY_MESH.phase3Bundle;
      expect(
        bundled || SERVICE_CREDENTIAL_SERVICES.includes(service),
        `${r.toolId}: ${service} has no credential predicate`,
      ).toBe(true);
    }
  });
});

describe("toolsGenerationFor: a per-slot generation", () => {
  type Private = {
    setLazyClient(key: string, client: MCPClient): void;
    stopLazyClient(key: string): Promise<void>;
  };
  const fakeClient = (tools: Record<string, unknown> = {}) =>
    ({
      listTools: () => Promise.resolve(tools),
      disconnect: () => Promise.resolve(),
    }) as unknown as MCPClient;

  const TABLEAU = {
    "tableau.server_url": "https://t.example.com",
    "tableau.site_content_url": "s",
    "tableau.pat_name": "n",
    "tableau.pat_secret": "x",
  };

  test("spawning or stopping ANOTHER slot leaves the listing slot's generation unchanged", async () => {
    const { m } = await build({ secrets: ARGO, slots: { [LAZY_MESH.phase3Bundle]: ARGO_TOOLS } });
    const p = m as unknown as Private;
    await m.listFirstPartyServerTools("argocd");
    expect(m.toolsGenerationFor("argocd")).toBe(0);
    p.setLazyClient(LAZY_MESH.discord, fakeClient());
    await p.stopLazyClient(LAZY_MESH.discord);
    expect(m.toolsGenerationFor("argocd")).toBe(0);
    // The global epoch DID move: that is exactly what the door must not key on.
    expect(m.getToolsEpoch()).toBeGreaterThan(0);
  });

  test("spawning or stopping the listing slot itself bumps the hosted service's generation", async () => {
    const { m } = await build({ secrets: ARGO });
    const p = m as unknown as Private;
    p.setLazyClient(LAZY_MESH.phase3Bundle, fakeClient(ARGO_TOOLS));
    await m.listFirstPartyServerTools("argocd");
    expect(m.toolsGenerationFor("argocd")).toBe(1);
    await p.stopLazyClient(LAZY_MESH.phase3Bundle);
    expect(m.toolsGenerationFor("argocd")).toBe(2);
  });

  test("wave-2 slots are isolated: the Google bundle restarting leaves github's generation alone", async () => {
    const { m } = await build({ secrets: { ...driveOnly(), "github.pat": "p" } });
    const p = m as unknown as Private;
    p.setLazyClient(LAZY_MESH.googleBundle, fakeClient(GOOGLE_TOOLS));
    p.setLazyClient(LAZY_MESH.github, fakeClient({ github_github_issue_create: {} }));
    await m.listFirstPartyServerTools("google_drive");
    await m.listFirstPartyServerTools("github");
    expect(m.toolsGenerationFor("google_drive")).toBe(1);
    expect(m.toolsGenerationFor("github")).toBe(1);
    await p.stopLazyClient(LAZY_MESH.googleBundle);
    expect(m.toolsGenerationFor("google_drive")).toBe(2);
    expect(m.toolsGenerationFor("github")).toBe(1);
  });

  test("a mapped service is -1 until a listing confirms it; unmapped ids are always -1, never NaN", async () => {
    const { m } = await build({ secrets: { ...ARGO, ...TABLEAU, "github.pat": "p" } });
    for (const s of ["argocd", "tableau", "github", "gmail", "bitbucket", "mcp_x", "__proto__"]) {
      expect(m.toolsGenerationFor(s), s).toBe(-1);
    }
  });
});
