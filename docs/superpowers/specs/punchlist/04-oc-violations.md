# Punch list — section 4: Open/closed violations (3+ literals)

Total clusters: 61

| File | Line | Kind | Discriminator | Literals |
|---|---|---|---|---|
| `packages/gateway/src/ipc/diagnostics-rpc.ts` | 506 | switch | `method` | 20 (config.validate, telemetry.disableMark, db.verify, db.repair, db.snapshot.take, db.snapshots.list…) |
| `packages/cli/src/commands/deploy-annotate.ts` | 111 | switch | `a` | 12 (--service, --sha, --target-ref, --env, --status, --started-at…) |
| `packages/gateway/src/ipc/connector-rpc.ts` | 60 | switch | `method` | 12 (connector.addMcp, connector.listStatus, connector.pause, connector.resume, connector.setConfig, connector.setInterval…) |
| `packages/cli/src/commands/connector.ts` | 1150 | switch | `sub` | 11 (auth, add, list, history, pause, resume…) |
| `packages/cli/src/tui/state.ts` | 46 | switch | `action.type` | 11 (submit, stream-token, stream-done, stream-error, hitl-requested, hitl-advance…) |
| `packages/vscode-extension/src/chat/webview/main.ts` | 94 | switch | `msg.type` | 10 (reset, hydrate, userMessage, token, subTask, hitlInline…) |
| `packages/gateway/src/config/nimbus-toml.ts` | 226 | switch | `key` | 9 (prefer_local, remote_model, classifier_model, local_model, llamacpp_server_path, min_reasoning_params…) |
| `packages/gateway/src/connectors/connector-catalog.ts` | 227 | switch | `serviceId` | 9 (google_drive, gmail, google_photos, onedrive, outlook, teams…) |
| `packages/cli/src/commands/connector.ts` | 259 | switch | `normalized` | 8 (google_drive, gmail, google_photos, onedrive, outlook, teams…) |
| `packages/gateway/src/engine/gateway-agent-error.ts` | 46 | switch | `init.reason` | 8 (no_api_key, invalid_api_key, insufficient_quota, rate_limited, model_not_found, provider_error…) |
| `packages/gateway/src/ipc/llm-rpc.ts` | 115 | switch | `method` | 8 (llm.listModels, llm.getStatus, llm.pullModel, llm.cancelPull, llm.loadModel, llm.unloadModel…) |
| `packages/gateway/src/ipc/server/server.ts` | 168 | switch | `method` | 8 (gateway.ping, index.searchRanked, agent.invoke, consent.respond, audit.list, engine.askStream…) |
| `packages/gateway/src/people/prune.ts` | 10 | switch | `serviceId` | 8 (github, gitlab, slack, linear, jira, notion…) |
| `packages/cli/src/commands/lan.ts` | 14 | switch | `sub` | 7 (status, open, close, peers, grant, revoke…) |
| `packages/cli/src/commands/lan.ts` | 109 | switch | `sub.kind` | 7 (status, open, close, peers, grant, revoke…) |
| `packages/gateway/src/config/nimbus-toml.ts` | 111 | switch | `key` | 7 (enabled, provider, model, chunk_tokens, chunk_overlap_tokens, backfill_batch_size…) |
| `packages/gateway/src/config/nimbus-toml.ts` | 361 | switch | `key` | 7 (enabled, whisper_path, whisper_model, wake_word_whisper_model, wake_word, piper_path…) |
| `packages/gateway/src/connectors/health.ts` | 73 | switch | `event.type` | 7 (sync_success, rate_limited, unauthenticated, transient_error, persistent_error, paused…) |
| `packages/gateway/src/connectors/health.ts` | 205 | switch | `event.type` | 7 (sync_success, rate_limited, unauthenticated, transient_error, persistent_error, paused…) |
| `packages/gateway/src/ipc/server/dispatchers.ts` | 428 | switch | `method` | 7 (lan.openPairingWindow, lan.closePairingWindow, lan.listPeers, lan.grantWrite, lan.revokeWrite, lan.removePeer…) |
| `packages/cli/src/lib/parse-since.ts` | 15 | switch | `unit` | 6 (w, d, h, m, s, ms) |
| `packages/gateway/src/config/nimbus-toml.ts` | 548 | switch | `key` | 6 (enabled, port, bind, pairing_window_seconds, max_failed_attempts, lockout_seconds) |
| `packages/gateway/src/ipc/people-rpc.ts` | 163 | switch | `method` | 6 (people.get, people.list, people.unlinked, people.search, people.items, people.merge) |
| `packages/gateway/src/perf/pr-comment-formatter.ts` | 15 | switch | `metric` | 6 (p95_ms, p50_ms, throughput_per_sec, rss_bytes_p95, tokens_per_sec, first_token_ms) |
| `packages/gateway/src/perf/threshold-comparator.ts` | 48 | switch | `metric` | 6 (p95_ms, p50_ms, throughput_per_sec, rss_bytes_p95, tokens_per_sec, first_token_ms) |
| `packages/gateway/src/config/filesystem-toml.ts` | 83 | switch | `key` | 5 (path, git_aware, code_index, dependency_graph, exclude) |
| `packages/gateway/src/ipc/connector-rpc-handlers/auth.ts` | 527 | switch | `profile.provider` | 5 (google, microsoft, slack, notion, zoom) |
| `packages/gateway/src/ipc/voice-rpc.ts` | 37 | switch | `method` | 5 (voice.getStatus, voice.transcribe, voice.speak, voice.startWakeWord, voice.stopWakeWord) |
| `packages/gateway/src/metrics/dora-config.ts` | 98 | switch | `provider` | 5 (github, gitlab, bitbucket, jenkins, circleci) |
| `packages/gateway/src/metrics/dora.ts` | 92 | switch | `urn.provider` | 5 (github, bitbucket, gitlab, jenkins, circleci) |
| `packages/gateway/src/perf/pr-comment-formatter.ts` | 49 | switch | `c.status.kind` | 5 (pass, absolute-fail, delta-fail, no-baseline, skipped) |
| `packages/ui/src/components/dashboard/ConnectorTile.tsx` | 11 | switch | `h` | 5 (healthy, degraded, rate_limited, error, unauthenticated) |
| `packages/ui/src/components/updater/UpdaterRestartChrome.tsx` | 67 | switch | `n.method` | 5 (updater.updateAvailable, updater.downloadProgress, updater.restarting, updater.rolledBack, updater.verifyFailed) |
| `packages/ui/src/pages/settings/ConnectorsPanel.tsx` | 33 | switch | `h` | 5 (healthy, degraded, rate_limited, unauthenticated, error) |
| `scripts/coverage-floor/check.ts` | 153 | switch | `v.kind` | 5 (below_floor, missing_from_lcov, regression, must_raise, must_remove) |
| `packages/cli/src/commands/doctor-core.ts` | 342 | if | `key` | 4 (enabled, whisper_path, piper_path, piper_model) |
| `packages/cli/src/commands/vault.ts` | 73 | switch | `sub` | 4 (set, get, delete, list) |
| `packages/cli/src/lib/parse-duration.ts` | 15 | switch | `unit` | 4 (ms, s, m, h) |
| `packages/gateway/src/config/nimbus-toml.ts` | 448 | switch | `key` | 4 (enabled, url, check_on_startup, auto_apply) |
| `packages/gateway/src/index/item-list-query.ts` | 61 | switch | `unit` | 4 (d, h, m, s) |
| `packages/gateway/src/ipc/profile-rpc.ts` | 22 | switch | `method` | 4 (profile.list, profile.create, profile.switch, profile.delete) |
| `packages/gateway/src/ipc/server/vault-dispatch.ts` | 55 | switch | `method` | 4 (vault.set, vault.get, vault.delete, vault.listKeys) |
| `packages/gateway/src/ipc/session-rpc.ts` | 34 | switch | `method` | 4 (session.append, session.recall, session.list, session.clear) |
| `packages/gateway/src/ipc/updater-rpc.ts` | 27 | switch | `method` | 4 (updater.getStatus, updater.checkNow, updater.applyUpdate, updater.rollback) |
| `scripts/coverage-floor/exclusions.ts` | 208 | switch | `pattern.kind` | 4 (exact, dirPrefix, basenameRegex, pathRegex) |
| `scripts/regen-slo.ts` | 64 | switch | `t.noiseFloorAbsUnit` | 4 (ms, items_per_sec, bytes, tps) |
| `packages/cli/src/commands/data.ts` | 11 | switch | `sub` | 3 (export, import, delete) |
| `packages/cli/src/commands/update.ts` | 17 | switch | `arg` | 3 (--check, --yes, -y) |
| `packages/gateway/src/connectors/openapi-indexer-config.ts` | 72 | if | `key` | 3 (max_walk_depth, max_spec_bytes, ignore_globs) |
| `packages/gateway/src/connectors/openapi-indexer-sync.ts` | 220 | if | `parsed.reason` | 3 (too_large, parse_failed, not_a_spec) |
| `packages/gateway/src/perf/worker-bench.ts` | 91 | if | `msg.kind` | 3 (ready, done, error) |
| `packages/gateway/src/platform/gateway-log-file.ts` | 221 | switch | `p` | 3 (win32, darwin, linux) |
| `packages/gateway/src/platform/index.ts` | 16 | switch | `p` | 3 (win32, darwin, linux) |
| `packages/gateway/src/platform/sandbox/sandbox-runner.ts` | 31 | switch | `p` | 3 (linux, darwin, win32) |
| `packages/gateway/src/vault/factory.ts` | 13 | switch | `p` | 3 (win32, darwin, linux) |
| `packages/gateway/src/voice/tts.ts` | 8 | switch | `platform` | 3 (darwin, win32, linux) |
| `packages/github-actions/annotate-action/src/main.ts` | 281 | if | `result.status` | 3 (auth_failed, rate_limited, surface_disabled) |
| `packages/ui/src/components/chrome/ProfileHealthPill.tsx` | 9 | switch | `h` | 3 (normal, amber, red) |
| `packages/ui/src/components/dashboard/AuditFeed.tsx` | 13 | switch | `o` | 3 (approved, rejected, not_required) |
| `packages/ui/src/pages/settings/connectors/interval-parts.ts` | 20 | switch | `parts.unit` | 3 (sec, min, hr) |
| `scripts/structure-audit/count-any-usage.ts` | 29 | if | `a` | 3 (--check, --update, --baseline) |

## Triage rule

- Discriminator is `service` / `provider` / `connector` / `type` / `kind` → strong registry candidate.
- Discriminator is a tagged-union state field (`status`, `state`) → leave as switch; that's idiomatic.
- Discriminator is a config flag (`mode`, `level`) → registry only if open to extension; otherwise keep.
