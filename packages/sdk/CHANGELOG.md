# @nimbus-dev/sdk — Changelog

## [1.2.1](https://github.com/nimbus-agent/Nimbus/compare/sdk-v1.2.0...sdk-v1.2.1) (2026-06-23)


### Bug Fixes

* **sonar:** clear the SonarCloud board — S5906 sweep + long-tail code smells ([#731](https://github.com/nimbus-agent/Nimbus/issues/731)) ([3a87e54](https://github.com/nimbus-agent/Nimbus/commit/3a87e54a7335c1be87ecb582673183b242b97c88))

## [1.2.0](https://github.com/nimbus-agent/Nimbus/compare/sdk-v1.1.2...sdk-v1.2.0) (2026-06-22)


### Features

* **apple:** iCloud Mail + Calendar connector (Phase 6 Slice 9-E) ([#711](https://github.com/nimbus-agent/Nimbus/issues/711)) ([58c69e0](https://github.com/nimbus-agent/Nimbus/commit/58c69e09fba285b03b94eed60f69751103da1bf3))

## [1.1.2](https://github.com/nimbus-agent/Nimbus/compare/sdk-v1.1.1...sdk-v1.1.2) (2026-06-14)


### Bug Fixes

* add repository field to client, sdk, and root for npm provenance ([#633](https://github.com/nimbus-agent/Nimbus/issues/633)) ([f0e7f07](https://github.com/nimbus-agent/Nimbus/commit/f0e7f075d755c8b4a006911b513979f289fa192f))

## [1.1.1](https://github.com/nimbus-agent/Nimbus/compare/sdk-v1.1.0...sdk-v1.1.1) (2026-05-22)


### Bug Fixes

* **ci:** unblock cross-platform test suite + SonarCloud reliability gate ([c75dbab](https://github.com/nimbus-agent/Nimbus/commit/c75dbab037d98b9c51df38b0ea7769089c52418a))

## [1.1.0](https://github.com/nimbus-agent/Nimbus/compare/sdk-v1.0.0...sdk-v1.1.0) (2026-05-17)


### Features

* **sandbox:** T2 PR 1 — Sandbox PAL + 3-OS isolation + I15 ([e668244](https://github.com/nimbus-agent/Nimbus/commit/e668244a42858d810a4e82c777c5d9565ddc3a10))
* **sdk:** runSandboxContractTests + probe (T2 PR 1) ([633b464](https://github.com/nimbus-agent/Nimbus/commit/633b464336aa8196550d8db9748858317bb385dd))


### Bug Fixes

* **coverage-floor:** Sonar new-code coverage — mirror local exemptions + lift sandbox-contract (PR [#329](https://github.com/nimbus-agent/Nimbus/issues/329)) ([51b101e](https://github.com/nimbus-agent/Nimbus/commit/51b101e0c9c20462bbd7005bb863efe546647bb6))
* **sdk:** drop .ts extension on testing/index re-export (T2 PR 1 CI) ([51b218c](https://github.com/nimbus-agent/Nimbus/commit/51b218c981fec8189829fca29181c6fc0d729a30))

## 1.0.0 — 2026-04-19 — Plugin API v1 (stable)

First stable release. The following surface is frozen under semver — breaking changes require a major-version bump.

### Stable exports

| Export | Kind | Purpose |
|---|---|---|
| `ExtensionManifest` | type | Extension manifest shape |
| `NimbusItem` | type | Canonical item shape returned by connectors |
| `NimbusExtensionServer` | class | MCP server scaffolding for extensions |
| `MockGateway` | class | In-process Gateway stub for extension tests |
| `runContractTests` | function | Validates an extension against the v1 contract |
| `ExtensionContractError` | class | Thrown by `runContractTests` on violation |
| `AuditLogger` | type | Interface for scoped audit-log writes (new in v1) |
| `AuditEmit` | type | Function shape the Gateway injects (new in v1) |
| `createScopedAuditLogger` | function | Constructs a scoped logger (new in v1) |
| `HitlRequest` | type | Shape returned by a tool to request consent (new in v1) |
| `isHitlRequest` | function | Runtime type guard (new in v1) |

### Stability guarantee

- Removing any of the above exports requires a major version bump to v2.
- Adding a new required field to any v1 type requires a major version bump.
- Adding optional fields, new exports, or relaxing constraints is a minor bump.

### Out of scope for v1 (deferred)

- `NimbusTool`, `NimbusToolHandler`, `McpServerBuilder`, `ItemSchema`, `PersonSchema` — deferred until a real extension-author use case appears.
