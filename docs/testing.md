# Testing

Five-layer pyramid:

1. **Unit (`bun test`)** — Engine logic, Vault contracts, HITL invariants, manifest validation. Co-located with source. Runs in milliseconds.
2. **Integration (`bun test` + real SQLite)** — connector sync, index queries, extension loading and isolation. Each test gets a fresh temp dir + fresh DB.
3. **E2E CLI (`bun test` + Gateway subprocess)** — full CLI command flows against a real Gateway backed by mock MCP servers.
4. **UI Components (Vitest + Testing Library)** — React components in the Tauri WebView. Vitest is used here because `bun test` does not support jsdom.
5. **E2E Desktop (Playwright + Tauri WebDriver)** — full desktop flows on all three platforms. Runs on push to `main` and release tags.

Security scans: `bun audit`, `trivy`, CodeQL on every PR; Dependabot for dependency updates. HIGH/CRITICAL findings block merges, and `bun run audit:advisories` blocks any *other* live advisory that has no dated decision in [`scripts/structure-audit/accepted-advisories.ts`](../scripts/structure-audit/accepted-advisories.ts) — see [`security-hardening.md`](./security-hardening.md). License compatibility (`bun run audit:js-licenses` + `cargo-deny`) and committed-secret detection (`gitleaks`) are also enforced on every PR — see [`license-policy.md`](./license-policy.md) and [`SECURITY.md`](./SECURITY.md).

**Structure-audit gates** (also CI-enforced) sit alongside the test pyramid:

- `bun run audit:invariants` — runtime-test complement: static checks for `I1` (`spawn` under `connectors/` uses `extensionProcessEnv()`), the vault-key allow-list, `I14` (`D12` — direct `db.run` / `db.exec` outside `db/write.ts`), and `I15` (`D10` — every `ServerSpec` under `connectors/lazy-mesh/` routes through `wrapServerSpec(...)`).
- `bun run audit:openapi-drift` — fails if `packages/gateway/openapi/v1.yaml` and `READ_ONLY_HTTP_ROUTES` disagree.
- `bun run audit:coverage-floor` — per-file coverage floor (≥85% line, ≥80% branch) with a ratcheting baseline; prevents new files from landing under-tested.
- `bun run audit:boundaries`, `audit:dead-code`, `audit:duplication`, `audit:any` — package-boundary / unused-export / token-duplication / `any`-usage gates (Phase 4 B3 structure audit).

For the full per-subsystem coverage-gate table (`test:coverage:engine` / `agents` / `vault` / `sandbox` / `embedding` / `metrics` / `preflight` / `deployment` and a dozen more) and the environment-variable overrides each gate respects, see the [`nimbus-commands`](../.claude/commands/nimbus-commands.md) skill / reference file.

For deeper detail on which test layer to use for each subsystem, see [`.claude/commands/nimbus-testing.md`](../.claude/commands/nimbus-testing.md).
