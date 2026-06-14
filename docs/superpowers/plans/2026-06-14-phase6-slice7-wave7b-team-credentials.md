# Phase 6 Slice 7 — Wave 7b: Team-Shared Credentials Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the six Wave-7a warehouse/BI connectors (snowflake, tableau, looker, powerbi, montecarlo, bigeye) optionally source their credential from **Team Vault** through the existing **I19** secret chokepoint, with both personal and team sync unified onto a spawn → `<svc>_list` (paginated) → gateway-maps-and-indexes transport.

**Architecture:** A new `[connectors.<name>]` config family selects `personal` (default) or `team` credential per connector. Sync no longer calls `connectorFetch` gateway-side; instead it spawns the connector once per cycle (`withConnectorSession`) and drains a paginated `<svc>_list` tool. Personal spawns use a **service-scoped vault view**; team spawns route through a **principal-polymorphic** `answerFederatedInvoke` (peer | localOperator) into the unchanged `invokeTeamTool` secret chokepoint. The secret never enters gateway heap (faithful I19).

**Tech Stack:** Bun 1.2+, TypeScript 6 strict, Biome, `bun:sqlite`, `bun:test`, `@mastra/mcp` (`MCPClient`), Zod (connector tool schemas), hand-rolled TOML parser in `config/nimbus-toml.ts`.

**Scope decisions locked with the user (2026-06-14):** Keep **D5** (unify personal onto spawn) and **D6** (full vendor pagination). The 6 vendor cursor contracts are implemented against each vendor's *documented* pagination model and tested by faking that shape at the HTTP boundary; they are **not** verifiable against live APIs in this environment — each connector task carries a "verify against live docs" note. See the design's §11 review dispositions and `2026-06-14-phase6-slice7-wave7b-team-credentials-design.md`.

**Staging (design O6):** config → session seam + gate refactor (+ I19 test) → **snowflake** end-to-end → fan out the other five sequentially (commit per connector to avoid subagent-death mid-registration) → docs + preflight + Docker coverage dry-run.

---

## File Structure

**New files (gateway):**

- `packages/gateway/src/config/nimbus-toml-connectors.ts` — `[connectors.<name>]` parse + validate + `loadNimbusConnectorsFromConfigDir`. (Kept out of the already-large `nimbus-toml.ts`; re-exported from it for parity with siblings.)
- `packages/gateway/src/connectors/service-scoped-vault-view.ts` — `createServiceScopedVaultView(vault, service)` (personal single-service spawn scope).
- `packages/gateway/src/connectors/connector-list-page.ts` — `parseMcpListPage`, `drainPagedList` (gateway-side unwrap + pagination drain shared by personal + team).
- `packages/gateway/src/teamvault/connector-session.ts` — `withConnectorSession` (spawn-once primitive yielding a `call(toolId,args)`), refactored out of `team-tool-spawn.ts`.
- `packages/gateway/src/connectors/warehouse-sync-transport.ts` — `listConnectorItems(ctx, service, listToolId)`: the personal-vs-team branch the 6 handlers call.

**Modified files (gateway):**

- `packages/gateway/src/federation/invoke-gate.ts` — principal-polymorphic gate.
- `packages/gateway/src/teamvault/team-vault-audit.ts` — principal descriptor instead of required `peerId`.
- `packages/gateway/src/teamvault/team-tool-invoke.ts` — add `invokeTeamToolList` (paginated drain in one session).
- `packages/gateway/src/teamvault/team-tool-spawn.ts` — re-implement on `withConnectorSession`.
- `packages/gateway/src/ipc/federation-rpc.ts` — adapt `InboundInvoke` → `{ principal:{kind:"peer",peerId} }` (byte-identical).
- `packages/gateway/src/sync/types.ts` — `SyncContext` gains `sandboxCwd`, `credentialFor`, `runTeamList`.
- `packages/gateway/src/platform/assemble.ts` + `assemble-sync-registrations.ts` — load connectors config, thread the new `SyncContext` members, wire `runTeamList` through the gate.
- `packages/gateway/src/connectors/{snowflake,tableau,looker,powerbi,monte-carlo,bigeye}-sync.ts` — drop `connectorFetch`; call `listConnectorItems`.
- `packages/gateway/src/security-invariants.test.ts` — extend I19 for localOperator.

**Modified files (connectors):**

- `packages/mcp-connectors/{snowflake,tableau,looker,powerbi,monte-carlo,bigeye}/src/server.ts` — `<svc>_list` gains `{cursor,limit}` → `{items,nextCursor}`; new `test/server-list-pagination.test.ts` each.

**Docs:** `docs/SECURITY-INVARIANTS.md` (I19 wording), `CLAUDE.md` + `GEMINI.md` (I19 line), `docs/CHANGELOG.md`, `docs/roadmap.md`.

---

## Conventions for every task

- **TDD:** write the failing test, run it red, implement, run it green, commit.
- **Run a single gateway test file:** `bun test packages/gateway/src/<path>.test.ts` (from the worktree root).
- **Typecheck (catches wiring `bun test` hides):** `bun run typecheck` (or the package's `tsc --noEmit`). Run it before each commit that changes a `.ts` signature.
- **No `any`** — `unknown` + narrowing. **No hardcoded dates** in fixtures — use `Date.now()`-relative values.
- **Commit message prefix:** `feat(teamvault):` / `feat(connectors):` / `test:` / `docs:` as appropriate; end with the Co-Authored-By trailer.
- **Branch:** `dev/asafgolombek/phase6-slice7-wave7b` (already checked out in the worktree). Verify with `git rev-parse --abbrev-ref HEAD` before the first commit.

---

## Phase 0 — Foundations

## Task 1: `[connectors.<name>]` config schema + parser

**Files:**

- Create: `packages/gateway/src/config/nimbus-toml-connectors.ts`
- Create: `packages/gateway/src/config/nimbus-toml-connectors.test.ts`
- Modify: `packages/gateway/src/config/nimbus-toml.ts` (re-export, end of file)

Pattern source: `parseQuorumConfig` / `collectQuorumKvSections` / `beginQuorumTable` in `nimbus-toml.ts` (lines 969–1025); error style from `parseUpdateCheckIntervalHours` (lines 618–629). Service-id type: `ConnectorServiceId` in `connectors/connector-catalog.ts`. Entry-name rule: `ENTRY_RE` in `teamvault/team-vault-keys.ts`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/config/nimbus-toml-connectors.test.ts
import { describe, expect, it } from "bun:test";
import { parseNimbusConnectorsToml } from "./nimbus-toml-connectors.ts";

describe("parseNimbusConnectorsToml", () => {
  it("returns an empty map when no [connectors.*] section is present (default personal)", () => {
    const cfg = parseNimbusConnectorsToml("");
    expect(cfg.size).toBe(0);
  });

  it("parses a team connector with a team_entry", () => {
    const raw = ['[connectors.snowflake]', 'credential = "team"', 'team_entry = "prod-snowflake"'].join("\n");
    const cfg = parseNimbusConnectorsToml(raw);
    expect(cfg.get("snowflake")).toEqual({ credential: "team", teamEntry: "prod-snowflake" });
  });

  it("parses an explicit personal connector (no team_entry)", () => {
    const raw = ['[connectors.tableau]', 'credential = "personal"'].join("\n");
    const cfg = parseNimbusConnectorsToml(raw);
    expect(cfg.get("tableau")).toEqual({ credential: "personal" });
  });

  it("throws when credential is not personal|team", () => {
    const raw = ['[connectors.looker]', 'credential = "shared"'].join("\n");
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(/connectors\.looker\.credential.*personal.*team/);
  });

  it("throws when credential = team but team_entry is absent", () => {
    const raw = ['[connectors.powerbi]', 'credential = "team"'].join("\n");
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(/connectors\.powerbi\.team_entry is required/);
  });

  it("throws when team_entry violates the entry-name rule (dots/upper)", () => {
    const raw = ['[connectors.bigeye]', 'credential = "team"', 'team_entry = "Prod.Bigeye"'].join("\n");
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(/connectors\.bigeye\.team_entry .* invalid/);
  });

  it("throws when the connector name is not one of the six warehouse/BI services", () => {
    const raw = ['[connectors.github]', 'credential = "team"', 'team_entry = "x"'].join("\n");
    expect(() => parseNimbusConnectorsToml(raw)).toThrow(/connectors\.github is not a supported team-credential connector/);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test packages/gateway/src/config/nimbus-toml-connectors.test.ts`
Expected: FAIL — `Cannot find module './nimbus-toml-connectors.ts'`.

- [ ] **Step 3: Implement the parser**

```ts
// packages/gateway/src/config/nimbus-toml-connectors.ts
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ENTRY_RE } from "../teamvault/team-vault-keys.ts";

/** The six warehouse/BI services that may use a team credential in Wave 7b. Kept tight on purpose. */
export const TEAM_CREDENTIAL_CONNECTORS = [
  "snowflake",
  "tableau",
  "looker",
  "powerbi",
  "montecarlo",
  "bigeye",
] as const;
export type TeamCredentialConnector = (typeof TEAM_CREDENTIAL_CONNECTORS)[number];

export interface ConnectorCredentialConfig {
  readonly credential: "personal" | "team";
  readonly teamEntry?: string;
}

export type ConnectorsConfig = ReadonlyMap<TeamCredentialConnector, ConnectorCredentialConfig>;

const TABLE_PREFIX = "[connectors.";

function isTableHeader(line: string): boolean {
  return line.startsWith("[") && line.endsWith("]");
}

function stripComment(line: string): string {
  const i = line.indexOf("#");
  return i === -1 ? line : line.slice(0, i);
}

function parseQuoted(raw: string): string {
  const t = raw.trim();
  return t.startsWith('"') && t.endsWith('"') ? t.slice(1, -1) : t;
}

/** Parse `[connectors.<name>]` tables into a validated map. Fail-closed on every malformed entry. */
export function parseNimbusConnectorsToml(source: string): ConnectorsConfig {
  const accum = new Map<string, Record<string, string>>();
  let current: string | undefined;

  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      current =
        trimmed.startsWith(TABLE_PREFIX) && trimmed.endsWith("]")
          ? trimmed.slice(TABLE_PREFIX.length, -1)
          : undefined;
      if (current !== undefined && !accum.has(current)) accum.set(current, {});
      continue;
    }
    if (current === undefined) continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = parseQuoted(trimmed.slice(eq + 1));
    const bag = accum.get(current);
    if (bag !== undefined) bag[key] = val;
  }

  const out = new Map<TeamCredentialConnector, ConnectorCredentialConfig>();
  for (const [name, kv] of accum) {
    if (!(TEAM_CREDENTIAL_CONNECTORS as readonly string[]).includes(name)) {
      throw new Error(
        `[connectors.${name}] is not a supported team-credential connector (one of: ${TEAM_CREDENTIAL_CONNECTORS.join(", ")})`,
      );
    }
    const connector = name as TeamCredentialConnector;
    const credential = kv["credential"] ?? "personal";
    if (credential !== "personal" && credential !== "team") {
      throw new Error(`connectors.${name}.credential must be "personal" or "team" (got: ${credential})`);
    }
    if (credential === "personal") {
      out.set(connector, { credential: "personal" });
      continue;
    }
    const teamEntry = (kv["team_entry"] ?? "").trim();
    if (teamEntry === "") {
      throw new Error(`connectors.${name}.team_entry is required when credential = "team"`);
    }
    if (!ENTRY_RE.test(teamEntry)) {
      throw new Error(
        `connectors.${name}.team_entry "${teamEntry}" is invalid (lowercase alphanumerics + dashes, no dots)`,
      );
    }
    out.set(connector, { credential: "team", teamEntry });
  }
  return out;
}

/** Load + parse the `[connectors.*]` family from `<configDir>/nimbus.toml`. Empty map when absent. */
export function loadNimbusConnectorsFromConfigDir(configDir: string): ConnectorsConfig {
  const tomlPath = join(configDir, "nimbus.toml");
  if (!existsSync(tomlPath)) return new Map();
  return parseNimbusConnectorsToml(readFileSync(tomlPath, "utf8"));
}
```

> **Verify before coding:** open `teamvault/team-vault-keys.ts` and confirm `ENTRY_RE` is exported and matches "lowercase alnum + dashes, no dots". If the export name differs, import the actual symbol (do not duplicate the regex).

- [ ] **Step 4: Run it green**

Run: `bun test packages/gateway/src/config/nimbus-toml-connectors.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Re-export from `nimbus-toml.ts` for sibling parity**

At the end of `packages/gateway/src/config/nimbus-toml.ts` add:

```ts
export {
  type ConnectorCredentialConfig,
  type ConnectorsConfig,
  type TeamCredentialConnector,
  TEAM_CREDENTIAL_CONNECTORS,
  loadNimbusConnectorsFromConfigDir,
  parseNimbusConnectorsToml,
} from "./nimbus-toml-connectors.ts";
```

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add packages/gateway/src/config/nimbus-toml-connectors.ts packages/gateway/src/config/nimbus-toml-connectors.test.ts packages/gateway/src/config/nimbus-toml.ts
git commit -m "feat(connectors): [connectors.<name>] team-credential config schema"
```

---

## Task 2: Service-scoped personal vault view

**Files:**

- Create: `packages/gateway/src/connectors/service-scoped-vault-view.ts`
- Create: `packages/gateway/src/connectors/service-scoped-vault-view.test.ts`

Model on `createTeamVaultView` (`teamvault/team-vault-view.ts`). Purpose: when spawning a connector for **personal** sync, expose only `<service>.*` keys so `ensurePhase3BundleMcp` → `buildPhase3Servers` starts exactly one server (the full personal vault would start every configured phase-3 connector).

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/service-scoped-vault-view.test.ts
import { describe, expect, it } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { createServiceScopedVaultView } from "./service-scoped-vault-view.ts";

function fakeVault(entries: Record<string, string>): NimbusVault {
  return {
    get: async (k) => entries[k] ?? null,
    set: async () => {},
    delete: async () => {},
    listKeys: async (p) => Object.keys(entries).filter((k) => (p === undefined ? true : k.startsWith(p))),
  };
}

describe("createServiceScopedVaultView", () => {
  it("passes through keys for the scoped service", async () => {
    const v = createServiceScopedVaultView(fakeVault({ "snowflake.account": "acme" }), "snowflake");
    expect(await v.get("snowflake.account")).toBe("acme");
  });

  it("returns null for other services' keys", async () => {
    const v = createServiceScopedVaultView(fakeVault({ "tableau.url": "https://t" }), "snowflake");
    expect(await v.get("tableau.url")).toBeNull();
  });

  it("listKeys is filtered to the service prefix", async () => {
    const v = createServiceScopedVaultView(
      fakeVault({ "snowflake.account": "a", "tableau.url": "u" }),
      "snowflake",
    );
    expect(await v.listKeys()).toEqual(["snowflake.account"]);
  });

  it("refuses writes (read-only spawn scope)", async () => {
    const v = createServiceScopedVaultView(fakeVault({}), "snowflake");
    await expect(v.set("snowflake.account", "x")).rejects.toThrow(/read-only/);
    await expect(v.delete("snowflake.account")).rejects.toThrow(/read-only/);
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test packages/gateway/src/connectors/service-scoped-vault-view.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/connectors/service-scoped-vault-view.ts
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/**
 * A READ-ONLY view of the OS Vault scoped to a single connector service's keyspace (`<service>.*`).
 * Used by the unified spawn-based PERSONAL sync so `ensurePhase3BundleMcp` builds exactly one
 * server (mirrors how a team-vault view exposes only one entry's keys). Writes are refused — a sync
 * spawn never mutates the vault.
 */
export function createServiceScopedVaultView(underlying: NimbusVault, service: string): NimbusVault {
  const prefix = `${service}.`;
  const readOnly = (op: string): Promise<never> =>
    Promise.reject(new Error(`service-scoped vault view is read-only (no ${op} during sync spawn)`));
  return {
    get: (key) => (key.startsWith(prefix) ? underlying.get(key) : Promise.resolve(null)),
    set: () => readOnly("writes"),
    delete: () => readOnly("deletes"),
    async listKeys(listPrefix?: string): Promise<string[]> {
      const full = listPrefix === undefined ? prefix : `${prefix}${listPrefix}`;
      const keys = await underlying.listKeys(full);
      return keys.filter((k) => k.startsWith(prefix));
    },
  };
}
```

- [ ] **Step 4: Run it green**

Run: `bun test packages/gateway/src/connectors/service-scoped-vault-view.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/service-scoped-vault-view.ts packages/gateway/src/connectors/service-scoped-vault-view.test.ts
git commit -m "feat(connectors): service-scoped personal vault view for single-server spawn"
```

---

## Task 3: `withConnectorSession` spawn-once primitive (D9)

**Files:**

- Create: `packages/gateway/src/teamvault/connector-session.ts`
- Create: `packages/gateway/src/teamvault/connector-session.test.ts`
- Modify: `packages/gateway/src/teamvault/team-tool-spawn.ts` (re-implement `spawnTeamToolAndCall` on the new primitive)

Today `spawnTeamToolAndCall` spawns → one call → disconnect. D9 needs **one spawn, N calls**. Extract the spawn lifecycle into `withConnectorSession` yielding a `call(toolId,args)`; keep `spawnTeamToolAndCall` as the single-call convenience over it (back-compat for any non-paged team tool).

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/teamvault/connector-session.test.ts
import { describe, expect, it, mock } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { withConnectorSession, __setSessionSpawnerForTest } from "./connector-session.ts";

const fakeVault: NimbusVault = {
  get: async () => "secret",
  set: async () => {},
  delete: async () => {},
  listKeys: async () => [],
};

describe("withConnectorSession", () => {
  it("spawns once, allows N calls, then disconnects once", async () => {
    let spawns = 0;
    let disconnects = 0;
    const execute = mock(async (args: unknown) => ({ content: [{ type: "text", text: JSON.stringify({ echo: args }) }] }));
    __setSessionSpawnerForTest(() => {
      spawns += 1;
      return {
        listTools: async () => ({ snowflake_list: { execute } }),
        disconnect: async () => {
          disconnects += 1;
        },
      };
    });

    const calls = await withConnectorSession(
      { service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" },
      async (s) => {
        const a = await s.call("snowflake_list", { cursor: null });
        const b = await s.call("snowflake_list", { cursor: "1" });
        return [a, b];
      },
    );

    expect(spawns).toBe(1);
    expect(disconnects).toBe(1);
    expect(execute).toHaveBeenCalledTimes(2);
    expect(calls).toHaveLength(2);
  });

  it("disconnects even when the body throws", async () => {
    let disconnects = 0;
    __setSessionSpawnerForTest(() => ({
      listTools: async () => ({ snowflake_list: { execute: async () => ({}) } }),
      disconnect: async () => {
        disconnects += 1;
      },
    }));
    await expect(
      withConnectorSession({ service: "snowflake", vaultView: fakeVault, sandboxCwd: "/tmp" }, async () => {
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(disconnects).toBe(1);
  });
});
```

> The `__setSessionSpawnerForTest` seam injects a fake in place of the real mesh spawn (DI over `mock.module` — the gateway-leak rule). The real spawner is `spawnerFor(service)` + an `MCPClient`.

- [ ] **Step 2: Run it red**

Run: `bun test packages/gateway/src/teamvault/connector-session.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the session primitive**

```ts
// packages/gateway/src/teamvault/connector-session.ts
import { MCPClient } from "@mastra/mcp";
import * as spawners from "../connectors/lazy-mesh/connector-spawns.ts";
import type { MeshSpawnContext } from "../connectors/lazy-mesh/slot.ts";
import { listLazyMeshClientTools } from "../connectors/lazy-mesh/tool-map.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export interface ConnectorSessionRequest {
  readonly service: string;
  readonly vaultView: NimbusVault;
  readonly sandboxCwd: string;
}

export interface ConnectorToolSession {
  call(toolId: string, args: unknown): Promise<unknown>;
}

type Spawner = (ctx: MeshSpawnContext) => Promise<void>;

const SINGLE_SERVICE_SPAWNERS: Readonly<Record<string, Spawner>> = {
  github: spawners.ensureGithubMcp,
  gitlab: spawners.ensureGitlabMcp,
  bitbucket: spawners.ensureBitbucketMcp,
  slack: spawners.ensureSlackMcp,
  linear: spawners.ensureLinearMcp,
  jira: spawners.ensureJiraMcp,
  confluence: spawners.ensureConfluenceMcp,
  notion: spawners.ensureNotionMcp,
  discord: spawners.ensureDiscordMcp,
  jenkins: spawners.ensureJenkinsMcp,
  circleci: spawners.ensureCircleciMcp,
  pagerduty: spawners.ensurePagerdutyMcp,
  kubernetes: spawners.ensureKubernetesMcp,
  zoom: spawners.ensureZoomMcp,
  hubspot: spawners.ensureHubspotMcp,
  miro: spawners.ensureMiroMcp,
  canva: spawners.ensureCanvaMcp,
  figma: spawners.ensureFigmaMcp,
  salesforce: spawners.ensureSalesforceMcp,
};

function spawnerFor(service: string): Spawner {
  // The 6 warehouse/BI services + all phase-3 cloud connectors run via the bundle spawner, which
  // only starts the server whose creds the (scoped) vault view exposes.
  return SINGLE_SERVICE_SPAWNERS[service] ?? spawners.ensurePhase3BundleMcp;
}

/** Minimal client surface the session uses (lets a test inject a fake without mock.module). */
interface SessionClient {
  listTools(): Promise<Record<string, { execute?: (args: unknown) => Promise<unknown> }>>;
  disconnect(): Promise<void>;
}

type SessionSpawn = (req: ConnectorSessionRequest) => Promise<SessionClient> | SessionClient | undefined;

let spawnOverride: SessionSpawn | undefined;
/** TEST-ONLY DI seam. Pass `undefined` to restore the real mesh spawn. */
export function __setSessionSpawnerForTest(fn: SessionSpawn | undefined): void {
  spawnOverride = fn;
}

async function realSpawn(req: ConnectorSessionRequest): Promise<SessionClient | undefined> {
  const clients = new Map<string, MCPClient>();
  const ctx: MeshSpawnContext = {
    vault: req.vaultView,
    sandboxCwd: req.sandboxCwd,
    clearLazyIdle: () => {},
    getLazyClient: (key) => clients.get(key),
    setLazyClient: (key, client) => {
      clients.set(key, client);
    },
    bumpToolsEpoch: () => {},
    scheduleLazyDisconnect: () => {},
  };
  await spawnerFor(req.service)(ctx);
  const client = [...clients.values()][0];
  if (client === undefined) return undefined;
  return {
    listTools: () => listLazyMeshClientTools(client),
    disconnect: () => client.disconnect().then(() => {}).catch(() => {}),
  };
}

/**
 * Spawn the connector for `service` ONCE (fed by `vaultView`), run `body` with a `call(toolId,args)`
 * session, then tear the instance down — even on throw. The secret stays inside the subprocess env +
 * this view's scope for the whole session (faithful I19 when `vaultView` is a team view).
 */
export async function withConnectorSession<T>(
  req: ConnectorSessionRequest,
  body: (session: ConnectorToolSession) => Promise<T>,
): Promise<T> {
  const spawn = spawnOverride ?? realSpawn;
  const client = await spawn(req);
  if (client === undefined) {
    throw new Error(`connector-session: no server spawned for service "${req.service}"`);
  }
  try {
    const session: ConnectorToolSession = {
      async call(toolId, args) {
        const tools = await client.listTools();
        const tool = tools[toolId];
        if (tool?.execute === undefined) {
          throw new Error(`connector-session: tool "${toolId}" not found for service "${req.service}"`);
        }
        return tool.execute(args);
      },
    };
    return await body(session);
  } finally {
    await client.disconnect();
  }
}
```

- [ ] **Step 4: Run it green**

Run: `bun test packages/gateway/src/teamvault/connector-session.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Re-implement `spawnTeamToolAndCall` on the primitive**

Replace the body of `packages/gateway/src/teamvault/team-tool-spawn.ts` with:

```ts
import type { TeamToolSpawnRequest } from "./team-tool-invoke.ts";
import { withConnectorSession } from "./connector-session.ts";

/**
 * The single-call ephemeral-spawn seam for {@link invokeTeamTool}: spawn the team-credentialed
 * connector, call the named tool once, tear down. The team secret only ever lives in the spawned
 * subprocess env + the view's call scope — never returned.
 */
export async function spawnTeamToolAndCall(req: TeamToolSpawnRequest): Promise<unknown> {
  return withConnectorSession(
    { service: req.service, vaultView: req.vaultView, sandboxCwd: req.sandboxCwd },
    (session) => session.call(req.toolId, req.args),
  );
}
```

- [ ] **Step 6: Verify existing team-tool tests still pass + typecheck**

Run: `bun test packages/gateway/src/teamvault/ && bun run typecheck`
Expected: PASS — `team-tool-invoke.test.ts` and any spawn test still green (behavior unchanged for single calls).

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/teamvault/connector-session.ts packages/gateway/src/teamvault/connector-session.test.ts packages/gateway/src/teamvault/team-tool-spawn.ts
git commit -m "feat(teamvault): withConnectorSession spawn-once primitive (D9, one spawn N calls)"
```

---

## Task 4: Gateway-side list unwrap + pagination drain

**Files:**

- Create: `packages/gateway/src/connectors/connector-list-page.ts`
- Create: `packages/gateway/src/connectors/connector-list-page.test.ts`

`<svc>_list` returns the MCP envelope `{ content: [{ type:"text", text: JSON.stringify({ items, nextCursor }) }] }` (from `mcpJsonResult`). The gateway unwraps + drains pages over a `ConnectorToolSession`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/gateway/src/connectors/connector-list-page.test.ts
import { describe, expect, it } from "bun:test";
import type { ConnectorToolSession } from "../teamvault/connector-session.ts";
import { drainPagedList, parseMcpListPage } from "./connector-list-page.ts";

function envelope(data: unknown): unknown {
  return { content: [{ type: "text", text: JSON.stringify(data) }] };
}

describe("parseMcpListPage", () => {
  it("unwraps the MCP text envelope into { items, nextCursor }", () => {
    const page = parseMcpListPage(envelope({ items: [{ id: 1 }], nextCursor: "2" }));
    expect(page).toEqual({ items: [{ id: 1 }], nextCursor: "2" });
  });

  it("defaults missing/invalid fields to [] and null", () => {
    expect(parseMcpListPage(envelope({}))).toEqual({ items: [], nextCursor: null });
  });

  it("throws on a non-MCP shape", () => {
    expect(() => parseMcpListPage({ nope: true })).toThrow(/unexpected MCP tool result/);
  });
});

describe("drainPagedList", () => {
  it("follows nextCursor until null, aggregating items, passing limit", async () => {
    const pages: Record<string, unknown> = {
      "null": envelope({ items: [{ id: 1 }, { id: 2 }], nextCursor: "p2" }),
      p2: envelope({ items: [{ id: 3 }], nextCursor: null }),
    };
    const seen: Array<{ cursor: string | null; limit: number }> = [];
    const session: ConnectorToolSession = {
      call: async (_toolId, args) => {
        const a = args as { cursor: string | null; limit: number };
        seen.push(a);
        return pages[a.cursor === null ? "null" : a.cursor];
      },
    };
    const items = await drainPagedList(session, "snowflake_list", 200);
    expect(items).toEqual([{ id: 1 }, { id: 2 }, { id: 3 }]);
    expect(seen).toEqual([
      { cursor: null, limit: 200 },
      { cursor: "p2", limit: 200 },
    ]);
  });

  it("stops at a safety page cap to avoid an infinite cursor loop", async () => {
    const session: ConnectorToolSession = {
      call: async () => ({ content: [{ type: "text", text: JSON.stringify({ items: [{ id: 1 }], nextCursor: "same" }) }] }),
    };
    const items = await drainPagedList(session, "snowflake_list", 200);
    expect(items.length).toBeGreaterThan(0);
    expect(items.length).toBeLessThanOrEqual(200 * 1000); // bounded; see MAX_PAGES
  });
});
```

- [ ] **Step 2: Run it red**

Run: `bun test packages/gateway/src/connectors/connector-list-page.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```ts
// packages/gateway/src/connectors/connector-list-page.ts
import type { ConnectorToolSession } from "../teamvault/connector-session.ts";

export interface ListPage {
  readonly items: unknown[];
  readonly nextCursor: string | null;
}

export const DEFAULT_LIST_PAGE_SIZE = 200;
/** Hard backstop against a misbehaving cursor that never terminates. */
const MAX_PAGES = 1000;

function extractMcpText(result: unknown): string {
  if (result !== null && typeof result === "object") {
    const content = (result as Record<string, unknown>)["content"];
    if (Array.isArray(content) && content.length > 0) {
      const first = content[0] as Record<string, unknown>;
      if (typeof first["text"] === "string") return first["text"];
    }
  }
  throw new Error("connector list: unexpected MCP tool result shape");
}

export function parseMcpListPage(result: unknown): ListPage {
  const parsed = JSON.parse(extractMcpText(result)) as Record<string, unknown>;
  const items = Array.isArray(parsed["items"]) ? parsed["items"] : [];
  const nextCursor = typeof parsed["nextCursor"] === "string" ? parsed["nextCursor"] : null;
  return { items, nextCursor };
}

/** Drain a paginated `<svc>_list` tool over one session, following nextCursor to exhaustion. */
export async function drainPagedList(
  session: ConnectorToolSession,
  listToolId: string,
  pageSize: number = DEFAULT_LIST_PAGE_SIZE,
): Promise<unknown[]> {
  const items: unknown[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const res = await session.call(listToolId, { cursor, limit: pageSize });
    const { items: pageItems, nextCursor } = parseMcpListPage(res);
    items.push(...pageItems);
    if (nextCursor === null || nextCursor === cursor) break; // terminate on null or non-advancing cursor
    cursor = nextCursor;
  }
  return items;
}
```

- [ ] **Step 4: Run it green**

Run: `bun test packages/gateway/src/connectors/connector-list-page.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/connector-list-page.ts packages/gateway/src/connectors/connector-list-page.test.ts
git commit -m "feat(connectors): MCP list-envelope unwrap + paginated drain helper"
```

---

## Task 5: Principal-polymorphic gate + audit principal descriptor

**Files:**

- Modify: `packages/gateway/src/teamvault/team-vault-audit.ts`
- Modify: `packages/gateway/src/teamvault/team-tool-invoke.ts` (add `invokeTeamToolList`)
- Modify: `packages/gateway/src/federation/invoke-gate.ts`
- Modify: `packages/gateway/src/ipc/federation-rpc.ts` (adapt the wire to a peer principal)
- Test: `packages/gateway/src/federation/invoke-gate.test.ts` (extend), `packages/gateway/src/teamvault/team-vault-audit.test.ts` (extend)

### 5a — Audit accepts a principal descriptor

- [ ] **Step 1: Write the failing test** (append to `team-vault-audit.test.ts`)

```ts
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { appendTeamVaultAudit } from "./team-vault-audit.ts";

describe("appendTeamVaultAudit — principal descriptor", () => {
  it("records a localOperator principal (no synthetic peer id)", () => {
    const db = new Database(":memory:");
    // (reuse the existing audit-chain schema bootstrap helper this file already imports)
    appendTeamVaultAudit(db, {
      principal: { kind: "localOperator" },
      entry: "prod-snowflake",
      toolId: "snowflake_list",
      decision: "answered",
      timestamp: 1,
    });
    const row = db.prepare("SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1").get() as { federation_json: string };
    const fed = JSON.parse(row.federation_json) as Record<string, unknown>;
    expect(fed["principal"]).toBe("localOperator");
    expect(fed["peer_id"]).toBeUndefined();
  });

  it("records a peer principal's id (federated path unchanged)", () => {
    const db = new Database(":memory:");
    appendTeamVaultAudit(db, {
      principal: { kind: "peer", peerId: "peer-123" },
      entry: "e",
      toolId: "t",
      decision: "answered",
      timestamp: 1,
    });
    const row = db.prepare("SELECT federation_json FROM audit_log ORDER BY id DESC LIMIT 1").get() as { federation_json: string };
    const fed = JSON.parse(row.federation_json) as Record<string, unknown>;
    expect(fed["peer_id"]).toBe("peer-123");
    expect(fed["principal"]).toBe("peer");
  });
});
```

> **Verify before coding:** confirm the audit table name + column (`audit_log` / `federation_json`) by reading `db/audit-chain.ts` `appendAuditEntry` — match the real schema; adjust the SELECT if names differ. Reuse whatever schema-bootstrap the existing `team-vault-audit.test.ts` already does (do not invent one).

- [ ] **Step 2: Run it red**

Run: `bun test packages/gateway/src/teamvault/team-vault-audit.test.ts`
Expected: FAIL — `principal` not accepted; `peerId` required.

- [ ] **Step 3: Implement the descriptor**

Replace `team-vault-audit.ts` with:

```ts
import type { Database } from "bun:sqlite";
import { appendAuditEntry } from "../db/audit-chain.ts";

export type TeamVaultDecision =
  | "answered"
  | "no_grant"
  | "identity_invalid"
  | "quorum_failed"
  | "quorum_denied";

/** Who consumed (or was denied) the team credential. */
export type AuditPrincipal =
  | { readonly kind: "peer"; readonly peerId: string }
  | { readonly kind: "localOperator" };

export interface TeamVaultAuditFields {
  readonly principal: AuditPrincipal;
  readonly entry: string;
  readonly toolId: string;
  readonly decision: TeamVaultDecision;
  readonly timestamp: number;
  readonly approvers?: readonly string[];
}

/** Tamper-evident audit for a team-vault invoke (answered or rejected), by either principal kind. */
export function appendTeamVaultAudit(db: Database, f: TeamVaultAuditFields): void {
  const federationJson = JSON.stringify({
    principal: f.principal.kind,
    ...(f.principal.kind === "peer" ? { peer_id: f.principal.peerId } : {}),
    entry: f.entry,
    tool_id: f.toolId,
    decision: f.decision,
    method: "federation.invoke",
    ...(f.approvers === undefined ? {} : { approvers: f.approvers }),
  });
  appendAuditEntry(db, {
    actionType: `teamvault.invoke.${f.decision}`,
    hitlStatus: "not_required",
    actionJson: JSON.stringify({ method: "federation.invoke", entry: f.entry, toolId: f.toolId }),
    timestamp: f.timestamp,
    federationJson,
  });
}
```

- [ ] **Step 4: Run it green**

Run: `bun test packages/gateway/src/teamvault/team-vault-audit.test.ts`
Expected: PASS.

### 5b — `invokeTeamToolList` (paginated drain in one team session)

- [ ] **Step 5: Write the failing test** (append to `team-tool-invoke.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { invokeTeamToolList } from "./team-tool-invoke.ts";

const present = { get: async () => "secret", set: async () => {}, delete: async () => {}, listKeys: async () => [] };

describe("invokeTeamToolList — fail-closed paginated drain", () => {
  it("throws team_secret_missing before opening a session when a required key is absent", async () => {
    let opened = false;
    await expect(
      invokeTeamToolList(
        {
          vault: { get: async () => null, set: async () => {}, delete: async () => {}, listKeys: async () => [] },
          sandboxCwd: "/tmp",
          requiredSecretKeysFor: () => ["snowflake.account"],
          openSession: async () => {
            opened = true;
            return [];
          },
        },
        { entry: "e", service: "snowflake", listToolId: "snowflake_list" },
      ),
    ).rejects.toThrow(/team_secret_missing|missing required secret/);
    expect(opened).toBe(false);
  });

  it("returns the drained items when secrets are present", async () => {
    const items = await invokeTeamToolList(
      {
        vault: present,
        sandboxCwd: "/tmp",
        requiredSecretKeysFor: () => ["snowflake.account"],
        openSession: async () => [{ id: 1 }, { id: 2 }],
      },
      { entry: "e", service: "snowflake", listToolId: "snowflake_list" },
    );
    expect(items).toEqual([{ id: 1 }, { id: 2 }]);
  });
});
```

- [ ] **Step 6: Run it red** → FAIL (`invokeTeamToolList` undefined).

- [ ] **Step 7: Implement `invokeTeamToolList`** (add to `team-tool-invoke.ts`, reusing the existing fail-closed loop)

```ts
import { drainPagedList } from "../connectors/connector-list-page.ts";
import { withConnectorSession } from "./connector-session.ts";

export interface TeamToolListRequest {
  readonly entry: string;
  readonly service: string;
  readonly listToolId: string;
}

export interface InvokeTeamToolListDeps {
  readonly vault: NimbusVault;
  readonly sandboxCwd: string;
  readonly requiredSecretKeysFor: (service: string) => readonly string[] | undefined;
  /** Opens a team-credentialed session and drains the paginated list. Injected for tests. */
  readonly openSession: (req: { service: string; vaultView: NimbusVault; sandboxCwd: string; listToolId: string }) => Promise<unknown[]>;
}

/** Default `openSession`: spawn once, drain pages, tear down (faithful I19 — secret bound to session). */
export const drainTeamListSession = (req: {
  service: string;
  vaultView: NimbusVault;
  sandboxCwd: string;
  listToolId: string;
}): Promise<unknown[]> =>
  withConnectorSession(
    { service: req.service, vaultView: req.vaultView, sandboxCwd: req.sandboxCwd },
    (session) => drainPagedList(session, req.listToolId),
  );

/**
 * I19 — drain a paginated connector `_list` using a TEAM credential. Same fail-closed secret check
 * as {@link invokeTeamTool}, then ONE session that follows the cursor to exhaustion. The secret lives
 * only in the spawned subprocess for the whole session; only the raw items are returned.
 */
export async function invokeTeamToolList(
  deps: InvokeTeamToolListDeps,
  req: TeamToolListRequest,
): Promise<unknown[]> {
  const requiredKeys = deps.requiredSecretKeysFor(req.service);
  if (requiredKeys === undefined || requiredKeys.length === 0) {
    throw new TeamToolError("team_service_unsupported", `team-vault: service "${req.service}" has no team-injectable secret keys`);
  }
  const vaultView = createTeamVaultView(deps.vault, req.entry);
  for (const key of requiredKeys) {
    const present = await vaultView.get(key);
    if (present === null || present === "") {
      throw new TeamToolError("team_secret_missing", `team-vault: entry "${req.entry}" is missing required secret for ${req.service}`);
    }
  }
  return deps.openSession({ service: req.service, vaultView, sandboxCwd: deps.sandboxCwd, listToolId: req.listToolId });
}
```

> Note the test injects `openSession` returning a plain array (it does not go through `withConnectorSession`); production wires `openSession: drainTeamListSession`.

- [ ] **Step 8: Run it green** → `bun test packages/gateway/src/teamvault/team-tool-invoke.test.ts` PASS.

### 5c — Principal-polymorphic gate

- [ ] **Step 9: Write the failing test** (extend `invoke-gate.test.ts`)

```ts
import { describe, expect, it } from "bun:test";
import { answerFederatedInvoke, answerLocalOperatorList } from "./invoke-gate.ts";

// Peer path stays byte-identical: an existing peer test must remain unchanged & green.
// New localOperator list path:
describe("answerLocalOperatorList — config-pinned local operator", () => {
  const baseCtx = () => ({
    db: makeAuditDb(), // reuse the file's existing audit-db helper
    store: { getEntry: (e: string) => (e === "prod-snowflake" ? { service: "snowflake", entry: e, createdAt: 0, createdBy: "me" } : undefined), checkGrant: () => false },
    runListTool: async () => [{ id: 1 }],
    now: () => 1,
  });

  it("authorizes on entry-presence + service match, returns drained items, audits localOperator/answered", async () => {
    const ctx = baseCtx();
    const out = await answerLocalOperatorList(ctx as never, { entry: "prod-snowflake", service: "snowflake", listToolId: "snowflake_list" });
    expect(out).toEqual({ kind: "ok", items: [{ id: 1 }] });
  });

  it("fails closed when the entry is missing or service mismatches (no spawn)", async () => {
    const ctx = baseCtx();
    const out = await answerLocalOperatorList(ctx as never, { entry: "nope", service: "snowflake", listToolId: "snowflake_list" });
    expect(out).toEqual({ kind: "error", error: "no_grant" });
  });

  it("fails closed when identity is enabled and the operator is invalid", async () => {
    const ctx = { ...baseCtx(), identity: { enabled: true, isOperatorValid: () => false } };
    const out = await answerLocalOperatorList(ctx as never, { entry: "prod-snowflake", service: "snowflake", listToolId: "snowflake_list" });
    expect(out).toEqual({ kind: "error", error: "identity_invalid" }); // local operator gets a specific code (not opaque)
  });
});
```

> The localOperator error is **non-opaque** (`identity_invalid`) — design §5: the peer path stays opaque (`no_grant`) to avoid leaking identity state to a remote peer, but the local operator may see the real reason on their own machine.

- [ ] **Step 10: Run it red** → FAIL (`answerLocalOperatorList` undefined).

- [ ] **Step 11: Implement the polymorphic gate**

In `invoke-gate.ts`:

1. Change the `audit` helper to build an `AuditPrincipal` (peer path passes `{ kind:"peer", peerId: q.peerId }`).
2. Keep `answerFederatedInvoke` signature + behavior **byte-identical** (it constructs the peer principal internally).
3. Add a `runListTool` member to a new `LocalOperatorListCtx` and the `answerLocalOperatorList` function:

```ts
export interface LocalOperatorListCtx {
  readonly db: Database;
  readonly store: Pick<TeamVaultStore, "getEntry">;
  /** Gate-internal: drains the paginated team list (wired to invokeTeamToolList). */
  readonly runListTool: (input: { entry: string; service: string; listToolId: string }) => Promise<unknown[]>;
  readonly now?: () => number;
  readonly identity?: { readonly enabled: boolean; readonly isOperatorValid: () => boolean };
}

export interface LocalOperatorListRequest {
  readonly entry: string;
  readonly service: string;
  readonly listToolId: string;
}

export type LocalOperatorListResult =
  | { readonly kind: "ok"; readonly items: unknown[] }
  | { readonly kind: "error"; readonly error: "no_grant" | "identity_invalid" };

/**
 * I19 localOperator branch (D3/D4): authorize a config-pinned local operator and drain the team
 * `_list`. No checkGrant, no quorum (read tool, D8). Unlike the peer path, the local operator gets a
 * SPECIFIC error (their own machine — no cross-principal leak).
 */
export async function answerLocalOperatorList(
  ctx: LocalOperatorListCtx,
  req: LocalOperatorListRequest,
): Promise<LocalOperatorListResult> {
  const ts = (ctx.now ?? Date.now)();
  if (ctx.identity?.enabled === true && !ctx.identity.isOperatorValid()) {
    appendTeamVaultAudit(ctx.db, { principal: { kind: "localOperator" }, entry: req.entry, toolId: req.listToolId, decision: "identity_invalid", timestamp: ts });
    return { kind: "error", error: "identity_invalid" };
  }
  const entryDef = ctx.store.getEntry(req.entry);
  if (entryDef === undefined || entryDef.service !== req.service) {
    appendTeamVaultAudit(ctx.db, { principal: { kind: "localOperator" }, entry: req.entry, toolId: req.listToolId, decision: "no_grant", timestamp: ts });
    return { kind: "error", error: "no_grant" };
  }
  const items = await ctx.runListTool({ entry: req.entry, service: req.service, listToolId: req.listToolId });
  appendTeamVaultAudit(ctx.db, { principal: { kind: "localOperator" }, entry: req.entry, toolId: req.listToolId, decision: "answered", timestamp: ts });
  return { kind: "ok", items };
}
```

1. Update the existing peer `audit(...)` calls to pass `{ kind:"peer", peerId: q.peerId }`.

- [ ] **Step 12: Adapt the federation wire (byte-identical peer path)**

In `ipc/federation-rpc.ts` the `federation.invoke` handler already builds `InboundInvoke` from the wire and calls `answerFederatedInvoke`. No behavior change is needed there (the peer principal is constructed inside `answerFederatedInvoke`). Confirm the call still compiles after the audit-helper change; run the federation-rpc tests.

- [ ] **Step 13: Run gate + federation-rpc + audit tests green + typecheck**

Run: `bun test packages/gateway/src/federation/ packages/gateway/src/teamvault/ packages/gateway/src/ipc/federation-rpc.test.ts && bun run typecheck`
Expected: PASS — including the **unchanged** existing peer-path regression tests (acceptance #3).

- [ ] **Step 14: Commit**

```bash
git add packages/gateway/src/teamvault/team-vault-audit.ts packages/gateway/src/teamvault/team-tool-invoke.ts packages/gateway/src/federation/invoke-gate.ts packages/gateway/src/ipc/federation-rpc.ts packages/gateway/src/federation/invoke-gate.test.ts packages/gateway/src/teamvault/team-vault-audit.test.ts packages/gateway/src/teamvault/team-tool-invoke.test.ts
git commit -m "feat(teamvault): principal-polymorphic invoke gate + localOperator list drain (I19)"
```

---

## Task 6: Unified sync transport (`listConnectorItems`) + SyncContext wiring

**Files:**

- Create: `packages/gateway/src/connectors/warehouse-sync-transport.ts`
- Create: `packages/gateway/src/connectors/warehouse-sync-transport.test.ts`
- Modify: `packages/gateway/src/sync/types.ts` (SyncContext members)
- Modify: `packages/gateway/src/platform/assemble.ts` + `assemble-sync-registrations.ts` (thread the members)

`listConnectorItems` is the one function the 6 handlers call. It branches on `ctx.credentialFor(service)`: personal → service-scoped view + `withConnectorSession` + `drainPagedList`; team → `ctx.runTeamList(...)` (gate-routed localOperator).

- [ ] **Step 1: Add SyncContext members (red via typecheck)**

In `sync/types.ts`, extend `SyncContext`:

```ts
export interface SyncContext {
  vault: NimbusVault;
  db: Database;
  logger: Logger;
  rateLimiter: ProviderRateLimiter;
  scheduleItemEmbedding?: (itemId: string) => void;
  // Wave 7b:
  sandboxCwd: string;
  /** Per-connector credential selection from [connectors.<name>]; defaults to personal. */
  credentialFor: (service: string) => { credential: "personal" | "team"; teamEntry?: string };
  /** Gate-routed localOperator team list drain (I19). Returns raw items or throws an actionable error. */
  runTeamList: (req: { entry: string; service: string; listToolId: string }) => Promise<unknown[]>;
}
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/gateway/src/connectors/warehouse-sync-transport.test.ts
import { describe, expect, it } from "bun:test";
import { listConnectorItems, __setPersonalDrainForTest } from "./warehouse-sync-transport.ts";

function ctx(over: Partial<Parameters<typeof listConnectorItems>[0]>) {
  return {
    vault: { get: async () => "x", set: async () => {}, delete: async () => {}, listKeys: async () => [] },
    sandboxCwd: "/tmp",
    credentialFor: () => ({ credential: "personal" as const }),
    runTeamList: async () => [{ team: true }],
    ...over,
  } as Parameters<typeof listConnectorItems>[0];
}

describe("listConnectorItems", () => {
  it("personal: drains via a service-scoped session", async () => {
    __setPersonalDrainForTest(async () => [{ id: 1 }]);
    const items = await listConnectorItems(ctx({}), "snowflake", "snowflake_list");
    expect(items).toEqual([{ id: 1 }]);
  });

  it("team: routes through runTeamList with the configured entry", async () => {
    let got: unknown;
    const items = await listConnectorItems(
      ctx({
        credentialFor: () => ({ credential: "team", teamEntry: "prod-snowflake" }),
        runTeamList: async (req) => {
          got = req;
          return [{ team: true }];
        },
      }),
      "snowflake",
      "snowflake_list",
    );
    expect(items).toEqual([{ team: true }]);
    expect(got).toEqual({ entry: "prod-snowflake", service: "snowflake", listToolId: "snowflake_list" });
  });

  it("team with no teamEntry is a fail-closed config error (should never happen post-validation)", async () => {
    await expect(
      listConnectorItems(ctx({ credentialFor: () => ({ credential: "team" }) }), "snowflake", "snowflake_list"),
    ).rejects.toThrow(/team_entry/);
  });
});
```

- [ ] **Step 3: Run it red** → FAIL (module not found).

- [ ] **Step 4: Implement**

```ts
// packages/gateway/src/connectors/warehouse-sync-transport.ts
import type { SyncContext } from "../sync/types.ts";
import { withConnectorSession } from "../teamvault/connector-session.ts";
import { drainPagedList } from "./connector-list-page.ts";
import { createServiceScopedVaultView } from "./service-scoped-vault-view.ts";

type PersonalDrain = (ctx: SyncContext, service: string, listToolId: string) => Promise<unknown[]>;

const realPersonalDrain: PersonalDrain = (ctx, service, listToolId) =>
  withConnectorSession(
    { service, vaultView: createServiceScopedVaultView(ctx.vault, service), sandboxCwd: ctx.sandboxCwd },
    (session) => drainPagedList(session, listToolId),
  );

let personalDrainOverride: PersonalDrain | undefined;
/** TEST-ONLY DI seam (avoids spawning a real subprocess). */
export function __setPersonalDrainForTest(fn: PersonalDrain | undefined): void {
  personalDrainOverride = fn;
}

/**
 * The unified Wave-7b list transport. Personal → service-scoped single-spawn drain. Team → the
 * principal-polymorphic gate (I19). Returns raw items for the gateway-side mapper to index.
 */
export async function listConnectorItems(
  ctx: SyncContext,
  service: string,
  listToolId: string,
): Promise<unknown[]> {
  const cfg = ctx.credentialFor(service);
  if (cfg.credential === "team") {
    if (cfg.teamEntry === undefined || cfg.teamEntry === "") {
      throw new Error(`connectors.${service}: credential = "team" requires a team_entry`);
    }
    return ctx.runTeamList({ entry: cfg.teamEntry, service, listToolId });
  }
  return (personalDrainOverride ?? realPersonalDrain)(ctx, service, listToolId);
}
```

- [ ] **Step 5: Run it green** → PASS (3 tests).

- [ ] **Step 6: Wire the SyncContext members in assemble**

In `platform/assemble-sync-registrations.ts` (where `SyncContext` is constructed / sync runs), add:

- `sandboxCwd: paths.dataDir`
- `credentialFor: (service) => connectorsConfig.get(service as TeamCredentialConnector) ?? { credential: "personal" }`
- `runTeamList: (req) => answerLocalOperatorList(localOpListCtx, req).then((r) => { if (r.kind === "error") throw new Error(teamListErrorMessage(r.error, req)); return r.items; })`

where `connectorsConfig = loadNimbusConnectorsFromConfigDir(paths.configDir)` (load once in `assemble.ts`, pass through), and `localOpListCtx` is built next to the existing `teamVault` wiring in `assemble.ts`:

```ts
const localOpListCtx: LocalOperatorListCtx = {
  db: index.getDatabase(),
  store: new TeamVaultStore(index.getDatabase()),
  runListTool: (input) =>
    invokeTeamToolList(
      {
        vault,
        sandboxCwd: paths.dataDir,
        requiredSecretKeysFor: (service) => CONNECTOR_VAULT_SECRET_KEYS[service as keyof typeof CONNECTOR_VAULT_SECRET_KEYS],
        openSession: drainTeamListSession,
      },
      input,
    ),
  ...(identityGuard === undefined ? {} : { identity: identityGuard }),
};
```

and the actionable error helper (design §3/§4 — corrected CLI string):

```ts
function teamListErrorMessage(error: "no_grant" | "identity_invalid", req: { entry: string; service: string }): string {
  if (error === "identity_invalid") {
    return `team-credential sync for ${req.service} blocked: your identity is invalid/expired — re-run the device-code login with: nimbus identity login`;
  }
  return `team-credential sync for ${req.service} failed: team-vault entry "${req.entry}" not found or service mismatch. Add it with: nimbus team vault put ${req.entry} ${req.service} --secret <key>=<value>`;
}
```

> The login verb is verified: `nimbus identity login` (`cli/src/commands/identity.ts` usage `nimbus identity [login|status|logout|...]`). Use it verbatim in the `identity_invalid` message.

- [ ] **Step 7: Typecheck + commit**

```bash
bun run typecheck
git add packages/gateway/src/connectors/warehouse-sync-transport.ts packages/gateway/src/connectors/warehouse-sync-transport.test.ts packages/gateway/src/sync/types.ts packages/gateway/src/platform/assemble.ts packages/gateway/src/platform/assemble-sync-registrations.ts
git commit -m "feat(connectors): unified personal|team list transport + SyncContext wiring"
```

> After this task the SyncContext type changed — the 6 existing `*-sync.test.ts` files that build a context via `syncTestContext` will fail to typecheck until `syncTestContext` provides the 3 new members. Update `connector-sync-test-helpers.ts` `syncTestContext` to default them: `sandboxCwd: os.tmpdir()`, `credentialFor: () => ({ credential: "personal" })`, `runTeamList: async () => []`. Do this in Step 6's commit so the tree stays green.

---

## Phase 1 — Snowflake vertical (reference connector)

## Task 7: Snowflake `snowflake_list` pagination (D6)

**Files:**

- Modify: `packages/mcp-connectors/snowflake/src/server.ts` (lines ~82–93)
- Create: `packages/mcp-connectors/snowflake/test/server-list-pagination.test.ts`

**Cursor contract (verify against live Snowflake SQL-API docs):** the `_list` SQL becomes `... information_schema.tables ORDER BY table_schema, table_name LIMIT {limit} OFFSET {offset}`. `cursor` = the next offset as a decimal string (null/absent → offset 0). `nextCursor` = `String(offset + limit)` when the page returned exactly `limit` rows, else `null`.

- [ ] **Step 1: Write the failing test**

```ts
// packages/mcp-connectors/snowflake/test/server-list-pagination.test.ts
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildServer } from "../src/server.ts"; // adjust to the actual exported factory

// Snowflake SQL-API statements response: { resultSetMetaData: { rowType }, data: [[...]] }
function statementsResponse(rows: string[][]): string {
  return JSON.stringify({
    resultSetMetaData: { rowType: [{ name: "TABLE_CATALOG" }, { name: "TABLE_SCHEMA" }, { name: "TABLE_NAME" }, { name: "ROW_COUNT" }, { name: "LAST_ALTERED" }] },
    data: rows,
  });
}

describe("snowflake_list pagination", () => {
  const origFetch = globalThis.fetch;
  let bodies: string[] = [];
  beforeEach(() => {
    bodies = [];
    process.env["SNOWFLAKE_ACCOUNT"] = "acme-xy12345";
    process.env["SNOWFLAKE_OAUTH_TOKEN"] = "tok";
  });
  afterEach(() => {
    globalThis.fetch = origFetch;
  });

  it("passes LIMIT/OFFSET from {limit,cursor} and returns nextCursor when a full page comes back", async () => {
    globalThis.fetch = (async (_url: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body).statement as string);
      const rows = Array.from({ length: 2 }, (_v, i) => ["DB", "PUBLIC", `T${i}`, "1", "2026-01-01T00:00:00Z"]);
      return new Response(statementsResponse(rows), { status: 200 });
    }) as unknown as typeof fetch;

    const tools = buildServer(); // however the server exposes its tool map for tests
    const res = await tools["snowflake_list"].execute({ limit: 2, cursor: null });
    const out = JSON.parse(res.content[0].text) as { items: unknown[]; nextCursor: string | null };
    expect(out.items).toHaveLength(2);
    expect(out.nextCursor).toBe("2"); // full page → more may exist
    expect(bodies[0]).toContain("LIMIT 2");
    expect(bodies[0]).toContain("OFFSET 0");
  });

  it("returns nextCursor=null on a short final page", async () => {
    globalThis.fetch = (async () => new Response(statementsResponse([["DB", "PUBLIC", "T0", "1", "2026-01-01T00:00:00Z"]]), { status: 200 })) as unknown as typeof fetch;
    const tools = buildServer();
    const res = await tools["snowflake_list"].execute({ limit: 2, cursor: "4" });
    const out = JSON.parse(res.content[0].text) as { nextCursor: string | null };
    expect(out.nextCursor).toBeNull();
  });
});
```

> **Verify before coding:** read `snowflake/src/server.ts` to find how tools are registered (`reg(...)`) and whether the server exposes a test-accessible tool map. If there is no `buildServer` export, add a thin exported factory or mirror the existing `search-filter.test.ts` harness. Match the real fetch-fake style used elsewhere in this connector's tests.

- [ ] **Step 2: Run it red** → FAIL (no cursor handling / `nextCursor` undefined).

- [ ] **Step 3: Implement pagination in `snowflake_list`**

```ts
// snowflake/src/server.ts — replace the snowflake_list registration
reg(
  "snowflake_list",
  "List Snowflake tables (information_schema.tables). Paginated: `cursor` (opaque offset) + `limit` (default 200, max 500) → `{ items, nextCursor }`.",
  z.object({
    cursor: z.string().nullable().optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async (p) => {
    const limit = p.limit ?? 200;
    const offset = p.cursor === null || p.cursor === undefined || p.cursor === "" ? 0 : Math.max(0, Number.parseInt(p.cursor, 10) || 0);
    const items = await fetchTables(limit, offset); // fetchTables now appends LIMIT/OFFSET to TABLES_SQL
    const nextCursor = items.length === limit ? String(offset + limit) : null;
    return jsonResult({ items, nextCursor });
  },
);
```

Update `fetchTables(limit, offset)` to build SQL `${TABLES_SQL} ORDER BY table_schema, table_name LIMIT ${limit} OFFSET ${offset}` (interpolating only numbers — never strings — so there is no injection surface).

- [ ] **Step 4: Run it green** → `bun test packages/mcp-connectors/snowflake/test/server-list-pagination.test.ts` PASS.

- [ ] **Step 5: Typecheck the connector + commit**

```bash
cd packages/mcp-connectors/snowflake && bun run typecheck && cd ../../..
git add packages/mcp-connectors/snowflake/src/server.ts packages/mcp-connectors/snowflake/test/server-list-pagination.test.ts
git commit -m "feat(connectors): paginate snowflake_list (cursor/limit -> items/nextCursor)"
```

---

## Task 8: Snowflake sync handler on the unified transport

**Files:**

- Modify: `packages/gateway/src/connectors/snowflake-sync.ts`
- Modify: `packages/gateway/src/connectors/snowflake-sync.test.ts`

Drop `connectorFetch` + `loadCreds` + `ensureSnowflakeMcpRunning`; call `listConnectorItems(ctx, "snowflake", "snowflake_list")`, map each raw row with the existing `mapSnowflakeTableToItem`, upsert, return a `SyncResult`.

- [ ] **Step 1: Rewrite the test for the spawn transport**

```ts
// snowflake-sync.test.ts — personal + team via the injected transport
import { describe, expect, test } from "bun:test";
import { createMemoryIndexDb, createStubVault, expectServiceItemCount, syncTestContext } from "./connector-sync-test-helpers.ts";
import { __setPersonalDrainForTest } from "./warehouse-sync-transport.ts";
import { createSnowflakeSyncable } from "./snowflake-sync.ts";

describe("snowflake-sync (unified spawn transport)", () => {
  test("personal: indexes items drained from snowflake_list", async () => {
    __setPersonalDrainForTest(async () => [
      // raw rows in the shape mapSnowflakeTableToItem expects (mirror the Wave-7a mapper fixture)
      { TABLE_CATALOG: "DB", TABLE_SCHEMA: "PUBLIC", TABLE_NAME: "ORDERS", ROW_COUNT: "100", LAST_ALTERED: "2026-01-01T00:00:00Z" },
    ]);
    const db = createMemoryIndexDb();
    const ctx = syncTestContext(db, createStubVault({ "snowflake.account": "acme-xy12345" }));
    const r = await createSnowflakeSyncable().sync(ctx, null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    expectServiceItemCount(db, "snowflake", 1);
  });

  test("team: routes through runTeamList (gate), indexes the returned items", async () => {
    const db = createMemoryIndexDb();
    const ctx = {
      ...syncTestContext(db, createStubVault({})),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-snowflake" }),
      runTeamList: async () => [{ TABLE_CATALOG: "DB", TABLE_SCHEMA: "PUBLIC", TABLE_NAME: "ORDERS", ROW_COUNT: "100", LAST_ALTERED: "2026-01-01T00:00:00Z" }],
    };
    const r = await createSnowflakeSyncable().sync(ctx, null);
    expect(r.itemsUpserted).toBeGreaterThanOrEqual(1);
    expectServiceItemCount(db, "snowflake", 1);
  });

  test("team no-leak: a secret-shaped value never lands in the indexed row", async () => {
    const db = createMemoryIndexDb();
    const SECRET = "tv-secret-do-not-leak";
    const ctx = {
      ...syncTestContext(db, createStubVault({})),
      credentialFor: () => ({ credential: "team" as const, teamEntry: "prod-snowflake" }),
      // The transport returns only mapped raw items; the secret is never in this array.
      runTeamList: async () => [{ TABLE_CATALOG: "DB", TABLE_SCHEMA: "PUBLIC", TABLE_NAME: "ORDERS", ROW_COUNT: "1", LAST_ALTERED: "2026-01-01T00:00:00Z" }],
    };
    await createSnowflakeSyncable().sync(ctx, null);
    const rows = db.prepare("SELECT title, body, metadata_json FROM item WHERE service = 'snowflake'").all() as Array<Record<string, string>>;
    for (const row of rows) {
      for (const v of Object.values(row)) expect(String(v)).not.toContain(SECRET);
    }
  });
});
```

> **Verify before coding:** confirm `mapSnowflakeTableToItem`'s expected raw-row shape (object vs positional array). The Wave-7a handler used `rowsFromStatementsResponse(outcome.parsed)` to turn the SQL-API `data` matrix into rows — decide whether the mapper consumes the matrix rows or named objects, and make the connector `_list` emit that shape (so the mapper is unchanged). Align the fixture to the real mapper input; reuse the Wave-7a mapper test fixture verbatim.

- [ ] **Step 2: Run it red** → FAIL (handler still uses connectorFetch).

- [ ] **Step 3: Rewrite the handler**

```ts
// snowflake-sync.ts
import { listConnectorItems } from "./warehouse-sync-transport.ts";
import { mapSnowflakeTableToItem } from "./snowflake-map.ts"; // existing mapper module
import { upsertIndexedItemForSync } from "./item-store.ts"; // existing
import type { SyncContext, SyncResult, Syncable } from "../sync/types.ts";

const SERVICE_ID = "snowflake";

export function createSnowflakeSyncable(): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      const raw = await listConnectorItems(ctx, SERVICE_ID, "snowflake_list");
      const now = Date.now();
      let upserted = 0;
      for (const row of raw) {
        const mapped = mapSnowflakeTableToItem(row, { syncedAt: now });
        if (mapped !== null) {
          upsertIndexedItemForSync(ctx, mapped);
          upserted += 1;
        }
      }
      return { cursor, itemsUpserted: upserted, itemsDeleted: 0, hasMore: false, durationMs: performance.now() - t0 };
    },
  };
}
```

> The `SyncResult` cursor semantics: pagination is fully drained inside `listConnectorItems`, so the sync returns the input `cursor` unchanged (`hasMore: false`). If the Wave-7a handler used a multi-pass cursor (`pass1Cursor()`), that machinery is no longer needed — the drain replaces it. Confirm no scheduler logic depends on the old pass-cursor for snowflake.

- [ ] **Step 4: Run it green** → `bun test packages/gateway/src/connectors/snowflake-sync.test.ts` PASS.

- [ ] **Step 5: Remove the now-unused `ensureSnowflakeMcpRunning` option wiring**

In `assemble-sync-registrations.ts`, change `createSnowflakeSyncable({ ensureSnowflakeMcpRunning: ... })` to `createSnowflakeSyncable()`. Typecheck.

- [ ] **Step 6: Typecheck + commit**

```bash
bun run typecheck
git add packages/gateway/src/connectors/snowflake-sync.ts packages/gateway/src/connectors/snowflake-sync.test.ts packages/gateway/src/platform/assemble-sync-registrations.ts
git commit -m "feat(connectors): snowflake sync on unified spawn transport (personal+team)"
```

---

## Task 9: I19 security-invariants extension (localOperator)

**Files:**

- Modify: `packages/gateway/src/security-invariants.test.ts` (the `I19` describe block, ~lines 650–681)

Extend the existing I19 block (do **not** add a new invariant — count unchanged) with the localOperator assertions from design §7/§8.

- [ ] **Step 1: Add the failing tests** (inside the I19 describe)

```ts
test("localOperator team list fails CLOSED on a missing secret (no session opened)", async () => {
  const { invokeTeamToolList } = await import("./teamvault/team-tool-invoke.ts");
  let opened = false;
  await expect(
    invokeTeamToolList(
      {
        vault: { get: async () => null, set: async () => {}, delete: async () => {}, listKeys: async () => [] },
        sandboxCwd: "/tmp",
        requiredSecretKeysFor: () => ["snowflake.account"],
        openSession: async () => {
          opened = true;
          return [];
        },
      },
      { entry: "e", service: "snowflake", listToolId: "snowflake_list" },
    ),
  ).rejects.toThrow();
  expect(opened).toBe(false);
});

test("the unified transport only reaches a team secret via the gate (not the ordinary personal path)", async () => {
  // With credential='team', listConnectorItems MUST route to runTeamList — never the personal drain.
  const { listConnectorItems, __setPersonalDrainForTest } = await import("./connectors/warehouse-sync-transport.ts");
  let personalCalled = false;
  __setPersonalDrainForTest(async () => {
    personalCalled = true;
    return [];
  });
  let teamCalled = false;
  await listConnectorItems(
    {
      vault: { get: async () => "x", set: async () => {}, delete: async () => {}, listKeys: async () => [] },
      sandboxCwd: "/tmp",
      credentialFor: () => ({ credential: "team", teamEntry: "prod-snowflake" }),
      runTeamList: async () => {
        teamCalled = true;
        return [];
      },
    } as never,
    "snowflake",
    "snowflake_list",
  );
  expect(teamCalled).toBe(true);
  expect(personalCalled).toBe(false);
  __setPersonalDrainForTest(undefined);
});

test("the answerFederatedInvoke peer path remains the sole federated consumption site", async () => {
  const rpc = await read("packages/gateway/src/ipc/federation-rpc.ts");
  expect(rpc).toContain("answerFederatedInvoke"); // unchanged from the existing assertion
});
```

- [ ] **Step 2: Run it red** → the new tests fail until Tasks 5–6 are merged (they are; this just locks them under I19).

- [ ] **Step 3: Run green + the whole invariants suite + the static audit**

Run: `bun test packages/gateway/src/security-invariants.test.ts`
Run: `bun run audit:structure` (or the exact D15 static-audit script name from `scripts/structure-audit/check-nimbus-invariants.ts`)
Expected: PASS; **invariant count unchanged**; D15 green (no new `"teamvault."` literal site).

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/security-invariants.test.ts
git commit -m "test(security): extend I19 for the localOperator team-credential path"
```

---

## Task 10: Snowflake team e2e via a sink seam (O4)

**Files:**

- Create: `packages/gateway/src/connectors/warehouse-team-sync.e2e.test.ts`
- Modify: `packages/gateway/src/connectors/warehouse-sync-transport.ts` (add a `NIMBUS_WAREHOUSE_E2E_SINK_DIR` seam mirroring `NIMBUS_CHATOPS_E2E_SINK_DIR`)

Reuse the Slice-5 seam pattern (`buildE2eSinkRunChatopsTool`): an env-gated file-backed connector that the e2e drives a near-real transport against without a live warehouse, asserting the gate → drain → index path + the audit row.

- [ ] **Step 1: Add the env-gated seam to the team list path**

In `assemble.ts` where `openSession: drainTeamListSession` is wired, branch on `processEnvGet("NIMBUS_WAREHOUSE_E2E_SINK_DIR")`: when set, use a sink session that reads `<sinkDir>/mock-warehouse.json` (`{ pages: [[...],[...]] }`) and returns those pages (proving the drain) instead of spawning. Keep production wired to `drainTeamListSession`.

- [ ] **Step 2: Write the e2e test** — set the sink dir, write a 2-page fixture + a team-vault entry with a fake secret, run `answerLocalOperatorList` → assert: items aggregated across both pages, an `audit_log` row with `principal:"localOperator"`, `decision:"answered"`, and no secret-shaped string anywhere in the indexed rows or the audit row.

- [ ] **Step 3: Run green + commit**

```bash
bun test packages/gateway/src/connectors/warehouse-team-sync.e2e.test.ts
git add packages/gateway/src/connectors/warehouse-team-sync.e2e.test.ts packages/gateway/src/platform/assemble.ts
git commit -m "test(connectors): team-credential warehouse sync e2e via sink seam"
```

---

## Phase 2 — Fan out the other five connectors

> **Per-connector cadence (commit per connector to avoid subagent-death mid-registration):** for each, (a) paginate `<svc>_list` in the connector `server.ts` + a `test/server-list-pagination.test.ts`, (b) rewrite `<svc>-sync.ts` onto `listConnectorItems` + update its `*-sync.test.ts` (personal + team), (c) drop its `ensure<Svc>McpRunning` wiring in `assemble-sync-registrations.ts`, (d) typecheck the connector + gateway, (e) commit. The structure mirrors Tasks 7–8; only the **cursor contract, URL, and mapper** differ — given below per connector. **Each cursor contract is the vendor's documented model and MUST be verified against live docs during implementation; the test fakes that shape.**

## Task 11: Tableau

- **`_list` today:** `GET /api/3.4/sites/{siteId}/views`, response `{ views: { view: [...] }, pagination: { pageNumber, pageSize, totalAvailable } }`, client-side cap. Mapper: `mapTableauViewToItem`. Sync file: `tableau-sync.ts`.
- **Cursor contract:** add `?pageSize={limit}&pageNumber={n}` to the views request. Tableau is **1-based**, so parse defensively — `const n = Number(p.cursor) || 1;` maps `null`/`undefined`/`""`/`"0"` all to page 1 (never page 0 / out-of-bounds / a repeated first page). `nextCursor` = `String(n+1)` while `n * pageSize < totalAvailable`, else `null`. Read `pagination.totalAvailable` from the response.
- [ ] Step 1: `tableau/test/server-list-pagination.test.ts` — fake two pages with `pagination.totalAvailable = 3`, assert `pageNumber`/`pageSize` query params sent and `nextCursor` advances then nulls. **Add an edge-case case:** `cursor: "0"` and `cursor: null` both request `pageNumber=1` (assert via the captured query string).
- [ ] Step 2: implement pagination in `tableau_list` (compute next page from `pagination`), run green.
- [ ] Step 3: rewrite `tableau-sync.ts` to `listConnectorItems(ctx, "tableau", "tableau_list")` + `mapTableauViewToItem`; update `tableau-sync.test.ts` (personal + team + no-leak), run green.
- [ ] Step 4: drop `ensureTableauMcpRunning` in `assemble-sync-registrations.ts`; `bun run typecheck`.
- [ ] Step 5: commit `feat(connectors): paginate + unify tableau sync (team-credential capable)`.

## Task 12: Looker

- **`_list` today:** `GET /api/4.0/dashboards` → bare array, client-side cap. Mappers: `mapLookerDashboardToItem` + `mapLookerViewToItem` (LookML models, used for lineage). Sync file: `looker-sync.ts`.
- **Both fetches must use the SAME credential (review §3 — corrects the earlier deferral).** A team-credentialed Looker sync cannot fall back to personal creds for the models fetch — personal creds are typically absent/unauthorized, so the lineage would silently drop for exactly the team setups 7b targets. The model listing must run inside the same credentialed session as the dashboards. Add a second drained tool `looker_models_list` (cursor/limit → `{items,nextCursor}`, `GET /api/4.0/lookml_models` with `limit`/`offset`); the sync drains both `looker_list` and `looker_models_list` through `listConnectorItems` (two `listConnectorItems` calls, same `credentialFor` result).
- **Cursor contract:** add `?limit={limit}&offset={offset}` to `/api/4.0/dashboards`. `cursor` = offset string (absent → 0). `nextCursor` = `String(offset+limit)` when the returned array length === limit, else `null`.
- [ ] Step 1: `looker/test/server-list-pagination.test.ts` — for **both** `looker_list` (dashboards) and `looker_models_list` (LookML models): full page → nextCursor advances; short page → null; assert `limit`/`offset` query params.
- [ ] Step 2: implement pagination on `looker_list`; **add** `looker_models_list` (paginated `GET /api/4.0/lookml_models`), run green.
- [ ] Step 3: rewrite `looker-sync.ts` to drain **both** lists via the unified transport — `listConnectorItems(ctx, "looker", "looker_list")` for dashboards and `listConnectorItems(ctx, "looker", "looker_models_list")` for models — then map with `mapLookerDashboardToItem` / `mapLookerViewToItem` and build the **same** `normalizeDataModelKey` lineage edges as Wave 7a (re-use its mapper + lineage fixtures, byte-identical). Update `looker-sync.test.ts` with a team-credential case asserting **both** dashboards and model lineage are produced via `runTeamList` (not the personal path). Run green.
- [ ] Step 4: drop `ensureLookerMcpRunning`; typecheck.
- [ ] Step 5: commit `feat(connectors): paginate + unify looker sync incl. team-credentialed model lineage`.

> **Looker note:** the lineage *logic* (`normalizeDataModelKey`, the graph populators) stays byte-identical to Wave 7a — only the *transport* of both lists changes (gateway-side fetch → spawned `_list`/`_models_list`). The non-negotiable from review §3: both fetches share one credential, so a team sync produces full lineage without any personal-credential dependency.

## Task 13: Power BI

- **`_list` today:** `GET /v1.0/myorg/reports` → `{ value: [...] }`, client-side cap. The Power BI reports endpoint does **not** support OData `$skip`/`$top` server paging reliably. Mapper: `mapPowerBiReportToItem`. Sync file: `powerbi-sync.ts` (note its async `processReport` per-report dataset-table fetch).
- **No pagination — single fetch (review §1).** Iterating pages would re-fetch the entire `{value}` array on every `_list` call (N fetches to slice). Report lists are small (≪ 500), so `powerbi_list` fetches once and returns **all** reports with `nextCursor: null` (the `cursor` arg is accepted and ignored; `limit` still caps defensively). `drainPagedList` then makes exactly one call. Simpler, no redundant cloud round-trips.
- **Dataset-table lineage must use the SAME credential (review §3, applied to Power BI).** `processReport` does a *second* credentialed fetch (dataset tables) — under team creds it must run inside the spawned session, never on a personal credential. Move that fetch into the connector: `powerbi_list` returns each report **with its dataset-table refs already expanded** in the payload, so the gateway only maps + builds lineage (no second gateway-side credentialed call). This keeps team syncs fully lineage-complete and the secret in-process.
- [ ] Step 1: `powerbi/test/server-list-pagination.test.ts` — fetch returns 3 reports (each with expanded dataset-table refs); one `powerbi_list({ cursor: null, limit: 200 })` call → all 3 items + `nextCursor: null`; assert the reports endpoint is hit exactly **once**. Add a case proving each returned report carries its dataset-table refs.
- [ ] Step 2: implement single-fetch `powerbi_list` (all reports, `nextCursor: null`) with `processReport`'s dataset-table fetch folded into the connector payload, run green.
- [ ] Step 3: rewrite `powerbi-sync.ts` onto `listConnectorItems(ctx, "powerbi", "powerbi_list")` + `mapPowerBiReportToItem` + the **same** dataset-table lineage edges as Wave 7a (now read from the expanded payload, not a gateway-side fetch). Update `powerbi-sync.test.ts` with a team case asserting report items **and** dataset-table lineage via `runTeamList`. Run green.
- [ ] Step 4: drop `ensurePowerbiMcpRunning`; typecheck.
- [ ] Step 5: commit `feat(connectors): single-fetch + unify powerbi sync incl. team-credentialed dataset lineage`.

## Task 14: Monte Carlo

- **`_list` today:** GraphQL `POST /graphql`, `getIncidents(first: 500)` hardcoded, response `{ data: { getIncidents: { edges: [{ node }] } } }`. Mapper: `mapMonteCarloIncidentToItem`. Sync file: `monte-carlo-sync.ts`.
- **Cursor contract (relay GraphQL):** change the query to `getIncidents(first: {limit}, after: {cursor}) { edges { node { ... } } pageInfo { hasNextPage endCursor } }`. `cursor` = `after` token (absent → omit `after`). `nextCursor` = `pageInfo.endCursor` when `pageInfo.hasNextPage`, else `null`. Pass `first`/`after` as GraphQL variables (not string interpolation).
- [ ] Step 1: `monte-carlo/test/server-list-pagination.test.ts` — page 1 `hasNextPage:true,endCursor:"c2"`; page 2 `hasNextPage:false`; assert `after` variable threaded.
- [ ] Step 2: implement (query + variables + pageInfo), run green.
- [ ] Step 3: rewrite `monte-carlo-sync.ts` onto `listConnectorItems(ctx, "montecarlo", "montecarlo_list")` + `mapMonteCarloIncidentToItem`; update test (personal + team + no-leak), run green.
- [ ] Step 4: drop `ensureMontecarloMcpRunning`; typecheck.
- [ ] Step 5: commit `feat(connectors): paginate + unify montecarlo sync (team-credential capable)`.

> **Service-id note:** the config + spawner key is `montecarlo` (no hyphen) per `CONNECTOR_VAULT_SECRET_KEYS` / `connector-catalog.ts`, even though the package dir is `monte-carlo`. Use `"montecarlo"` as the `service` / `listToolId` prefix (`montecarlo_list`).

## Task 15: Bigeye

- **`_list` today:** `GET /api/v1/issues` → array or `{ issues: [...] }` or `{ data: [...] }`, client-side cap. Mapper: `mapBigeyeIssueToItem`. Sync file: `bigeye-sync.ts`.
- **Cursor contract:** add `?limit={limit}&offset={offset}` to `/api/v1/issues`. `cursor` = offset string (absent → 0). `nextCursor` = `String(offset+limit)` when the returned array length === limit, else `null`.
- [ ] Step 1: `bigeye/test/server-list-pagination.test.ts` — full page advances; short page nulls; assert `limit`/`offset` params.
- [ ] Step 2: implement, run green.
- [ ] Step 3: rewrite `bigeye-sync.ts` onto `listConnectorItems(ctx, "bigeye", "bigeye_list")` + `mapBigeyeIssueToItem`; update test, run green.
- [ ] Step 4: drop `ensureBigeyeMcpRunning`; typecheck.
- [ ] Step 5: commit `feat(connectors): paginate + unify bigeye sync (team-credential capable)`.

---

## Phase 3 — Docs, invariant triple, preflight

## Task 16: Docs + I19 triple-rule update

**Files:**

- Modify: `docs/SECURITY-INVARIANTS.md` (I19 row), `CLAUDE.md` (I19 line), `GEMINI.md` (I19 line), `docs/CHANGELOG.md`, `docs/roadmap.md`.

- [ ] **Step 1: I19 wording** — broaden "an inbound peer" → "a peer **or** local-operator principal" in `docs/SECURITY-INVARIANTS.md` I19 + the matching CLAUDE.md/GEMINI.md I19 bullet. **Count stays at I25 — no new invariant.** Note the wiring sites are unchanged (`invoke-gate.ts`, `team-tool-invoke.ts`).
- [ ] **Step 2: CHANGELOG** — add a Wave-7b entry under the connector-delivery convention (per the `connector-docs-changelog-convention` rule): config `[connectors.<name>]`, team-credential path, unified spawn transport, pagination, Looker/Power BI lineage fully team-credentialed. **Known limitation to list explicitly:** the 6 vendor cursor/pagination contracts are implemented against documented vendor models but were **not** verified against live APIs in development — first live-API run may need a cursor-shape correction (tracked follow-up).
- [ ] **Step 3: roadmap** — mark Slice 7 Wave 7b status; record the deferred sub-items (D6 live-API verification follow-up; audit-identity-subject from review §4).
- [ ] **Step 4: doc-refs audit** — `bun run audit:doc-refs && bun run audit:readme-cli`. Fix any broken refs.
- [ ] **Step 5: Commit**

```bash
git add docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md docs/CHANGELOG.md docs/roadmap.md
git commit -m "docs: Wave 7b team-credential path (I19 wording, CHANGELOG, roadmap)"
```

## Task 17: Full preflight + Docker coverage dry-run (ship-readiness — never push-and-see)

- [ ] **Step 1: Full typecheck across all packages** — `bun run typecheck` (sequential if the OOM trap bites; see the date-rollover/OOM memory). Resolve any `@nimbus-dev/client` worktree false-fail by `cd packages/client && bun run build`.
- [ ] **Step 2: Lint** — `bunx biome check packages scripts` (the in-worktree biome false-fail caveat — do not trust `bun run lint` inside `.claude/worktrees`).
- [ ] **Step 3: Full preflight** — `bun run preflight` (full CI parity, all gates). Green required.
- [ ] **Step 4: Coverage floor (CI-Linux-authoritative) in Docker** — run the lcov build + `check.ts` under `oven/bun:latest` (bun 1.3.14) per the ship-readiness rule. Every changed/new file must clear ≥80% line+branch against baseline `{}`. Fix gaps with targeted tests (not exclusions) before pushing.
- [ ] **Step 5: Whole-branch review** — `/code-review` over the full branch diff; address findings.
- [ ] **Step 6: Push** — only after Steps 1–5 are green. `git push -u origin dev/asafgolombek/phase6-slice7-wave7b` and open the PR. Watch the 3-OS matrix + coverage-floor; if a reseed round is needed, use the **PR's own merge-lcov artifact**, never stale main lcov.

---

## Acceptance criteria (Wave 7b exit — from design §8)

1. A connector configured `credential="team"` sources its secret **only** via the I19 machinery (gate → `invokeTeamToolList` → session), **fails closed** on a missing team secret with the actionable `nimbus team vault put …` message, and the secret never appears in config, logs, IPC, the `SyncResult`, or any indexed SQLite row (Tasks 5, 8, 9, 10).
2. `credential="personal"` (default) indexes the same items as Wave 7a after the unify; pagination parity preserved (Tasks 6–8, 11–15).
3. The federated **peer** invoke path is behaviorally identical post-refactor — existing peer tests unchanged & green (Task 5).
4. `bun run preflight` green on the 3-OS matrix; `security-invariants.test.ts` count **unchanged** (no new invariant); D15 static audit green (Tasks 9, 17).
5. Every changed/new file clears the ≥80% line+branch coverage floor, verified by Docker dry-run before the first push (Task 17).

---

## Self-review notes (gaps surfaced; addressed inline)

- **Mapper input shape (snowflake/powerbi/looker)** is the highest-risk unknown — each connector task carries an explicit "verify the mapper's expected raw shape and make `_list` emit it so the Wave-7a mapper stays unchanged" step. Do not change a mapper; change what the connector emits.
- **Power BI `processReport` + Looker models** do a *second* credentialed fetch with lineage implications. Per review §3, the deferral is removed: both fetches MUST run under the same credential, in-session (Looker via a second `looker_models_list` drained tool; Power BI by folding the dataset-table fetch into `powerbi_list`'s payload). A team sync therefore produces full lineage with no personal-credential dependency. This raises T12/T13 scope (an extra connector tool / payload expansion each) — accept it; the alternative ships broken team lineage.
- **`runTeamList` actionable error** uses the verified verb `nimbus identity login` (Task 6 Step 6) and the verified `nimbus team vault put …` for the missing-entry case.
- **Coverage floor on the 6 just-merged connector files** — re-baselining is expected (design §2.2 accepted cost); Task 17 Step 4 is the gate.
