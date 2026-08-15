# Changelog

All notable changes to the `nimbus` core (headless Gateway + CLI binary + first-party MCP connectors) are documented in this file. release-please appends new entries between this header and the most recent version below when a release PR merges.

## [2.4.5](https://github.com/nimbus-agent/Nimbus/compare/v2.4.4...v2.4.5) (2026-08-15)


### Bug Fixes

* `nimbus config set` on a fresh machine, and an unactionable brief footer ([#1212](https://github.com/nimbus-agent/Nimbus/issues/1212)) ([c6824c7](https://github.com/nimbus-agent/Nimbus/commit/c6824c7a361af60a966d3aa9004e079ff3dbd914))

## [2.4.4](https://github.com/nimbus-agent/Nimbus/compare/v2.4.3...v2.4.4) (2026-08-15)


### Bug Fixes

* **sonar:** resolve the six minor findings and annotate the S8786 false positive ([#1206](https://github.com/nimbus-agent/Nimbus/issues/1206)) ([fa65d95](https://github.com/nimbus-agent/Nimbus/commit/fa65d957c46ff46354f8c17d9d37cf4d13957c19))
* **tui:** render the watcher pane, and stop claiming OS notifications work ([#1204](https://github.com/nimbus-agent/Nimbus/issues/1204)) ([78cb49b](https://github.com/nimbus-agent/Nimbus/commit/78cb49b0b8242e8ce56245c4454cc6e49c507244))

## [2.4.3](https://github.com/nimbus-agent/Nimbus/compare/v2.4.2...v2.4.3) (2026-08-15)


### Bug Fixes

* **admin-console:** escape policy.version before it reaches innerHTML ([#1201](https://github.com/nimbus-agent/Nimbus/issues/1201)) ([f62fd85](https://github.com/nimbus-agent/Nimbus/commit/f62fd8553e1ebc14f67f0a16a784302e80cb55e2))
* **cli:** stop blocking gateway RPCs dying on the 30s client timeout ([#1203](https://github.com/nimbus-agent/Nimbus/issues/1203)) ([3fc2132](https://github.com/nimbus-agent/Nimbus/commit/3fc2132255c86fbf04fce408e8f35cb123cb24ef))

## [2.4.2](https://github.com/nimbus-agent/Nimbus/compare/v2.4.1...v2.4.2) (2026-08-15)


### Bug Fixes

* **egress:** count the whole prove window, not the first page of it ([#1189](https://github.com/nimbus-agent/Nimbus/issues/1189)) ([1743437](https://github.com/nimbus-agent/Nimbus/commit/1743437229cc4b9fec8387fede74ced92f8d0453))

## [2.4.1](https://github.com/nimbus-agent/Nimbus/compare/v2.4.0...v2.4.1) (2026-08-14)


### Bug Fixes

* **install:** stop Windows PowerShell 5.1 native stderr from aborting gpg signature verification ([#1179](https://github.com/nimbus-agent/Nimbus/issues/1179)) ([6c991ea](https://github.com/nimbus-agent/Nimbus/commit/6c991eabf4cb110a4ddaf0ca844da62bfd437e7d))

## [2.4.0](https://github.com/nimbus-agent/Nimbus/compare/v2.3.1...v2.4.0) (2026-08-14)


### Features

* **connectors:** attribute PagerDuty incidents to people ([#1177](https://github.com/nimbus-agent/Nimbus/issues/1177)) ([20b51f6](https://github.com/nimbus-agent/Nimbus/commit/20b51f645fb118c388a4ba763514e9272ba627b2))

## [2.3.1](https://github.com/nimbus-agent/Nimbus/compare/v2.3.0...v2.3.1) (2026-08-14)


### Bug Fixes

* **install:** verify the release signature on Windows with a Git-for-Windows gpg ([#1175](https://github.com/nimbus-agent/Nimbus/issues/1175)) ([a68945e](https://github.com/nimbus-agent/Nimbus/commit/a68945e55cff9409536824d9fa7ff2c87d025fef))

## [2.3.0](https://github.com/nimbus-agent/Nimbus/compare/v2.2.0...v2.3.0) (2026-08-13)


### Features

* **connectors:** index Sentry issues, and make the published installers able to install ([#1172](https://github.com/nimbus-agent/Nimbus/issues/1172)) ([ea37e0d](https://github.com/nimbus-agent/Nimbus/commit/ea37e0d0ca904aa9ea229146692ef945b4c80df3))

## [2.2.0](https://github.com/nimbus-agent/Nimbus/compare/v2.1.0...v2.2.0) (2026-08-13)


### Features

* **agents:** nimbus negotiate — a cited contribution brief ([#1166](https://github.com/nimbus-agent/Nimbus/issues/1166)) ([fa807e3](https://github.com/nimbus-agent/Nimbus/commit/fa807e30377ae6e121b58eacb0b304d85b73a4fe))
* **ipc:** tag agent.chunk with a client-supplied streamId and add workflow.cancel ([#1165](https://github.com/nimbus-agent/Nimbus/issues/1165)) ([5779488](https://github.com/nimbus-agent/Nimbus/commit/5779488c77871113aeaecb7c9fa33c2b82ab540b))

## [2.1.0](https://github.com/nimbus-agent/Nimbus/compare/v2.0.0...v2.1.0) (2026-08-12)


### Features

* **connectors:** index GitHub PR reviews and size statistics ([#1159](https://github.com/nimbus-agent/Nimbus/issues/1159)) ([fb8a0c7](https://github.com/nimbus-agent/Nimbus/commit/fb8a0c7a1caeb8ffcf292b9b1f5ca472511e6855))

## [2.0.0](https://github.com/nimbus-agent/Nimbus/compare/v1.29.0...v2.0.0) (2026-08-11)


### ⚠ BREAKING CHANGES

* **egress:** remove the EgressCompleteness.tier compat shim ([#1156](https://github.com/nimbus-agent/Nimbus/issues/1156))

### Bug Fixes

* **clips:** embed web clips locally and stop advertising discarded text ([#1151](https://github.com/nimbus-agent/Nimbus/issues/1151)) ([0e3b183](https://github.com/nimbus-agent/Nimbus/commit/0e3b18336d1e1cb79080d09b660f20ca785c57ca))
* **quality:** close two ReDoS regexes and clear 25 SonarCloud findings ([#1152](https://github.com/nimbus-agent/Nimbus/issues/1152)) ([1f89379](https://github.com/nimbus-agent/Nimbus/commit/1f893798d6466c8a860fcda2141f5832acdda9c2))


### Code Refactoring

* **egress:** remove the EgressCompleteness.tier compat shim ([#1156](https://github.com/nimbus-agent/Nimbus/issues/1156)) ([7b530dc](https://github.com/nimbus-agent/Nimbus/commit/7b530dcc15930a208d63af43ad3af9dd46f44d07))

## [1.29.0](https://github.com/nimbus-agent/Nimbus/compare/v1.28.0...v1.29.0) (2026-08-11)


### Features

* **agents:** nimbus pre-mortem, with a service-scoped incident watcher condition ([#1146](https://github.com/nimbus-agent/Nimbus/issues/1146)) ([58e93fd](https://github.com/nimbus-agent/Nimbus/commit/58e93fd3e9e245c0ad17a3c8a3c51df815afda7a))


### Bug Fixes

* **connectors:** report only what was actually verified in connector auth and targeted fetch ([#1141](https://github.com/nimbus-agent/Nimbus/issues/1141)) ([902cd42](https://github.com/nimbus-agent/Nimbus/commit/902cd4291f9fb5278e56e59a9c1ecebbb293b33c))
* **gateway:** log why the process exits instead of dying silently ([#1140](https://github.com/nimbus-agent/Nimbus/issues/1140)) ([322ea68](https://github.com/nimbus-agent/Nimbus/commit/322ea683266d97a96aaa05e182b6208365ad5dbe))

## [1.28.0](https://github.com/nimbus-agent/Nimbus/compare/v1.27.0...v1.28.0) (2026-08-10)


### Features

* **automation:** add incident_opened and deploy_failed watcher conditions ([#1138](https://github.com/nimbus-agent/Nimbus/issues/1138)) ([34601b2](https://github.com/nimbus-agent/Nimbus/commit/34601b24b98026e61f3785965cf38b38b1d414f6))

## [1.27.0](https://github.com/nimbus-agent/Nimbus/compare/v1.26.1...v1.27.0) (2026-08-09)


### Features

* **gateway:** pre-mortem theme extraction pass (V53, PR A of 2) ([#1134](https://github.com/nimbus-agent/Nimbus/issues/1134)) ([cd1d9c2](https://github.com/nimbus-agent/Nimbus/commit/cd1d9c2e4c25e656af7db81b4de486a939139b69))

## [1.26.1](https://github.com/nimbus-agent/Nimbus/compare/v1.26.0...v1.26.1) (2026-08-09)


### Bug Fixes

* **ci:** accept repo as satisfying public_repo on WINGET_PAT, and add a scope-check script ([#1131](https://github.com/nimbus-agent/Nimbus/issues/1131)) ([ba54754](https://github.com/nimbus-agent/Nimbus/commit/ba54754432f3fb15d61020dff948b6ec8b4fdaf2))

## [1.26.0](https://github.com/nimbus-agent/Nimbus/compare/v1.25.2...v1.26.0) (2026-08-09)


### Features

* **gateway:** index Jira/Linear ticket depth and recover it via rebody --since ([#1128](https://github.com/nimbus-agent/Nimbus/issues/1128)) ([bdbecd1](https://github.com/nimbus-agent/Nimbus/commit/bdbecd16438824333aa5014bcf10a3ef19225a58))

## [1.25.2](https://github.com/nimbus-agent/Nimbus/compare/v1.25.1...v1.25.2) (2026-08-08)


### Bug Fixes

* **bitbucket:** 🧹 correct itemsUpserted overcount ([#1086](https://github.com/nimbus-agent/Nimbus/issues/1086)) ([9657921](https://github.com/nimbus-agent/Nimbus/commit/965792107ebcafba10667aab9bd5c7166388dc00))
* **gateway:** 🔒 Prevent command injection in tar extraction ([#1091](https://github.com/nimbus-agent/Nimbus/issues/1091)) ([575e2aa](https://github.com/nimbus-agent/Nimbus/commit/575e2aa5648d101c02f06450df4016500e3cfe50))
* **gateway:** resolve WAL mode race in http-api-test-server ([#1093](https://github.com/nimbus-agent/Nimbus/issues/1093)) ([1323567](https://github.com/nimbus-agent/Nimbus/commit/1323567a7a2d07bea4b39a6ba1b4a974cccc2b00))


### Performance Improvements

* **connectors:** ⚡ batch fetch message metadata in Gmail sync ([#1099](https://github.com/nimbus-agent/Nimbus/issues/1099)) ([cf1dfe1](https://github.com/nimbus-agent/Nimbus/commit/cf1dfe1d50b61682a7a27849e4678ecd734bc078))
* **gateway:** ⚡ batch API calls in SonarQube Sync to resolve N+1 issue ([#1089](https://github.com/nimbus-agent/Nimbus/issues/1089)) ([892e96b](https://github.com/nimbus-agent/Nimbus/commit/892e96b62839e9bc1a94d73b206a49fa1dd3233a))
* **jenkins:** ⚡ batch jenkins job builds sync ([#1087](https://github.com/nimbus-agent/Nimbus/issues/1087)) ([d94d632](https://github.com/nimbus-agent/Nimbus/commit/d94d63274a0d8f4a29771816e77911363ea24c11))

## [1.25.1](https://github.com/nimbus-agent/Nimbus/compare/v1.25.0...v1.25.1) (2026-08-08)


### Bug Fixes

* resolve macos-15 CI test failures and consolidate open connector PRs ([#1082](https://github.com/nimbus-agent/Nimbus/issues/1082)) ([9f9215b](https://github.com/nimbus-agent/Nimbus/commit/9f9215bfcca7ba4cdde0b66e4975881359882797))

## [1.25.0](https://github.com/nimbus-agent/Nimbus/compare/v1.24.0...v1.25.0) (2026-08-08)


### Features

* **gateway:** resolve an indexed item by URL (V52 resolve_key) ([#1070](https://github.com/nimbus-agent/Nimbus/issues/1070)) ([0a32751](https://github.com/nimbus-agent/Nimbus/commit/0a32751f6e97af93b5fc405080df14bd7a77911d))
* **gateway:** targeted fetch-on-miss behind a derived host boundary ([#1072](https://github.com/nimbus-agent/Nimbus/issues/1072)) ([369f9af](https://github.com/nimbus-agent/Nimbus/commit/369f9af1a81e10599dc3d9b9f6c86c43bfa95fbc))

## [1.24.0](https://github.com/nimbus-agent/Nimbus/compare/v1.23.0...v1.24.0) (2026-08-07)


### Features

* **gateway:** read the ownership graph through the agents.ownership brief ([#1067](https://github.com/nimbus-agent/Nimbus/issues/1067)) ([e898a1e](https://github.com/nimbus-agent/Nimbus/commit/e898a1e9e204c8720050b44b73b37c52611690fc))

## [1.23.0](https://github.com/nimbus-agent/Nimbus/compare/v1.22.0...v1.23.0) (2026-08-07)


### Features

* **gateway:** invoke read-only agents over the HTTP API, recorded in the egress ledger ([#1063](https://github.com/nimbus-agent/Nimbus/issues/1063)) ([4b4bedb](https://github.com/nimbus-agent/Nimbus/commit/4b4bedb4e000f79d63f2cddbbda2e2d92006a51e))
* **gateway:** ownership graph derived from already-indexed blame data ([#1064](https://github.com/nimbus-agent/Nimbus/issues/1064)) ([82c03d2](https://github.com/nimbus-agent/Nimbus/commit/82c03d27339290d11276f65cec795c9975432647))
* **gateway:** scope the HTTP API bearer tokens ([#1062](https://github.com/nimbus-agent/Nimbus/issues/1062)) ([826b76a](https://github.com/nimbus-agent/Nimbus/commit/826b76a1a5352ac226bfcd3c6a88b901d6afe33a))


### Bug Fixes

* **gateway:** serve the admin console and OpenAPI doc from a compiled binary ([#1058](https://github.com/nimbus-agent/Nimbus/issues/1058)) ([36abf19](https://github.com/nimbus-agent/Nimbus/commit/36abf192457984a42e2d4e74b984603d51fbb376))

## [1.22.0](https://github.com/nimbus-agent/Nimbus/compare/v1.21.0...v1.22.0) (2026-08-06)


### Features

* expose the read-only agents as MCP tools, recorded in the egress ledger ([#1059](https://github.com/nimbus-agent/Nimbus/issues/1059)) ([dcc7bd7](https://github.com/nimbus-agent/Nimbus/commit/dcc7bd7d1a1bbdf04273b4769df7e0f637bbc209))

## [1.21.0](https://github.com/nimbus-agent/Nimbus/compare/v1.20.0...v1.21.0) (2026-08-05)


### Features

* **tooling:** close the gap between local gates and CI ([#1050](https://github.com/nimbus-agent/Nimbus/issues/1050)) ([0efd781](https://github.com/nimbus-agent/Nimbus/commit/0efd781af366606b6dc0ddb8e08a97027db55d5a))


### Bug Fixes

* **gateway:** make connectors spawnable from a compiled binary ([#1055](https://github.com/nimbus-agent/Nimbus/issues/1055)) ([b3a6f15](https://github.com/nimbus-agent/Nimbus/commit/b3a6f159e9f9c4b8b0ed44262067efec42dfaba4))

## [1.20.0](https://github.com/nimbus-agent/Nimbus/compare/v1.19.1...v1.20.0) (2026-08-04)


### Features

* **connectors:** index real Notion and Confluence page bodies ([#1039](https://github.com/nimbus-agent/Nimbus/issues/1039)) ([609409e](https://github.com/nimbus-agent/Nimbus/commit/609409ec07c6b72c9d817330a394e1b961ca27fb))
* **egress:** make the I29 completeness claim true — coverage vector, boot marker, required sink ([#1038](https://github.com/nimbus-agent/Nimbus/issues/1038)) ([a1169d9](https://github.com/nimbus-agent/Nimbus/commit/a1169d943aca41a339bb8fb1c6b32ee4f929e2fb))

## [1.19.1](https://github.com/nimbus-agent/Nimbus/compare/v1.19.0...v1.19.1) (2026-08-03)


### Bug Fixes

* **deps:** bump the brace-expansion override to 5.0.9 (GHSA-rgw5-rvv9-x895) ([#1035](https://github.com/nimbus-agent/Nimbus/issues/1035)) ([8d66323](https://github.com/nimbus-agent/Nimbus/commit/8d663237a4ff3615e12cd6c8f106aa3c51b4f34e))

## [1.19.0](https://github.com/nimbus-agent/Nimbus/compare/v1.18.1...v1.19.0) (2026-08-03)


### Features

* **cli:** nimbus index rebody, and correct the full-body-store connector accounting ([#1032](https://github.com/nimbus-agent/Nimbus/issues/1032)) ([9ab8c69](https://github.com/nimbus-agent/Nimbus/commit/9ab8c697f4aa81e843e4670a888f19d654c1c9cc))

## [1.18.1](https://github.com/nimbus-agent/Nimbus/compare/v1.18.0...v1.18.1) (2026-08-03)


### Bug Fixes

* **connectors:** metadata_only redaction must erase embedding chunks and the right vectors ([#1026](https://github.com/nimbus-agent/Nimbus/issues/1026)) ([bae0d86](https://github.com/nimbus-agent/Nimbus/commit/bae0d86aea42d3161da828b53be69f19e8bd1614))
* **ipc:** forbid the clip namespace over LAN — clip.pair opens the I30 pairing window ([#1027](https://github.com/nimbus-agent/Nimbus/issues/1027)) ([7bd2cdc](https://github.com/nimbus-agent/Nimbus/commit/7bd2cdc128e4f5ab8fcdb3a8301bc8cdd6efade5))

## [1.18.0](https://github.com/nimbus-agent/Nimbus/compare/v1.17.0...v1.18.0) (2026-08-02)


### Features

* **index:** full-body store — V48 item.body, uncapped keyword search, and full bodies for the prose sources ([#1023](https://github.com/nimbus-agent/Nimbus/issues/1023)) ([faa23a8](https://github.com/nimbus-agent/Nimbus/commit/faa23a8b50fe7d8e9ae293adcb7e912572a1a900))


### Bug Fixes

* **share:** fail closed on unverified share replay ([#1021](https://github.com/nimbus-agent/Nimbus/issues/1021)) ([e210723](https://github.com/nimbus-agent/Nimbus/commit/e210723c8885f77c9be560ff3ccb3cff90e9018e))

## [1.17.0](https://github.com/nimbus-agent/Nimbus/compare/v1.16.1...v1.17.0) (2026-08-02)


### Features

* **decisions:** add nimbus decisions, the implicit ADR extractor ([#1019](https://github.com/nimbus-agent/Nimbus/issues/1019)) ([e999122](https://github.com/nimbus-agent/Nimbus/commit/e99912257b32315641c1ac43c1f75790146679c5))

## [1.16.1](https://github.com/nimbus-agent/Nimbus/compare/v1.16.0...v1.16.1) (2026-08-01)


### Bug Fixes

* **deps:** reconcile overrides, align the sdk floor onto the BOM fix, and gate both ([#1017](https://github.com/nimbus-agent/Nimbus/issues/1017)) ([6dfdc81](https://github.com/nimbus-agent/Nimbus/commit/6dfdc81edfc73e0f8ff2ba3558004352c264e5d8))

## [1.16.0](https://github.com/nimbus-agent/Nimbus/compare/v1.15.1...v1.16.0) (2026-08-01)


### Features

* **cli:** implement --json on the six commands that documented it ([#1011](https://github.com/nimbus-agent/Nimbus/issues/1011)) ([d3d252e](https://github.com/nimbus-agent/Nimbus/commit/d3d252e8c6ea3342fb5b9b80391eb056d952ff3c))


### Bug Fixes

* **cli:** make nimbus connector remove work by answering the gateway HITL gate ([#1013](https://github.com/nimbus-agent/Nimbus/issues/1013)) ([8f646c7](https://github.com/nimbus-agent/Nimbus/commit/8f646c76918a2ccab380d7c2fb5bd6cf2823c675))
* **release:** prune the yum channel, keeping the newest N and the published release ([#1010](https://github.com/nimbus-agent/Nimbus/issues/1010)) ([7dc717a](https://github.com/nimbus-agent/Nimbus/commit/7dc717a0fc0f8b8138a3e62bf3fdde867c44b06a))

## [1.15.1](https://github.com/nimbus-agent/Nimbus/compare/v1.15.0...v1.15.1) (2026-08-01)


### Bug Fixes

* **cli:** stop share argument errors crashing, and retire seven false coverage exclusions ([#1004](https://github.com/nimbus-agent/Nimbus/issues/1004)) ([982b4d2](https://github.com/nimbus-agent/Nimbus/commit/982b4d2a2605338a539077db56d9d02c38ccbd01))

## [1.15.0](https://github.com/nimbus-agent/Nimbus/compare/v1.14.2...v1.15.0) (2026-08-01)


### Features

* **glossary:** author and correct terms in nimbus.toml ([#993](https://github.com/nimbus-agent/Nimbus/issues/993)) ([b25c0f1](https://github.com/nimbus-agent/Nimbus/commit/b25c0f1a119700b7f2d50294c6165dc09eb89ce2))

## [1.14.2](https://github.com/nimbus-agent/Nimbus/compare/v1.14.1...v1.14.2) (2026-07-31)


### Bug Fixes

* **extensions:** accept entrypoint as a fallback for entry ([#991](https://github.com/nimbus-agent/Nimbus/issues/991)) ([d796cfb](https://github.com/nimbus-agent/Nimbus/commit/d796cfbf44934c6c4019ee956b943beb6418f9d1))

## [1.14.1](https://github.com/nimbus-agent/Nimbus/compare/v1.14.0...v1.14.1) (2026-07-31)


### Bug Fixes

* **glossary:** stop --refresh hanging when the gateway dies mid-pass ([#989](https://github.com/nimbus-agent/Nimbus/issues/989)) ([c571fe1](https://github.com/nimbus-agent/Nimbus/commit/c571fe18122cdaa81c6fa41fc2d37a20a65145a0))

## [1.14.0](https://github.com/nimbus-agent/Nimbus/compare/v1.13.1...v1.14.0) (2026-07-31)


### Features

* **glossary:** consolidate through a local-only LLM, upgrade snippet definitions, and wire --refresh/--rebuild ([#987](https://github.com/nimbus-agent/Nimbus/issues/987)) ([9d8def2](https://github.com/nimbus-agent/Nimbus/commit/9d8def2ea3fe048044dbb908e4fc877f6ca784e5))

## [1.13.1](https://github.com/nimbus-agent/Nimbus/compare/v1.13.0...v1.13.1) (2026-07-31)


### Bug Fixes

* **gateway:** remove the data-export staging directory ([#985](https://github.com/nimbus-agent/Nimbus/issues/985)) ([606788c](https://github.com/nimbus-agent/Nimbus/commit/606788c3c9b440a254d402f53f2aaba2f4d361f4))

## [1.13.0](https://github.com/nimbus-agent/Nimbus/compare/v1.12.1...v1.13.0) (2026-07-31)


### Features

* **glossary:** nimbus glossary — implicit-knowledge terminology agent ([#981](https://github.com/nimbus-agent/Nimbus/issues/981)) ([bb0069c](https://github.com/nimbus-agent/Nimbus/commit/bb0069c06b411ede044cacb135dac66f65982483))

## [1.12.1](https://github.com/nimbus-agent/Nimbus/compare/v1.12.0...v1.12.1) (2026-07-30)


### Bug Fixes

* **db:** finalize prepared statements so close() releases the database file ([#970](https://github.com/nimbus-agent/Nimbus/issues/970)) ([fa4aca2](https://github.com/nimbus-agent/Nimbus/commit/fa4aca2602a79cd64349c3e003ca01708f042976))

## [1.12.0](https://github.com/nimbus-agent/Nimbus/compare/v1.11.0...v1.12.0) (2026-07-30)


### Documentation

* **claude:** record that release tags are immutable, and how to recover ([#962](https://github.com/nimbus-agent/Nimbus/issues/962)) ([039176c](https://github.com/nimbus-agent/Nimbus/commit/039176c781f6f2617c581d50c8a8921c152f3cfc))

## [1.11.0](https://github.com/nimbus-agent/Nimbus/compare/v1.10.0...v1.11.0) (2026-07-30)

> **Never published — superseded by 1.12.0.** This tag's release build failed its
> Unit + Coverage gate, which skipped every build and publish job, so no GitHub Release,
> installer, or updater manifest was ever produced for `v1.11.0`; the git tag is its only
> trace. The tag is immutable under the *Protected release tags* ruleset and was left in
> place rather than moved, so the feature below shipped in 1.12.0 instead.
> See [#957](https://github.com/nimbus-agent/Nimbus/issues/957).

### Features

* **p6:** gate ruleset bypass actors — owner-run audit + credential-free attestation ([#954](https://github.com/nimbus-agent/Nimbus/issues/954)) ([2a3187b](https://github.com/nimbus-agent/Nimbus/commit/2a3187bd4942e33b128a09df3e59d9680d275960))

## [1.10.0](https://github.com/nimbus-agent/Nimbus/compare/v1.9.0...v1.10.0) (2026-07-30)


### Features

* **ci:** audit:review-coverage — close P3's org-wide half ([#948](https://github.com/nimbus-agent/Nimbus/issues/948)) ([5ad05a8](https://github.com/nimbus-agent/Nimbus/commit/5ad05a8c69e98624897f3996b6989fc145e69bba))

## [1.9.0](https://github.com/nimbus-agent/Nimbus/compare/v1.8.0...v1.9.0) (2026-07-30)


### Features

* **connectors:** index Readwise books as `readwise:book` ([#926](https://github.com/nimbus-agent/Nimbus/issues/926)) ([83b83f4](https://github.com/nimbus-agent/Nimbus/commit/83b83f491479c3ca8f0f8f45e12d4d08c0b425f2))

## [1.8.0](https://github.com/nimbus-agent/Nimbus/compare/v1.7.0...v1.8.0) (2026-07-29)


### Features

* **connectors:** index Google Meet participant detail on conference records ([#927](https://github.com/nimbus-agent/Nimbus/issues/927)) ([69282ef](https://github.com/nimbus-agent/Nimbus/commit/69282ef9712ec966afd9b5e6f4bc11527aa77d35))


### Bug Fixes

* **ci:** repair the coverage-gate count assertion broken by [#936](https://github.com/nimbus-agent/Nimbus/issues/936) ([#941](https://github.com/nimbus-agent/Nimbus/issues/941)) ([af9d246](https://github.com/nimbus-agent/Nimbus/commit/af9d246b5f06dceaeee4f43e8665c8b70932e956))
* **cli:** handle the embedding warm-up error in `nimbus search` ([#937](https://github.com/nimbus-agent/Nimbus/issues/937)) ([8640972](https://github.com/nimbus-agent/Nimbus/commit/8640972adbc81a88c7999597a6feaf381491fc39))

## [1.7.0](https://github.com/nimbus-agent/Nimbus/compare/v1.6.0...v1.7.0) (2026-07-29)


### Features

* **ci:** split secret-health's "expiring" from "dead" so a new failure is visible ([#922](https://github.com/nimbus-agent/Nimbus/issues/922)) ([2adae3c](https://github.com/nimbus-agent/Nimbus/commit/2adae3cc3d036ca97b1771ae9f880fbea5929881))
* **connectors:** index Mercury transactions (`mercury:transaction`) ([#924](https://github.com/nimbus-agent/Nimbus/issues/924)) ([d9a4708](https://github.com/nimbus-agent/Nimbus/commit/d9a4708318fc0ccd321f1e1dd96ad6fc074e863d))
* **connectors:** index Raindrop collections as `raindrop:collection` ([#929](https://github.com/nimbus-agent/Nimbus/issues/929)) ([bbe2be7](https://github.com/nimbus-agent/Nimbus/commit/bbe2be71a72fbea2f336ae47787c9aa535f755a0))


### Bug Fixes

* **cli:** make `nimbus init` fail loudly when the Gateway never starts ([#933](https://github.com/nimbus-agent/Nimbus/issues/933)) ([a28e3f0](https://github.com/nimbus-agent/Nimbus/commit/a28e3f049fbe85ef275d0c10149bf2fce95d2120))
* **gateway:** bind IPC before the embedding model loads ([#928](https://github.com/nimbus-agent/Nimbus/issues/928)) ([#934](https://github.com/nimbus-agent/Nimbus/issues/934)) ([79b18f0](https://github.com/nimbus-agent/Nimbus/commit/79b18f0e484d22a381324f660aa0631dce1385d5))
* **security:** close the last two bun audit advisories — @hono/node-server fixed, @ai-sdk/provider-utils accepted with a re-check date ([#923](https://github.com/nimbus-agent/Nimbus/issues/923)) ([ede61eb](https://github.com/nimbus-agent/Nimbus/commit/ede61eb4772b443abc1f7d24f843f04b8b90d7b5))
* **vault:** probe the Linux Secret Service instead of secret-tool's PATH ([#935](https://github.com/nimbus-agent/Nimbus/issues/935)) ([ccba4aa](https://github.com/nimbus-agent/Nimbus/commit/ccba4aa2dde285c7145ca2b6a94f3a6677954199))

## [1.6.0](https://github.com/nimbus-agent/Nimbus/compare/v1.5.1...v1.6.0) (2026-07-29)


### Features

* **audit:** detect when main is red ([#917](https://github.com/nimbus-agent/Nimbus/issues/917)) ([0f0b140](https://github.com/nimbus-agent/Nimbus/commit/0f0b14029396f4bc6cc5f73ce6427f115d03d1e5))
* **ci:** widen audit:org-settings-drift from 2 settings to 12 across 4 endpoints ([#918](https://github.com/nimbus-agent/Nimbus/issues/918)) ([04961ba](https://github.com/nimbus-agent/Nimbus/commit/04961ba9edf1d2ba0ccd2a9c4f122996df546783))

## [1.5.1](https://github.com/nimbus-agent/Nimbus/compare/v1.5.0...v1.5.1) (2026-07-28)


### Bug Fixes

* **docs:** serve .well-known/security.txt by disabling Jekyll filtering ([#915](https://github.com/nimbus-agent/Nimbus/issues/915)) ([393e7de](https://github.com/nimbus-agent/Nimbus/commit/393e7de7982e1a74f5544c1571b463bf66207c52))

## [1.5.0](https://github.com/nimbus-agent/Nimbus/compare/v1.4.3...v1.5.0) (2026-07-28)


### Features

* **ci:** close out P4b — after-measurement, co-gate enforcement, sweep proof ([#901](https://github.com/nimbus-agent/Nimbus/issues/901)) ([eaa1999](https://github.com/nimbus-agent/Nimbus/commit/eaa199953e2253cf03d24b7efb82d64a12bbb872))

## [1.4.3](https://github.com/nimbus-agent/Nimbus/compare/v1.4.2...v1.4.3) (2026-07-28)


### Bug Fixes

* **cast-driver:** normalize macOS's /private tmpdir alias — unbreaks main on macOS ([#899](https://github.com/nimbus-agent/Nimbus/issues/899)) ([de0a5f2](https://github.com/nimbus-agent/Nimbus/commit/de0a5f28c3313eef2c5f54c1c5aa616586bb6d50))

## [1.4.2](https://github.com/nimbus-agent/Nimbus/compare/v1.4.1...v1.4.2) (2026-07-28)


### Bug Fixes

* **cast-driver:** print the diff on DRIFT so a macOS-only failure is diagnosable ([#897](https://github.com/nimbus-agent/Nimbus/issues/897)) ([b9d074c](https://github.com/nimbus-agent/Nimbus/commit/b9d074cd25629eef66f373ad26b2469b1ba02911))

## [1.4.1](https://github.com/nimbus-agent/Nimbus/compare/v1.4.0...v1.4.1) (2026-07-28)


### Bug Fixes

* **gateway:** nimbus init could never index — connector.sync rejected every local syncable ([#895](https://github.com/nimbus-agent/Nimbus/issues/895)) ([f16b012](https://github.com/nimbus-agent/Nimbus/commit/f16b012cd2d4af2f2bc3ccf90cf74cc34ab12a99))


### Performance Improvements

* **ci:** cut a push run 105 -&gt; 75 jobs — CI was queueing behind its own fan-out ([#894](https://github.com/nimbus-agent/Nimbus/issues/894)) ([1462894](https://github.com/nimbus-agent/Nimbus/commit/146289412bcc865d8583093a25a747c5fb979563))

## [1.4.0](https://github.com/nimbus-agent/Nimbus/compare/v1.3.0...v1.4.0) (2026-07-28)


### Features

* **demos:** recut the hero cast to the zero-config path ([#888](https://github.com/nimbus-agent/Nimbus/issues/888)) ([ad437ba](https://github.com/nimbus-agent/Nimbus/commit/ad437ba28522369411d96289998e8f2b9d95d016))

## [1.3.0](https://github.com/nimbus-agent/Nimbus/compare/v1.2.0...v1.3.0) (2026-07-28)


### Features

* zero-config onboarding — nimbus init, and the LLM demoted to optional ([#887](https://github.com/nimbus-agent/Nimbus/issues/887)) ([3e51aaf](https://github.com/nimbus-agent/Nimbus/commit/3e51aaf9f8171415c81d97a9b77f0f0141d40c76))


### Bug Fixes

* **perf:** stop a huggingface.co stall from blowing the 45m bench timeout ([#885](https://github.com/nimbus-agent/Nimbus/issues/885)) ([22938ac](https://github.com/nimbus-agent/Nimbus/commit/22938ac57788eed724d1ab6a28553bb7138b7631))

## [1.2.0](https://github.com/nimbus-agent/Nimbus/compare/v1.1.0...v1.2.0) (2026-07-27)


### Features

* **audit:** P4b — measure CI latency before tuning anything ([#877](https://github.com/nimbus-agent/Nimbus/issues/877)) ([6ffe23f](https://github.com/nimbus-agent/Nimbus/commit/6ffe23f3f0f9d94601ff4b9a23a48b3d3fc3f2a7))


### Bug Fixes

* **ci:** retry the Rust toolchain install, drop the redundant one, and close [#809](https://github.com/nimbus-agent/Nimbus/issues/809)/[#810](https://github.com/nimbus-agent/Nimbus/issues/810)/[#812](https://github.com/nimbus-agent/Nimbus/issues/812) ([#855](https://github.com/nimbus-agent/Nimbus/issues/855)) ([bb729c5](https://github.com/nimbus-agent/Nimbus/commit/bb729c5b55f3d64823a29e1b15bdd7e6c85a110a))
* **release:** publish the install scripts and stable-name aliases users are told to download ([#881](https://github.com/nimbus-agent/Nimbus/issues/881)) ([fdbc246](https://github.com/nimbus-agent/Nimbus/commit/fdbc2467bfa503a208d2f463e2b786f9cb4885e8))

## [1.1.0](https://github.com/nimbus-agent/Nimbus/compare/v1.0.1...v1.1.0) (2026-07-26)


### Features

* **audit:** action-pin freshness — pinned is not the same as current ([#847](https://github.com/nimbus-agent/Nimbus/issues/847)) ([fd1e7ae](https://github.com/nimbus-agent/Nimbus/commit/fd1e7ae03019158cbd3796d9e4933263d8687ea1))
* **audit:** P2 Release Train Phase 2 — dependency-DAG edges ([#843](https://github.com/nimbus-agent/Nimbus/issues/843)) ([1e8c9ea](https://github.com/nimbus-agent/Nimbus/commit/1e8c9eafdcde6a9f338ce87a613d19e417de8dfa))
* **review:** give the monorepo a tuned CodeRabbit config ([#846](https://github.com/nimbus-agent/Nimbus/issues/846)) ([060f50c](https://github.com/nimbus-agent/Nimbus/commit/060f50cda7c240651954cb7294c64d0a249d12a4))

## [1.0.1](https://github.com/nimbus-agent/Nimbus/compare/v1.0.0...v1.0.1) (2026-07-26)


### Bug Fixes

* **ci:** stop pending-run eviction silently cancelling main's validation ([#840](https://github.com/nimbus-agent/Nimbus/issues/840)) ([7ce8815](https://github.com/nimbus-agent/Nimbus/commit/7ce8815952858b16f367b98941539375e0af105e))

## [1.0.0](https://github.com/nimbus-agent/Nimbus/compare/v0.27.0...v1.0.0) (2026-07-26)


### ⚠ BREAKING CHANGES

* **security:** clear all high advisories (react-router v8, postcss, brace-expansion) + scope cla.yml permissions ([#835](https://github.com/nimbus-agent/Nimbus/issues/835))

### Features

* **infra:** P2 Release Train Phase 1 — release-staleness gate ([#836](https://github.com/nimbus-agent/Nimbus/issues/836)) ([98b0327](https://github.com/nimbus-agent/Nimbus/commit/98b03278380e946c36c4ae2c0038321969d2ff83))


### Bug Fixes

* **release:** reconcile step never detected a missing tag (gh writes 422 to stdout) ([#834](https://github.com/nimbus-agent/Nimbus/issues/834)) ([ffcec8e](https://github.com/nimbus-agent/Nimbus/commit/ffcec8eab8370ab6b8f908e0646a0f3975bd2194))
* **release:** request workflows:write so the App can create the release tag ([#837](https://github.com/nimbus-agent/Nimbus/issues/837)) ([2be97d7](https://github.com/nimbus-agent/Nimbus/commit/2be97d743861edb2764d707f349522161f9cf077))
* **security:** clear all high advisories (react-router v8, postcss, brace-expansion) + scope cla.yml permissions ([#835](https://github.com/nimbus-agent/Nimbus/issues/835)) ([7d2129e](https://github.com/nimbus-agent/Nimbus/commit/7d2129e62387e4de74159befbc6db1f85440d9fa))

## [0.27.0](https://github.com/nimbus-agent/Nimbus/compare/v0.26.0...v0.27.0) (2026-07-24)


### Features

* **infra:** P6a access model — team-reachability + org-settings drift gates ([#826](https://github.com/nimbus-agent/Nimbus/issues/826)) ([52afca3](https://github.com/nimbus-agent/Nimbus/commit/52afca34746045f202545d0bf0d55d70483d4afa))

## [0.26.0](https://github.com/nimbus-agent/Nimbus/compare/v0.25.0...v0.26.0) (2026-07-24)


### Features

* **agents:** the why lens — why agent, whyPeek, on-demand blame + index regraph (step 1b) ([#820](https://github.com/nimbus-agent/Nimbus/issues/820)) ([940cb2e](https://github.com/nimbus-agent/Nimbus/commit/940cb2e01c5c8ecb853c2d359c203022457a7efd))
* **blame:** whole-file 90-day blame indexer (Stage 2a un-park PR B) ([#819](https://github.com/nimbus-agent/Nimbus/issues/819)) ([4bcc076](https://github.com/nimbus-agent/Nimbus/commit/4bcc0767d5e1bb452789baff27f6aee98c517a91))
* **github:** enrich fallback 'PR #N' titles via pull-detail fetch ([#817](https://github.com/nimbus-agent/Nimbus/issues/817)) ([465bee0](https://github.com/nimbus-agent/Nimbus/commit/465bee092dcc732d72b52fd9b93adeb758edceba))
* **graph:** make resolves, mentions and correlates_with real (why-lens step 1a) ([#813](https://github.com/nimbus-agent/Nimbus/issues/813)) ([44e1c38](https://github.com/nimbus-agent/Nimbus/commit/44e1c384243354593ecbcea32df5b4af6a843b0c))
* nimbus index add + filesystem.ensureRoot — register blame roots (Stage 2a PR C) ([#822](https://github.com/nimbus-agent/Nimbus/issues/822)) ([67a9f75](https://github.com/nimbus-agent/Nimbus/commit/67a9f75cd2765c3f3f751b9db90f04f718fa265a))


### Bug Fixes

* **agents:** report why a janitor resourceRef was rejected ([#805](https://github.com/nimbus-agent/Nimbus/issues/805)) ([1b002b5](https://github.com/nimbus-agent/Nimbus/commit/1b002b516180b8ba039a5279d8db50d03e7e9227))
* **ipc:** the connector HITL prompts named params no caller sends ([#811](https://github.com/nimbus-agent/Nimbus/issues/811)) ([cc2b07f](https://github.com/nimbus-agent/Nimbus/commit/cc2b07fb65e49bacc8cc208d8b84986527d2ae65))
* **secrets:** VSCE_PAT deadline is its expiry (2026-09-20), not the decommission ([#803](https://github.com/nimbus-agent/Nimbus/issues/803)) ([bdb79f8](https://github.com/nimbus-agent/Nimbus/commit/bdb79f858de97f7e68d519de62c2c32d496866ff))

## [0.25.0](https://github.com/nimbus-agent/Nimbus/compare/v0.24.0...v0.25.0) (2026-07-22)


### Features

* **gateway:** research briefs — staged HTTP reasoning surface with citation-validated reports ([#799](https://github.com/nimbus-agent/Nimbus/issues/799)) ([f310d2a](https://github.com/nimbus-agent/Nimbus/commit/f310d2a679ca7edc1f73c6abde808acd0c851931))


### Bug Fixes

* clear the SonarCloud board (15), the 6 astro XSS advisories, and the stale release line ([#801](https://github.com/nimbus-agent/Nimbus/issues/801)) ([825df03](https://github.com/nimbus-agent/Nimbus/commit/825df03e6157ebfa2299984115aa68be24539fe1))

## [0.24.0](https://github.com/nimbus-agent/Nimbus/compare/v0.23.2...v0.24.0) (2026-07-22)


### Features

* **apple:** iCloud Mail + Calendar connector (Phase 6 Slice 9-E) ([#711](https://github.com/nimbus-agent/Nimbus/issues/711)) ([58c69e0](https://github.com/nimbus-agent/Nimbus/commit/58c69e09fba285b03b94eed60f69751103da1bf3))
* **audit:** promote D12 to binary; new DB_RUN_EXEC_ALLOW_LIST (T6 PR 4) ([10b9876](https://github.com/nimbus-agent/Nimbus/commit/10b9876a4fbd1e1a4e1c16b7bc0b3c425697a305))
* **auth+connectors:** OAuth provider registry (PR-1) + Tier-1 connector batch + Zoom planning ([#447](https://github.com/nimbus-agent/Nimbus/issues/447)) ([9d71a62](https://github.com/nimbus-agent/Nimbus/commit/9d71a62fa5058475b8482469e82b76b8eb05615c))
* **cli:** add `nimbus --version` / `-v` / `version` ([#753](https://github.com/nimbus-agent/Nimbus/issues/753)) ([5eec16c](https://github.com/nimbus-agent/Nimbus/commit/5eec16c118e94667ddccc0ebb0e122f0bc31f136))
* **client:** add searchRanked to NimbusClient + MockClient ([#742](https://github.com/nimbus-agent/Nimbus/issues/742)) ([a378884](https://github.com/nimbus-agent/Nimbus/commit/a378884360c50b55f1d76bcd61492c1594327b86))
* **client:** expose egress ledger reads on NimbusClient + MockClient ([#751](https://github.com/nimbus-agent/Nimbus/issues/751)) ([31c05b2](https://github.com/nimbus-agent/Nimbus/commit/31c05b25c17b858d14980455ad8800fbfb99e875))
* **cli:** nimbus clip list + clip delete (+ clip-scoped tags) ([#760](https://github.com/nimbus-agent/Nimbus/issues/760)) ([65e8857](https://github.com/nimbus-agent/Nimbus/commit/65e8857a27dff10ac85f9c3e63c2fd2a21628bb2))
* **cli:** nimbus mcp-server — expose local index to editor AIs over MCP ([#480](https://github.com/nimbus-agent/Nimbus/issues/480)) ([003e32d](https://github.com/nimbus-agent/Nimbus/commit/003e32dd0c85ba6224acb27d0fc5f5c2e73e013c))
* **cli:** print the gateway URL from `nimbus clip pair` ([#761](https://github.com/nimbus-agent/Nimbus/issues/761)) ([b72f96d](https://github.com/nimbus-agent/Nimbus/commit/b72f96dcb862f54084927d8542edce9e0e795ad7))
* **clips:** web clipper gateway — POST /v1/clips, pairing auth, invariant I30 (Phase 6 Slice 9) ([#718](https://github.com/nimbus-agent/Nimbus/issues/718)) ([17d325e](https://github.com/nimbus-agent/Nimbus/commit/17d325e7a55729772623438fa4a914c762d810ea))
* **cli:** T6 PR 3 — nimbus index reembed ([46f1e8c](https://github.com/nimbus-agent/Nimbus/commit/46f1e8c4e3cfc2f43d2abe8e2a2b44f60e9d292b))
* **config:** [pagerduty] TOML block — max_pages_per_sync + severity_p1_aliases ([62eeb39](https://github.com/nimbus-agent/Nimbus/commit/62eeb3960dda99955c0a46c51928ae9e79db3a67))
* **config:** add severityP1Aliases field to ServiceConfig ([5dfca63](https://github.com/nimbus-agent/Nimbus/commit/5dfca63e0e6554598957977ed5e4f26ff2939c13))
* **config:** thread [pagerduty].severity_p1_aliases into ServiceConfig ([18e1612](https://github.com/nimbus-agent/Nimbus/commit/18e161291b4bae3acb8ee2e2e83bb7f0967d752a))
* **connectors:** declare permissions.network for all 30 first-party connectors (T2 PR 1) ([9a5bf7a](https://github.com/nimbus-agent/Nimbus/commit/9a5bf7af56ac8cb0e75a8db885c65611cfc42739))
* **connectors:** Mendeley connector (Phase 6 Slice 9 — sub-project A) ([#631](https://github.com/nimbus-agent/Nimbus/issues/631)) ([1ddeae5](https://github.com/nimbus-agent/Nimbus/commit/1ddeae52ca6301d5992a915250a9189b4c61f3a4))
* **connectors:** Phase 6 Slice 7 Wave 7b — team-shared credentials for warehouse/BI connectors ([#617](https://github.com/nimbus-agent/Nimbus/issues/617)) ([e5d1665](https://github.com/nimbus-agent/Nimbus/commit/e5d1665ef7f98203ea9f72bfe28ee2e32e602eeb))
* **connectors:** Phase 6 Slice 7 Wave 7c — HITL-gated WRITE actions for warehouse/BI connectors ([#632](https://github.com/nimbus-agent/Nimbus/issues/632)) ([822cebc](https://github.com/nimbus-agent/Nimbus/commit/822cebc39ad17cd1b6d1605f0a1296ac1d8cb68f))
* **coverage-floor:** baseline format + diff helpers ([2d909cc](https://github.com/nimbus-agent/Nimbus/commit/2d909cc68c56df5322af89c8a3f89a345b070b4c))
* **coverage-floor:** exclusion registry + matcher ([25d7ead](https://github.com/nimbus-agent/Nimbus/commit/25d7eadd035387c6cec081d5ad73a80cab69a668))
* **coverage-floor:** exclusion-parity check ([f2527ef](https://github.com/nimbus-agent/Nimbus/commit/f2527efc5e8edc2b1894c42da04293f1ae907190))
* **coverage-floor:** orchestration entry point ([1e34574](https://github.com/nimbus-agent/Nimbus/commit/1e34574adace51054c99878337148ac4ed6efd6d))
* **coverage-floor:** per-file 80% line-coverage gate (Phase 0) ([5b958d5](https://github.com/nimbus-agent/Nimbus/commit/5b958d56bb1da4b56ab6c7ba4e52581554715a8d))
* **coverage-floor:** pure lcov parser ([f78e592](https://github.com/nimbus-agent/Nimbus/commit/f78e59279fc2c9ad356925d575d70f91524be144))
* **coverage-floor:** scope walker to bun-tested packages; add build-lcov.sh ([6d0dba5](https://github.com/nimbus-agent/Nimbus/commit/6d0dba548deb6136e90e9f636db34c82e3ef81d8))
* **coverage:** branch-coverage foundation (true-coverage Sub-project A) ([#530](https://github.com/nimbus-agent/Nimbus/issues/530)) ([49768bb](https://github.com/nimbus-agent/Nimbus/commit/49768bb99eb074810602da74763b84e7e38d9b09))
* **db:** add dbStmtRun wrapper for prepared-statement writes (T6 PR 4) ([3dfd2ea](https://github.com/nimbus-agent/Nimbus/commit/3dfd2ea81c51f4ee235421f747b6783f1a134763))
* **db:** T6 PR 4 — route all writes through dbRun/dbExec/dbStmtRun (I14) ([639dd64](https://github.com/nimbus-agent/Nimbus/commit/639dd64321aea479e527d48286a2b476a96e30db))
* **db:** widen dbRun to return RunResult (T6 PR 4) ([4511a5b](https://github.com/nimbus-agent/Nimbus/commit/4511a5bd7f81d14f740192589da8d5bf992d6068))
* **diag/cli:** three-surface degraded label for sandbox posture (T2 PR 1) ([c74acbc](https://github.com/nimbus-agent/Nimbus/commit/c74acbc4d80a130069d194ab709b6f8462497262))
* **egress:** Egress Ledger & nimbus prove (S1 Local Brain — I29/D22/V44) ([#698](https://github.com/nimbus-agent/Nimbus/issues/698)) ([34fb594](https://github.com/nimbus-agent/Nimbus/commit/34fb5942fd536981f58405a8e4904529addd40a3))
* **extensions:** hard-disable pre-T2 extensions until reinstall (T2 PR 1) ([2e67dcc](https://github.com/nimbus-agent/Nimbus/commit/2e67dcce686e1c3e1320a6bcfcf225c7b8fdb724))
* **extensions:** object-form permissions schema + legacy array normalizer (T2 PR 1) ([649d573](https://github.com/nimbus-agent/Nimbus/commit/649d5736de026fcbc11cd7095e7436b05d6b6d6c))
* **gateway:** route ask through local LLM providers ([#479](https://github.com/nimbus-agent/Nimbus/issues/479)) ([b49e7ae](https://github.com/nimbus-agent/Nimbus/commit/b49e7aeb8d55d4f98e3a128f089321852d8e5efc))
* **gateway:** wire [pagerduty].max_pages_per_sync at bootstrap ([ca7d65b](https://github.com/nimbus-agent/Nimbus/commit/ca7d65bee2ee6b3b02282186fe4ecdbb592773d9))
* **gateway:** wire Updater factory in assemblePlatformServices (S6-F1) ([5fd38bd](https://github.com/nimbus-agent/Nimbus/commit/5fd38bd73005441e75b02f0a9bff01cef4f36a76))
* **invariants:** wire I14 — typed dbRun/dbExec/dbStmtRun (T6 PR 4) ([eda338e](https://github.com/nimbus-agent/Nimbus/commit/eda338ea50ccae4e66e064a97ccee35ced0eebb7))
* **ipc:** T6 PR 3 — index.reembed long-running RPC ([26c1075](https://github.com/nimbus-agent/Nimbus/commit/26c1075eac8727a6d50ff0df183e79f7a0f9245a))
* **lazy-mesh:** wrap MCP ServerSpec through sandbox-wrapper script (T2 PR 1, I15) ([95b46a0](https://github.com/nimbus-agent/Nimbus/commit/95b46a0ebebde45aa5483f70dbea4d1980533c19))
* **pagerduty:** walk all incident pages per sync ([e4a0720](https://github.com/nimbus-agent/Nimbus/commit/e4a0720d4764111bcb31873782cf18df2b35c82f))
* **pagerduty:** write metadata.urgency on indexed incidents ([596b47a](https://github.com/nimbus-agent/Nimbus/commit/596b47add2799557d93e464bcbb86e154c6b5ab1))
* **perf:** hybrid perf-CI strategy — gate stable surfaces, trend the noisy ones ([#642](https://github.com/nimbus-agent/Nimbus/issues/642)) ([abfdfbe](https://github.com/nimbus-agent/Nimbus/commit/abfdfbe8c76ec59dcd3337317bc0c3241775a2db))
* **perf:** wire up the sustained-drift detector (daily _perf-drift.yml) ([#659](https://github.com/nimbus-agent/Nimbus/issues/659)) ([e433ec7](https://github.com/nimbus-agent/Nimbus/commit/e433ec71c9651f07cb8109e848a97b4923a8d95b))
* Phase 6 Slice 1 — Federation Core ([#519](https://github.com/nimbus-agent/Nimbus/issues/519)) ([bb92960](https://github.com/nimbus-agent/Nimbus/commit/bb92960cb4e29c2290c98821d867566f0de00b03))
* Phase 6 Slice 1 — real two-gateway over-the-wire federation ([#521](https://github.com/nimbus-agent/Nimbus/issues/521)) ([8f61f16](https://github.com/nimbus-agent/Nimbus/commit/8f61f16e2a85fd2c813c61cba3c21be2907440b9))
* Phase 6 Slice 3 — Identity & Access (SSO/OIDC + SCIM) ([#523](https://github.com/nimbus-agent/Nimbus/issues/523)) ([9af95d6](https://github.com/nimbus-agent/Nimbus/commit/9af95d68ce6426984361351fad823c42120bb876))
* **preflight:** urgency-gap diagnostic probe ([80ef006](https://github.com/nimbus-agent/Nimbus/commit/80ef00637bfa36b5cc1540704618daed30c7a378))
* **preflight:** widen active-P1 filter to severity_p1_aliases ([742740d](https://github.com/nimbus-agent/Nimbus/commit/742740db5c8c560ce030a15f4c4f70bc1680cd82))
* **release-health:** loud release-asset gate + weekly secret-health monitor ([#768](https://github.com/nimbus-agent/Nimbus/issues/768)) ([2417189](https://github.com/nimbus-agent/Nimbus/commit/241718962e707e4f236b457dc8bd2ff21a255c4c))
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
* **search:** T6 PR 3 — wire dual-search through hybrid options ([4570841](https://github.com/nimbus-agent/Nimbus/commit/4570841d5b1f2607203ae8286e5c5be6fac9e3e2))
* **share:** Phase 6 Slice 8a — Share foundation (I27 share-gate, verify-share, V41) ([#661](https://github.com/nimbus-agent/Nimbus/issues/661)) ([c4f12d3](https://github.com/nimbus-agent/Nimbus/commit/c4f12d382be6e8601858605089b664f7c5604e0c))
* **share:** Phase 6 Slice 8b — recipe (--as-recipe declarative DAG, V42 params) ([#679](https://github.com/nimbus-agent/Nimbus/issues/679)) ([97573bd](https://github.com/nimbus-agent/Nimbus/commit/97573bdc2423d8687a974ccc08ad4d5f26da15df))
* **share:** Phase 6 Slice 8c — replay (verify-share --replay, recipe-runner) ([#684](https://github.com/nimbus-agent/Nimbus/issues/684)) ([8535f4d](https://github.com/nimbus-agent/Nimbus/commit/8535f4db75a68806806813131e7fb0a34327fba7))
* **share:** Phase 6 Slice 8d — sovereign-mesh referral (forwarding, provenance, V43 inbox) ([#687](https://github.com/nimbus-agent/Nimbus/issues/687)) ([18131cf](https://github.com/nimbus-agent/Nimbus/commit/18131cf9d9499614d20b10421e5c511086942618))
* **slice9-w1:** HITL-gated GitOps + ML writes (ArgoCD/Flux/MLflow), generalize I26 ([#700](https://github.com/nimbus-agent/Nimbus/issues/700)) ([bccab8b](https://github.com/nimbus-agent/Nimbus/commit/bccab8bf9e8f34fabed47afff3619bf6dc6802ff))
* **slice9:** Workday connector (read-only) — workers/time-off/job-postings + RaaS reports ([#709](https://github.com/nimbus-agent/Nimbus/issues/709)) ([2646918](https://github.com/nimbus-agent/Nimbus/commit/2646918570aaa52e1477765fe169df3433bdba25))
* tool_call_log retention policy ([audit].tool_call_log_retention_days) ([#511](https://github.com/nimbus-agent/Nimbus/issues/511)) ([83165b1](https://github.com/nimbus-agent/Nimbus/commit/83165b1764faf08ab1066abaea143a0ceba3b3b3))
* **updater:** createUpdaterFromConfig factory with disabled + unsupported-platform paths ([423fe23](https://github.com/nimbus-agent/Nimbus/commit/423fe23677615f8153ca1bd9106c4230edde7a5b))
* **updater:** S6-F1 production wiring ([a1c69b9](https://github.com/nimbus-agent/Nimbus/commit/a1c69b9e46d9fc0ec6c3a570b695b8f7ff53b06f))
* **zoom:** PR-3 cloud recordings + AI transcripts (Walk B) ([#458](https://github.com/nimbus-agent/Nimbus/issues/458)) ([21aefdd](https://github.com/nimbus-agent/Nimbus/commit/21aefdd96f8f4e6bcefa730f7f4c7d97d3ef58d8))


### Bug Fixes

* add repository field to client, sdk, and root for npm provenance ([#633](https://github.com/nimbus-agent/Nimbus/issues/633)) ([f0e7f07](https://github.com/nimbus-agent/Nimbus/commit/f0e7f075d755c8b4a006911b513979f289fa192f))
* **audit:** close credential-redaction boundary escapes + property lock (True Coverage C1) ([#596](https://github.com/nimbus-agent/Nimbus/issues/596)) ([f974c02](https://github.com/nimbus-agent/Nimbus/commit/f974c02a33b3e29ada53319c1db36643588a5188))
* **ci:** build @nimbus-dev/sdk before client in node-compat job ([#640](https://github.com/nimbus-agent/Nimbus/issues/640)) ([76b9898](https://github.com/nimbus-agent/Nimbus/commit/76b98988821e11bc279f9dea8bf6ad76d99582f6))
* **ci:** export GNUPGHOME in linux-repo publish so signing finds the key ([#605](https://github.com/nimbus-agent/Nimbus/issues/605)) ([e5f5154](https://github.com/nimbus-agent/Nimbus/commit/e5f515460d95a47e237086967e5876d22ef77525))
* **ci:** gitleaks allowlist synthetic TestFlight PEM fixture ([#670](https://github.com/nimbus-agent/Nimbus/issues/670)) ([3da4609](https://github.com/nimbus-agent/Nimbus/commit/3da460991b487b68fad2ea1febc9c32a148db807))
* **ci:** guard gateway daily-log async destination against unhandled flush errors ([#615](https://github.com/nimbus-agent/Nimbus/issues/615)) ([7a9f62c](https://github.com/nimbus-agent/Nimbus/commit/7a9f62cf733ae965e88a6614c2516990fd90de45))
* **ci:** harden Linux apt-get against flaky Microsoft repos + integration-test timeout ([#613](https://github.com/nimbus-agent/Nimbus/issues/613)) ([209fc96](https://github.com/nimbus-agent/Nimbus/commit/209fc966b8a86286f9535a8134b6238d16d1f313))
* **ci:** linux-repo publish verifies only the downloaded .deb/.rpm ([#603](https://github.com/nimbus-agent/Nimbus/issues/603)) ([4d63cad](https://github.com/nimbus-agent/Nimbus/commit/4d63cada3a55d1e3bdeb2f3c1c7e434a05457f3c))
* **ci:** publish package managers after Release uploads assets (kill the asset-race) ([#658](https://github.com/nimbus-agent/Nimbus/issues/658)) ([f5f246f](https://github.com/nimbus-agent/Nimbus/commit/f5f246fb9713a023ef8c1eaf8f09ffbac6804b80))
* **ci:** restore lint + license gates after Biome 2.5.0 / ovsx 1.0.1 bumps ([#656](https://github.com/nimbus-agent/Nimbus/issues/656)) ([76e4a88](https://github.com/nimbus-agent/Nimbus/commit/76e4a88999ddef1915b6e6c74b3c705281edf891))
* **ci:** session-memory getRecentTurns must not require sqlite-vec (share e2e I27) ([#664](https://github.com/nimbus-agent/Nimbus/issues/664)) ([0870362](https://github.com/nimbus-agent/Nimbus/commit/0870362301fecd1c6742c799ece667edf1d8f671))
* **ci:** set --timeout 60000 on the integration test step ([#610](https://github.com/nimbus-agent/Nimbus/issues/610)) ([69986c1](https://github.com/nimbus-agent/Nimbus/commit/69986c1a5eeb2b1cba00f97b3f243912d92f100f))
* **ci:** unblock cross-platform test suite + SonarCloud reliability gate ([c75dbab](https://github.com/nimbus-agent/Nimbus/commit/c75dbab037d98b9c51df38b0ea7769089c52418a))
* **ci:** unhang the Windows gateway cross-platform leg (was 30-min "cancelled") ([#591](https://github.com/nimbus-agent/Nimbus/issues/591)) ([605e46a](https://github.com/nimbus-agent/Nimbus/commit/605e46ac2a5716b7213dc4d588e623ea7729a331))
* **client:** bundle sdk via the "bun" condition so the publish build resolves ([#638](https://github.com/nimbus-agent/Nimbus/issues/638)) ([c1f36d2](https://github.com/nimbus-agent/Nimbus/commit/c1f36d2e1cee0f02430aab5f48e517a9882ccf4d))
* **client:** pin internal deps on publish so the tarball installs standalone ([#716](https://github.com/nimbus-agent/Nimbus/issues/716)) ([1ab1b5c](https://github.com/nimbus-agent/Nimbus/commit/1ab1b5c7912948394c51142519b0d2698447caf6))
* **client:** widen node-compat askStream streamId poll to STREAM_TIMEOUT_MS ([#624](https://github.com/nimbus-agent/Nimbus/issues/624)) ([e86014f](https://github.com/nimbus-agent/Nimbus/commit/e86014f3ae3b2a865a0e589eda2eb997b33ca727))
* **cli:** T6 PR 3 — drop the word "any" from index reembed help ([676cbd2](https://github.com/nimbus-agent/Nimbus/commit/676cbd219f797bfd00851b3cbaf861a1ca7a6e0c))
* **coverage-floor:** computeUpdatedBaseline seeds new below-floor entries ([2ba425a](https://github.com/nimbus-agent/Nimbus/commit/2ba425accbcc19e2ebf38938180ea027d4ed5af0))
* **coverage-floor:** drop unused [@ts-expect-error](https://github.com/ts-expect-error) in freeze test ([bc26019](https://github.com/nimbus-agent/Nimbus/commit/bc26019dfa7ded9a1de2368f887b816309ccdb45))
* **coverage-floor:** rename unused find() param to satisfy biome ([b63c40d](https://github.com/nimbus-agent/Nimbus/commit/b63c40dae65f2e664c11e38705f6958e9aa73a44))
* **coverage-floor:** Sonar new-code coverage — mirror local exemptions + lift sandbox-contract (PR [#329](https://github.com/nimbus-agent/Nimbus/issues/329)) ([51b101e](https://github.com/nimbus-agent/Nimbus/commit/51b101e0c9c20462bbd7005bb863efe546647bb6))
* **db:** enable WAL on production SQLite handles (changelog backfill for [#789](https://github.com/nimbus-agent/Nimbus/issues/789)) ([#795](https://github.com/nimbus-agent/Nimbus/issues/795)) ([88db17f](https://github.com/nimbus-agent/Nimbus/commit/88db17f708798a03a704ac37c410bb3105409364))
* **db:** T6 PR 3 — guard V30 no-vec branch against db.exec("") on macOS ([4130138](https://github.com/nimbus-agent/Nimbus/commit/4130138fedc9f06294aa88d8972ce7dcfd5fddf5))
* **deps:** clear high audit advisories (vite/protobufjs/form-data) ([#644](https://github.com/nimbus-agent/Nimbus/issues/644)) ([24169d9](https://github.com/nimbus-agent/Nimbus/commit/24169d9928b9317bd0ed19982eaad9f0b2e5e925))
* **deps:** clear the critical + high advisories blocking every PR ([#781](https://github.com/nimbus-agent/Nimbus/issues/781)) ([4d723b8](https://github.com/nimbus-agent/Nimbus/commit/4d723b80bad63d96016f5aeb379b465844f82f5e))
* **deps:** clear two high advisories blocking every PR ([#793](https://github.com/nimbus-agent/Nimbus/issues/793)) ([40007eb](https://github.com/nimbus-agent/Nimbus/commit/40007ebbfc5aa5abd06e3b3345782c72f85b18fd))
* **deps:** clear two high advisories blocking every PR (sharp, svgo) ([#796](https://github.com/nimbus-agent/Nimbus/issues/796)) ([864bb8e](https://github.com/nimbus-agent/Nimbus/commit/864bb8e0eb626725ee0c917acd7b49026f12336a))
* **extensions:** locale-aware sort in PreT2DisabledRegistry + new-code coverage push (PR [#329](https://github.com/nimbus-agent/Nimbus/issues/329)) ([afdc62e](https://github.com/nimbus-agent/Nimbus/commit/afdc62e8e8bb12d38567724a0a6393c25f8db1c6))
* **extensions:** reject trailing-hyphen + empty hostnames per RFC 1123 (T2 PR 1 code review) ([c5966b3](https://github.com/nimbus-agent/Nimbus/commit/c5966b3be793331de61c2d5cd6da060c68d3b401))
* **gateway:** report real version in `nimbus status` + stamp Windows exe metadata ([#762](https://github.com/nimbus-agent/Nimbus/issues/762)) ([d337167](https://github.com/nimbus-agent/Nimbus/commit/d337167e6e461645526525167ed6acf77396f4e2))
* **gitleaks:** rename fake API-key fixtures to defuse generic-api-key rule ([fddf720](https://github.com/nimbus-agent/Nimbus/commit/fddf7209f7064cbd8aed8b9982a27f5ad3c8363d))
* **llm:** report fallback provider in `llm status`, fix reason labels, reuse IPC helper ([#513](https://github.com/nimbus-agent/Nimbus/issues/513)) ([4bfb99a](https://github.com/nimbus-agent/Nimbus/commit/4bfb99ac019ca71f013f81ae6fb5f9e813e1c475))
* **perf:** gate S1 + S11-b latency on Linux only to stop main bench delta-flapping ([#623](https://github.com/nimbus-agent/Nimbus/issues/623)) ([52eff98](https://github.com/nimbus-agent/Nimbus/commit/52eff98bfe540d1edbb72de78db1e51487697df6))
* **perf:** gate S11-a latency on Linux only (completes the spawn-jitter set) ([#628](https://github.com/nimbus-agent/Nimbus/issues/628)) ([f107082](https://github.com/nimbus-agent/Nimbus/commit/f107082655a3f031776b7717d8509328d24111b3))
* **perf:** median baseline over recent main runs to stop bench delta-flapping ([#618](https://github.com/nimbus-agent/Nimbus/issues/618)) ([e6c34c2](https://github.com/nimbus-agent/Nimbus/commit/e6c34c2023b9e31f74d0bc1e98a9bd6aee4eef8c))
* **sandbox-helper:** freeaddrinfo leak on inet_ntop error + AUDIT_ARCH_X86_64 seccomp guard (T2 PR 1 code review) ([f8c91a2](https://github.com/nimbus-agent/Nimbus/commit/f8c91a298d84130511400c7216ea11d60d73616a))
* **sandbox-helper:** guard _GNU_SOURCE redefine to unblock -Werror build ([#346](https://github.com/nimbus-agent/Nimbus/issues/346)) ([6f0e231](https://github.com/nimbus-agent/Nimbus/commit/6f0e231ea39052fc28b28638525442f2dc11a478))
* **sandbox:** allow epoll_wait + clone3, block io_uring (T2 PR 1 code review) ([dc63c7c](https://github.com/nimbus-agent/Nimbus/commit/dc63c7c1122fbcf5640ecc1e3c9a79961bb9ea78))
* **sandbox:** AUDIT_ARCH_X86_64 guard in connector seccomp filter (T2 PR 1 review) ([20fb86c](https://github.com/nimbus-agent/Nimbus/commit/20fb86c6a4ff0bde9c00409bac69366ed71c3c8e))
* **sandbox:** match platform/index.ts dispatcher idiom — node:os + .ts extensions (T2 PR 1 code review) ([cd9886d](https://github.com/nimbus-agent/Nimbus/commit/cd9886da39224528b8a51d227aa4aa40ac8c734f))
* **sandbox:** mkdtempSync for seccomp BPF tmpfile (CodeQL js/insecure-temporary-file) ([7804539](https://github.com/nimbus-agent/Nimbus/commit/78045391701e8738fdcb180e0b398aa0eed68303))
* **sdk:** drop .ts extension on testing/index re-export (T2 PR 1 CI) ([51b218c](https://github.com/nimbus-agent/Nimbus/commit/51b218c981fec8189829fca29181c6fc0d729a30))
* **sdk:** point published entry points at dist so the package is usable ([#637](https://github.com/nimbus-agent/Nimbus/issues/637)) ([155b127](https://github.com/nimbus-agent/Nimbus/commit/155b127f9577d8f19a4e822ba5ee3714b2a5badd))
* **security:** connector nextLink SSRF + email header CR/LF injection hardening ([#694](https://github.com/nimbus-agent/Nimbus/issues/694)) ([6257da8](https://github.com/nimbus-agent/Nimbus/commit/6257da812df50705eaf62ba78d4fb20fa4693df0))
* **security:** T6 PR 3 — block index.reembed* over LAN (I5) ([4f0d6c4](https://github.com/nimbus-agent/Nimbus/commit/4f0d6c4946e058c3ab14ac4b206504a519bbdef1))
* **sonar:** clear last 2 S7735 negated-condition smells ([#683](https://github.com/nimbus-agent/Nimbus/issues/683)) ([e6cbfff](https://github.com/nimbus-agent/Nimbus/commit/e6cbfff9b4fdb173b3f650e8f1f98c494b985c43))
* **sonar:** clear the board — S3776/S8786/S7735 sweep + warehouse-mapper dedup ([#743](https://github.com/nimbus-agent/Nimbus/issues/743)) ([2401330](https://github.com/nimbus-agent/Nimbus/commit/2401330932fa941bdf584c87bca88ea69167fa0c))
* **sonar:** clear the SonarCloud board — S5906 sweep + long-tail code smells ([#731](https://github.com/nimbus-agent/Nimbus/issues/731)) ([3a87e54](https://github.com/nimbus-agent/Nimbus/commit/3a87e54a7335c1be87ecb582673183b242b97c88))
* stop relabelling 55% of indexed items, and return NimbusItem from index.queryItems ([#780](https://github.com/nimbus-agent/Nimbus/issues/780)) ([008615d](https://github.com/nimbus-agent/Nimbus/commit/008615da3ba74fec7aabf935abc57b7eabda90bb))
* **test:** add --timeout 30000 to all coverage shards (Windows flake) ([#681](https://github.com/nimbus-agent/Nimbus/issues/681)) ([93270ca](https://github.com/nimbus-agent/Nimbus/commit/93270cad4eae8c14330ca67c09947d692ecc18e8))
* **test:** remove real-resolver connector-spawns twin that reds the combined run ([#675](https://github.com/nimbus-agent/Nimbus/issues/675)) ([fde6718](https://github.com/nimbus-agent/Nimbus/commit/fde67189a6bca3e2289f522eb981d1560d5de768))
* **test:** resolve LanServer gate test flake ([#705](https://github.com/nimbus-agent/Nimbus/issues/705)) ([2e757e8](https://github.com/nimbus-agent/Nimbus/commit/2e757e8143045963ba7c78cb58bcb4806071fdd9))
* **vscode-extension:** scope tsconfig to types:[node] (fixes CI typecheck) ([#446](https://github.com/nimbus-agent/Nimbus/issues/446)) ([78484a6](https://github.com/nimbus-agent/Nimbus/commit/78484a6e67bef930040afd4cc5b69d5f153aae0c))


### Performance Improvements

* Phase 2 (Bencher) — advisory trend ingest (soak alongside github-action-benchmark) ([#666](https://github.com/nimbus-agent/Nimbus/issues/666)) ([5993765](https://github.com/nimbus-agent/Nimbus/commit/5993765bb97b1058676e7ecde34b112d4ed33c87))
* **slo:** widen S1 noise floor 200→300 ms to absorb cold-start jitter ([#608](https://github.com/nimbus-agent/Nimbus/issues/608)) ([b49c799](https://github.com/nimbus-agent/Nimbus/commit/b49c799af4e59ea93b2fff71d3eae2cb7c2e9caf))

## [0.23.2](https://github.com/nimbus-agent/Nimbus/compare/v0.23.1...v0.23.2) (2026-07-21)


### Bug Fixes

* **deps:** clear two high advisories blocking every PR ([#793](https://github.com/nimbus-agent/Nimbus/issues/793)) ([40007eb](https://github.com/nimbus-agent/Nimbus/commit/40007ebbfc5aa5abd06e3b3345782c72f85b18fd))

## [0.23.1](https://github.com/nimbus-agent/Nimbus/compare/v0.23.0...v0.23.1) (2026-07-21)


### Bug Fixes

* **deps:** clear the critical + high advisories blocking every PR ([#781](https://github.com/nimbus-agent/Nimbus/issues/781)) ([4d723b8](https://github.com/nimbus-agent/Nimbus/commit/4d723b80bad63d96016f5aeb379b465844f82f5e))
* stop relabelling 55% of indexed items, and return NimbusItem from index.queryItems ([#780](https://github.com/nimbus-agent/Nimbus/issues/780)) ([008615d](https://github.com/nimbus-agent/Nimbus/commit/008615da3ba74fec7aabf935abc57b7eabda90bb))

## [0.23.0](https://github.com/nimbus-agent/Nimbus/compare/v0.22.0...v0.23.0) (2026-07-19)


### Features

* **release-health:** loud release-asset gate + weekly secret-health monitor ([#768](https://github.com/nimbus-agent/Nimbus/issues/768)) ([2417189](https://github.com/nimbus-agent/Nimbus/commit/241718962e707e4f236b457dc8bd2ff21a255c4c))

## [0.22.0](https://github.com/nimbus-agent/Nimbus/compare/v0.21.0...v0.22.0) (2026-07-18)


### Features

* **cli:** nimbus clip list + clip delete (+ clip-scoped tags) ([#760](https://github.com/nimbus-agent/Nimbus/issues/760)) ([65e8857](https://github.com/nimbus-agent/Nimbus/commit/65e8857a27dff10ac85f9c3e63c2fd2a21628bb2))
* **cli:** print the gateway URL from `nimbus clip pair` ([#761](https://github.com/nimbus-agent/Nimbus/issues/761)) ([b72f96d](https://github.com/nimbus-agent/Nimbus/commit/b72f96dcb862f54084927d8542edce9e0e795ad7))


### Bug Fixes

* **gateway:** report real version in `nimbus status` + stamp Windows exe metadata ([#762](https://github.com/nimbus-agent/Nimbus/issues/762)) ([d337167](https://github.com/nimbus-agent/Nimbus/commit/d337167e6e461645526525167ed6acf77396f4e2))

## [0.21.0](https://github.com/nimbus-agent/Nimbus/compare/v0.20.0...v0.21.0) (2026-07-16)


### Features

* **cli:** add `nimbus --version` / `-v` / `version` ([#753](https://github.com/nimbus-agent/Nimbus/issues/753)) ([5eec16c](https://github.com/nimbus-agent/Nimbus/commit/5eec16c118e94667ddccc0ebb0e122f0bc31f136))

## [0.20.0](https://github.com/nimbus-agent/Nimbus/compare/v0.19.0...v0.20.0) (2026-07-14)


### Features

* **client:** expose egress ledger reads on NimbusClient + MockClient ([#751](https://github.com/nimbus-agent/Nimbus/issues/751)) ([31c05b2](https://github.com/nimbus-agent/Nimbus/commit/31c05b25c17b858d14980455ad8800fbfb99e875))

## [0.19.0](https://github.com/nimbus-agent/Nimbus/compare/v0.18.0...v0.19.0) (2026-06-23)


### Features

* **client:** add searchRanked to NimbusClient + MockClient ([#742](https://github.com/nimbus-agent/Nimbus/issues/742)) ([a378884](https://github.com/nimbus-agent/Nimbus/commit/a378884360c50b55f1d76bcd61492c1594327b86))


### Bug Fixes

* **sonar:** clear the board — S3776/S8786/S7735 sweep + warehouse-mapper dedup ([#743](https://github.com/nimbus-agent/Nimbus/issues/743)) ([2401330](https://github.com/nimbus-agent/Nimbus/commit/2401330932fa941bdf584c87bca88ea69167fa0c))
* **sonar:** clear the SonarCloud board — S5906 sweep + long-tail code smells ([#731](https://github.com/nimbus-agent/Nimbus/issues/731)) ([3a87e54](https://github.com/nimbus-agent/Nimbus/commit/3a87e54a7335c1be87ecb582673183b242b97c88))

## [0.18.0](https://github.com/nimbus-agent/Nimbus/compare/v0.17.0...v0.18.0) (2026-06-23)


### Features

* **clips:** web clipper gateway — POST /v1/clips, pairing auth, invariant I30 (Phase 6 Slice 9) ([#718](https://github.com/nimbus-agent/Nimbus/issues/718)) ([17d325e](https://github.com/nimbus-agent/Nimbus/commit/17d325e7a55729772623438fa4a914c762d810ea))

## [0.17.0](https://github.com/nimbus-agent/Nimbus/compare/v0.16.0...v0.17.0) (2026-06-22)


### Features

* **apple:** iCloud Mail + Calendar connector (Phase 6 Slice 9-E) ([#711](https://github.com/nimbus-agent/Nimbus/issues/711)) ([58c69e0](https://github.com/nimbus-agent/Nimbus/commit/58c69e09fba285b03b94eed60f69751103da1bf3))


### Bug Fixes

* **client:** pin internal deps on publish so the tarball installs standalone ([#716](https://github.com/nimbus-agent/Nimbus/issues/716)) ([1ab1b5c](https://github.com/nimbus-agent/Nimbus/commit/1ab1b5c7912948394c51142519b0d2698447caf6))

## [0.16.0](https://github.com/nimbus-agent/Nimbus/compare/v0.15.0...v0.16.0) (2026-06-21)


### Features

* **slice9:** Workday connector (read-only) — workers/time-off/job-postings + RaaS reports ([#709](https://github.com/nimbus-agent/Nimbus/issues/709)) ([2646918](https://github.com/nimbus-agent/Nimbus/commit/2646918570aaa52e1477765fe169df3433bdba25))

## [0.15.0](https://github.com/nimbus-agent/Nimbus/compare/v0.14.0...v0.15.0) (2026-06-21)


### Features

* **slice9-w1:** HITL-gated GitOps + ML writes (ArgoCD/Flux/MLflow), generalize I26 ([#700](https://github.com/nimbus-agent/Nimbus/issues/700)) ([bccab8b](https://github.com/nimbus-agent/Nimbus/commit/bccab8bf9e8f34fabed47afff3619bf6dc6802ff))


### Bug Fixes

* **test:** resolve LanServer gate test flake ([#705](https://github.com/nimbus-agent/Nimbus/issues/705)) ([2e757e8](https://github.com/nimbus-agent/Nimbus/commit/2e757e8143045963ba7c78cb58bcb4806071fdd9))

## [0.14.0](https://github.com/nimbus-agent/Nimbus/compare/v0.13.1...v0.14.0) (2026-06-21)


### Features

* **egress:** Egress Ledger & nimbus prove (S1 Local Brain — I29/D22/V44) ([#698](https://github.com/nimbus-agent/Nimbus/issues/698)) ([34fb594](https://github.com/nimbus-agent/Nimbus/commit/34fb5942fd536981f58405a8e4904529addd40a3))

## [0.13.1](https://github.com/nimbus-agent/Nimbus/compare/v0.13.0...v0.13.1) (2026-06-20)


### Bug Fixes

* **security:** connector nextLink SSRF + email header CR/LF injection hardening ([#694](https://github.com/nimbus-agent/Nimbus/issues/694)) ([6257da8](https://github.com/nimbus-agent/Nimbus/commit/6257da812df50705eaf62ba78d4fb20fa4693df0))

## [0.13.0](https://github.com/nimbus-agent/Nimbus/compare/v0.12.0...v0.13.0) (2026-06-18)


### Features

* **share:** Phase 6 Slice 8d — sovereign-mesh referral (forwarding, provenance, V43 inbox) ([#687](https://github.com/nimbus-agent/Nimbus/issues/687)) ([18131cf](https://github.com/nimbus-agent/Nimbus/commit/18131cf9d9499614d20b10421e5c511086942618))

## [0.12.0](https://github.com/nimbus-agent/Nimbus/compare/v0.11.2...v0.12.0) (2026-06-17)


### Features

* **share:** Phase 6 Slice 8b — recipe (--as-recipe declarative DAG, V42 params) ([#679](https://github.com/nimbus-agent/Nimbus/issues/679)) ([97573bd](https://github.com/nimbus-agent/Nimbus/commit/97573bdc2423d8687a974ccc08ad4d5f26da15df))
* **share:** Phase 6 Slice 8c — replay (verify-share --replay, recipe-runner) ([#684](https://github.com/nimbus-agent/Nimbus/issues/684)) ([8535f4d](https://github.com/nimbus-agent/Nimbus/commit/8535f4db75a68806806813131e7fb0a34327fba7))


### Bug Fixes

* **sonar:** clear last 2 S7735 negated-condition smells ([#683](https://github.com/nimbus-agent/Nimbus/issues/683)) ([e6cbfff](https://github.com/nimbus-agent/Nimbus/commit/e6cbfff9b4fdb173b3f650e8f1f98c494b985c43))
* **test:** add --timeout 30000 to all coverage shards (Windows flake) ([#681](https://github.com/nimbus-agent/Nimbus/issues/681)) ([93270ca](https://github.com/nimbus-agent/Nimbus/commit/93270cad4eae8c14330ca67c09947d692ecc18e8))

## [0.11.2](https://github.com/nimbus-agent/Nimbus/compare/v0.11.1...v0.11.2) (2026-06-17)


### Bug Fixes

* **test:** remove real-resolver connector-spawns twin that reds the combined run ([#675](https://github.com/nimbus-agent/Nimbus/issues/675)) ([fde6718](https://github.com/nimbus-agent/Nimbus/commit/fde67189a6bca3e2289f522eb981d1560d5de768))

## [0.11.1](https://github.com/nimbus-agent/Nimbus/compare/v0.11.0...v0.11.1) (2026-06-17)


### Bug Fixes

* **ci:** gitleaks allowlist synthetic TestFlight PEM fixture ([#670](https://github.com/nimbus-agent/Nimbus/issues/670)) ([3da4609](https://github.com/nimbus-agent/Nimbus/commit/3da460991b487b68fad2ea1febc9c32a148db807))

## [0.11.0](https://github.com/nimbus-agent/Nimbus/compare/v0.10.0...v0.11.0) (2026-06-16)


### Features

* **share:** Phase 6 Slice 8a — Share foundation (I27 share-gate, verify-share, V41) ([#661](https://github.com/nimbus-agent/Nimbus/issues/661)) ([c4f12d3](https://github.com/nimbus-agent/Nimbus/commit/c4f12d382be6e8601858605089b664f7c5604e0c))


### Bug Fixes

* **ci:** session-memory getRecentTurns must not require sqlite-vec (share e2e I27) ([#664](https://github.com/nimbus-agent/Nimbus/issues/664)) ([0870362](https://github.com/nimbus-agent/Nimbus/commit/0870362301fecd1c6742c799ece667edf1d8f671))


### Performance Improvements

* Phase 2 (Bencher) — advisory trend ingest (soak alongside github-action-benchmark) ([#666](https://github.com/nimbus-agent/Nimbus/issues/666)) ([5993765](https://github.com/nimbus-agent/Nimbus/commit/5993765bb97b1058676e7ecde34b112d4ed33c87))

## [0.10.0](https://github.com/nimbus-agent/Nimbus/compare/v0.9.1...v0.10.0) (2026-06-16)


### Features

* **perf:** wire up the sustained-drift detector (daily _perf-drift.yml) ([#659](https://github.com/nimbus-agent/Nimbus/issues/659)) ([e433ec7](https://github.com/nimbus-agent/Nimbus/commit/e433ec71c9651f07cb8109e848a97b4923a8d95b))


### Bug Fixes

* **ci:** publish package managers after Release uploads assets (kill the asset-race) ([#658](https://github.com/nimbus-agent/Nimbus/issues/658)) ([f5f246f](https://github.com/nimbus-agent/Nimbus/commit/f5f246fb9713a023ef8c1eaf8f09ffbac6804b80))

## [0.9.1](https://github.com/nimbus-agent/Nimbus/compare/v0.9.0...v0.9.1) (2026-06-16)


### Bug Fixes

* **ci:** restore lint + license gates after Biome 2.5.0 / ovsx 1.0.1 bumps ([#656](https://github.com/nimbus-agent/Nimbus/issues/656)) ([76e4a88](https://github.com/nimbus-agent/Nimbus/commit/76e4a88999ddef1915b6e6c74b3c705281edf891))

## [0.9.0](https://github.com/nimbus-agent/Nimbus/compare/v0.8.0...v0.9.0) (2026-06-15)


### Features

* **perf:** hybrid perf-CI strategy — gate stable surfaces, trend the noisy ones ([#642](https://github.com/nimbus-agent/Nimbus/issues/642)) ([abfdfbe](https://github.com/nimbus-agent/Nimbus/commit/abfdfbe8c76ec59dcd3337317bc0c3241775a2db))


### Bug Fixes

* **deps:** clear high audit advisories (vite/protobufjs/form-data) ([#644](https://github.com/nimbus-agent/Nimbus/issues/644)) ([24169d9](https://github.com/nimbus-agent/Nimbus/commit/24169d9928b9317bd0ed19982eaad9f0b2e5e925))

## [0.8.0](https://github.com/nimbus-agent/Nimbus/compare/v0.7.0...v0.8.0) (2026-06-15)


### Features

* **connectors:** Mendeley connector (Phase 6 Slice 9 — sub-project A) ([#631](https://github.com/nimbus-agent/Nimbus/issues/631)) ([1ddeae5](https://github.com/nimbus-agent/Nimbus/commit/1ddeae52ca6301d5992a915250a9189b4c61f3a4))
* **connectors:** Phase 6 Slice 7 Wave 7c — HITL-gated WRITE actions for warehouse/BI connectors ([#632](https://github.com/nimbus-agent/Nimbus/issues/632)) ([822cebc](https://github.com/nimbus-agent/Nimbus/commit/822cebc39ad17cd1b6d1605f0a1296ac1d8cb68f))


### Bug Fixes

* add repository field to client, sdk, and root for npm provenance ([#633](https://github.com/nimbus-agent/Nimbus/issues/633)) ([f0e7f07](https://github.com/nimbus-agent/Nimbus/commit/f0e7f075d755c8b4a006911b513979f289fa192f))
* **ci:** build @nimbus-dev/sdk before client in node-compat job ([#640](https://github.com/nimbus-agent/Nimbus/issues/640)) ([76b9898](https://github.com/nimbus-agent/Nimbus/commit/76b98988821e11bc279f9dea8bf6ad76d99582f6))
* **client:** bundle sdk via the "bun" condition so the publish build resolves ([#638](https://github.com/nimbus-agent/Nimbus/issues/638)) ([c1f36d2](https://github.com/nimbus-agent/Nimbus/commit/c1f36d2e1cee0f02430aab5f48e517a9882ccf4d))
* **perf:** gate S11-a latency on Linux only (completes the spawn-jitter set) ([#628](https://github.com/nimbus-agent/Nimbus/issues/628)) ([f107082](https://github.com/nimbus-agent/Nimbus/commit/f107082655a3f031776b7717d8509328d24111b3))
* **sdk:** point published entry points at dist so the package is usable ([#637](https://github.com/nimbus-agent/Nimbus/issues/637)) ([155b127](https://github.com/nimbus-agent/Nimbus/commit/155b127f9577d8f19a4e822ba5ee3714b2a5badd))

## [0.7.0](https://github.com/nimbus-agent/Nimbus/compare/v0.6.3...v0.7.0) (2026-06-14)


### Features

* **connectors:** Phase 6 Slice 7 Wave 7b — team-shared credentials for warehouse/BI connectors ([#617](https://github.com/nimbus-agent/Nimbus/issues/617)) ([e5d1665](https://github.com/nimbus-agent/Nimbus/commit/e5d1665ef7f98203ea9f72bfe28ee2e32e602eeb))


### Bug Fixes

* **perf:** median baseline over recent main runs to stop bench delta-flapping ([#618](https://github.com/nimbus-agent/Nimbus/issues/618)) ([e6c34c2](https://github.com/nimbus-agent/Nimbus/commit/e6c34c2023b9e31f74d0bc1e98a9bd6aee4eef8c))

## [0.6.3](https://github.com/nimbus-agent/Nimbus/compare/v0.6.2...v0.6.3) (2026-06-14)


### Bug Fixes

* **ci:** guard gateway daily-log async destination against unhandled flush errors ([#615](https://github.com/nimbus-agent/Nimbus/issues/615)) ([7a9f62c](https://github.com/nimbus-agent/Nimbus/commit/7a9f62cf733ae965e88a6614c2516990fd90de45))
* **ci:** harden Linux apt-get against flaky Microsoft repos + integration-test timeout ([#613](https://github.com/nimbus-agent/Nimbus/issues/613)) ([209fc96](https://github.com/nimbus-agent/Nimbus/commit/209fc966b8a86286f9535a8134b6238d16d1f313))
* **ci:** set --timeout 60000 on the integration test step ([#610](https://github.com/nimbus-agent/Nimbus/issues/610)) ([69986c1](https://github.com/nimbus-agent/Nimbus/commit/69986c1a5eeb2b1cba00f97b3f243912d92f100f))


### Performance Improvements

* **slo:** widen S1 noise floor 200→300 ms to absorb cold-start jitter ([#608](https://github.com/nimbus-agent/Nimbus/issues/608)) ([b49c799](https://github.com/nimbus-agent/Nimbus/commit/b49c799af4e59ea93b2fff71d3eae2cb7c2e9caf))

## [0.6.2](https://github.com/nimbus-agent/Nimbus/compare/v0.6.1...v0.6.2) (2026-06-14)


### Bug Fixes

* **ci:** export GNUPGHOME in linux-repo publish so signing finds the key ([#605](https://github.com/nimbus-agent/Nimbus/issues/605)) ([e5f5154](https://github.com/nimbus-agent/Nimbus/commit/e5f515460d95a47e237086967e5876d22ef77525))
* **ci:** linux-repo publish verifies only the downloaded .deb/.rpm ([#603](https://github.com/nimbus-agent/Nimbus/issues/603)) ([4d63cad](https://github.com/nimbus-agent/Nimbus/commit/4d63cada3a55d1e3bdeb2f3c1c7e434a05457f3c))

## [0.6.1](https://github.com/nimbus-agent/Nimbus/compare/v0.6.0...v0.6.1) (2026-06-13)


### Bug Fixes

* **audit:** close credential-redaction boundary escapes + property lock (True Coverage C1) ([#596](https://github.com/nimbus-agent/Nimbus/issues/596)) ([f974c02](https://github.com/nimbus-agent/Nimbus/commit/f974c02a33b3e29ada53319c1db36643588a5188))
* **ci:** unhang the Windows gateway cross-platform leg (was 30-min "cancelled") ([#591](https://github.com/nimbus-agent/Nimbus/issues/591)) ([605e46a](https://github.com/nimbus-agent/Nimbus/commit/605e46ac2a5716b7213dc4d588e623ea7729a331))

## [0.6.0](https://github.com/nimbus-agent/Nimbus/compare/v0.5.0...v0.6.0) (2026-06-11)


### Features

* **coverage:** branch-coverage foundation (true-coverage Sub-project A) ([#530](https://github.com/nimbus-agent/Nimbus/issues/530)) ([49768bb](https://github.com/nimbus-agent/Nimbus/commit/49768bb99eb074810602da74763b84e7e38d9b09))
* Phase 6 Slice 1 — Federation Core ([#519](https://github.com/nimbus-agent/Nimbus/issues/519)) ([bb92960](https://github.com/nimbus-agent/Nimbus/commit/bb92960cb4e29c2290c98821d867566f0de00b03))
* Phase 6 Slice 1 — real two-gateway over-the-wire federation ([#521](https://github.com/nimbus-agent/Nimbus/issues/521)) ([8f61f16](https://github.com/nimbus-agent/Nimbus/commit/8f61f16e2a85fd2c813c61cba3c21be2907440b9))
* Phase 6 Slice 3 — Identity & Access (SSO/OIDC + SCIM) ([#523](https://github.com/nimbus-agent/Nimbus/issues/523)) ([9af95d6](https://github.com/nimbus-agent/Nimbus/commit/9af95d68ce6426984361351fad823c42120bb876))

## [0.5.0](https://github.com/nimbus-agent/Nimbus/compare/v0.4.0...v0.5.0) (2026-06-04)


### Features

* **auth+connectors:** OAuth provider registry (PR-1) + Tier-1 connector batch + Zoom planning ([#447](https://github.com/nimbus-agent/Nimbus/issues/447)) ([9d71a62](https://github.com/nimbus-agent/Nimbus/commit/9d71a62fa5058475b8482469e82b76b8eb05615c))
* **cli:** nimbus mcp-server — expose local index to editor AIs over MCP ([#480](https://github.com/nimbus-agent/Nimbus/issues/480)) ([003e32d](https://github.com/nimbus-agent/Nimbus/commit/003e32dd0c85ba6224acb27d0fc5f5c2e73e013c))
* **gateway:** route ask through local LLM providers ([#479](https://github.com/nimbus-agent/Nimbus/issues/479)) ([b49e7ae](https://github.com/nimbus-agent/Nimbus/commit/b49e7aeb8d55d4f98e3a128f089321852d8e5efc))
* tool_call_log retention policy ([audit].tool_call_log_retention_days) ([#511](https://github.com/nimbus-agent/Nimbus/issues/511)) ([83165b1](https://github.com/nimbus-agent/Nimbus/commit/83165b1764faf08ab1066abaea143a0ceba3b3b3))
* **zoom:** PR-3 cloud recordings + AI transcripts (Walk B) ([#458](https://github.com/nimbus-agent/Nimbus/issues/458)) ([21aefdd](https://github.com/nimbus-agent/Nimbus/commit/21aefdd96f8f4e6bcefa730f7f4c7d97d3ef58d8))


### Bug Fixes

* **llm:** report fallback provider in `llm status`, fix reason labels, reuse IPC helper ([#513](https://github.com/nimbus-agent/Nimbus/issues/513)) ([4bfb99a](https://github.com/nimbus-agent/Nimbus/commit/4bfb99ac019ca71f013f81ae6fb5f9e813e1c475))
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
