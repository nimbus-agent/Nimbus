# LaunchDarkly Connector Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a first-party, read-only LaunchDarkly feature-flag connector (`launchdarkly:feature_flag`) that indexes flags across all (or one configured) LaunchDarkly project into the local index, following the Snyk/SonarQube/Semgrep/Wiz template.

**Architecture:** A standalone MCP server (`packages/mcp-connectors/launchdarkly/`) exposing the three mandatory read tools, plus a gateway-side `Syncable` (`launchdarkly-sync.ts`) that walks `GET /api/v2/projects` → `GET /api/v2/flags/{projectKey}` and upserts each flag via a pure mapper (`launchdarkly-flag-mapping.ts`). Wired through the seven standard sites. Read-only; `hitlRequired: []`. The `launchdarkly.flag.toggle` write tool is a deferred Phase 8 follow-up.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict (no `any`), `bun:test`, `@modelcontextprotocol/sdk`, `zod`. LaunchDarkly REST API v2 (API-token auth: the raw token in the `Authorization` header — **no** `Bearer` prefix, unlike Semgrep).

**Spec:** [`docs/superpowers/specs/2026-05-24-phase-5-connector-buildout-program-design.md`](../specs/2026-05-24-phase-5-connector-buildout-program-design.md) (Tier 1, connector #1).

**Reference implementation:** the Semgrep connector (`packages/mcp-connectors/semgrep/` + `packages/gateway/src/connectors/semgrep-*.ts`). This connector is structurally identical; the differences are the API endpoints, the auth header (raw token), and the item shape (`feature_flag`).

---

## File Structure

### Files created

| Path | Responsibility |
|---|---|
| `packages/mcp-connectors/launchdarkly/package.json` | Bun workspace package manifest. |
| `packages/mcp-connectors/launchdarkly/tsconfig.json` | Extends repo base tsconfig. |
| `packages/mcp-connectors/launchdarkly/nimbus.extension.json` | Connector manifest (sandbox `network` allow-list + `hitlRequired: []`). |
| `packages/mcp-connectors/launchdarkly/README.md` | Connector usage doc. |
| `packages/mcp-connectors/launchdarkly/src/search-filter.ts` | Pure substring filter for `launchdarkly_search`. |
| `packages/mcp-connectors/launchdarkly/src/server.ts` | MCP server: `launchdarkly_list` / `launchdarkly_get` / `launchdarkly_search`. |
| `packages/mcp-connectors/launchdarkly/test/search-filter.test.ts` | Unit test for the pure filter. |
| `packages/mcp-connectors/launchdarkly/test/sandbox.test.ts` | Sandbox contract test (gated on `NIMBUS_TEST_HARNESS`). |
| `packages/gateway/src/connectors/launchdarkly-flag-mapping.ts` | Pure LaunchDarkly flag → indexed-row mapper. |
| `packages/gateway/src/connectors/launchdarkly-sync.ts` | Gateway-side `Syncable`. |
| `packages/gateway/test/unit/connectors/launchdarkly-flag-mapping.test.ts` | Mapper unit tests. |
| `packages/gateway/test/integration/connectors/launchdarkly-sync-fake-server.test.ts` | Sync integration test against a `Bun.serve` fake (incl. error/429 path). |

### Files modified

| Path | Change |
|---|---|
| `package.json` (root) | Add `packages/mcp-connectors/launchdarkly` to `workspaces`. |
| `packages/gateway/src/connectors/connector-catalog.ts` | Add `"launchdarkly"` to `CONNECTOR_SERVICE_IDS`, the interval map, and the OAuth-unsupported map. |
| `packages/gateway/src/connectors/connector-secrets-manifest.ts` | Add the `launchdarkly` vault-key entry. |
| `packages/gateway/src/sync/rate-limiter.ts` | Add `"launchdarkly"` to the `Provider` union + `DEFAULT_QUOTAS`. |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts` | Add the `launchdarkly` sandbox manifest. |
| `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts` | Add `"launchdarkly"` to the manifest enumeration test. |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts` | Add `phase3AddLaunchdarklyMcp` + append to `buildPhase3Servers`. |
| `packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts` | Add the `phase3AddLaunchdarklyMcp` test block + import. |
| `packages/gateway/src/platform/assemble-sync-registrations.ts` | Import + register `createLaunchdarklySyncable`. |
| `CLAUDE.md`, `GEMINI.md` | Append the status-line entry. |
| `docs/roadmap.md` | Flip the LaunchDarkly checklist item to a full `[x]` summary. |
| `.claude/commands/nimbus-file-map.md` | Add `launchdarkly-sync.ts`, `launchdarkly-flag-mapping.ts`, `mcp-connectors/launchdarkly/src/server.ts` rows. |

---

## Task 0: Worktree + branch

**Files:** none (git only).

- [ ] **Step 1: Create the connector worktree off latest `main`**

```bash
cd C:/gitrep/Nimbus
git fetch origin main
git worktree add C:/gitrep/Nimbus/.worktrees/connector-launchdarkly -b dev/asafgolombek/connector-launchdarkly origin/main
```

Expected: `Preparing worktree (new branch 'dev/asafgolombek/connector-launchdarkly')`.

- [ ] **Step 2: Confirm branch + clean tree**

```bash
cd C:/gitrep/Nimbus/.worktrees/connector-launchdarkly
git rev-parse --abbrev-ref HEAD
git status --short
```

Expected: `dev/asafgolombek/connector-launchdarkly` and no output from status.

**All subsequent paths are relative to `C:/gitrep/Nimbus/.worktrees/connector-launchdarkly`.**

---

## Task 1: MCP connector package scaffolding + workspace install

**Files:**
- Create: `packages/mcp-connectors/launchdarkly/package.json`
- Create: `packages/mcp-connectors/launchdarkly/tsconfig.json`
- Create: `packages/mcp-connectors/launchdarkly/nimbus.extension.json`
- Create: `packages/mcp-connectors/launchdarkly/README.md`
- Modify: `package.json` (root)

- [ ] **Step 1: Create `packages/mcp-connectors/launchdarkly/package.json`**

```json
{
  "name": "nimbus-mcp-launchdarkly",
  "version": "0.1.0",
  "private": false,
  "license": "AGPL-3.0-only",
  "type": "module",
  "scripts": {
    "typecheck": "tsc --noEmit",
    "lint": "biome check src/",
    "test": "bun test",
    "clean": "rm -rf dist"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.29.0",
    "@nimbus-dev/sdk": "workspace:*",
    "zod": "^4.4.2"
  },
  "devDependencies": {
    "@types/bun": "latest"
  }
}
```

- [ ] **Step 2: Create `packages/mcp-connectors/launchdarkly/tsconfig.json`**

```json
{
  "extends": "../../../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"]
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist"]
}
```

- [ ] **Step 3: Create `packages/mcp-connectors/launchdarkly/nimbus.extension.json`**

```json
{
  "id": "com.nimbus.launchdarkly",
  "displayName": "LaunchDarkly",
  "version": "0.1.0",
  "description": "LaunchDarkly feature-flag connector (read-only). Surfaces flag key, name, kind, tags, per-environment on/off state, maintainer, and timestamps into the local index as `launchdarkly:feature_flag` items — useful for incident correlation (\"was this flag enabled when the alert fired?\"). API-token auth. Regional / federal instances override `launchdarkly.base_url`; the SaaS host (app.launchdarkly.com) is the only one in the static sandbox manifest today (Task 14 runtime-merge follow-up). The `launchdarkly.flag.toggle` write tool is a deferred Phase 8 follow-up.",
  "author": "Nimbus",
  "entrypoint": "dist/server.js",
  "runtime": "bun",
  "permissions": {
    "network": ["app.launchdarkly.com"]
  },
  "hitlRequired": [],
  "syncInterval": 600,
  "minNimbusVersion": "0.2.0"
}
```

- [ ] **Step 4: Create `packages/mcp-connectors/launchdarkly/README.md`**

```markdown
# nimbus-mcp-launchdarkly

First-party Nimbus MCP connector for [LaunchDarkly](https://launchdarkly.com)
feature flags. Read-only.

## Tools

- `launchdarkly_list` — list flags for a project (or list projects).
- `launchdarkly_get` — fetch one flag by `projectKey` + `flagKey`.
- `launchdarkly_search` — substring search across a project's flags.

## Credentials (vault keys, injected at spawn time)

- `launchdarkly.token` — **required.** A LaunchDarkly REST API access token.
- `launchdarkly.base_url` — optional. Override for regional/federal instances
  (default `https://app.launchdarkly.com`).
- `launchdarkly.project_key` — optional. Restrict the sync to one project;
  otherwise all projects are walked.

## Item shape

`launchdarkly:feature_flag`, `external_id = "<projectKey>:<flagKey>"`. Metadata:
`key`, `name`, `kind`, `project_key`, `tags`, `temporary`, `archived`,
`maintainer`, `maintainer_id`, `description`, `variation_count`,
`environments`, `env_states`, `created_at`, `updated_at`, `canonical_url`.

## Deferred (Phase 8)

`launchdarkly.flag.toggle` (HITL-gated write).
```

- [ ] **Step 5: Register the workspace in root `package.json`**

Find the `workspaces` array (it lists `packages/mcp-connectors/semgrep` near the end) and add the LaunchDarkly entry immediately after `packages/mcp-connectors/semgrep`:

```json
    "packages/mcp-connectors/semgrep",
    "packages/mcp-connectors/launchdarkly",
    "packages/vscode-extension"
```

- [ ] **Step 6: Install so the new workspace links `@nimbus-dev/sdk`**

```bash
bun install
```

Expected: completes; `bun.lock` updated to include `nimbus-mcp-launchdarkly`. (This step is mandatory — without it `@nimbus-dev/sdk/testing` will not resolve in the sandbox test.)

- [ ] **Step 7: Commit scaffolding**

```bash
git add packages/mcp-connectors/launchdarkly/package.json \
        packages/mcp-connectors/launchdarkly/tsconfig.json \
        packages/mcp-connectors/launchdarkly/nimbus.extension.json \
        packages/mcp-connectors/launchdarkly/README.md \
        package.json bun.lock
git commit -m "$(cat <<'EOF'
feat(launchdarkly): scaffold mcp-connectors/launchdarkly package

Manifest (read-only, hitlRequired: []), package.json, tsconfig, README.
Registers the workspace; no server logic yet.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: Search filter (pure) — TDD

**Files:**
- Create: `packages/mcp-connectors/launchdarkly/test/search-filter.test.ts`
- Create: `packages/mcp-connectors/launchdarkly/src/search-filter.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-connectors/launchdarkly/test/search-filter.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { filterLaunchDarklyFlags } from "../src/search-filter.ts";

function flag(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "enable-new-checkout",
    name: "Enable new checkout",
    description: "Rolls out the redesigned checkout flow.",
    tags: ["checkout", "frontend"],
    ...over,
  };
}

describe("filterLaunchDarklyFlags", () => {
  test("matches against name (case-insensitive)", () => {
    const out = filterLaunchDarklyFlags([flag()], { query: "CHECKOUT" });
    expect(out).toHaveLength(1);
  });

  test("matches against key, description, and tags", () => {
    expect(filterLaunchDarklyFlags([flag()], { query: "enable-new" })).toHaveLength(1);
    expect(filterLaunchDarklyFlags([flag()], { query: "redesigned" })).toHaveLength(1);
    expect(filterLaunchDarklyFlags([flag()], { query: "frontend" })).toHaveLength(1);
  });

  test("non-match returns empty", () => {
    expect(filterLaunchDarklyFlags([flag()], { query: "nonsense" })).toHaveLength(0);
  });

  test("skips non-object entries", () => {
    expect(filterLaunchDarklyFlags([null, 42, "x", flag()], { query: "checkout" })).toHaveLength(1);
  });

  test("honors the limit cap", () => {
    const many = Array.from({ length: 10 }, (_, i) => flag({ key: `flag-${String(i)}` }));
    expect(filterLaunchDarklyFlags(many, { query: "Enable new", limit: 3 })).toHaveLength(3);
  });
});
```

- [ ] **Step 2: Run it — verify failure**

```bash
bun test packages/mcp-connectors/launchdarkly/test/search-filter.test.ts
```

Expected: FAIL — `Cannot find module '../src/search-filter.ts'`.

- [ ] **Step 3: Create `packages/mcp-connectors/launchdarkly/src/search-filter.ts`**

```ts
/**
 * Pure substring-match filter for `launchdarkly_search`. Extracted from
 * `server.ts` so the matching logic can be unit-tested without spawning an
 * MCP stdio transport. The server keeps the HTTP / envelope wrapper; this
 * module owns the key/name/description/tags haystack + case-insensitive
 * substring match.
 */

export interface LaunchDarklySearchMatchOptions {
  readonly query: string;
  readonly limit?: number | undefined;
}

function stringField(row: Record<string, unknown>, key: string): string {
  const v = row[key];
  return typeof v === "string" ? v : "";
}

function tagsString(row: Record<string, unknown>): string {
  const tags = row["tags"];
  if (!Array.isArray(tags)) {
    return "";
  }
  return tags.filter((t): t is string => typeof t === "string").join(" ");
}

function buildHaystack(row: Record<string, unknown>): string {
  const key = stringField(row, "key");
  const name = stringField(row, "name");
  const description = stringField(row, "description");
  return `${key} ${name} ${description} ${tagsString(row)}`.toLowerCase();
}

export function filterLaunchDarklyFlags(
  flags: readonly unknown[],
  options: LaunchDarklySearchMatchOptions,
): unknown[] {
  const needle = options.query.toLowerCase();
  const cap = options.limit ?? 50;
  const out: unknown[] = [];
  for (const it of flags) {
    if (it === null || typeof it !== "object") {
      continue;
    }
    const row = it as Record<string, unknown>;
    if (!buildHaystack(row).includes(needle)) {
      continue;
    }
    out.push(it);
    if (out.length >= cap) {
      break;
    }
  }
  return out;
}
```

- [ ] **Step 4: Run it — verify pass**

```bash
bun test packages/mcp-connectors/launchdarkly/test/search-filter.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-connectors/launchdarkly/src/search-filter.ts \
        packages/mcp-connectors/launchdarkly/test/search-filter.test.ts
git commit -m "$(cat <<'EOF'
feat(launchdarkly): pure search-filter + unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Sandbox contract test (gated)

**Files:**
- Create: `packages/mcp-connectors/launchdarkly/test/sandbox.test.ts`

- [ ] **Step 1: Create the test**

Create `packages/mcp-connectors/launchdarkly/test/sandbox.test.ts`:

```ts
// Sandbox contract test — verifies the declared manifest permissions match
// runtime enforcement when this connector is spawned under the gateway's
// sandbox runner.
//
// Gated on NIMBUS_TEST_HARNESS because `runSandboxContractTests` expects the
// probe to run inside a sandbox-wrapped process. LaunchDarkly joins the same
// deferred-harness queue as Snyk / SonarQube / Semgrep / Wiz.

import { describe, it } from "bun:test";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runSandboxContractTests } from "@nimbus-dev/sdk/testing";

const manifestPath = resolve(fileURLToPath(import.meta.url), "../../nimbus.extension.json");

describe.skipIf(!process.env["NIMBUS_TEST_HARNESS"])("sandbox contract", () => {
  it("respects declared permissions", async () => {
    await runSandboxContractTests(manifestPath);
  });
});
```

- [ ] **Step 2: Run it — verify it loads + skips**

```bash
bun test packages/mcp-connectors/launchdarkly/test/sandbox.test.ts
```

Expected: `1 skip`, `0 fail` (the `@nimbus-dev/sdk/testing` import resolves thanks to Task 1 Step 6; the body is skipped without `NIMBUS_TEST_HARNESS`).

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-connectors/launchdarkly/test/sandbox.test.ts
git commit -m "$(cat <<'EOF'
test(launchdarkly): sandbox contract test (NIMBUS_TEST_HARNESS-gated)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Flag mapper (pure) — TDD

**Files:**
- Create: `packages/gateway/test/unit/connectors/launchdarkly-flag-mapping.test.ts`
- Create: `packages/gateway/src/connectors/launchdarkly-flag-mapping.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/gateway/test/unit/connectors/launchdarkly-flag-mapping.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  flagUrl,
  mapLaunchDarklyFlagToItem,
} from "../../../src/connectors/launchdarkly-flag-mapping.ts";

function makeFlag(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key: "enable-new-checkout",
    name: "Enable new checkout",
    kind: "boolean",
    description: "Rolls out the redesigned checkout flow.",
    tags: ["checkout", "frontend"],
    temporary: true,
    archived: false,
    creationDate: 1_700_000_000_000,
    maintainerId: "user-123",
    _maintainer: { email: "dev@acme.com", firstName: "Dev", lastName: "Eloper" },
    variations: [{ value: true }, { value: false }],
    environments: {
      production: { on: true, lastModified: 1_700_000_500_000 },
      staging: { on: false, lastModified: 1_700_000_200_000 },
    },
    ...over,
  };
}

const NOW = 1_700_009_999_999;
const BASE = "https://app.launchdarkly.com";

function meta(row: { metadata: Record<string, unknown> }): Record<string, unknown> {
  return row.metadata;
}

describe("mapLaunchDarklyFlagToItem", () => {
  test("returns null when the row is not a plain object", () => {
    expect(mapLaunchDarklyFlagToItem(null, { baseUrl: BASE, projectKey: "default", syncedAt: NOW })).toBeNull();
    expect(mapLaunchDarklyFlagToItem("nope", { baseUrl: BASE, projectKey: "default", syncedAt: NOW })).toBeNull();
  });

  test("returns null when key is missing or empty", () => {
    const noKey = makeFlag();
    delete (noKey as Record<string, unknown>)["key"];
    expect(mapLaunchDarklyFlagToItem(noKey, { baseUrl: BASE, projectKey: "default", syncedAt: NOW })).toBeNull();
    expect(mapLaunchDarklyFlagToItem(makeFlag({ key: "" }), { baseUrl: BASE, projectKey: "default", syncedAt: NOW })).toBeNull();
  });

  test("service/type fixed; externalId is <projectKey>:<flagKey>", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.service).toBe("launchdarkly");
    expect(row.type).toBe("feature_flag");
    expect(row.externalId).toBe("default:enable-new-checkout");
  });

  test("title from name; falls back to key", () => {
    const withName = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (withName === null) throw new Error("expected mapping to succeed");
    expect(withName.title).toBe("Enable new checkout");

    const noName = makeFlag();
    delete (noName as Record<string, unknown>)["name"];
    const row = mapLaunchDarklyFlagToItem(noName, { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.title).toBe("enable-new-checkout");
  });

  test("bodyPreview from description; falls back to title", () => {
    const noDesc = makeFlag();
    delete (noDesc as Record<string, unknown>)["description"];
    const row = mapLaunchDarklyFlagToItem(noDesc, { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.bodyPreview).toBe("Enable new checkout");
  });

  test("kind accepts boolean/multivariate; unknown → null", () => {
    for (const k of ["boolean", "multivariate"]) {
      const row = mapLaunchDarklyFlagToItem(makeFlag({ kind: k }), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
      if (row === null) throw new Error("expected mapping to succeed");
      expect(meta(row)["kind"]).toBe(k);
    }
    const garbage = mapLaunchDarklyFlagToItem(makeFlag({ kind: "rollout" }), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (garbage === null) throw new Error("expected mapping to succeed");
    expect(meta(garbage)["kind"]).toBeNull();
  });

  test("flag metadata flows through", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    const m = meta(row);
    expect(m["key"]).toBe("enable-new-checkout");
    expect(m["project_key"]).toBe("default");
    expect(m["tags"]).toEqual(["checkout", "frontend"]);
    expect(m["temporary"]).toBe(true);
    expect(m["archived"]).toBe(false);
    expect(m["maintainer"]).toBe("dev@acme.com");
    expect(m["maintainer_id"]).toBe("user-123");
    expect(m["variation_count"]).toBe(2);
    expect(m["created_at"]).toBe(1_700_000_000_000);
  });

  test("environments list + env_states on/off map are derived", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(meta(row)["environments"]).toEqual(["production", "staging"]);
    expect(meta(row)["env_states"]).toEqual({ production: true, staging: false });
  });

  test("modifiedAt = max env lastModified; falls back to creationDate then syncedAt", () => {
    const withEnvs = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (withEnvs === null) throw new Error("expected mapping to succeed");
    expect(withEnvs.modifiedAt).toBe(1_700_000_500_000);

    const noEnvMod = makeFlag({ environments: { production: { on: true } } });
    const createdOnly = mapLaunchDarklyFlagToItem(noEnvMod, { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (createdOnly === null) throw new Error("expected mapping to succeed");
    expect(createdOnly.modifiedAt).toBe(1_700_000_000_000);

    const noDates = makeFlag({ environments: {} });
    delete (noDates as Record<string, unknown>)["creationDate"];
    const fallback = mapLaunchDarklyFlagToItem(noDates, { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (fallback === null) throw new Error("expected mapping to succeed");
    expect(fallback.modifiedAt).toBe(NOW);
  });

  test("url === canonicalUrl and points at the project flag page", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.canonicalUrl).toBe("https://app.launchdarkly.com/projects/default/flags/enable-new-checkout");
    expect(row.url).toBe(row.canonicalUrl);
    expect(meta(row)["canonical_url"]).toBe(row.canonicalUrl);
  });

  test("syncedAt propagates", () => {
    const row = mapLaunchDarklyFlagToItem(makeFlag(), { baseUrl: BASE, projectKey: "default", syncedAt: NOW });
    if (row === null) throw new Error("expected mapping to succeed");
    expect(row.syncedAt).toBe(NOW);
  });
});

describe("flagUrl", () => {
  test("builds the project flag URL from the base host", () => {
    expect(flagUrl("https://app.launchdarkly.com", "default", "my-flag")).toBe(
      "https://app.launchdarkly.com/projects/default/flags/my-flag",
    );
  });

  test("strips a trailing slash on the base url", () => {
    expect(flagUrl("https://app.launchdarkly.com/", "p", "f")).toBe(
      "https://app.launchdarkly.com/projects/p/flags/f",
    );
  });

  test("percent-encodes project and flag keys", () => {
    expect(flagUrl("https://app.launchdarkly.com", "a/b", "c d")).toContain(
      `${encodeURIComponent("a/b")}/flags/${encodeURIComponent("c d")}`,
    );
  });
});
```

- [ ] **Step 2: Run it — verify failure**

```bash
bun test packages/gateway/test/unit/connectors/launchdarkly-flag-mapping.test.ts
```

Expected: FAIL — `Cannot find module '.../launchdarkly-flag-mapping.ts'`.

- [ ] **Step 3: Create `packages/gateway/src/connectors/launchdarkly-flag-mapping.ts`**

```ts
/**
 * Pure mapping from a LaunchDarkly v2 feature-flag rep to the
 * {@link upsertIndexedItemForSync} row shape. Lives separately from
 * `launchdarkly-sync.ts` so the REST path and the indexing path can be
 * tested independently.
 *
 * Emits `service = "launchdarkly", type = "feature_flag"` rows. The
 * `feature_flag` type is sparse/structured (key, name, state), so it stays
 * on local MiniLM embeddings — NOT added to `PROSE_HEAVY_TYPES`.
 */

import { asRecord, stringField } from "./unknown-record.ts";

type Kind = "boolean" | "multivariate";
const KINDS: ReadonlySet<string> = new Set(["boolean", "multivariate"]);

export interface LaunchDarklyMappingContext {
  /** App base URL — used to construct canonical flag URLs. */
  readonly baseUrl: string;
  /** Project key the flag belongs to. */
  readonly projectKey: string;
  readonly syncedAt: number;
}

export interface LaunchDarklyMappedRow {
  readonly service: "launchdarkly";
  readonly type: "feature_flag";
  readonly externalId: string;
  readonly title: string;
  readonly bodyPreview: string;
  readonly url: string | null;
  readonly canonicalUrl: string;
  readonly modifiedAt: number;
  readonly metadata: Record<string, unknown>;
  readonly syncedAt: number;
}

export function flagUrl(baseUrl: string, projectKey: string, flagKey: string): string {
  const base = baseUrl.endsWith("/") ? baseUrl.slice(0, -1) : baseUrl;
  return `${base}/projects/${encodeURIComponent(projectKey)}/flags/${encodeURIComponent(flagKey)}`;
}

function pickEnum<T extends string>(value: unknown, set: ReadonlySet<string>): T | null {
  if (typeof value !== "string") {
    return null;
  }
  return set.has(value) ? (value as T) : null;
}

function numberField(row: Record<string, unknown>, key: string): number | null {
  const v = row[key];
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

function extractTags(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((t): t is string => typeof t === "string");
}

/** Returns { envKeys (sorted), states (envKey→on bool), maxLastModified }. */
function extractEnvironments(value: unknown): {
  readonly envKeys: string[];
  readonly states: Record<string, boolean>;
  readonly maxLastModified: number | null;
} {
  const root = asRecord(value);
  if (root === undefined) {
    return { envKeys: [], states: {}, maxLastModified: null };
  }
  const envKeys = Object.keys(root).sort();
  const states: Record<string, boolean> = {};
  let maxLastModified: number | null = null;
  for (const k of envKeys) {
    const env = asRecord(root[k]) ?? {};
    states[k] = env["on"] === true;
    const lm = numberField(env, "lastModified");
    if (lm !== null && (maxLastModified === null || lm > maxLastModified)) {
      maxLastModified = lm;
    }
  }
  return { envKeys, states, maxLastModified };
}

export function mapLaunchDarklyFlagToItem(
  raw: unknown,
  ctx: LaunchDarklyMappingContext,
): LaunchDarklyMappedRow | null {
  const row = asRecord(raw);
  if (row === undefined) {
    return null;
  }
  const key = stringField(row, "key");
  if (key === undefined || key === "") {
    return null;
  }

  const name = stringField(row, "name") ?? null;
  const description = stringField(row, "description") ?? null;
  const kind = pickEnum<Kind>(row["kind"], KINDS);
  const tags = extractTags(row["tags"]);
  const maintainer = stringField(asRecord(row["_maintainer"]) ?? {}, "email") ?? null;
  const maintainerId = stringField(row, "maintainerId") ?? null;
  const variations = Array.isArray(row["variations"]) ? row["variations"].length : 0;
  const createdAt = numberField(row, "creationDate");
  const { envKeys, states, maxLastModified } = extractEnvironments(row["environments"]);

  const modifiedAt = maxLastModified ?? createdAt ?? ctx.syncedAt;
  const canonicalUrl = flagUrl(ctx.baseUrl, ctx.projectKey, key);
  const title = name ?? key;
  const bodyPreview = description ?? title;

  const metadata: Record<string, unknown> = {
    key,
    name,
    kind,
    project_key: ctx.projectKey,
    tags,
    temporary: row["temporary"] === true,
    archived: row["archived"] === true,
    maintainer,
    maintainer_id: maintainerId,
    description,
    variation_count: variations,
    environments: envKeys,
    env_states: states,
    created_at: createdAt,
    updated_at: maxLastModified,
    canonical_url: canonicalUrl,
  };

  return {
    service: "launchdarkly",
    type: "feature_flag",
    externalId: `${ctx.projectKey}:${key}`,
    title,
    bodyPreview,
    url: canonicalUrl,
    canonicalUrl,
    modifiedAt,
    metadata,
    syncedAt: ctx.syncedAt,
  };
}
```

- [ ] **Step 4: Run it — verify pass**

```bash
bun test packages/gateway/test/unit/connectors/launchdarkly-flag-mapping.test.ts
```

Expected: PASS (all `mapLaunchDarklyFlagToItem` + `flagUrl` tests).

If `stringField` returns `""` vs `undefined`: confirm `unknown-record.ts`'s `stringField` returns `undefined` for a missing/non-string field (it does — same helper Wiz/Semgrep mappers use). The `name ?? null` / `key === undefined` guards rely on that.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/launchdarkly-flag-mapping.ts \
        packages/gateway/test/unit/connectors/launchdarkly-flag-mapping.test.ts
git commit -m "$(cat <<'EOF'
feat(launchdarkly): pure flag mapper + unit tests

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: Sync handler — TDD (integration fake-server)

**Files:**
- Create: `packages/gateway/test/integration/connectors/launchdarkly-sync-fake-server.test.ts`
- Create: `packages/gateway/src/connectors/launchdarkly-sync.ts`

- [ ] **Step 1: Write the failing integration test**

Create `packages/gateway/test/integration/connectors/launchdarkly-sync-fake-server.test.ts`:

```ts
/**
 * Integration: exercise `createLaunchdarklySyncable` against a `Bun.serve`
 * fake LaunchDarkly v2 API. Proves the sync handler walks projects → flags,
 * sends the raw API token in the Authorization header (no Bearer prefix),
 * upserts well-formed rows, and degrades gracefully on error responses.
 *
 * Pattern (matches semgrep/sonarqube/snyk/wiz): a fetch interceptor rewrites
 * the default LaunchDarkly host to the local Bun.serve URL.
 */

import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import pino from "pino";

import { createLaunchdarklySyncable } from "../../../src/connectors/launchdarkly-sync.ts";
import { LocalIndex } from "../../../src/index/local-index.ts";
import { ProviderRateLimiter } from "../../../src/sync/rate-limiter.ts";
import type { SyncContext } from "../../../src/sync/types.ts";
import { createMockVault } from "../../../src/vault/mock.ts";

interface RecordedReq {
  method: string;
  path: string;
  auth: string | null;
  search: URLSearchParams;
}

interface FakeLdConfig {
  projects: Array<{ key: string }>;
  flagsByProject: Record<string, unknown[]>;
  /** When set, the /flags endpoint responds with this status instead of 200. */
  flagsStatus?: number;
}

interface FakeLd {
  baseUrl: string;
  requests: RecordedReq[];
  stop(): void;
}

function startFakeLd(config: FakeLdConfig): FakeLd {
  const requests: RecordedReq[] = [];
  let server: Server | undefined;
  server = Bun.serve({
    port: 0,
    fetch: (req) => {
      const u = new URL(req.url);
      requests.push({
        method: req.method,
        path: u.pathname,
        auth: req.headers.get("authorization"),
        search: u.searchParams,
      });
      if (u.pathname === "/api/v2/projects") {
        return Response.json({ items: config.projects });
      }
      const flagsMatch = /^\/api\/v2\/flags\/([^/]+)$/.exec(u.pathname);
      if (flagsMatch !== null) {
        if (config.flagsStatus !== undefined && config.flagsStatus !== 200) {
          return new Response("error", { status: config.flagsStatus });
        }
        const projectKey = decodeURIComponent(flagsMatch[1] ?? "");
        return Response.json({ items: config.flagsByProject[projectKey] ?? [] });
      }
      return new Response("not found", { status: 404 });
    },
  });
  const baseUrl = `http://${server.hostname}:${server.port}`;
  return { baseUrl, requests, stop: () => server?.stop(true) };
}

interface Harness {
  db: Database;
  ctx: SyncContext;
  fake: FakeLd;
  cleanup: () => void;
}

function startHarness(config: FakeLdConfig): Harness {
  const db = new Database(":memory:");
  LocalIndex.ensureSchema(db);
  const vault = createMockVault();
  const fake = startFakeLd(config);
  const originalFetch = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const rewritten = url.replace("https://app.launchdarkly.com", fake.baseUrl);
    return originalFetch(rewritten, init);
  }) as typeof globalThis.fetch;
  return {
    db,
    fake,
    cleanup: () => {
      globalThis.fetch = originalFetch;
      fake.stop();
      db.close();
    },
    ctx: {
      vault,
      db,
      logger: pino({ level: "silent" }),
      rateLimiter: new ProviderRateLimiter(),
    },
  };
}

function flag(key: string, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    key,
    name: `Flag ${key}`,
    kind: "boolean",
    tags: ["t"],
    creationDate: 1_700_000_000_000,
    environments: { production: { on: true, lastModified: 1_700_000_500_000 } },
    ...over,
  };
}

describe("launchdarkly-sync against Bun.serve fake API", () => {
  let h: Harness | undefined;
  afterEach(() => {
    h?.cleanup();
    h = undefined;
  });

  test("walks projects → flags and upserts well-formed rows with raw-token auth", async () => {
    h = startHarness({
      projects: [{ key: "default" }],
      flagsByProject: { default: [flag("flag-a"), flag("flag-b", { kind: "multivariate" })] },
    });
    await h.ctx.vault.set("launchdarkly.token", "api-test-token");

    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);

    expect(result.itemsUpserted).toBe(2);
    expect(result.hasMore).toBe(false);
    expect(result.cursor?.startsWith("nimbus-launchdarkly1:")).toBe(true);

    // Raw token, no "Bearer " prefix.
    for (const r of h.fake.requests) {
      expect(r.auth).toBe("api-test-token");
    }
    expect(h.fake.requests.filter((r) => r.path === "/api/v2/projects")).toHaveLength(1);

    const rows = h.db
      .query<{ external_id: string; metadata: string }, []>(
        "SELECT external_id, metadata FROM item WHERE service = 'launchdarkly' ORDER BY external_id",
      )
      .all();
    expect(rows.map((r) => r.external_id)).toEqual(["default:flag-a", "default:flag-b"]);
    const a = JSON.parse(rows[0]?.metadata ?? "{}") as Record<string, unknown>;
    expect(a["kind"]).toBe("boolean");
    expect(a["project_key"]).toBe("default");
    expect(a["env_states"]).toEqual({ production: true });
  });

  test("when launchdarkly.project_key is set, skips the /projects round-trip", async () => {
    h = startHarness({
      projects: [{ key: "default" }, { key: "other" }],
      flagsByProject: { mobile: [flag("m1")] },
    });
    await h.ctx.vault.set("launchdarkly.token", "tok");
    await h.ctx.vault.set("launchdarkly.project_key", "mobile");
    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(1);
    expect(h.fake.requests.filter((r) => r.path === "/api/v2/projects")).toHaveLength(0);
    expect(h.fake.requests.some((r) => r.path === "/api/v2/flags/mobile")).toBe(true);
  });

  test("noop when launchdarkly.token is unset — no requests", async () => {
    h = startHarness({ projects: [], flagsByProject: {} });
    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(h.fake.requests).toHaveLength(0);
  });

  test("a 429 on the flags endpoint degrades gracefully (no throw, zero upserts, pass-1 cursor)", async () => {
    h = startHarness({
      projects: [{ key: "default" }],
      flagsByProject: { default: [flag("flag-a")] },
      flagsStatus: 429,
    });
    await h.ctx.vault.set("launchdarkly.token", "tok");
    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    const result = await syncable.sync(h.ctx, null);
    expect(result.itemsUpserted).toBe(0);
    expect(result.cursor?.startsWith("nimbus-launchdarkly1:")).toBe(true);
  });

  test("flag count of exactly PAGE_SIZE triggers a second offset page", async () => {
    const fullPage = Array.from({ length: 100 }, (_, i) => flag(`flag-${String(i)}`));
    h = startHarness({
      projects: [{ key: "default" }],
      flagsByProject: { default: fullPage },
    });
    await h.ctx.vault.set("launchdarkly.token", "tok");
    const syncable = createLaunchdarklySyncable({ ensureLaunchdarklyMcpRunning: async () => {} });
    await syncable.sync(h.ctx, null);
    const flagCalls = h.fake.requests.filter((r) => r.path === "/api/v2/flags/default");
    expect(flagCalls.length).toBeGreaterThanOrEqual(2);
    expect(flagCalls[0]?.search.get("offset")).toBe("0");
    expect(flagCalls[1]?.search.get("offset")).toBe("100");
  });
});
```

- [ ] **Step 2: Run it — verify failure**

```bash
bun test packages/gateway/test/integration/connectors/launchdarkly-sync-fake-server.test.ts
```

Expected: FAIL — `Cannot find module '.../launchdarkly-sync.ts'`.

- [ ] **Step 3: Create `packages/gateway/src/connectors/launchdarkly-sync.ts`**

```ts
/**
 * LaunchDarkly v2 REST sync handler. Walks `GET /api/v2/projects` →
 * `GET /api/v2/flags/{projectKey}` (offset-paged, capped) and upserts each
 * feature flag into the unified `item` table as
 * `service = "launchdarkly", type = "feature_flag"` via
 * {@link mapLaunchDarklyFlagToItem}.
 *
 * Auth: a LaunchDarkly REST API access token, sent as the raw value of the
 * `Authorization` header (NO `Bearer` prefix). Single-pass cursor model
 * (matches snyk/sonarqube/semgrep/wiz): every successful run emits a fresh
 * `nimbus-launchdarkly1:{pass: 1}` cursor.
 *
 * Deletion reconciliation: none. Flags deleted in LaunchDarkly linger in the
 * local index until a future cross-connector full-set-diff/tombstone pass — an
 * accepted Phase 5 limitation shared by the other REST upsert connectors
 * (snyk/sonarqube/semgrep/wiz).
 */

import { upsertIndexedItemForSync } from "../index/item-store.ts";
import {
  syncPassCursorHttpEmpty,
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../sync/pass-cursor-sync-result.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { readConnectorSecret } from "./connector-vault.ts";
import { mapLaunchDarklyFlagToItem } from "./launchdarkly-flag-mapping.ts";
import { encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";
import { asRecord, stringField } from "./unknown-record.ts";

const SERVICE_ID = "launchdarkly";
const CURSOR_PREFIX = "nimbus-launchdarkly1:";
const DEFAULT_BASE = "https://app.launchdarkly.com";
const PAGE_SIZE = 100;
// Per-cycle cost bound (2 000 flags/project), matching the sibling connectors'
// MAX_PAGES_PER_CYCLE. A `[launchdarkly].max_pages_per_project` config knob is a
// discrete follow-up (precedent: `[pagerduty].max_pages_per_sync`) if an
// enterprise project ever genuinely exceeds this.
const MAX_PAGES_PER_PROJECT = 20;

type LaunchdarklyCursorV1 = { pass: number };

function pass1Cursor(): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, { pass: 1 } satisfies LaunchdarklyCursorV1);
}

export type LaunchdarklySyncableOptions = {
  ensureLaunchdarklyMcpRunning: () => Promise<void>;
};

interface LaunchdarklyCreds {
  readonly token: string;
  readonly baseUrl: string;
  readonly projectKey: string | null;
}

async function loadCreds(ctx: SyncContext): Promise<LaunchdarklyCreds | null> {
  const token = (await readConnectorSecret(ctx.vault, "launchdarkly", "token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const baseRaw = (await readConnectorSecret(ctx.vault, "launchdarkly", "base_url"))?.trim() ?? "";
  const projectRaw =
    (await readConnectorSecret(ctx.vault, "launchdarkly", "project_key"))?.trim() ?? "";
  return {
    token,
    baseUrl: baseRaw === "" ? DEFAULT_BASE : baseRaw,
    projectKey: projectRaw === "" ? null : projectRaw,
  };
}

type FetchOutcome =
  | { kind: "ok"; parsed: unknown; bytes: number }
  | { kind: "http_error"; bytes: number }
  | { kind: "parse_error"; bytes: number };

async function ldGet(ctx: SyncContext, creds: LaunchdarklyCreds, path: string): Promise<FetchOutcome> {
  await ctx.rateLimiter.acquire(SERVICE_ID);
  const res = await fetch(`${creds.baseUrl}/api/v2${path}`, {
    headers: { Authorization: creds.token, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    ctx.logger.warn({ serviceId: SERVICE_ID, status: res.status, path }, "launchdarkly GET failed");
    return { kind: "http_error", bytes: text.length };
  }
  try {
    return { kind: "ok", parsed: JSON.parse(text) as unknown, bytes: text.length };
  } catch {
    return { kind: "parse_error", bytes: text.length };
  }
}

function extractItems(parsed: unknown): unknown[] {
  const root = asRecord(parsed) ?? {};
  const items = root["items"];
  return Array.isArray(items) ? items : [];
}

function extractProjectKeys(parsed: unknown): string[] {
  const out: string[] = [];
  for (const p of extractItems(parsed)) {
    const row = asRecord(p);
    if (row === undefined) {
      continue;
    }
    const key = stringField(row, "key");
    if (key !== undefined && key !== "") {
      out.push(key);
    }
  }
  return out;
}

function flagsPath(projectKey: string, offset: number): string {
  const params = new URLSearchParams({
    summary: "true",
    limit: String(PAGE_SIZE),
    offset: String(offset),
  });
  return `/flags/${encodeURIComponent(projectKey)}?${params.toString()}`;
}

function upsertFlags(
  ctx: SyncContext,
  creds: LaunchdarklyCreds,
  projectKey: string,
  flags: readonly unknown[],
  now: number,
): number {
  let upserted = 0;
  for (const f of flags) {
    const mapped = mapLaunchDarklyFlagToItem(f, {
      baseUrl: creds.baseUrl,
      projectKey,
      syncedAt: now,
    });
    if (mapped === null) {
      continue;
    }
    upsertIndexedItemForSync(ctx, mapped);
    upserted += 1;
  }
  return upserted;
}

export function createLaunchdarklySyncable(options: LaunchdarklySyncableOptions): Syncable {
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: 30,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      await options.ensureLaunchdarklyMcpRunning();
      const creds = await loadCreds(ctx);
      if (creds === null) {
        return syncNoopResult(cursor, t0);
      }

      let totalBytes = 0;
      let projectKeys: string[];
      if (creds.projectKey !== null) {
        projectKeys = [creds.projectKey];
      } else {
        const outcome = await ldGet(ctx, creds, "/projects");
        totalBytes += outcome.bytes;
        if (outcome.kind === "http_error") {
          return syncPassCursorHttpEmpty(t0, totalBytes, cursor, pass1Cursor());
        }
        if (outcome.kind === "parse_error") {
          return syncPassCursorParseEmpty(t0, totalBytes, pass1Cursor());
        }
        projectKeys = extractProjectKeys(outcome.parsed);
      }

      const now = Date.now();
      let totalUpserted = 0;
      for (const projectKey of projectKeys) {
        for (let page = 0; page < MAX_PAGES_PER_PROJECT; page += 1) {
          const outcome = await ldGet(ctx, creds, flagsPath(projectKey, page * PAGE_SIZE));
          totalBytes += outcome.bytes;
          if (outcome.kind !== "ok") {
            break;
          }
          const flags = extractItems(outcome.parsed);
          totalUpserted += upsertFlags(ctx, creds, projectKey, flags, now);
          if (flags.length < PAGE_SIZE) {
            break;
          }
        }
      }

      return syncPassCursorSuccess(t0, totalBytes, pass1Cursor(), totalUpserted);
    },
  };
}
```

- [ ] **Step 4: Run it — verify pass**

```bash
bun test packages/gateway/test/integration/connectors/launchdarkly-sync-fake-server.test.ts
```

Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/launchdarkly-sync.ts \
        packages/gateway/test/integration/connectors/launchdarkly-sync-fake-server.test.ts
git commit -m "$(cat <<'EOF'
feat(launchdarkly): gateway-side syncable + fake-server integration test

Walks /api/v2/projects -> /api/v2/flags/{projectKey} (offset-paged, 20-page
cap per project); raw-token Authorization header; single-pass cursor.
Integration test covers happy path, project_key short-circuit, noop,
429 degradation, and offset pagination.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: MCP server

**Files:**
- Create: `packages/mcp-connectors/launchdarkly/src/server.ts`

There is no fast unit test for the stdio server itself (the search logic is already covered by Task 2; the HTTP paths are covered live by the user-side smoke test). Typecheck is the gate here.

- [ ] **Step 1: Create `packages/mcp-connectors/launchdarkly/src/server.ts`**

```ts
/**
 * nimbus-mcp-launchdarkly — LaunchDarkly v2 REST API MCP server (read-only).
 *
 * Exposes the three mandatory read tools (`launchdarkly_list`,
 * `launchdarkly_get`, `launchdarkly_search`). No write tools are registered
 * and `hitlRequired` is empty in the manifest — `launchdarkly.flag.toggle` is
 * a deferred Phase 8 follow-up.
 *
 * Credentials arrive as `LAUNCHDARKLY_TOKEN` env, injected at spawn time by
 * the Gateway from the `launchdarkly.token` vault key. `LAUNCHDARKLY_BASE_URL`
 * (optional) overrides the SaaS host. The connector never reaches for the
 * vault itself (project non-negotiable #3). LaunchDarkly sends the raw token
 * in the Authorization header — no `Bearer` prefix.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
} from "../../shared/mcp-tool-kit.ts";
import { filterLaunchDarklyFlags } from "./search-filter.ts";

const DEFAULT_BASE = "https://app.launchdarkly.com";

function baseUrl(): string {
  const v = process.env["LAUNCHDARKLY_BASE_URL"]?.trim();
  return v === undefined || v === "" ? DEFAULT_BASE : v;
}

function authHeader(): Record<string, string> {
  const t = process.env["LAUNCHDARKLY_TOKEN"]?.trim();
  if (t === undefined || t === "") {
    throw new Error("LAUNCHDARKLY_TOKEN is not set");
  }
  return { Authorization: t, Accept: "application/json" };
}

async function ldGet(path: string): Promise<unknown> {
  const res = await fetch(`${baseUrl()}/api/v2${path}`, { headers: authHeader() });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`LaunchDarkly ${String(res.status)}: ${text.slice(0, 400)}`);
  }
  return JSON.parse(text) as unknown;
}

const mcp = new McpServer({ name: "nimbus-launchdarkly", version: "0.1.0" });
const reg = createZodToolRegistrar(createRegisterSimpleTool(mcp));

reg(
  "launchdarkly_list",
  "List LaunchDarkly projects, or feature flags for a project. Without `projectKey`, returns the account's projects (`/projects`). With `projectKey`, returns that project's flags (`/flags/{projectKey}`), capped at `limit` (default 100).",
  z.object({
    projectKey: z.string().min(1).optional(),
    limit: z.number().int().min(1).max(500).optional(),
  }),
  async (p) => {
    if (p.projectKey === undefined) {
      return jsonResult(await ldGet("/projects"));
    }
    const search = new URLSearchParams({ summary: "true", limit: String(p.limit ?? 100) });
    return jsonResult(await ldGet(`/flags/${encodeURIComponent(p.projectKey)}?${search.toString()}`));
  },
);

reg(
  "launchdarkly_get",
  "Fetch one LaunchDarkly feature flag by project key + flag key. Throws when no match is found.",
  z.object({
    projectKey: z.string().min(1),
    flagKey: z.string().min(1),
  }),
  async (p) => {
    return jsonResult(
      await ldGet(`/flags/${encodeURIComponent(p.projectKey)}/${encodeURIComponent(p.flagKey)}`),
    );
  },
);

reg(
  "launchdarkly_search",
  "Substring search across a project's feature flags. Matches the query against flag key, name, description, and tags (case-insensitive). Returns a `{ matches: [...] }` envelope.",
  z.object({
    projectKey: z.string().min(1),
    query: z.string().min(1),
    limit: z.number().int().min(1).max(200).optional(),
  }),
  async (p) => {
    const search = new URLSearchParams({ summary: "true", limit: "500" });
    const root = await ldGet(`/flags/${encodeURIComponent(p.projectKey)}?${search.toString()}`);
    const flags = (root as { items?: unknown[] } | null)?.items;
    const matches = Array.isArray(flags)
      ? filterLaunchDarklyFlags(flags, { query: p.query, limit: p.limit })
      : [];
    return jsonResult({ matches });
  },
);

const transport = new StdioServerTransport();
await mcp.connect(transport);
```

- [ ] **Step 2: Typecheck the connector package**

```bash
cd packages/mcp-connectors/launchdarkly && bun run typecheck && cd ../../..
```

Expected: exits 0 (no output from `tsc --noEmit`).

- [ ] **Step 3: Commit**

```bash
git add packages/mcp-connectors/launchdarkly/src/server.ts
git commit -m "$(cat <<'EOF'
feat(launchdarkly): MCP server — list/get/search read tools

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Wiring — catalog, secrets, rate-limiter

**Files:**
- Modify: `packages/gateway/src/connectors/connector-catalog.ts`
- Modify: `packages/gateway/src/connectors/connector-secrets-manifest.ts`
- Modify: `packages/gateway/src/sync/rate-limiter.ts`

- [ ] **Step 1: `connector-catalog.ts` — three edits**

Edit 1 — add to `CONNECTOR_SERVICE_IDS` (after `"semgrep",`):

```ts
  "semgrep",
  "launchdarkly",
] as const;
```

Edit 2 — add to the sync-interval map (after `semgrep: MIN10,`):

```ts
  semgrep: MIN10,
  launchdarkly: MIN10,
};
```

Edit 3 — add to the OAuth-unsupported map (after the `semgrep:` line):

```ts
  semgrep: "uses a Semgrep PAT (connector.auth semgrep)",
  launchdarkly: "uses an API token (connector.auth launchdarkly)",
};
```

- [ ] **Step 2: `connector-secrets-manifest.ts` — add the vault-key entry**

After the `semgrep:` line in `CONNECTOR_VAULT_SECRET_KEYS`:

```ts
  semgrep: ["semgrep.token", "semgrep.deployment_slug"],
  launchdarkly: ["launchdarkly.token", "launchdarkly.base_url", "launchdarkly.project_key"],
} as const satisfies {
```

- [ ] **Step 3: `rate-limiter.ts` — two edits**

Edit 1 — extend the `Provider` union (the last member is `| "semgrep";`):

```ts
  | "semgrep"
  | "launchdarkly";
```

Edit 2 — add to `DEFAULT_QUOTAS` (after `semgrep: { ... },`):

```ts
  semgrep: { requestsPerMinute: 60, burstSize: 10 },
  launchdarkly: { requestsPerMinute: 60, burstSize: 10 },
};
```

- [ ] **Step 4: Typecheck**

```bash
bun run typecheck
```

Expected: `@nimbus/gateway typecheck: Exited with code 0`. (The `satisfies { [K in ConnectorServiceId]: ... }` in the secrets manifest forces every catalog id to have an entry — if you missed one of the three catalog maps, typecheck fails here.)

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/connectors/connector-catalog.ts \
        packages/gateway/src/connectors/connector-secrets-manifest.ts \
        packages/gateway/src/sync/rate-limiter.ts
git commit -m "$(cat <<'EOF'
feat(launchdarkly): wire catalog + secrets manifest + rate-limiter quota

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: Wiring — sandbox manifest + phase3 spawn (+ their tests)

**Files:**
- Modify: `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/phase3-config.ts`
- Modify: `packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts`

- [ ] **Step 1: `first-party-manifests.ts` — add the manifest**

Immediately after the `semgrep: baseManifest(...)` block (it ends with `}),` before the `// --- Cluster management ---` comment), insert:

```ts
  // --- Feature flags ---
  launchdarkly: baseManifest("com.nimbus.launchdarkly", {
    // LaunchDarkly SaaS. Regional / federal instances inherit the same
    // Task 14 runtime-merge follow-up; the SaaS host is the only one in
    // the static manifest today.
    network: ["app.launchdarkly.com"],
    filesystem: { read: [], write: [] },
  }),
```

- [ ] **Step 2: `first-party-manifests.test.ts` — extend the enumeration**

Find the `expected` string array (it ends with `"semgrep",`) and add:

```ts
      "semgrep",
      "launchdarkly",
    ];
```

- [ ] **Step 3: `phase3-config.ts` — add the spawn helper**

Immediately after the `phase3AddSemgrepMcp` function (it ends with `}` before `export async function buildPhase3Servers`), insert:

```ts
export async function phase3AddLaunchdarklyMcp(
  vault: NimbusVault,
  servers: Record<string, ServerSpec>,
  sandboxCwd: string,
): Promise<void> {
  const tok = (await readConnectorSecret(vault, "launchdarkly", "token"))?.trim() ?? "";
  if (tok === "") {
    return;
  }
  // Optional regional override; passes through only when set so the
  // connector falls back to the SaaS default app.launchdarkly.com host.
  const baseUrl = (await readConnectorSecret(vault, "launchdarkly", "base_url"))?.trim() ?? "";
  servers["launchdarkly"] = wrap(
    {
      command: "bun",
      args: [mcpConnectorServerScript("launchdarkly")],
      env: extensionProcessEnv({
        LAUNCHDARKLY_TOKEN: tok,
        ...(baseUrl === "" ? {} : { LAUNCHDARKLY_BASE_URL: baseUrl }),
      }),
    },
    "launchdarkly",
    sandboxCwd,
  );
}
```

- [ ] **Step 4: `phase3-config.ts` — append to `buildPhase3Servers`**

After `await phase3AddSemgrepMcp(vault, servers, sandboxCwd);`:

```ts
  await phase3AddSemgrepMcp(vault, servers, sandboxCwd);
  await phase3AddLaunchdarklyMcp(vault, servers, sandboxCwd);
  return servers;
}
```

- [ ] **Step 5: `phase3-config.test.ts` — add the import**

Add `phase3AddLaunchdarklyMcp` to the import block from `./phase3-config.ts` (alphabetical-ish; place after `phase3AddIacMcp` / wherever the block reads cleanly):

```ts
  phase3AddIacMcp,
  phase3AddLaunchdarklyMcp,
  phase3AddNewrelicMcp,
```

- [ ] **Step 6: `phase3-config.test.ts` — add the test block**

Immediately before the `// ─── buildPhase3Servers (aggregator) ───` marker, insert:

```ts
// ─── phase3AddLaunchdarklyMcp ────────────────────────────────────────────────

describe("phase3AddLaunchdarklyMcp", () => {
  test("no-op without launchdarkly.token", async () => {
    const vault = createMockVault();
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLaunchdarklyMcp(vault, servers, SANDBOX_CWD);
    expect(servers["launchdarkly"]).toBeUndefined();
  });

  test("no-op when launchdarkly.token is whitespace-only", async () => {
    const vault = createMockVault();
    await vault.set("launchdarkly.token", "   ");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLaunchdarklyMcp(vault, servers, SANDBOX_CWD);
    expect(servers["launchdarkly"]).toBeUndefined();
  });

  test("spawns with LAUNCHDARKLY_TOKEN set + app.launchdarkly.com in manifest network list", async () => {
    const vault = createMockVault();
    await vault.set("launchdarkly.token", "api-test-token");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLaunchdarklyMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["launchdarkly"];
    expect(spec).toBeDefined();
    if (spec === undefined) return;
    expectSandboxed(spec, "app.launchdarkly.com");
    expect(spec.env?.["LAUNCHDARKLY_TOKEN"]).toBe("api-test-token");
    expect(spec.env?.["LAUNCHDARKLY_BASE_URL"]).toBeUndefined();
  });

  test("base_url override propagates as LAUNCHDARKLY_BASE_URL env when present", async () => {
    const vault = createMockVault();
    await vault.set("launchdarkly.token", "tok");
    await vault.set("launchdarkly.base_url", "https://app.launchdarkly.us");
    const servers: Record<string, ServerSpec> = {};
    await phase3AddLaunchdarklyMcp(vault, servers, SANDBOX_CWD);
    const spec = servers["launchdarkly"];
    if (spec === undefined) throw new Error("expected spec");
    expect(spec.env?.["LAUNCHDARKLY_BASE_URL"]).toBe("https://app.launchdarkly.us");
  });
});

```

- [ ] **Step 7: Run the lazy-mesh tests**

```bash
bun test packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts
```

Expected: PASS (manifest enumeration includes `launchdarkly`; 4 new `phase3AddLaunchdarklyMcp` tests pass).

- [ ] **Step 8: Commit**

```bash
git add packages/gateway/src/connectors/lazy-mesh/first-party-manifests.ts \
        packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts \
        packages/gateway/src/connectors/lazy-mesh/phase3-config.ts \
        packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts
git commit -m "$(cat <<'EOF'
feat(launchdarkly): sandbox manifest + phase3 spawn helper (+ tests)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Wiring — scheduler registration

**Files:**
- Modify: `packages/gateway/src/platform/assemble-sync-registrations.ts`

- [ ] **Step 1: Add the import**

In the import block, after `import { createSemgrepSyncable } from "../connectors/semgrep-sync.ts";` (the imports are alphabetical — `launchdarkly` sorts before `semgrep`, so place it where it reads cleanly; alphabetical position is after the `gitlab`/`jenkins` group and before `linear` — match the file's existing ordering):

```ts
import { createLaunchdarklySyncable } from "../connectors/launchdarkly-sync.ts";
```

- [ ] **Step 2: Register the syncable**

After the `createSemgrepSyncable({ ... })` registration block, add:

```ts
  syncScheduler.register(
    createLaunchdarklySyncable({
      ensureLaunchdarklyMcpRunning: () => connectorMesh.ensurePhase3BundleRunning(),
    }),
  );
}
```

(Insert before the function's closing `}` — match the existing `syncScheduler.register(createSemgrepSyncable(...))` shape exactly.)

- [ ] **Step 3: Typecheck**

```bash
bun run typecheck
```

Expected: `@nimbus/gateway typecheck: Exited with code 0`.

- [ ] **Step 4: Commit**

```bash
git add packages/gateway/src/platform/assemble-sync-registrations.ts
git commit -m "$(cat <<'EOF'
feat(launchdarkly): register the syncable with the sync scheduler

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Docs

**Files:**
- Modify: `CLAUDE.md`, `GEMINI.md`, `docs/roadmap.md`, `.claude/commands/nimbus-file-map.md`

- [ ] **Step 1: `CLAUDE.md` + `GEMINI.md` status line**

In both files, on the `**Status:**` line, insert immediately before `` · `v0.1.0` released 2026-05-09``:

```
 · Tier-2 connector LaunchDarkly ✅ (2026-05-24)
```

(Both files carry the identical status line; make the same edit in each.)

- [ ] **Step 2: `docs/roadmap.md` — flip the LaunchDarkly checklist item**

Find the LaunchDarkly line under "Feature Flags":

```
- [ ] **LaunchDarkly** — flags, environments, targeting rules, flag evaluation history; API key; flag toggle behind HITL; `feature_flag` item type indexed with name, state, environments, last modified; critical for incident correlation ("was this flag enabled when the alert fired?")
```

Replace it with:

```
- [x] **LaunchDarkly** (2026-05-24, Phase 5 Tier 1) — first-party MCP connector `nimbus-mcp-launchdarkly` + gateway-side syncable. Walks `GET /api/v2/projects → GET /api/v2/flags/{projectKey}` (offset-paged 100/page, 20 pages per project cap) and upserts feature flags as `launchdarkly:feature_flag` items via `mapLaunchDarklyFlagToItem`. Metadata exposed: `key`, `name`, `kind` (boolean/multivariate), `project_key`, `tags`, `temporary`, `archived`, `maintainer`, `maintainer_id`, `description`, `variation_count`, `environments`, `env_states` (per-env on/off), `created_at`, `updated_at`, `canonical_url` — critical for incident correlation ("was this flag enabled when the alert fired?"). Vault keys: `launchdarkly.token` (required API access token), `launchdarkly.base_url` (optional regional override → default `https://app.launchdarkly.com`; sandbox runtime-merge for regional/federal hosts inherits the same Task 14 follow-up as `sentry.url`), `launchdarkly.project_key` (optional single-project restriction). Three read-only MCP tools: `launchdarkly_list` / `launchdarkly_get` / `launchdarkly_search`. `hitlRequired: []` — `launchdarkly.flag.toggle` is a deferred Phase 8 follow-up.
```

- [ ] **Step 3: `.claude/commands/nimbus-file-map.md` — add three rows**

In the "Connectors + MCP Mesh" table, after the `semgrep/src/server.ts` row (the last connector row before `sync/connectivity.ts`), insert:

```
| `packages/gateway/src/connectors/launchdarkly-sync.ts` | LaunchDarkly feature-flag connector (Phase 5 Tier 1, 2026-05-24); API-token auth (raw `Authorization` header), walks `GET /api/v2/projects → /api/v2/flags/{projectKey}` (offset-paged 100/page, 20 pages/project cap); emits `launchdarkly:feature_flag` items via `mapLaunchDarklyFlagToItem`. Regional override via `launchdarkly.base_url`; single-project via `launchdarkly.project_key` |
| `packages/gateway/src/connectors/launchdarkly-flag-mapping.ts` | Pure LaunchDarkly flag → `IndexedItem` mapper; surfaces `{ key, name, kind, project_key, tags, temporary, archived, maintainer, maintainer_id, description, variation_count, environments, env_states, created_at, updated_at, canonical_url }` in metadata; `flagUrl` builds the project flag page URL. Unit-tested independently of the REST path |
| `packages/mcp-connectors/launchdarkly/src/server.ts` | LaunchDarkly MCP server — read-only tools `launchdarkly_list` / `launchdarkly_get` / `launchdarkly_search`. `hitlRequired: []` — `launchdarkly.flag.toggle` is a deferred Phase 8 follow-up |
```

- [ ] **Step 4: Verify doc references resolve**

```bash
bun scripts/structure-audit/check-doc-references.ts --check
```

Expected: exits 0 (`all resolve`).

- [ ] **Step 5: Commit**

```bash
git add CLAUDE.md GEMINI.md docs/roadmap.md .claude/commands/nimbus-file-map.md
git commit -m "$(cat <<'EOF'
docs(launchdarkly): status lines, roadmap row, file-map entries

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Task 11: Full verification + PR

**Files:** none (verification + git/gh).

- [ ] **Step 1: Lint the new + changed files**

```bash
bunx biome check packages/mcp-connectors/launchdarkly/src packages/mcp-connectors/launchdarkly/test \
  packages/gateway/src/connectors/launchdarkly-sync.ts \
  packages/gateway/src/connectors/launchdarkly-flag-mapping.ts \
  packages/gateway/test/unit/connectors/launchdarkly-flag-mapping.test.ts \
  packages/gateway/test/integration/connectors/launchdarkly-sync-fake-server.test.ts \
  packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts \
  packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts
```

Expected: `No fixes applied`, 0 errors. (Fix any `useTemplate`/unused-import findings before continuing.)

- [ ] **Step 2: Run all launchdarkly + lazy-mesh tests together**

```bash
bun test packages/gateway/test/unit/connectors/launchdarkly-flag-mapping.test.ts \
  packages/gateway/test/integration/connectors/launchdarkly-sync-fake-server.test.ts \
  packages/gateway/src/connectors/lazy-mesh/first-party-manifests.test.ts \
  packages/gateway/src/connectors/lazy-mesh/phase3-config.test.ts \
  packages/mcp-connectors/launchdarkly/
```

Expected: all pass, exactly 1 skip (the gated sandbox test), 0 fail.

- [ ] **Step 3: Full CI parity**

```bash
bun run test:ci
```

Expected: exit 0 — typecheck (all packages), lint (0 errors), build, unit+coverage, all coverage gates (incl. `test:coverage:mcp` ≥70% covering the new connector package), integration, e2e, UI vitest.

- [ ] **Step 4: Confirm the connector test suite passed inside `test:ci`**

The broader connector suite runs as part of `test:ci`. If `test:ci` is green, the catalog/manifest enumeration and rate-limiter additions did not break any sibling test.

- [ ] **Step 5: Push the branch**

```bash
git push -u origin dev/asafgolombek/connector-launchdarkly
```

- [ ] **Step 6: Open the PR**

```bash
gh pr create --base main --head dev/asafgolombek/connector-launchdarkly \
  --title "Phase 5: LaunchDarkly connector" \
  --body "$(cat <<'EOF'
## Summary

First-party MCP connector for LaunchDarkly feature flags (Tier 1, read-only),
modeled on the Snyk/SonarQube/Semgrep/Wiz template. Indexes flags across all
(or one configured) project as `launchdarkly:feature_flag` items — useful for
incident correlation ("was this flag enabled when the alert fired?").

## What ships

- `packages/mcp-connectors/launchdarkly/` — MCP server with three read-only
  tools (`launchdarkly_list` / `launchdarkly_get` / `launchdarkly_search`).
  `hitlRequired: []` (`launchdarkly.flag.toggle` deferred to Phase 8).
- `packages/gateway/src/connectors/launchdarkly-sync.ts` — single-pass cursor
  syncable; walks `/api/v2/projects → /api/v2/flags/{projectKey}` (offset-paged
  100/page, 20 pages/project cap); raw-token Authorization header.
- `packages/gateway/src/connectors/launchdarkly-flag-mapping.ts` — pure mapper.

## Wiring (Snyk/SonarQube/Semgrep/Wiz pattern)

connector-catalog, connector-secrets-manifest, lazy-mesh/first-party-manifests
(+ test), lazy-mesh/phase3-config `phase3AddLaunchdarklyMcp` (+ test),
platform/assemble-sync-registrations, sync/rate-limiter, root package.json.

## Vault keys

- `launchdarkly.token` — required API access token.
- `launchdarkly.base_url` — optional regional/federal override (default
  app.launchdarkly.com; sandbox runtime-merge follow-up shared with sentry.url).
- `launchdarkly.project_key` — optional single-project restriction.

## Test plan

- [x] `bun run test:ci` — full CI parity, exit 0.
- [x] Mapper unit tests + sync fake-server integration test (incl. 429
  degradation + offset pagination) + phase3 spawn test + manifest enumeration.
- [ ] CI pr-quality job on this PR.
- [ ] Live smoke-test against a real LaunchDarkly account (user-side follow-up).

## Deferred

`launchdarkly.flag.toggle` HITL write tool — Phase 8. Regional/federal sandbox
runtime-merge — Task 14 (shared with sentry.url).

🤖 Generated with [Claude Code](https://claude.com/claude-code)
EOF
)"
```

Expected: prints the new PR URL.

---

## Review disposition (2026-05-24)

From `2026-05-24-launchdarkly-connector-review.md`. Guiding principle: connector
#1 stays consistent with the proven Snyk/SonarQube/Semgrep/Wiz cohort; genuinely
good cross-cutting ideas become cross-connector follow-ups rather than
LaunchDarkly-specific bolt-ons.

| # | Item | Disposition |
|---|---|---|
| Q1 | `MAX_PAGES_PER_PROJECT` cap | **Defer / comment added.** Matches sibling per-cycle bound; 2 000 flags/project is generous; `[launchdarkly].max_pages_per_project` knob is a follow-up if ever hit. |
| Q2 | search cap numbers (50/200/500) | **Defer (no change).** Intentional sibling pattern — 500 haystack fetch, 50 default returned-match cap, 200 max. Not a discrepancy. |
| S1 | deleted flags linger | **Defer mechanism / comment added.** Accepted Phase 5 limitation shared by all REST upsert connectors; general tombstone pass is a cross-connector follow-up. |
| S2 | `ldGet` generic error / map 401·404 | **Defer (no change).** Status code already in the message; matches siblings; LD returns a native 404 (no custom "not found" needed, unlike Semgrep). |
| S3 | `server.ts` 429 backoff/retry | **Defer (no change).** No sibling MCP server retries; a shared backoff wrapper in `mcp-tool-kit.ts` is the right cross-connector vehicle if desired. |

## Self-Review

- **Spec coverage:** the connector satisfies the `nimbus-connector-authoring` checklist (mandatory tool surface, manifest fields, `process.env`-only creds, `Syncable` with populated cursor, `<service>:<native_id>` ids, registration), the program spec's per-connector template (mapper + fake-server test incl. error/429 path per Review S2), and the roadmap's LaunchDarkly line (name/state/environments/last-modified, `feature_flag` type, incident-correlation use case). Embedding routing: `feature_flag` is sparse → correctly omitted from `PROSE_HEAVY_TYPES`.
- **Placeholder scan:** none — every step has complete code or an exact command.
- **Type consistency:** `createLaunchdarklySyncable` / `LaunchdarklySyncableOptions` / `ensureLaunchdarklyMcpRunning` / `mapLaunchDarklyFlagToItem` / `LaunchDarklyMappingContext` / `flagUrl` / `filterLaunchDarklyFlags` are used identically across the sync, mapper, server, tests, and wiring. `SyncResult` field names (`itemsUpserted`, `cursor`, `hasMore`) match the `pass-cursor-sync-result.ts` helpers. Catalog/secrets/rate-limiter use the literal `"launchdarkly"` consistently.
