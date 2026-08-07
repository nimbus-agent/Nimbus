export type ExclusionPattern =
  | { kind: "exact"; path: string }
  | { kind: "dirPrefix"; prefix: string }
  | { kind: "basenameRegex"; re: RegExp }
  | { kind: "pathRegex"; re: RegExp };

export const EXCLUSIONS: readonly ExclusionPattern[] = Object.freeze([
  // ── FFI (Vault) — DPAPI / Keychain / libsecret native bindings ──
  { kind: "exact", path: "packages/gateway/src/vault/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/ffi-ptr.ts" },

  // ── Platform-gated — OS-specific; a single CI-Linux runner takes one branch per OS ──
  // The rationale is literal: each file below reaches a foreign OS's syscalls/binaries (bwrap,
  // sandbox-exec, AppContainer FFI, `security`/`secret-tool`) or a non-node realm, so the Linux
  // gate can only ever execute one arm. It is NOT a blanket "the filename names an OS" exemption —
  // `platform/linux.ts` (the ACTIVE, covered arm on a Linux runner) and `sandbox/{win32,
  // orphan-reap}.ts` (pure string/array helpers plus a fail-closed stub — no FFI, no OS call)
  // were retired from this block on 2026-08-01 and are gated normally.
  { kind: "exact", path: "packages/gateway/src/platform/win32.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/browser.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/linux.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/darwin.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-runner.ts" },

  // ── Boot orchestrators / index barrels / factories / process entry points ──
  // `index.ts` is now a thin argv shim that dynamically imports one of three role modules; the
  // boot orchestrator it used to contain moved to `gateway-main.ts`. Both are the same
  // process-entry class this block exempts — the exemption follows the code, it is not a new one.
  { kind: "exact", path: "packages/gateway/src/index.ts" },
  { kind: "exact", path: "packages/gateway/src/gateway-main.ts" },
  { kind: "exact", path: "packages/cli/src/index.ts" },
  // `assemble.ts` is the boot-assembly I/O orchestrator (opens SQLite, spawns sidecars,
  // wires every runtime together) — same untestable shell class as `gateway/src/index.ts`
  // and `ipc/server/options.ts`. The new federation glue block is inert by default
  // (federation.enabled = false); testing it requires a full subprocess boot.
  { kind: "exact", path: "packages/gateway/src/platform/assemble.ts" },
  // `assemble-sync-registrations.ts` is boot glue: ~89 hardcoded `syncScheduler.register(...)`
  // calls whose line coverage depends on which connectors the integration/boot tests happen to
  // spawn — it flakes ±0.6% between identical runs, which a one-directional ratchet can't absorb.
  // Same I/O/boot-glue exemption class as assemble.ts.
  { kind: "exact", path: "packages/gateway/src/platform/assemble-sync-registrations.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/index.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/index.ts" },
  { kind: "exact", path: "packages/gateway/src/platform/sandbox/sandbox-wrapper.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/index.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/factory.ts" },

  // ── mock.module-shadowed (real logic tested via the gateway-process.ts twin) ──
  // `gateway-process.ts` is imported by 40+ CLI modules and is `mock.module`'d process-global in
  // their tests, so it can't be un-excluded without ripping mock.module out of 40+ files. Its real
  // logic is covered via the byte-identical `gw-state-helpers.ts` twin (which IS tested).
  { kind: "exact", path: "packages/cli/src/lib/gateway-process.ts" },

  // ── Cross-task test harness ──
  // `brief-test-server.ts` is test-only but not .test.ts-suffixed, so it isn't auto-skipped;
  // imported by brief tests rather than redefined. Defensive branches (TOCTOU, stop() errors) can't
  // meet the production floor.
  { kind: "exact", path: "packages/gateway/src/briefs/brief-test-server.ts" },
  // `agent-test-server.ts` is the same shape and excluded for the same reason: test-only, not
  // .test.ts-suffixed, imported by the agents e2e suite rather than redefined, and its defensive
  // branches (the three swallowing try/catch blocks in stop()) cannot meet the production floor.
  { kind: "exact", path: "packages/gateway/src/agent-runs/agent-test-server.ts" },
  // `http-api-test-server.ts` is the third harness of this shape — same reason.
  { kind: "exact", path: "packages/gateway/src/ipc/http-api-test-server.ts" },

  // ── Generated SQL ── (retired 2026-08-01)
  // The `index/*-v<N>-sql.ts` migration constants are single exported template literals that the
  // migration runner imports unconditionally, so every one of them is executed by the migration
  // tests: all 43 read 100% line / 100% branch. The exemption protected nothing and only cost a
  // regression guard on the one thing that CAN break here — a new `-v<N>-sql.ts` landing that no
  // migration ever imports (dead SQL) now fails the gate as `missing_from_lcov` instead of
  // shipping silently. Deliberately NOT re-added; add a test, not an exemption.

  // ── Connect-shell regexes (MCP connector server/tools, github-actions main) ──
  { kind: "pathRegex", re: /^packages\/github-actions\/[^/]+\/src\/main\.ts$/ },
  { kind: "pathRegex", re: /^packages\/mcp-connectors\/[^/]+\/src\/server\.ts$/ },
  // Each MCP connector's `src/tools.ts` is the same connect-shell class as its
  // `server.ts`: thin `reg(name, desc, schema, handler)` registrations whose
  // handlers shell out to a CLI (`Bun.spawn`) or `fetch` a remote API. The
  // testable logic (no-row-data stripping, arg guards, response mapping) lives in
  // shared helpers / sibling modules that ARE covered; the I/O shell is exempt,
  // exactly like server.ts.
  { kind: "pathRegex", re: /^packages\/mcp-connectors\/[^/]+\/src\/tools\.ts$/ },

  // ── Benchmarks / native ──
  // These two mirror the ONLY perf patterns Sonar carries (`**/perf/surfaces/**`,
  // `**/perf/fixtures/synthetic-*-trace.ts`): the `nimbus bench` surface drivers run only behind
  // the interactive protocol confirmation in a WS5 reference run, and the seeded synthetic trace
  // generators are fixture data, not logic.
  { kind: "dirPrefix", prefix: "packages/gateway/src/perf/surfaces/" },
  { kind: "pathRegex", re: /^packages\/gateway\/src\/perf\/fixtures\/synthetic-[^/]+-trace\.ts$/ },
  // Narrowed 2026-08-01. The old blanket `packages/gateway/src/perf/` dirPrefix was strictly
  // broader than the two Sonar patterns above and hid 21 modules from the gate. Seven pure
  // analysis modules — baseline-median, bencher-bmf, pr-comment-formatter, process-spawn-bench,
  // slo-thresholds, threshold-comparator, worker-bench — already clear 85/80 and have REJOINED the
  // floor at zero test-writing cost. The bench drivers, samplers and fixture helpers below still
  // carry real debt (they spawn gateways/CLIs and sample RSS, so the unit layer reaches only part
  // of them). They stay exempt ONE FILE AT A TIME rather than behind a directory, so the debt is
  // visible and each entry is individually retirable: delete the entry the moment its file clears
  // both floors on the CI-Linux lcov. Trailing comments are the last measured line/branch pct.
  { kind: "exact", path: "packages/gateway/src/perf/bench-ci-gh.ts" }, // 89.83 / 73.58
  { kind: "exact", path: "packages/gateway/src/perf/bench-ci.ts" }, // 95.12 / 74.07
  { kind: "exact", path: "packages/gateway/src/perf/bench-cli.ts" }, // 76.64 / 82.47
  { kind: "exact", path: "packages/gateway/src/perf/bench-harness.ts" }, // 95.74 / 75.00
  { kind: "exact", path: "packages/gateway/src/perf/bench-runner.ts" }, // 90.00 / 70.59
  { kind: "exact", path: "packages/gateway/src/perf/derive-latest-json.ts" }, // 62.50 / 54.17
  { kind: "exact", path: "packages/gateway/src/perf/gateway-spawn-bench.ts" }, // 98.59 / 78.57
  { kind: "exact", path: "packages/gateway/src/perf/history-line.ts" }, // 75.00 / 50.00
  { kind: "exact", path: "packages/gateway/src/perf/percentiles.ts" }, // 94.12 / 75.00
  { kind: "exact", path: "packages/gateway/src/perf/perf-fixture.ts" }, // 93.94 / 57.14
  { kind: "exact", path: "packages/gateway/src/perf/rss-sampler.ts" }, // 85.71 / 72.73
  { kind: "exact", path: "packages/gateway/src/perf/signal-handler.ts" }, // 66.67 / 100.00
  { kind: "exact", path: "packages/gateway/src/perf/fixtures/msw-handlers.ts" }, // 80.00 / 35.71
  { kind: "exact", path: "packages/gateway/src/perf/fixtures/synthetic-text.ts" }, // 100.00 / 75.00
  { kind: "dirPrefix", prefix: "packages/gateway/src-native/" },

  // ── Editor / desktop / admin UIs — DOM + VS Code/Electron host APIs, no in-process seam ──
  // The VS Code extension (activation lifecycle, webview message bridge, status-bar, HITL router)
  // and the admin-console renderer run against editor/Electron host APIs and a DOM that the
  // in-process bun:test layer cannot drive — same untestable-UI-shell class as `cli/src/commands/
  // tui.tsx`. Their pure helpers live in sibling modules that ARE covered.
  { kind: "dirPrefix", prefix: "packages/admin-console/src/" },

  // ── Build / release entry scripts (top-level await; run by `bun run`, not importable cleanly) ──
  { kind: "exact", path: "packages/gateway/compile-gateway.ts" },
  { kind: "exact", path: "packages/gateway/terminate-gateway-binary.ts" },

  // ── UI / React-Ink entry ──
  { kind: "exact", path: "packages/cli/src/commands/tui.tsx" },

  // ── CLI IPC shells (cores covered; residual runX = IPCClient + process.exit) ──
  // `start.ts`: the testable pure helpers (`decideStartAction`, `wantsNoWizard`) are exported +
  // unit-tested by `start.test.ts`; the residual is irreducible subprocess/socket/timer boot glue
  // (`spawnGateway`, the IPC ready-poll race, the TTY onboarding loop) with no injection seam —
  // same untestable I/O-shell class as a connector `server.ts`. (`decideStartAction` is also
  // currently dead — inlined by `handleExistingGatewayState`; a surgical fast-follow can remove it.)
  { kind: "exact", path: "packages/cli/src/commands/start.ts" },
  // `policy.ts` / `admin.ts` (Phase 6 Slice 4): the testable cores (parsePolicyArgs/
  // parseAdminArgs + runPolicyCommand/runAdminCommand, injected `client`) are covered by
  // policy.test.ts / admin.test.ts; the residual uncovered lines are the runPolicy/runAdmin
  // wrappers — CLI IPC shells that construct a real `IPCClient` + `process.exit`, no seam.
  // Same exemption class as team.ts.
  { kind: "exact", path: "packages/cli/src/commands/policy.ts" },
  { kind: "exact", path: "packages/cli/src/commands/admin.ts" },
  // `chatops.ts` (Phase 6 Slice 5): the testable cores (parseChatopsArgs + runChatopsCommand
  // with an injected `client`) are covered by chatops.test.ts; the residual uncovered lines are
  // the runChatops wrapper — a CLI IPC shell that reads gateway state, constructs a real
  // `IPCClient`, and calls `process.exit`, with no injection seam. Same exemption class as team.ts.
  { kind: "exact", path: "packages/cli/src/commands/chatops.ts" },
  { kind: "exact", path: "packages/cli/src/commands/repl.ts" },
  { kind: "exact", path: "packages/cli/src/commands/doctor.ts" },
  // `share.ts` was in this block until 2026-08-01. Its stated rationale ("no injection seam") was
  // false — policy/admin/chatops/tribal all already exported an `XIpc` interface plus a
  // `runXCommand(client, cmd)` dispatcher, and share.ts simply had never been given one. It now
  // follows that precedent (`ShareIpc` / `parseShareArgs` / `runShareCommand`) and is gated
  // normally. Read that as a warning about the four entries still in this block: "CLI IPC shell"
  // is only a valid exemption when the seam genuinely cannot exist, not when nobody built it.
  // `tribal.ts`: CLI IPC-shell class. The testable core (`parseTribalArgs` +
  // `runTribalCommand(client, …)`) is injected-client and covered by `tribal.test.ts`; the residual
  // uncovered lines are the `runTribal` dispatch wrapper — it reads gateway state, constructs a
  // real `IPCClient`, and calls `process.exit`, with no injection seam. Excluded at the line floor
  // (85) raise, same precedent as the siblings. (`telemetry.ts` shared this entry until
  // 2026-08-01; its uncovered `sub === "disable"` dispatch arm turned out to be reachable through
  // the platform-paths env seam, so it is gated normally now and this comment covers tribal only.)
  { kind: "exact", path: "packages/cli/src/commands/tribal.ts" },

  // ── Env-gated production-imported mock ── (retired 2026-08-01)
  // `chatops/chatops-tool-runner-e2e-sink.ts` was exempted here as a "genuinely-untestable
  // env-gated shell". It is not: `NIMBUS_CHATOPS_E2E_SINK_DIR` IS the injection seam, the module is
  // plain node:fs/node:path, and the e2e drives it to 100% line / 96% branch. The exemption
  // protected nothing while removing the regression guard from a module production boot
  // (`platform/assemble.ts`) statically imports. Gated normally now.

  // ── Real-subprocess shell (no meaningful seam) ──
  {
    kind: "exact",
    path: "packages/gateway/src/embedding/load-feature-extraction-pipeline.ts",
  },

  // ── Bun Workers (separate realm) ──
  // Bun Workers run in a separate realm the Istanbul `[test].preload` plugin cannot reach (parity
  // with Bun's native --coverage, which also misses workers). §5.3 probe (D3, 2026-06-14): a
  // worker-side preload re-register + __coverage__ flush was attempted; it WORKED mechanically (a
  // worker-spawned via Bun's `preload:` option re-registered the babel-plugin-istanbul Bun loader
  // inside the worker realm, produced a valid istanbul map with real branchMap/branch-hits, and
  // merged cleanly back into the main realm's globalThis.__coverage__ for report-coverage.ts). It
  // was NOT durably wired: doing so would thread a test-only `preload:` injection seam plus a
  // coverage-message merge protocol through the two PRODUCTION worker spawn sites
  // (db/query-guard.ts, embedding/worker-bridge.ts) and each worker's onmessage contract —
  // invasive cross-realm scaffolding in production I/O shells, and a divergence from Bun-native
  // --coverage parity, for no real gain. The meaningful orchestration was extracted to the
  // unit-tested `embedding/embedding-worker-core.ts` (NOT excluded), leaving:
  //   - `embedding-worker.ts`: a thin wiring shell (constructs real deps, routes origin-validated msgs).
  //   - `query-guard-worker.ts`: a genuinely-thin onmessage (security check lives in worker-security.ts;
  //     opens a readonly DB, runs the SQL, posts back) — nothing to extract.
  { kind: "exact", path: "packages/gateway/src/db/query-guard-worker.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-worker.ts" },

  // ── Type-only / zero-executable-line modules ──────────────────────────────────────────────────
  // The exact-path entries below emit NO `SF:` lcov record (no executable statements) → the gate
  // reads them as 0% and they can NEVER rejoin the floor. There is nothing to test. Each carries a
  // guardian header forbidding runtime logic. No rename (avoids import churn across every consumer
  // for marginal gain).
  //
  // The two basename regexes are a WEAKER claim and were documented wrongly until 2026-08-01. They
  // matched on FILENAME, and the old comment asserted every match was zero-executable "with a
  // guardian header forbidding runtime logic". That was false: most `*/types.ts` under the gateway
  // are genuinely declaration-only, but `identity/types.ts` carries six runtime declarations over
  // 23 executable lines (`form`, `asRecord`, `str`, `num`, `parseTokenResponse`,
  // `parseDeviceAuthResponse` — the last two are the I18-adjacent OIDC token/device-auth response
  // parsers) and `sync/types.ts` carries four over 20 (`retryAfterDateFromHeader`, `RateLimitError`,
  // `UnauthenticatedError`, `syncNoopResult`). Both already clear 85/80, so the cost was a lost
  // regression guard on a security-adjacent parser, not current debt. They are carved out via
  // NEVER_EXEMPT below and gated normally. The regexes stay for the declaration-only majority, but
  // read them as "matched by name, not verified" — a new `types.ts` that grows runtime logic must
  // be added to NEVER_EXEMPT, not left to inherit an exemption it does not deserve.
  { kind: "basenameRegex", re: /^types\.ts$/ },
  { kind: "basenameRegex", re: /-types\.ts$/ },
  { kind: "exact", path: "packages/gateway/src/index/ranked-item.ts" },
  { kind: "exact", path: "packages/gateway/src/embedding/embedding-runtime.ts" },
  { kind: "exact", path: "packages/gateway/src/vault/nimbus-vault.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/agent-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/workflow-invoke.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/mapped-row.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/connector-rpc-handlers/context.ts" },
  { kind: "exact", path: "packages/gateway/src/connectors/lazy-mesh/slot.ts" },
  // Generated by scripts/gen-bundled-connector-registry.ts: 94 lazy `() => import(...)` thunks and
  // no logic. Executing one starts a real MCP server on stdio, so unit tests cannot call them; the
  // all-connector boot smoke (scripts/connector-boot-smoke.ts) covers every entry instead.
  { kind: "exact", path: "packages/gateway/src/connectors/bundled-connector-registry.ts" },
  { kind: "exact", path: "packages/gateway/src/chatops/transport/transport.ts" },
  { kind: "exact", path: "packages/gateway/src/ipc/server/options.ts" },
  // `ipc/server/server.ts`: the JSON-RPC server's socket-listener / connection-lifecycle / error
  // shell (its 645-line `server.test.ts` already drives the dispatch + handler logic to ~83% line;
  // the residual uncovered lines are unix-socket `listen`/`close` callbacks and connection-error
  // handlers with no in-process seam). Same untestable-socket-shell class as `socket-listeners.ts`.
  // Held below the line floor (85) raise; not relaxed for the branch floor (80, which it clears).
  { kind: "exact", path: "packages/gateway/src/ipc/server/server.ts" },
  // `glossary/near-miss.ts`: 7 uncovered branches are all the RHS of `??` fallbacks that
  // `noUncheckedIndexedAccess` (tsconfig.base.json) FORCES us to write but that cannot execute —
  // `w[0]` inside a `.split()` map, the mandatory capture groups `m[1]`/`m[2]` of a matched regex,
  // and `row[j-1]`/`prev[j]`/`prev[j-1]`/`prev[b.length]` inside loops whose bounds guarantee the
  // index. Deleting them would not compile. Verified three ways during the glossary slice
  // (2026-07-30): lcov BRDA zero-hit records, empirical regex probing, and raw istanbul
  // `branchMap` counts — all agreeing. TS-strict-unreachable class, not a testing gap; its line
  // coverage clears the floor comfortably.
  { kind: "exact", path: "packages/gateway/src/glossary/near-miss.ts" },
  // ──────────────────────────────────────────────────────────────────────────────────────────────
]);

/**
 * A `Set` whose mutators throw. `Object.freeze(new Set(...))` does NOT make a Set immutable — its
 * contents live in internal slots rather than own properties, so `add`/`delete`/`clear` keep
 * working on a frozen Set and `ReadonlySet<T>` is a compile-time promise only. Overriding the three
 * mutators makes the guarantee real while leaving every read path (`has`, iteration, `size`, and
 * the set-algebra methods) genuine `Set` behaviour.
 *
 * The constructor populates through `Set.prototype.add` directly: `new Set(iterable)` dispatches to
 * `this.add`, which here would throw before a single entry landed.
 */
class ImmutableSet<T> extends Set<T> {
  constructor(values: Iterable<T>) {
    super();
    for (const v of values) Set.prototype.add.call(this, v);
  }
  override add(_value: T): never {
    throw new TypeError("NEVER_EXEMPT is immutable: add() is not supported");
  }
  override delete(_value: T): never {
    throw new TypeError("NEVER_EXEMPT is immutable: delete() is not supported");
  }
  override clear(): never {
    throw new TypeError("NEVER_EXEMPT is immutable: clear() is not supported");
  }
}

/**
 * Carve-outs: files that a BROAD pattern in `EXCLUSIONS` would otherwise swallow, but which carry
 * real runtime logic and must stay gated. Checked BEFORE the pattern list, so a name-shaped
 * exemption (the `types.ts` / `-types.ts` basename regexes) can never silently claim them.
 *
 * Only add a path here — never widen it into a pattern. The point is that each entry is a file
 * somebody read and confirmed has executable logic; a regex would defeat that.
 */
const NEVER_EXEMPT_PATHS: readonly string[] = [
  // Six runtime declarations / 23 executable lines, incl. the OIDC `parseTokenResponse` and
  // `parseDeviceAuthResponse` wire parsers that feed the I18 token verifier.
  "packages/gateway/src/identity/types.ts",
  // Four runtime declarations / 20 executable lines: `retryAfterDateFromHeader` (Retry-After
  // header parsing), `RateLimitError`, `UnauthenticatedError`, `syncNoopResult`.
  "packages/gateway/src/sync/types.ts",
];

/**
 * The carve-out list, immutable at runtime as well as in the type system: a caller who casts this
 * back to `Set<string>` gets a `TypeError` instead of silently editing the list and flipping
 * `isExempt` results for a file somebody deliberately kept gated.
 */
export const NEVER_EXEMPT: ReadonlySet<string> = Object.freeze(
  new ImmutableSet<string>(NEVER_EXEMPT_PATHS),
);

export function isExempt(relPath: string): boolean {
  const normalized = relPath.replaceAll("\\", "/");
  if (NEVER_EXEMPT.has(normalized)) return false;
  const basename = normalized.split("/").pop() ?? "";
  for (const pattern of EXCLUSIONS) {
    switch (pattern.kind) {
      case "exact":
        if (normalized === pattern.path) return true;
        break;
      case "dirPrefix":
        if (normalized.startsWith(pattern.prefix)) return true;
        break;
      case "basenameRegex":
        if (pattern.re.test(basename)) return true;
        break;
      case "pathRegex":
        if (pattern.re.test(normalized)) return true;
        break;
    }
  }
  return false;
}
