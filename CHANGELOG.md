# Changelog

All notable changes to the `nimbus` core (headless Gateway + CLI binary + first-party MCP connectors) are documented in this file. release-please appends new entries between this header and the most recent version below when a release PR merges.

## [0.5.0](https://github.com/nimbus-agent/Nimbus/compare/v0.4.0...v0.5.0) (2026-05-30)


### Features

* **auth+connectors:** OAuth provider registry (PR-1) + Tier-1 connector batch + Zoom planning ([#447](https://github.com/nimbus-agent/Nimbus/issues/447)) ([9d71a62](https://github.com/nimbus-agent/Nimbus/commit/9d71a62fa5058475b8482469e82b76b8eb05615c))
* **zoom:** PR-3 cloud recordings + AI transcripts (Walk B) ([#458](https://github.com/nimbus-agent/Nimbus/issues/458)) ([21aefdd](https://github.com/nimbus-agent/Nimbus/commit/21aefdd96f8f4e6bcefa730f7f4c7d97d3ef58d8))


### Bug Fixes

* **vscode-extension:** scope tsconfig to types:[node] (fixes CI typecheck) ([#446](https://github.com/nimbus-agent/Nimbus/issues/446)) ([78484a6](https://github.com/nimbus-agent/Nimbus/commit/78484a6e67bef930040afd4cc5b69d5f153aae0c))

## [0.4.0](https://github.com/nimbus-agent/Nimbus/compare/v0.3.0...v0.4.0) (2026-05-22)


### Features

* **audit:** promote D12 to binary; new DB_RUN_EXEC_ALLOW_LIST (T6 PR 4) ([10b9876](https://github.com/nimbus-agent/Nimbus/commit/10b9876a4fbd1e1a4e1c16b7bc0b3c425697a305))
* **cli:** T6 PR 3 — nimbus index reembed ([46f1e8c](https://github.com/nimbus-agent/Nimbus/commit/46f1e8c4e3cfc2f43d2abe8e2a2b44f60e9d292b))
* **config:** [pagerduty] TOML block — max_pages_per_sync + severity_p1_aliases ([62eeb39](https://github.com/nimbus-agent/Nimbus/commit/62eeb3960dda99955c0a46c51928ae9e79db3a67))
* **config:** add severityP1Aliases field to ServiceConfig ([5dfca63](https://github.com/nimbus-agent/Nimbus/commit/5dfca63e0e6554598957977ed5e4f26ff2939c13))
* **config:** thread [pagerduty].severity_p1_aliases into ServiceConfig ([18e1612](https://github.com/nimbus-agent/Nimbus/commit/18e161291b4bae3acb8ee2e2e83bb7f0967d752a))
* **connectors:** declare permissions.network for all 30 first-party connectors (T2 PR 1) ([9a5bf7a](https://github.com/nimbus-agent/Nimbus/commit/9a5bf7af56ac8cb0e75a8db885c65611cfc42739))
* **coverage-floor:** baseline format + diff helpers ([2d909cc](https://github.com/nimbus-agent/Nimbus/commit/2d909cc68c56df5322af89c8a3f89a345b070b4c))
* **coverage-floor:** exclusion registry + matcher ([25d7ead](https://github.com/nimbus-agent/Nimbus/commit/25d7eadd035387c6cec081d5ad73a80cab69a668))
* **coverage-floor:** exclusion-parity check ([f2527ef](https://github.com/nimbus-agent/Nimbus/commit/f2527efc5e8edc2b1894c42da04293f1ae907190))
* **coverage-floor:** orchestration entry point ([1e34574](https://github.com/nimbus-agent/Nimbus/commit/1e34574adace51054c99878337148ac4ed6efd6d))
* **coverage-floor:** per-file 80% line-coverage gate (Phase 0) ([5b958d5](https://github.com/nimbus-agent/Nimbus/commit/5b958d56bb1da4b56ab6c7ba4e52581554715a8d))
* **coverage-floor:** pure lcov parser ([f78e592](https://github.com/nimbus-agent/Nimbus/commit/f78e59279fc2c9ad356925d575d70f91524be144))
* **coverage-floor:** scope walker to bun-tested packages; add build-lcov.sh ([6d0dba5](https://github.com/nimbus-agent/Nimbus/commit/6d0dba548deb6136e90e9f636db34c82e3ef81d8))
* **db:** add dbStmtRun wrapper for prepared-statement writes (T6 PR 4) ([3dfd2ea](https://github.com/nimbus-agent/Nimbus/commit/3dfd2ea81c51f4ee235421f747b6783f1a134763))
* **db:** T6 PR 3 — V30 vec_items_1536 + dim-aware delete triggers ([0b0e3c7](https://github.com/nimbus-agent/Nimbus/commit/0b0e3c79777cfaa924c39f3131649af0e8da15a9))
* **db:** T6 PR 4 — route all writes through dbRun/dbExec/dbStmtRun (I14) ([639dd64](https://github.com/nimbus-agent/Nimbus/commit/639dd64321aea479e527d48286a2b476a96e30db))
* **db:** widen dbRun to return RunResult (T6 PR 4) ([4511a5b](https://github.com/nimbus-agent/Nimbus/commit/4511a5bd7f81d14f740192589da8d5bf992d6068))
* **diag/cli:** three-surface degraded label for sandbox posture (T2 PR 1) ([c74acbc](https://github.com/nimbus-agent/Nimbus/commit/c74acbc4d80a130069d194ab709b6f8462497262))
* **embedding:** T6 PR 3 — dim-aware pipeline + backfillForRoutingKeys ([2c258cc](https://github.com/nimbus-agent/Nimbus/commit/2c258ccf9b1a905f24310afa5b80bec10d7a54d2))
* **embedding:** T6 PR 3 — provider="hybrid" + promote provider="openai" to 1536 ([f1a3f70](https://github.com/nimbus-agent/Nimbus/commit/f1a3f704219a1ecfa9ba111c0c1440aa7e80ee46))
* **embedding:** T6 PR 3 — real embedQueryDual on lazy + worker runtimes ([2d3363a](https://github.com/nimbus-agent/Nimbus/commit/2d3363a22259c70b61ee0a7f73a6d3fb2fe1efad))
* **embedding:** T6 PR 3 — routing module + dim constants ([e392f0d](https://github.com/nimbus-agent/Nimbus/commit/e392f0dcc344d330e68c255d2397fa570b563fbc))
* **embedding:** T6 PR 3 — RoutingEmbeddingPipeline (hybrid mode) ([508f647](https://github.com/nimbus-agent/Nimbus/commit/508f647ff04f2ee70acecc458bc6798a305e6b1d))
* **extensions:** hard-disable pre-T2 extensions until reinstall (T2 PR 1) ([2e67dcc](https://github.com/nimbus-agent/Nimbus/commit/2e67dcce686e1c3e1320a6bcfcf225c7b8fdb724))
* **extensions:** object-form permissions schema + legacy array normalizer (T2 PR 1) ([649d573](https://github.com/nimbus-agent/Nimbus/commit/649d5736de026fcbc11cd7095e7436b05d6b6d6c))
* **gateway:** wire [pagerduty].max_pages_per_sync at bootstrap ([ca7d65b](https://github.com/nimbus-agent/Nimbus/commit/ca7d65bee2ee6b3b02282186fe4ecdbb592773d9))
* **gateway:** wire Updater factory in assemblePlatformServices (S6-F1) ([5fd38bd](https://github.com/nimbus-agent/Nimbus/commit/5fd38bd73005441e75b02f0a9bff01cef4f36a76))
* **invariants:** wire I14 — typed dbRun/dbExec/dbStmtRun (T6 PR 4) ([eda338e](https://github.com/nimbus-agent/Nimbus/commit/eda338ea50ccae4e66e064a97ccee35ced0eebb7))
* **ipc:** add IPCServer.setUpdater + broadcast for late attachment ([c1d9e48](https://github.com/nimbus-agent/Nimbus/commit/c1d9e48ab7f2a63a89aa425d5ff4da1445e5154c))
* **ipc:** T6 PR 3 — index.reembed long-running RPC ([26c1075](https://github.com/nimbus-agent/Nimbus/commit/26c1075eac8727a6d50ff0df183e79f7a0f9245a))
* **lazy-mesh:** wrap MCP ServerSpec through sandbox-wrapper script (T2 PR 1, I15) ([95b46a0](https://github.com/nimbus-agent/Nimbus/commit/95b46a0ebebde45aa5483f70dbea4d1980533c19))
* **pagerduty:** walk all incident pages per sync ([e4a0720](https://github.com/nimbus-agent/Nimbus/commit/e4a0720d4764111bcb31873782cf18df2b35c82f))
* **pagerduty:** write metadata.urgency on indexed incidents ([596b47a](https://github.com/nimbus-agent/Nimbus/commit/596b47add2799557d93e464bcbb86e154c6b5ab1))
* **preflight:** urgency-gap diagnostic probe ([80ef006](https://github.com/nimbus-agent/Nimbus/commit/80ef00637bfa36b5cc1540704618daed30c7a378))
* **preflight:** widen active-P1 filter to severity_p1_aliases ([742740d](https://github.com/nimbus-agent/Nimbus/commit/742740db5c8c560ce030a15f4c4f70bc1680cd82))
* **sandbox-helper:** enforce-and-exec mode + RFC 1123 + post-unshare seccomp (T2 PR 1) ([c5c7fea](https://github.com/nimbus-agent/Nimbus/commit/c5c7fea29573b480e89c9847acff171126654997))
* **sandbox-helper:** scaffold + --check-caps mode (T2 PR 1) ([80a84d0](https://github.com/nimbus-agent/Nimbus/commit/80a84d0d15ba13ab327d3d7ed22effee393dbc7b))
* **sandbox:** default Linux seccomp BPF filter (T2 PR 1) ([92d821f](https://github.com/nimbus-agent/Nimbus/commit/92d821fc121554cf294baa30338053e228f82eb7))
* **sandbox:** Linux SandboxRunner — bwrap + nimbus-sandbox-helper (T2 PR 1) ([6ea6c6a](https://github.com/nimbus-agent/Nimbus/commit/6ea6c6a6bf7e0b14617f8f38306dce5fda731e6f))
* **sandbox:** macOS SandboxRunner — sandbox-exec with SBPL profile (T2 PR 1) ([be8b001](https://github.com/nimbus-agent/Nimbus/commit/be8b001e7c4a99faf7aacca4fa2d34ac5577885b))
* **sandbox:** SandboxRunner PAL interface + dispatcher (T2 PR 1) ([d4ec092](https://github.com/nimbus-agent/Nimbus/commit/d4ec092388870d2ae096d52fdfffdfaa1f1962fa))
* **sandbox:** T2 PR 1 — Sandbox PAL + 3-OS isolation + I15 ([e668244](https://github.com/nimbus-agent/Nimbus/commit/e668244a42858d810a4e82c777c5d9565ddc3a10))
* **sandbox:** Windows AppContainer orphan-reap helper (T2 PR 1) ([01f16aa](https://github.com/nimbus-agent/Nimbus/commit/01f16aaec89300b53be6c9ca1215d31e3c7e27dd))
* **sandbox:** Windows SandboxRunner — AppContainer profile + capability surface (T2 PR 1) ([1efb7e8](https://github.com/nimbus-agent/Nimbus/commit/1efb7e8d1cbc4e5842b52d9bf4393c55cf7acd84))
* **sdk:** runSandboxContractTests + probe (T2 PR 1) ([633b464](https://github.com/nimbus-agent/Nimbus/commit/633b464336aa8196550d8db9748858317bb385dd))
* **search:** T6 PR 3 — vectorSearchChunksDual merge helper ([fe01976](https://github.com/nimbus-agent/Nimbus/commit/fe0197610eeee6cf712cd7e37d944498cf2860e0))
* **search:** T6 PR 3 — wire dual-search through hybrid options ([4570841](https://github.com/nimbus-agent/Nimbus/commit/4570841d5b1f2607203ae8286e5c5be6fac9e3e2))
* **updater:** createUpdaterFromConfig factory with disabled + unsupported-platform paths ([423fe23](https://github.com/nimbus-agent/Nimbus/commit/423fe23677615f8153ca1bd9106c4230edde7a5b))
* **updater:** derivePlatformTarget() with explicit unsupported-combo coverage ([7714aea](https://github.com/nimbus-agent/Nimbus/commit/7714aea57e1e690e8f796f6710ec94390d905ce2))
* **updater:** S6-F1 production wiring ([a1c69b9](https://github.com/nimbus-agent/Nimbus/commit/a1c69b9e46d9fc0ec6c3a570b695b8f7ff53b06f))


### Bug Fixes

* **ci:** unblock cross-platform test suite + SonarCloud reliability gate ([c75dbab](https://github.com/nimbus-agent/Nimbus/commit/c75dbab037d98b9c51df38b0ea7769089c52418a))
* **cli:** T6 PR 3 — drop the word "any" from index reembed help ([676cbd2](https://github.com/nimbus-agent/Nimbus/commit/676cbd219f797bfd00851b3cbaf861a1ca7a6e0c))
* **coverage-floor:** computeUpdatedBaseline seeds new below-floor entries ([2ba425a](https://github.com/nimbus-agent/Nimbus/commit/2ba425accbcc19e2ebf38938180ea027d4ed5af0))
* **coverage-floor:** drop unused [@ts-expect-error](https://github.com/ts-expect-error) in freeze test ([bc26019](https://github.com/nimbus-agent/Nimbus/commit/bc26019dfa7ded9a1de2368f887b816309ccdb45))
* **coverage-floor:** rename unused find() param to satisfy biome ([b63c40d](https://github.com/nimbus-agent/Nimbus/commit/b63c40dae65f2e664c11e38705f6958e9aa73a44))
* **coverage-floor:** Sonar new-code coverage — mirror local exemptions + lift sandbox-contract (PR [#329](https://github.com/nimbus-agent/Nimbus/issues/329)) ([51b101e](https://github.com/nimbus-agent/Nimbus/commit/51b101e0c9c20462bbd7005bb863efe546647bb6))
* **db:** T6 PR 3 — guard V30 no-vec branch against db.exec("") on macOS ([4130138](https://github.com/nimbus-agent/Nimbus/commit/4130138fedc9f06294aa88d8972ce7dcfd5fddf5))
* **extensions:** locale-aware sort in PreT2DisabledRegistry + new-code coverage push (PR [#329](https://github.com/nimbus-agent/Nimbus/issues/329)) ([afdc62e](https://github.com/nimbus-agent/Nimbus/commit/afdc62e8e8bb12d38567724a0a6393c25f8db1c6))
* **extensions:** reject trailing-hyphen + empty hostnames per RFC 1123 (T2 PR 1 code review) ([c5966b3](https://github.com/nimbus-agent/Nimbus/commit/c5966b3be793331de61c2d5cd6da060c68d3b401))
* **gitleaks:** rename fake API-key fixtures to defuse generic-api-key rule ([fddf720](https://github.com/nimbus-agent/Nimbus/commit/fddf7209f7064cbd8aed8b9982a27f5ad3c8363d))
* **sandbox-helper:** freeaddrinfo leak on inet_ntop error + AUDIT_ARCH_X86_64 seccomp guard (T2 PR 1 code review) ([f8c91a2](https://github.com/nimbus-agent/Nimbus/commit/f8c91a298d84130511400c7216ea11d60d73616a))
* **sandbox-helper:** guard _GNU_SOURCE redefine to unblock -Werror build ([#346](https://github.com/nimbus-agent/Nimbus/issues/346)) ([6f0e231](https://github.com/nimbus-agent/Nimbus/commit/6f0e231ea39052fc28b28638525442f2dc11a478))
* **sandbox:** allow epoll_wait + clone3, block io_uring (T2 PR 1 code review) ([dc63c7c](https://github.com/nimbus-agent/Nimbus/commit/dc63c7c1122fbcf5640ecc1e3c9a79961bb9ea78))
* **sandbox:** AUDIT_ARCH_X86_64 guard in connector seccomp filter (T2 PR 1 review) ([20fb86c](https://github.com/nimbus-agent/Nimbus/commit/20fb86c6a4ff0bde9c00409bac69366ed71c3c8e))
* **sandbox:** match platform/index.ts dispatcher idiom — node:os + .ts extensions (T2 PR 1 code review) ([cd9886d](https://github.com/nimbus-agent/Nimbus/commit/cd9886da39224528b8a51d227aa4aa40ac8c734f))
* **sandbox:** mkdtempSync for seccomp BPF tmpfile (CodeQL js/insecure-temporary-file) ([7804539](https://github.com/nimbus-agent/Nimbus/commit/78045391701e8738fdcb180e0b398aa0eed68303))
* **sdk:** drop .ts extension on testing/index re-export (T2 PR 1 CI) ([51b218c](https://github.com/nimbus-agent/Nimbus/commit/51b218c981fec8189829fca29181c6fc0d729a30))
* **security:** T6 PR 3 — block index.reembed* over LAN (I5) ([4f0d6c4](https://github.com/nimbus-agent/Nimbus/commit/4f0d6c4946e058c3ab14ac4b206504a519bbdef1))

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
