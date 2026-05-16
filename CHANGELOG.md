# Changelog

All notable changes to the `nimbus` core (headless Gateway + CLI binary + first-party MCP connectors) are documented in this file. release-please appends new entries between this header and the most recent version below when a release PR merges.

## [0.4.0](https://github.com/nimbus-agent/Nimbus/compare/v0.3.0...v0.4.0) (2026-05-16)


### Features

* **gateway:** wire Updater factory in assemblePlatformServices (S6-F1) ([5fd38bd](https://github.com/nimbus-agent/Nimbus/commit/5fd38bd73005441e75b02f0a9bff01cef4f36a76))
* **ipc:** add IPCServer.setUpdater + broadcast for late attachment ([c1d9e48](https://github.com/nimbus-agent/Nimbus/commit/c1d9e48ab7f2a63a89aa425d5ff4da1445e5154c))
* **updater:** createUpdaterFromConfig factory with disabled + unsupported-platform paths ([423fe23](https://github.com/nimbus-agent/Nimbus/commit/423fe23677615f8153ca1bd9106c4230edde7a5b))
* **updater:** derivePlatformTarget() with explicit unsupported-combo coverage ([7714aea](https://github.com/nimbus-agent/Nimbus/commit/7714aea57e1e690e8f796f6710ec94390d905ce2))
* **updater:** S6-F1 production wiring ([a1c69b9](https://github.com/nimbus-agent/Nimbus/commit/a1c69b9e46d9fc0ec6c3a570b695b8f7ff53b06f))

## [0.3.0](https://github.com/nimbus-agent/Nimbus/compare/v0.2.0...v0.3.0) (2026-05-15)


### Features

* **audit:** T6 PR 2 — tool_call_log V29 + audit.toolCalls IPC (I11 complement) ([431fa47](https://github.com/nimbus-agent/Nimbus/commit/431fa47acec4777345a0674b71064404a57013bc))
* **connectors:** write tool_call_log at mesh.ts:listTools ([71042de](https://github.com/nimbus-agent/Nimbus/commit/71042deaed42b6a08d5c99c0afd5cffb33637fa7))
* **db:** tool_call_log V29 schema + write/read helpers ([216e88f](https://github.com/nimbus-agent/Nimbus/commit/216e88f8c31c0f65682bc013fb023656cafb6477))
* **docs:** embed asciinema cast SVGs in README hero ([3c5d639](https://github.com/nimbus-agent/Nimbus/commit/3c5d639b35828d1301bcf6001fb5c84f1d6e4b4b))
* **docs:** finish README hero v0.2 + prune docs/superpowers/ (48 files) ([e324899](https://github.com/nimbus-agent/Nimbus/commit/e324899f7a8af041b9a381be882ce0c8f9aed0af))
* **docs:** OG social card + JetBrains Mono fonts + deterministic renderer ([6cc24a4](https://github.com/nimbus-agent/Nimbus/commit/6cc24a4a2ab628f352320495a09417e9631792af))
* **docs:** render incident-response asciinema cast as light + dark SVGs ([105cf98](https://github.com/nimbus-agent/Nimbus/commit/105cf98bcea9cfe1e30abf481bb436c2c9469d12))
* **engine:** write tool_call_log at agent.ts wrapToolForLlm ([16b5b09](https://github.com/nimbus-agent/Nimbus/commit/16b5b09be28e1e4e5a5b401325e8d57ae83f7dc9))
* **ipc:** TDD green — audit.toolCalls dispatcher branch ([0e2e28a](https://github.com/nimbus-agent/Nimbus/commit/0e2e28a83fc49755dc175883b54f4a7a7b2a24a0))
* Phase 3 cast-tripwire — CLI rendering drift CI gate ([4144df3](https://github.com/nimbus-agent/Nimbus/commit/4144df3eef75ec45c409a47812cec64308db9a7c))
* **platform:** wire localIndex.db to agent + mesh as auditDb ([25f7b8a](https://github.com/nimbus-agent/Nimbus/commit/25f7b8aa85def594f4497cdf20d2bbe14a0ad8a0))


### Bug Fixes

* **cast-driver:** satisfy Biome lint ([1d50b38](https://github.com/nimbus-agent/Nimbus/commit/1d50b387564f16bdae5d447b1ab06b6a6197e2eb))
* **ci:** drop svg-term-cli + repair lychee fallout from spec prune ([728a073](https://github.com/nimbus-agent/Nimbus/commit/728a073ff47cce78b294f8f70a73ceed833436b1))
* **ci:** use correct pinned SHA for actions/upload-artifact ([46570d4](https://github.com/nimbus-agent/Nimbus/commit/46570d4fe781f31242ac4081d0da942d9e5b4f4c))
* **docs:** repair T6 PR 2 spec links to pruned T6 PR 1 plan/spec files ([6423398](https://github.com/nimbus-agent/Nimbus/commit/64233986b4afcd6d94c24b6468c3610efd6ad7e2))
* **docs:** rerender README hero cast with watchable dwell ([375ae9f](https://github.com/nimbus-agent/Nimbus/commit/375ae9f6bd23457fa475c36b36722535939ac921))
* **docs:** rerender README hero cast with watchable dwell ([73f638d](https://github.com/nimbus-agent/Nimbus/commit/73f638d638ea2f7d54bb0370e8c797d0032e293b))
* **index:** bump CURRENT_SCHEMA_VERSION 28 → 29 for V29 tool_call_log ([9fb029b](https://github.com/nimbus-agent/Nimbus/commit/9fb029b6e8c433dee76563db6fa1d95292e130dc))

## [0.2.0](https://github.com/nimbus-agent/Nimbus/compare/v0.1.1...v0.2.0) (2026-05-14)


### Features

* **action:** nimbus-agent/annotate-action — post-deploy annotation ([e91e1e9](https://github.com/nimbus-agent/Nimbus/commit/e91e1e90e0987c22690468fb6cedbb4020026631))
* **audit:** add release-please manifest drift check ([9ffc421](https://github.com/nimbus-agent/Nimbus/commit/9ffc421003dc6296e66a46ef4ac2289e681052e8))
* **cli:** mixed_source gap shows ⚠ + explanatory hint in nimbus metrics dora ([5fc1daf](https://github.com/nimbus-agent/Nimbus/commit/5fc1daf2bc02b866371fc83f5c0631f5dc0b5306))
* **cli:** nimbus deploy annotate ([7eff973](https://github.com/nimbus-agent/Nimbus/commit/7eff9731a8ee26fdc333b63e0ea10d5aa1634eca))
* **config:** ServiceConfig.serviceId + deployEnvironments ([225c40f](https://github.com/nimbus-agent/Nimbus/commit/225c40f05e663ffe341204b0b7616b9fabc0b8b0))
* **deployment:** annotate input/result types ([34c4797](https://github.com/nimbus-agent/Nimbus/commit/34c4797da8a99336563c17c9fcb4723b2dbbcc16))
* **deployment:** annotateDeployment — validation + transactional upsert + audit ([ea348b3](https://github.com/nimbus-agent/Nimbus/commit/ea348b34b2376b11e38a46d285012486f544d41d))
* **deployment:** three-tier external_id rule ([48d8099](https://github.com/nimbus-agent/Nimbus/commit/48d809920b16c2530d1aaf1e36e644a7bcd2c545))
* **deployment:** V28 migration — deployment_items shadow table ([4e6cb01](https://github.com/nimbus-agent/Nimbus/commit/4e6cb010dc59ff5dfc758c553c472b2f107338dd))
* **docs:** render reference benchmarks at /perf/ via BenchmarksTable ([24b8840](https://github.com/nimbus-agent/Nimbus/commit/24b884019d4c9f4e4c2fe129c078ca3c618bd54c))
* **dora:** prefer annotated deploys; emit mixed_source gap ([463103a](https://github.com/nimbus-agent/Nimbus/commit/463103aac8f3cfa185f351451c397ab60e9964d8))
* **http:** bearer auth + 60/min sliding-window rate limiter ([bde8f75](https://github.com/nimbus-agent/Nimbus/commit/bde8f75e3dea232945882c817b4ce75731e616d7))
* **http:** mount POST /v1/deployments + rename HTTP_ROUTES ([1643239](https://github.com/nimbus-agent/Nimbus/commit/1643239722b434855c02c04b8be49da5d9af7a29))
* **http:** write-route dispatcher with allowlist + auth + rate limit ([59c4fce](https://github.com/nimbus-agent/Nimbus/commit/59c4fce159c44fda2161f5b0fb26ba2f9a223c1b))
* **ipc:** deployment.annotate JSON-RPC method ([ee1694d](https://github.com/nimbus-agent/Nimbus/commit/ee1694dfd9cb15a144e813af3f9b6157ad84b1f2))
* **ipc:** wire deployment.annotate into the dispatch chain ([bb29d1e](https://github.com/nimbus-agent/Nimbus/commit/bb29d1e61397b20f04d1c16ae02830dedd9d8f69))
* **openapi:** document POST /v1/deployments + bearer security scheme ([656327c](https://github.com/nimbus-agent/Nimbus/commit/656327cd29b3541134c100239e14c0c342603353))
* **pagerduty:** enrich incident metadata + 30d cold-start window ([0db1526](https://github.com/nimbus-agent/Nimbus/commit/0db15268bcc5bb9d82128e42012f679f7015932a))
* **pagerduty:** enrich incident metadata to unblock DORA + Preflight ([0789c47](https://github.com/nimbus-agent/Nimbus/commit/0789c477a70c0f67feb94149b2bbb8ff932c63bf))
* **perf:** derive-latest-json projection + synthetic placeholder snapshot ([e81ad98](https://github.com/nimbus-agent/Nimbus/commit/e81ad98d72faf3e79d3014d82602512425425a01))
* **perf:** publish reference benchmarks to docs site at /perf/ ([b95c061](https://github.com/nimbus-agent/Nimbus/commit/b95c061ee87bc6c5baf5476f6ef4ea50946a1f21))
* **security:** I13 — HTTP write-route allowlist + bearer auth ([a761563](https://github.com/nimbus-agent/Nimbus/commit/a761563efbc140728ac31108f31080aee184fbca))
* **t4 pr 3b:** post-deploy annotation — write surface, CLI, GH Action ([29968bd](https://github.com/nimbus-agent/Nimbus/commit/29968bd48b300ce67662969303e9937bca30e789))


### Bug Fixes

* **deployment:** annotate — transactional is_new + empty-string optional ids ([3e084ce](https://github.com/nimbus-agent/Nimbus/commit/3e084ce1f4e73a5f94e895d0e72a2ff6bf82b19e))
* **docs:** MD032 blanks-around-lists in I13 section ([f878101](https://github.com/nimbus-agent/Nimbus/commit/f878101416b05b14d875a472b8a8b85613832b48))
* **http:** body cap counts bytes, not JS string length ([ab5347d](https://github.com/nimbus-agent/Nimbus/commit/ab5347d57bc86d8d0d601767f321e7e2130a312e))
* **t4 pr 3b:** defensive create:false on write DB + correct file-map description ([c2d7711](https://github.com/nimbus-agent/Nimbus/commit/c2d7711d62b71b04085e81b560455832facd3eae))
* **test:** per-test DB isolation + finished_at_ms assertion + clearer V28 test name ([24089f7](https://github.com/nimbus-agent/Nimbus/commit/24089f7fea1c5337320c826d1b550d640d689064))

## [0.1.1] - 2026-05-10

- Patch release. See the GitHub Release notes for the full change list.

## [0.1.0] - 2026-05-09

- Phase 4 release. Headless Gateway + CLI binary + VS Code extension. See [`docs/roadmap.md`](./docs/roadmap.md) for the delivered feature set.
