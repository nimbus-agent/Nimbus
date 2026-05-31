# Punch list — section 2: Duplication clusters

## jscpd output

jscpd (token-based clone detection) identified **493 clones** across the monorepo, totaling **4.96% duplication** at a 3% threshold.

### Summary by language

| Format | Files analyzed | Total lines | Total tokens | Clones found | Duplicated lines | Duplicated tokens |
|---|---|---|---|---|---|---|
| **typescript** | 691 | 94147 | 863218 | 484 | 5103 (5.42%) | 53288 (6.17%) |
| **tsx** | 60 | 7828 | 72627 | 8 | 102 (1.3%) | 818 (1.13%) |
| **javascript** | 52 | 3210 | 28275 | 1 | 16 (0.5%) | 124 (0.44%) |
| **css** | 1 | 0 | 3 | 0 | 0 (0%) | 0 (0%) |
| **Total** | 804 | 105185 | 964123 | **493** | 5221 (4.96%) | 54230 (5.62%) |

The bulk of duplication is in **TypeScript code** (484 out of 493 clones), particularly in:

- **`packages/gateway/src/ipc/connector-rpc-handlers/auth.ts`** — multiple OAuth provider PKCE-flow handlers with repeated token-exchange logic
- **`packages/mcp-connectors/*/src/server.ts` and `search-filter.ts`** — template-driven connectors with similar tool definitions and filter builders (zendesk, wiz, vercel, stripe, sonarqube, superset, stackoverflow, teams, zoom)
- **`packages/gateway/src/perf/surfaces/`** — benchmark harness setup and fixture traces with similar synthetic-data patterns
- **`packages/gateway/src/ipc/server/dispatchers.ts` and `vault-dispatch.ts`** — RPC dispatch shims with nearly-identical error handling
- **`packages/ui/src/pages/settings/` and `components/settings/`** — settings panels with similar dialog/form patterns (TelemetryPanel ↔ UpdatesPanel, ExportWizard ↔ ImportWizard, DeleteServiceDialog)

### Top clusters by size

1. **auth.ts PKCE exchanges** — 6 clones within the same file plus 2 cross-file matches; OAuth provider-specific branches of `handleXxxOAuth` that call similar `getValidVaultAccessToken` + token-exchange sequences
2. **Connector search-filter builders** — 10+ clones across zendesk, wiz, stripe, vercel, sonarqube, stackoverflow; the `buildQuery()` and `buildSort()` filter helper patterns
3. **Connector server.ts tool definitions** — 7+ clones across multiple connectors; the list/get/search tool registration stubs with duplicated description text and similar error responses
4. **Benchmark fixtures** — synthetic-github-trace.ts ↔ synthetic-gmail-trace.ts, plus 3x bench-rss and 3x bench-cli-overhead files with duplicate setup code
5. **IPC dispatchers** — dispatchers.ts has 4 internal clones plus overlaps with vault-dispatch.ts in error-handling boilerplate

### Report file

Full jscpd report (JSON format) saved to: `docs/structure-audit/jscpd-report.json`

## Proposed extractions

At Pass 4 (Deduplication phase), the following clusters should be addressed:

- **Cluster 1** — auth.ts OAuth PKCE patterns (`getValidVaultAccessToken` + token-exchange retry loop): extract `performOAuthTokenExchange(provider, params): Promise<string>` helper in `packages/gateway/src/auth/oauth-token-exchange.ts`. Status: PROPOSED.

- **Cluster 2** — Connector search-filter builders (`buildQuery()` variants): extract shared `FilterBuilder` class or `buildServiceQuery(service, params)` helper in `packages/mcp-connectors/shared/filter-builder.ts`. Status: PROPOSED.

- **Cluster 3** — Connector server.ts tool stubs: extract shared tool-registration helpers (list/get/search templates with standard descriptions and error handling) in `packages/mcp-connectors/shared/tool-builders.ts`. Status: PROPOSED.

- **Cluster 4** — Benchmark fixture synthetic-data: consolidate synthetic-github-trace.ts, synthetic-gmail-trace.ts (and similar) via shared `createSyntheticTrace(service: 'github'|'gmail', itemCount): MockTrace[]` factory in `packages/gateway/src/perf/fixtures/synthetic-trace-factory.ts`. Status: PROPOSED.

- **Cluster 5** — IPC dispatcher error handling: extract `mapRpcErrorToResponse(error, context)` helper to reduce boilerplate in dispatchers.ts and vault-dispatch.ts. Status: PROPOSED.

- **Cluster 6** — UI settings panel repeated form/dialog patterns: extract shared `SettingsPanelSection`, `SettingsDialog` component primitives in `packages/ui/src/components/settings/shared/`. Status: PROPOSED.

All proposed extractions are **candidate refactorings** pending review at the post-Pass-1 checkpoint (2026-06-02). The triage will confirm whether each cluster is worth the extraction cost (test updates, import churn, surface complexity) or better left as-is.
