# Connector extraction (Project A) — design

**Status:** design, approved to write. No files move until a plan exists and is approved.
**Predecessor:** [Project B](./2026-08-23-standalone-connector-hardening-design.md), shipped in
`v2.15.0` / `v2.16.0`. Its §12 costed A and deferred it; this document supersedes that section.

---

## 1. What this is for

Three goals, all of them in scope. They are listed in the order they constrain the design, not in
order of importance:

1. **Third-party distribution** — someone with no Nimbus gateway installs a connector from npm and
   uses it in their own MCP client.
2. **Contributor velocity** — a connector author works in one repo, without the monorepo's five
   path-resolving gates and 209 connector test files.
3. **Monorepo hygiene** — the gateway repo gets smaller and faster to navigate.

**Goal 2 is only partly delivered, and that is now a deliberate choice.** This design originally
took the **fat move** — relocating the per-service sync and mapping code too — precisely so that
"add a connector" would stop being majority-gateway work. §11's pre-registered condition then fired
against it (see §4a), and the boundary is now **thin**. Adding a connector still touches both
repos.

## 2. Decisions already taken

| Decision | Choice | Consequence |
| --- | --- | --- |
| **Destination repo** | **`nimbus-agent/nimbus-mcp-servers`** — no new repo | It already exists for exactly this and has been an empty scaffold since 2026-06-18. See §2a. |
| Package granularity | **One package**, `@nimbus-dev/connectors`, with a launcher | One version, one release, one changelog. `shared/` never crosses a package boundary, which deletes §12's largest objection outright. |
| Repo boundary | **Thin** — only the MCP tool surface moves | Reversed from fat on the evidence in §4a. Sync/mapping stay in the gateway, so `SyncContext` stays an INTERNAL interface rather than a published contract. |
| Entry point | `npx @nimbus-dev/connectors <connector-id>` | Single discoverable command. |

## 2a. The destination already exists — and this design nearly missed it

An earlier draft of this section said "its own repo" and named none, because it was written without
checking the organisation first. That was a real gap: **`nimbus-agent/nimbus-mcp-servers`** was
created on 2026-06-18 for precisely this purpose — *"Standalone MCP servers from Nimbus connectors,
usable by any MCP client"* — and has sat empty ever since. Creating `nimbus-connectors` alongside it
would have left two repos with one purpose and no way to tell which was real.

The organisation has **20 repos, six of them scaffolds from that same 2026-06-18 batch**
(`nimbus-mcp-servers`, `nimbus-connector-registry`, `nimbus-statuspage`, `nimbus-raycast`,
`nimbus-recipes`, `nimbus-benchmarks`), none built. Project A is not "add a repo"; it is **filling
in one that already exists**. The other five deserve a build-or-archive decision on their own
schedule — `nimbus-connector-registry` in particular overlaps the S3 marketplace row and may be a
real destination rather than dead weight.

**That scaffold's README is stale in a way that misleads.** It still says *"Status: SCAFFOLD — not
yet built"* and lists "the decision to make first" — share-vs-vendor-vs-fork, the credential model
outside the Vault, and the AGPL implications for downstream clients. All three were answered by
Project B and shipped in #1318 / #1321: the connectors are consent-gated standalone, credentials
come from the environment, and `mcp-connectors/NOTICE` states the security tiering. Its "candidate
first connectors: github, linear" is overtaken too — all 94 are standalone-eligible. Refreshing it
is part of this work, not a follow-up, because a reader today is told the project is blocked on
questions that are closed.

**One packaging conflict, resolved deliberately rather than quietly.** That README proposes
`npx @nimbus/mcp-github` — a package per connector. This design chooses ONE package. The scaffold is
the older statement of intent, so the override is recorded here rather than left implicit: 94
packages means 94 releases and 94 changelogs, and it forces `shared/` to become a versioned
dependency that 166 files currently import by relative path. The discovery argument that motivated
per-connector packages is also weaker than it looks — see the discovery note below.

**Discovery note.** A single package is weaker on npm search than 94 packages would be. That
matters less than it appears: MCP servers are discovered through the **MCP Registry**, where this
project is already listed as `io.github.nimbus-agent/nimbus`, not through npm keyword search.

## 3. Naming — settled, and not casually

`nimbus-mcp` on npm **belongs to an unrelated third party** (`h4cd0c3`, v1.6.0, an AWS
security-assessment MCP server). The standalone README instructed users to `npx nimbus-mcp`, which
executed that stranger's code; fixed in #1323. Separately, our own `@nimbus-dev/mcp` already ships
a **bin** named `nimbus-mcp` that launches the gateway's MCP server — a different program.

Therefore:

- Package: **`@nimbus-dev/connectors`** (verified available 2026-08-24).
- Bin: **`nimbus-connector`** — never `nimbus-mcp`, which is taken twice over.
- **Rule:** `npm view <name>` before any name is written into a document or a `package.json`. Both
  the package namespace and the **bin** namespace must be checked; the bin collision here was ours.

The 94 per-connector names (`nimbus-mcp-<service>`) are all still free but are **not** claimed by
this design — a single package needs none of them. They currently lack `private: true`, which is a
loaded gun; §9 disarms it.

## 4. What moves, and what does not

## 4a. Why the boundary reversed from fat to thin

§11 of the first draft pre-registered the condition that would make the fat move wrong:

> If step 3 shows `SyncContext` needs more than roughly a dozen members, the sync code is more
> entangled with the gateway than the census suggests, and the thin move becomes correct.

**It needs 19.** Plan 1 shipped (#1333) and the final count is in `sync/sync-capabilities.ts`.
Six of the nineteen serve only one or two connectors each — `prEnrichCandidates` and
`itemMetadata` are GitHub-only, `listIndexedMetadataValues` serves CircleCI, GitHub Actions and
GitLab, `writeObsidianVault` and `writeApiEndpointsForSpec` serve one connector apiece.

Under the fat move those nineteen become a **published SDK contract**: third parties depend on
them, we version them, and every future capability is a breaking-change decision made in public.
Under the thin move they stay internal and free to change. That is the whole difference, and it is
not a small one for an interface that grew from five to nineteen inside a single plan.

**The narrowing was not wasted work, and this reversal does not diminish it.** Plan 1's value was
never the extraction — it was that `ctx.vault` went from 83 users to zero, so a connector can no
longer read another connector's credentials. That shipped, it is enforced by static rule D24, and
it stands whether or not a single file ever moves repositories.

**What this costs:** goal 2. A connector author still edits `<service>-sync.ts` and
`<service>-mapping.ts` in the gateway repo. The honest framing is that the extraction delivers
third-party distribution and monorepo hygiene, and improves contributor velocity only for the MCP
tool surface.

## 4b. What moves

**Moves to `nimbus-agent/nimbus-mcp-servers`:**

- `packages/mcp-connectors/**` — 188 source files, 209 test files, plus `shared/` and `standalone/`.
  That is the whole move. Nothing under `packages/gateway/src/` relocates.

**Stays in the gateway, deliberately:**

- **`packages/gateway/src/connectors/<service>-sync.ts` and `<service>-mapping.ts`** — the
  per-service sync intelligence, roughly 351 files. Under the fat boundary these moved; under thin
  they do not, which is what keeps `SyncContext` an internal interface. §4a.
- Every security-invariant enforcement site — unchanged by the reversal, and worth naming because
  they are what a reader will check first:
  - `index/item-store.ts` — `upsertIndexedItemForSync`, the **V48/V49** body-depth chokepoint.
  - `db/write.ts` — **I14**.
  - `egress/sync-egress.ts` — **I29**'s per-run sync appender.
  - `extensions/spawn-env.ts` — **I1** child-process env scoping.
  - `vault/*` — non-negotiable #3; credentials never leave the gateway.
- The connector registry, secrets manifest, catalog, credential probe and spawner.

## 5. The narrowing design — the heart of this document

> **Corrected 2026-08-24 after review.** The first draft of this section proposed *inventing* a
> `SyncContext` and inverting the dependency. That was wrong in its central claim, and the error is
> worth recording because it would have mis-sized the whole migration: **a `SyncContext` already
> exists** (`sync/types.ts`), every `*-sync.ts` already takes it, and it already carries
> `vault: NimbusVault` and `db: Database` outright. The draft measured *static imports* and so
> missed every capability flowing through that object — undercounting vault users as 1 when it is
> **83**, and raw-db users as 3 when it is **20**.
>
> The work is therefore **narrowing an existing context**, not inverting a dependency. That is
> structurally far safer than the draft described — no call site changes shape — and larger in
> volume. Both corrections matter; neither changes the decision.

`SyncContext` today grants: `vault`, `db`, `logger`, `rateLimiter`, `sandboxCwd`, `credentialFor`,
`runTeamList` (the I19 gate-routed team drain), `resolveServiceId`, `depth` (the V48/V49 index
depth, enforced centrally in `upsertIndexedItemForSync`), `historyFloorMs` and
`scheduleItemEmbedding`. Two of those are the problem: `vault` and `db` are raw handles, so a sync
file can reach any secret and any table.

The static import surface, for completeness — accurate, but not the whole coupling:

| Imported by `*-sync.ts` | Count | Disposition |
| --- | ---: | --- |
| `sync/types.ts` | 97 | **types only** → moves into `@nimbus-dev/sdk` |
| `index/item-store.ts` | 67 | **65 are `upsertIndexedItemForSync`** → injected |
| `sync/pass-cursor-sync-result.ts` | 12 | pure helper → moves |
| `people/linker.ts` | 11 | injected |
| `extensions/spawn-env.ts` | 6 | injected (I1) |
| `config/filesystem-toml.ts` | 4 | types + injected reader |
| `auth/google-access-token.ts` | 4 | injected (vault-backed) |
| `auth/microsoft-access-token.ts` | 3 | injected (vault-backed) |
| `db/write.ts`, `vault/nimbus-vault.ts` | 3 files total | see §6 |
| string helpers | ~7 | pure → move |

**So: do not move the chokepoints, and do not hand out raw handles. Replace `vault` and `db` with
scoped capabilities.** The connector repo declares the interface; the gateway implements it.

```ts
// @nimbus-dev/sdk — declared in nimbus-mcp-servers, implemented by the gateway
export interface SyncContext {
  // --- unchanged, already safe to expose ---
  logger: Logger;
  rateLimiter: ProviderRateLimiter;
  sandboxCwd: string;
  depth: "metadata_only" | "summary" | "full";
  historyFloorMs?: number;
  credentialFor(service: string): { credential: "personal" | "team"; teamEntry?: string };
  runTeamList(req: { entry: string; service: string; listToolId: string }): Promise<unknown[]>;

  // --- REPLACES `vault` (83 files) ---
  /**
   * Scoped to the CALLING service by the gateway, which prefixes the key: the jira syncable's
   * `getSecret("api_token")` resolves `jira.api_token` and cannot name `slack.token`. The service
   * id is supplied by the gateway from the registry, never by the caller — a caller-supplied
   * service id would make this a vault handle with extra steps.
   */
  getSecret(keyName: string): Promise<string | null>;

  // --- REPLACES `db` (20 files) ---
  /** V48/V49 body-depth chokepoint. The gateway's own upsertIndexedItemForSync. */
  upsertItem(item: IndexedItem, opts?: UpsertOptions): Promise<void>;
  /** SYNCHRONOUS and returns the id — callers set it as `authorId` on the item they build. */
  resolvePerson(hints: PersonSyncHints): string | null;
  /** Local-only structured indexes; SQL and schema stay gateway-side. See §6. */
  upsertObsidianNote(note: ObsidianNoteInput): Promise<void>;
  upsertApiEndpoint(endpoint: ApiEndpointInput): Promise<void>;
}

export interface Syncable {
  connectorId: string;
  syncInterval: number;
  sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult>;
}
```

**`getSecret` scoping is the load-bearing detail.** Today any syncable holding `ctx.vault` can read
any connector's credentials; afterwards the jira syncable can reach exactly `jira.*`. That is a
genuine tightening of non-negotiable #3, delivered as a side effect of the extraction rather than
despite it.

Why this is the right shape, and not merely the convenient one:

- **Every invariant site keeps its current home and its current test.** The I29 sync-egress
  appender still wraps the call in `sync/scheduler.ts`; V48/V49 still live in `item-store.ts`. No
  `docs/SECURITY-INVARIANTS.md` row changes, and no static rule (`D10`–`D23`) needs relaxing.
- **A capability the gateway does not pass cannot be reached.** Today a sync file can import
  anything in the gateway; afterwards it can reach exactly what `SyncContext` grants. The fat move
  makes the connector surface *narrower*, not wider — which is the opposite of the usual outcome
  and is the strongest argument for doing it this way.
- It is the pattern the codebase already prefers: dependency injection over `mock.module`, which
  CLAUDE.md mandates for exactly this class of problem.

## 6. The `ctx.db` users — 20 files, not three

The first draft named three files, from a static-import count. The real figure is **20 files using
`ctx.db`**. Most are expected to collapse into `upsertItem` and `resolvePerson`; the ones that will
not are the custom-table writers, and those get named methods rather than a raw handle:

- **`obsidian-sync.ts`** — writes `obsidian_notes` and `obsidian_links`.
- **`openapi-indexer-sync.ts`** — writes `api_endpoint`.

Both are `LOCAL_ONLY_SYNC_SERVICES` under I29, so they make no outbound request. Their direct DB
access is nonetheless the least constrained thing in this migration, which is why they get
`upsertObsidianNote` / `upsertApiEndpoint` and the SQL stays gateway-side.

**A raw-SQL escape hatch on the context is rejected.** It was considered — a scoped
`runQuery(sql, params)` would be less work than enumerating structured methods — but it defeats the
narrowing entirely: I9 (bound-param SQL, `escapeIdentifier`) and I14 (`dbRun`/`dbExec`) are
enforced by *what the gateway will execute*, and an arbitrary-SQL method hands that judgement to a
package outside the repo. The point of this exercise is that the connector cannot express an
operation the gateway has not sanctioned.

**No file moves until each of the 20 has a named disposition** — `upsertItem`, `resolvePerson`, a
structured method, or an explicit new one. Migrating by pattern-match is how an invariant gets
quietly relocated.

## 6b. Standalone mode is a different program, and the SDK must say so

A third party running `npx @nimbus-dev/connectors github` gets the **MCP tool server**, not the sync
loop. Those two halves have entirely separate credential paths and must never be confused:

| | Sync engine | MCP tool server |
| --- | --- | --- |
| Runs | inside the gateway only | standalone, or spawned by the gateway |
| Credentials | `ctx.getSecret()`, Vault-backed | `process.env` (e.g. `GITHUB_PAT`) |
| Consent | I2, in the executor | MCP elicitation, client-mediated |

The SDK types must make the sync half unreachable outside the gateway — a `Syncable` with no
gateway-supplied `SyncContext` simply cannot be invoked, which is the property to preserve. A
third-party developer must not be able to configure or start a sync loop off-gateway, and the
package README must say so rather than leaving it to be inferred from a type error.

## 7. The gates, the tests, and the 84 references

From §12 of the predecessor spec, re-verified where cheap:

- **~90 files** reference the `mcp-connectors` path from outside `packages/mcp-connectors/` itself,
  spread across `scripts/`, `docs/`, `packages/gateway/`, plus `biome.json`, `knip.json`,
  `.github/labeler.yml` and two workflows. The predecessor spec said 84; a re-count on 2026-08-24
  over `*.ts`/`*.json`/`*.md`/`*.yml` gave 90. The figures are close enough that the conclusion is
  unchanged and far enough apart that **the migration must derive this list mechanically rather
  than work from either number** — whichever is right, "84 references" is not a checklist.
- **Five** path-resolving gates: `gen:connector-registry`, `audit:connector-entrypoints`,
  `audit:connector-deps`, `audit:connector-registry-drift`, `test:connector-boot`.
- `scripts/ci/cross-platform-parity.test.ts` asserts `packages/mcp-connectors` appears in the
  `bun test` path list of **both** `ci.yml` and `_test-suite.yml`. That assertion must move or be
  rewritten, and it is load-bearing — see CLAUDE.md on why those two lists must stay equal.
- `audit:connector-consent` (added #1318, wired into CI #1321) moves with the connectors.
- **`test:connector-boot` is the one that matters most.** It proves the compiled binary can start a
  connector. `bun build --compile` embeds bare-specifier dynamic imports, so importing connectors
  from `@nimbus-dev/connectors` is viable — but this gate is the proof, and it must be green in the
  gateway repo against the *published* package before the monorepo copy is deleted.

## 8. Release choreography

One package, so the sequence is short — but it is a two-repo sequence and that is new:

1. Connector repo releases `@nimbus-dev/connectors@X`.
2. Gateway bumps its dependency to `X`, and `test:connector-boot` proves the compiled binary starts
   a connector from the published package.
3. Gateway releases.

**Version skew is the known failure mode**, not a hypothetical: `@nimbus-dev/sdk` is pinned at four
different floors inside this one repo today — gateway `^1.18.0`, root `^1.16.0`, cli `^1.11.1`,
connectors `^1.8.1` (×94) — against a registry at 1.20.0.

**`audit:connector-version-skew`** — a named, required gate, authored **before** the migration
rather than after the first incident:

- Compares the `@nimbus-dev/connectors` version pinned in `packages/gateway/package.json` against
  the latest published version on the registry.
- Fails CI on a **major or minor** gap; a patch gap warns. A minor gap means the gateway is missing
  a connector capability that has already shipped, which is the state that produces "why is this
  connector missing tools" reports.
- Added to `scripts/lib/preflight-gates.ts` **and** to a workflow in the same commit — #1318 added
  `audit:connector-consent` to the manifest and to no workflow, so it ran nowhere and the PR passed
  because the gate never executed. `preflight-gates.test.ts` now guards that class; this gate must
  satisfy it.
- Wired before step 5 of §9, so the move happens with skew detection already live.

## 9. Sequencing

Each step ends green and independently reviewable. No step both moves files and changes behaviour.

1. **Disarm** — `private: true` on all 94 connector packages. Nothing publishes them today; this
   removes the possibility that anything ever does by accident. Standalone, trivially reviewable.
2. **Define** — land `SyncContext` and `Syncable` in `@nimbus-dev/sdk`, unused. Types only.
3. **Narrow, in place** — remove `vault` and `db` from `SyncContext` and replace them with
   `getSecret`, `upsertItem`, `resolvePerson` and the two structured writers, **while every file
   still lives in the gateway with its existing tests running against it**. 83 files lose
   `ctx.vault`; 20 lose `ctx.db`. Call sites do not change shape — they already take `ctx` — so
   this is mechanical per file and reviewable in batches by capability rather than by connector.
   The §6 dispositions are settled here. **This step is independently valuable**: it tightens
   non-negotiable #3 whether or not the extraction ever happens, which makes it the right thing to
   land first even if A stalls.
4. **Prove the seam** — `test:connector-boot` against a locally-packed tarball of the new package,
   before any repo exists.
5. **Move** — populate `nimbus-mcp-servers` (it exists, empty), move files, rewrite the path references and five gates.
6. **Consume** — gateway depends on the published package; delete the monorepo copy **last**, only
   once step 4's gate is green against the published artifact.

Step 3 is where this design can fail, and it is deliberately placed before anything is unreachable
by the existing test suite.

## 10. Open questions

1. **Does the fat move include connector-owned mapping tests?** 209 test files move; the sync tests
   currently exercise gateway internals directly and will need a fake context. Narrowing the context
   first (§9 step 3) makes that fake far smaller — a fake `getSecret` is a map lookup, a fake
   `vault` is not — which is a second reason step 3 precedes the move.
2. **What does the gateway do when the published package is missing or a version behind?** Fail
   startup, or degrade to no connectors? Fail-closed is consistent with the rest of the codebase.
3. **Does the standalone launcher stay in this package** or become its own entry point? It is
   `@nimbus-dev/mcp-connector` and private as of #1323, pending this answer.
4. **The Claude Desktop bridge question.** If tools registered in Claude Desktop are proxied through
   `bridge.claudeusercontent.com`, third-party distribution to that client conflicts with
   non-negotiable #1. Unresolved; it does not block this design, but it bounds goal 1's value and
   should be settled before the package is promoted anywhere.
5. **Does `credentialFor` / `runTeamList` survive narrowing unchanged?** `runTeamList` is the I19
   gate-routed team drain and is already a scoped method rather than a handle, so it looks safe —
   but it is the one remaining context member that reaches a *credential* path, and it should be
   re-read against I19 during step 3 rather than assumed.

## 11. What would make this the wrong call

Recorded so the decision can be revisited on evidence rather than sentiment:

- ~~If step 3 shows `SyncContext` needs more than roughly a dozen members … the thin move becomes
  correct.~~ **FIRED.** It needed 19; the boundary reversed to thin. Recorded in §4a. Worth noting
  that this is the pre-registered condition working as intended: it was written before the count was
  knowable and it changed the decision when the evidence arrived, rather than being explained away.
- If the two-repo release sequence produces skew incidents in its first quarter despite the §8 gate,
  the single-repo property was worth more than contributor velocity — which the thin boundary now
  only partly delivers anyway, making the single-repo option cheaper to fall back to.
