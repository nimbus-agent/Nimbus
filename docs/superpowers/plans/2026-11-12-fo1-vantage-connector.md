# FO1 — Vantage connector (nimbus-mcp-servers) — implementation plan

Status: DRAFT plan for review. Spec: `docs/superpowers/specs/2026-11-12-finops-connectors.md` (APPROVED,
round 2), slice FO1 (§ 5.2, § 5.3 "Tools", "Vault keys", "Sandbox"). Plans never land on main: strip this
file before any implementation PR.
Target repo: `C:\gitrep\nimbus-mcp-servers` (read-only for the planner; the implementer works on a branch
there). Nothing in the Nimbus gateway changes in FO1.

## 0. What the planner read, and what it could not

Every file and line below was read from `origin/main` of the connectors repo at `0e3609c`
(`package.json` and `.release-please-manifest.json` both 0.13.0), re-read after review round 1. An earlier
draft of this plan was written against a clone 19 commits behind (0.11.0, 94 connectors) and had every
count one too low; those are corrected here. Line numbers may drift by a few; every citation names a
symbol so it can be re-found. T0 re-derives the facts that can drift again. The spec's slice table counts
from 94 (FO1 to 95, FO3 to 97, FO5a to 98, FO6a to 99); on current main the real sequence is
FO1 to 96, FO3 to 98, FO5a to 99, FO6a to 100, and the spec should say so when it is next touched.

Layout facts used (all `origin/main`):

- A connector is `connectors/<id>/{README.md, nimbus.extension.json, package.json, tsconfig.json,
  src/server.ts, src/tools.ts, test/…}` (`docs/adding-a-connector.md:5-18`). Reference connector: `dbt`
  (`connectors/dbt/src/tools.ts:1-14` builds `createJsonGetter({ base, label, headers:
  envAuthHeaders({ env, scheme }) })`; `connectors/dbt/src/server.ts` is the 4-line bootstrap).
- Cursor-paged list tools use `cursorListInputSchema()` (`shared/cursor-list-tool.ts:24`) and return
  `{ items, nextCursor }` (reference: `connectors/monte-carlo/src/server.ts:142-151`).
- `createJsonGetter` (`shared/env-json-api.ts:194`) throws `"<label> <status>: <400-char body snippet>"`
  and follows only same-origin redirects through `guardedFetch` (`shared/guarded-fetch.ts`); it takes a
  `fetch` seam in `JsonApiConfig` (`shared/env-json-api.ts:125`). `requiredEnv` (`:56`) throws
  `"<NAME> is not set"`; `optionalEnv` (`:65`) never throws.
- Search tools: `searchToolInputSchema` (`shared/mcp-search-tool.ts:16`), `matchesResult` (`:30`),
  `makeQueryFilter` + `fieldsFromKeys` (`shared/search-filter.ts:176`, `:137`).
- Test harness: `captureTools`, `stubFetch`, `withEnv` (`scripts/connector-tool-harness.ts:252`, `:434`,
  `:660`); reference test `connectors/dbt/test/tools.test.ts`; sandbox test is the 8-line
  `connectors/dbt/test/sandbox.test.ts` (skipped unless `NIMBUS_TEST_HARNESS`).
- Generic gates every new connector enters automatically: `scripts/connector-tool-contract.test.ts` (a
  tool with a missing credential must refuse BEFORE sending, naming the variable with "is not set" or
  "must be set"; every request must be https and carry the credential value; arguments come from
  `scripts/tool-arg-fixture.ts`), `scripts/connector-boot.test.ts` (boots `server.ts` over stubbed stdio;
  a bootstrap that reads env at start needs a `bootEnv` entry, ours does not),
  `scripts/exports-map.test.ts`, `scripts/connector-gates.test.ts`.
- Release: release-please, `release-please-config.json` (`release-type: node`, `bump-minor-pre-major:
  true`), `.release-please-manifest.json`; `.github/workflows/release.yml` runs release-please on every
  push to `main` and a `publish` job only when a release was created. History: `feat(...)` merges are
  followed by `chore(main): release connectors 0.N.0 (#NN)`.

## 1. Spec-coverage table (FO1 requirement to task step)

| FO1 requirement (spec §) | Task / step |
| --- | --- |
| `connectors/vantage` with four read-only tools `vantage_cost_list`, `vantage_recommendation_list`, `vantage_cost_get`, `vantage_search` (§ 5.2) | T2, T4, T5, T6, T7 |
| Built on `createJsonGetter` / `envAuthHeaders` (§ 5.2) | T4 step 3 |
| `GET /costs` with `start_date`, `end_date`, `date_bin=day`, `groupings`, `limit=5000`, following `links.next` (§ 5.3) | T4 |
| `sinceMs` and `{ items, nextCursor }` list contract (D-FO-5, § 5.3) | T4 steps 1-3 |
| Default groupings: saved report's when a report token is set, else `provider,service,account_id` (§ 5.3, D-FO-12) | T4 step 1 (case 3), step 3 |
| Pace `/costs` at no more than one request per 1.2 s (§ 5.3) | T8 |
| Stop on the first `429`, error names the `x-rate-limit-reset` time, no retry (§ 5.3, § 6) | T8 |
| `GET /recommendations?status=active&limit=1000` (§ 5.3, § 5.1) | T5 |
| Spawn env `VANTAGE_API_TOKEN`, `VANTAGE_COST_REPORT_TOKEN`, `VANTAGE_WORKSPACE_TOKEN`, `VANTAGE_GROUP_BY` (§ 5.3 "Vault keys") | T4 step 3, T9 case 1 |
| Read-only: `hitlRequired: []`, no write tool, GET only, verb pinned by a test (D-FO-1, § 6, § 7) | T2 step 3 (manifest), T9 |
| Manifest `network: ["api.vantage.sh"]`, no wildcard, no extra host (§ 5.3 "Sandbox") | T2 step 3, T9 case 4 |
| Token never in a thrown error or output (§ 6, § 7) | T9 case 3 |
| Pinned connector count raised (95 to 96), `exports` entry (§ 5.2) | T1, T2 |
| README with credentials and read-only token advice (§ 5.3, § 6) | T10 |
| Fixtures from documented shapes, not a live account (§ 7) | T3 |
| Release publishes the next minor; FO2's pin waits (§ 5.2 gate) | T12 |

## 2. Risks: UNVERIFIED API facts the implementer must close

Each is a fact the spec marked UNVERIFIED or that this plan found unverified. T3 closes the first
three by reading the vendor's published OpenAPI file; the rest are pinned as explicit assumptions in
tests and surfaced in the README.

| # | Unverified fact | How the implementer checks it |
| --- | --- | --- |
| R1 | How `groupings` is serialised (the spec read says "array, comma-separated"; OpenAPI `style`/`explode` unread) | T3: fetch `https://api.vantage.sh/v2/oas_v3.json`, read the `GET /costs` parameter `groupings` (`style`, `explode`, `schema`); record the finding in `test/fixtures.ts` and make T4 case 2 assert the exact query string |
| R2 | Shape of a cost row when a custom grouping (`tag:team`) is used: the documented example shows only `accrued_at, amount, currency, provider, account_id, service` | T3: read the `Costs` schema and any example with `groupings` in the same file; if the grouped key's location is not documented, the connector returns rows untouched (the gateway mapper in FO2 owns the interpretation) and the README says so. Do not invent a key |
| R3 | Whether `start_date`/`end_date` accept a date only or a datetime (`YYYY-MM-DD` is sent) | T3: schema `format` of both parameters; test asserts `YYYY-MM-DD` UTC |
| R4 | Whether `/costs` counts toward the Cost Report limit of 5 requests per 5 s (`docs.vantage.sh/api/rate_limiting`) | Cannot be checked offline. The connector paces at 1.2 s per `/costs` call regardless (T8); the README states the assumption |
| R5 | The `links.next` form (URL or null) and whether the last page omits it | T3: `Costs` schema; code treats a non-empty string as "more" and anything else as the last page, with a test for each |
| R6 | Whether a Bearer token alone satisfies the file's `oauth2` security scheme (the schemes block was not readable in the 567 KB file) | T3: read `components.securitySchemes`; the auth page (`docs.vantage.sh/api/authentication`) shows `Authorization: Bearer`; if the file contradicts it, stop and report to the spec owner |
| R7 | `GET /cost_reports/{token}` response shape (used by `vantage_cost_get`) | T3: read the schema; the tool returns the raw body, so only the path is pinned |
| R8 | The `recommendations` response envelope key (`recommendations` per the docs page) and `links` | T3 plus T5 fixture from the documented field list in spec § 5.0 [V4] |
| R9 | Drift between planning and implementation: counts, version and pinned strings were re-derived at `0e3609c` (0.13.0, 95 connectors) and can move again | T0 |

## 3. Tasks

All commands run from `C:\gitrep\nimbus-mcp-servers`. Windows and POSIX use the same Bun commands.
Use the Write/Edit tools for any file containing a backslash (`CLAUDE.md` "Traps": heredocs mangle them).

### T0 Preflight

1. `git fetch origin && git switch -c dev/<you>/fo1-vantage origin/main`; verify
   `git rev-parse --abbrev-ref HEAD`.
2. `bun install --frozen-lockfile` then `bun run check` (lint, typecheck, the four audits, `bun test`). It
   must be green before any change; if it is not, stop.
3. Re-derive: `ls connectors | wc -l` (expected 95), the number in `scripts/connector-gates.test.ts`
   (`expect(connectorDirs(ROOT)).toHaveLength(95)`, line 44 at `0e3609c`), `package.json` version, the
   newest `connectors-v*` tag (`git tag --list 'connectors-v*' --sort=-v:refname | head -1`), and the
   `minNimbusVersion` of the newest sibling manifest (copy it, do not guess). Write the numbers in the PR
   body. If the count is not 95, every "95/96" below shifts by the same amount.

### T1 Raise the pinned count first (red)

1. Edit `scripts/connector-gates.test.ts` (the `actually sees this repo's 95 connectors` test, lines
   43-44): the title and `toHaveLength` become 96.
2. `bun test scripts/connector-gates.test.ts` fails (95 found). This is the intended red.
3. Edit `docs/standalone-launcher.md:28`: the sentence (today `all 95 are eligible` and `50 declare no
   mutating tools`) becomes `all 96 are eligible` and `51 declare no mutating tools` (the new connector
   declares none; the 45 hardened stay 45). A test
   (`standalone/src/launcher.test.ts`, "the launcher doc states the measured total and split", about
   lines 468-485) recomputes `total`, `noWrites` and `hardened` from the tree and asserts the doc says
   `all ${total} are eligible`, `${noWrites} declare no mutating tools` and `other ${hardened} have had
   their writes`. The doc is wrapped, so match on the collapsed text.

### T2 Scaffold (all connector-level gates go from red to green together)

1. Create `connectors/vantage/package.json`: copy `connectors/dbt/package.json` with `name:
   "nimbus-mcp-vantage"`, `private: true` (asserted by a test), the same three dependencies, except `@nimbus-dev/sdk` is `^2.1.0` to match the root manifest (the per-connector
   file is metadata only, nothing installs from it, and `dbt` still says `^2.0.0`).
2. Create `connectors/vantage/tsconfig.json`: copy `connectors/dbt/tsconfig.json` verbatim.
3. Create `connectors/vantage/nimbus.extension.json`: `id: "com.nimbus.vantage"`, `displayName: "Vantage"`,
   `version: "0.1.0"`, `entrypoint: "dist/server.js"`, `runtime: "bun"`, `permissions: { network:
   ["api.vantage.sh"], filesystem: { read: [], write: [] } }`, `hitlRequired: []`, `syncInterval: 21600`
   (6 h, spec § 5.3), `minNimbusVersion` from T0. The description names the host, the Bearer header and
   the four env vars, and says it is read-only.
4. Create `connectors/vantage/src/server.ts` as the 4-line bootstrap of `connectors/dbt/src/server.ts`
   (`runReadOnlyMcpConnector("nimbus-vantage", (reg) => { registerVantageTools(reg); })`).
5. Create `connectors/vantage/src/tools.ts` with only `export const VANTAGE_TOOL_NAMES = [] as const;` and
   an empty `registerVantageTools(reg)` so imports resolve (filled in T4-T7).
6. Add `"./vantage": "./connectors/vantage/src/server.ts"` to the root `package.json` `exports` between
   `./testflight` and `./vercel` (alphabetical; `scripts/exports-map.test.ts` fails without it).
7. Copy `connectors/dbt/test/sandbox.test.ts` unchanged to `connectors/vantage/test/sandbox.test.ts`.
8. `bun test scripts/connector-gates.test.ts scripts/exports-map.test.ts standalone/src/launcher.test.ts`
   now pass (count, exports map, the launcher doc numbers). `scripts/connector-boot.test.ts` is NOT
   expected to pass yet: it asserts `served.length` is greater than 0 (`scripts/connector-boot.test.ts`,
   the `expect(served.length).toBeGreaterThan(0)` line) and an empty surface fails it. It goes green at
   T4, when `vantage_cost_list` is registered. T2 is therefore not independently green; the PR is
   squash-merged, so only the final state matters.

### T3 Close R1-R3, R5-R8 and write the fixtures

1. Fetch `https://api.vantage.sh/v2/oas_v3.json` into a scratch directory (it is 567 KB; read the
   `GET /costs`, `GET /recommendations`, `GET /cost_reports/{cost_report_token}` operations and
   `components.securitySchemes`). Do not commit the file.
2. Write `connectors/vantage/test/fixtures.ts` with: a one-page `/costs` reply
   `{ links: { self, next }, total_cost: { amount, currency }, costs: [...] }` using the documented example
   keys (`accrued_at`, `amount`, `currency`, `provider`, `account_id`, `service`); a last-page reply with
   no `next`; a `/recommendations` reply with `links` and `recommendations: [{ token, type, category,
   workspace_token, provider, provider_account_id, service, description, documentation_url,
   potential_savings, resources_affected_count, currency_code, currency_symbol, created_at }]` (field list:
   spec § 5.0 [V4]); a `/cost_reports/{token}` reply. Each constant carries a comment naming the source
   (the docs page or the OpenAPI schema) and the date read. State plainly in the file header that these
   are documentation-shaped fixtures, not live recordings.
3. Put the R1/R3/R5/R6/R7 findings in a comment block at the top of `fixtures.ts` (one line each:
   finding, section of the OpenAPI file). If R6 contradicts the Bearer assumption, stop (see § 2).

### T4 `vantage_cost_list` (test first)

Input schema: `cursorListInputSchema(5000)` extended with `sinceMs?: int >= 0` and `untilMs?: int >= 0`
(`untilMs` defaults to now; it exists so tests need no clock). Output `{ items, nextCursor }`.

1. Write `connectors/vantage/test/cost-list.test.ts` using `captureTools`, `stubFetch`, `withEnv`
   (pattern: `connectors/dbt/test/tools.test.ts`, `configured()` helper). Cases:
   - 1 sends `GET https://api.vantage.sh/v2/costs?...` with `Authorization: Bearer <token>` and
     `Accept: application/json`; the method is GET.
   - 2 query string is exactly `start_date=<UTC date of sinceMs>&end_date=<UTC date of untilMs>&date_bin=day&groupings=<per R1>&limit=5000&page=1`
     (assert via `new URL(req.url).searchParams`, then assert the R1 serialisation separately).
   - 3 grouping precedence: `VANTAGE_COST_REPORT_TOKEN` set sends `cost_report_token=<it>` and NO
     `groupings` unless `VANTAGE_GROUP_BY` is set; neither set sends `groupings=provider,service,account_id`;
     `VANTAGE_WORKSPACE_TOKEN` sends `workspace_token`.
   - 4 `limit` below 5000 is honoured; `cursor` `"3"` requests `page=3`; a cursor that is not
     `/^[1-9]\d{0,5}$/` is refused before any request (the cursor is the model's choice; it is never
     used as a URL, so the origin trap in `CLAUDE.md` "A URL in a tool argument" does not apply, and a
     test pins that no request URL is taken from a reply).
   - 5 `links.next` non-empty gives `nextCursor: "<page+1>"`; absent or null gives `nextCursor: null` (R5).
   - 6 `items` is the reply's `costs` array untouched (R2).
   - 7 a non-2xx throws `Vantage 500: <snippet>`.
2. `bun test connectors/vantage/test/cost-list.test.ts` fails (tool not registered).
3. Implement in `connectors/vantage/src/tools.ts`: `vantageGet = createJsonGetter({ base: "https://api.vantage.sh/v2",
   label: "Vantage", headers: envAuthHeaders({ env: "VANTAGE_API_TOKEN" }), fetch: <the 429 wrapper from T8> })`;
   optional env through `optionalEnv(name, "")`; the request is built with `URLSearchParams` (never
   string concatenation of env values). `registerVantageTools(reg, deps = realDeps)` takes an optional
   `{ now, sleep }` (a defaulted parameter keeps `Function.length` at 1, which the contract test's
   discovery requires: `scripts/connector-tool-contract.test.ts`, `loadSurface`). Export
   `VANTAGE_TOOL_NAMES`.
4. Green; commit `feat(vantage): vantage_cost_list`.

### T5 `vantage_recommendation_list` (test first)

1. Test file `connectors/vantage/test/recommendation-list.test.ts`: GET `/recommendations` with
   `status=active&limit=1000` (limit never above 1000: `cursorListInputSchema(1000)`) and `page` from the
   cursor; optional `workspace_token`; `items` is the `recommendations` array; `nextCursor` as T4 case 5;
   the bearer header.
2. Red, then implement beside T4's code (shared `pageCursor` helper), green, commit.

### T6 `vantage_cost_get` (test first)

Decision recorded for the reviewer: the spec lists `vantage_cost_get` without a target. This plan makes it
fetch one cost REPORT definition (`GET /cost_reports/{token}`), because the report's saved groupings are
what the owner's attribution rests on (D-FO-12) and the gateway or owner needs to read them. If review
prefers `vantage_recommendation_get`, only the path and fixture change.

1. Test: `{ id }` calls `GET /cost_reports/<encodeURIComponent(id)>` (assert an id with `/` and `?` is
   encoded), returns the raw body, throws `Vantage 404: ...` on 404.
2. Red, implement (`reg("vantage_cost_get", ..., z.object({ id: z.string().min(1) }), ...)`), green, commit.

### T7 `vantage_search` (test first)

1. `connectors/vantage/src/search-filter.ts`: `makeQueryFilter(fieldsFromKeys(["description", "type",
   "service", "provider", "category"]))` (pattern `connectors/dbt/src/search-filter.ts`, which uses
   `asObjectish` and `makeQueryFilter`).
2. Tests: `test/search-filter.test.ts` (case-insensitive match on each key, no match, `limit`), and a tool
   test: `vantage_search { query }` makes ONE request, `GET /recommendations?status=active&limit=1000`,
   and returns `{ matches }` (use `searchToolInputSchema(200)` and `matchesResult`,
   `shared/mcp-search-tool.ts:16,30`).
3. Red, implement, green, commit.

### T8 Rate limit: pacing and the 429 stop

1. Tests (`test/rate-limit.test.ts`, with an injected `sleep` recording its argument and an injected
   `now`): (a) two consecutive `/costs` calls in one process make the second wait so that at least
   1,200 ms separate the requests; the first call never sleeps; (b) `/recommendations` and
   `/cost_reports` calls are not paced; (c) a `429` reply with header `x-rate-limit-reset: <unix seconds>`
   throws an error containing `429`, the ISO time of the reset and the word `Vantage`, and makes exactly
   one request (no retry); (d) a `429` without the header still throws and says the reset time is unknown;
   (e) the error does not contain the token.
2. Implement: a `fetch` wrapper passed to `createJsonGetter` (`JsonApiConfig.fetch`,
   `shared/env-json-api.ts:125`, type `JsonFetch`) that, on `res.status === 429`, reads the header and
   throws; the pacer is a closure over `lastCostAt`. The pacing test is exact: `new URL(url).pathname === "/v2/costs"`
   (never `includes("cost")`, which would also pace `/cost_reports/...`; case (b) above pins it, and a
   `/cost_reports/abc` request in the same test must show no sleep).
3. Green, commit.

### T9 Read-only and sandbox pins (tests that can fail)

`connectors/vantage/test/read-only.test.ts`:

1. Every tool, driven with `scripts/tool-arg-fixture.ts` arguments under `stubFetch`, issues only `GET`
   requests (assert `req.method` across `stub.calls`), all to `https://api.vantage.sh/v2/`, all with the
   Bearer header carrying the configured token. Also pin the spawn env names: with only
   `VANTAGE_API_TOKEN` set the tools work; without it they throw `VANTAGE_API_TOKEN is not set` BEFORE any
   request (the contract test checks this generically; this is the named pin).
2. `nimbus.extension.json` parses with `hitlRequired` equal to `[]` and `permissions.network` equal to
   `["api.vantage.sh"]` (no wildcard, no second host).
3. A thrown error (401 with a body that does not contain the token) never contains the token; and a stub
   body that DOES echo the token is truncated to 400 characters by the getter (document, do not claim
   redaction: the getter does not redact).
4. The connector source imports neither `createWriteToolRegistrar` nor `consent-kit` (read `src/tools.ts`
   as text, but assert behaviour first: case 1 is the behavioural pin; this is a belt).

### T10 Documentation

1. `connectors/vantage/README.md` following `connectors/monte-carlo/README.md` / `dbt/README.md`:
   what it is; install ("Bundled with Nimbus"); quickstart with `nimbus vault set vantage.api_token ...`
   (the vault keys are registered gateway-side in FO2; the README says the gateway injects them as env at
   spawn); the env table (`VANTAGE_API_TOKEN` required; `VANTAGE_COST_REPORT_TOKEN`,
   `VANTAGE_WORKSPACE_TOKEN`, `VANTAGE_GROUP_BY` optional); advice to create a Read-only Vantage token
   (Nimbus cannot check scope, spec § 8); the four tools; the rate limits (1,000 requests per hour, Cost
   Report endpoints 5 per 5 s) and the assumption R4; the documented-fixture caveat.
2. Update the connector count in prose: `CLAUDE.md:5,88`, `CONTRIBUTING.md:3,103`, `README.md:6,119`,
   `docs/adding-a-connector.md:27,141,159` (the last two say "the other 94", which becomes 95), `docs/architecture.md:14,166` (and the "One package, not 95" heading
   at `:34` and the `:37` sentence), `docs/configuration.md:139,140` ("all 95 connectors" and "the other 94"). All of these are 95 today and
   become 96 (and 95 for "the other"). Leave
   historical sentences (`standalone/src/launcher.test.ts:457`, the `strip-comments.ts` measurement) alone.
   `scripts/doc-links.test.ts` guards links; run it.
3. Do NOT edit `CHANGELOG.md` (release-please owns it).

### T11 Full verification

1. `bun run sync:tool-names` then `bun run audit:tool-names` (the `VANTAGE_TOOL_NAMES` export must equal
   the four registered names, order as the script writes it).
2. `bun run check` (lint with `--error-on-warnings`, `tsc -p tsconfig.json` over `src/` only (tests are
   not type-checked), the four audits, `bun test`). Fix everything it names. Confirm
   `scripts/connector-tool-contract.test.ts` actually discovered `vantage` (it must not be in a skip map;
   add nothing to `NOT_HTTP`, `KEYLESS` or `ARG_OVERRIDES` unless a named property fails for a stated
   reason).
3. `bun run test:coverage` and read the new files' lines (the repo uploads lcov to SonarQube Cloud).
4. Do not run `bun run test:sandbox` (it opens real connections to vendor hosts; the repo marks it
   opt-in).

### T12 PR, release, and the FO2 gate

1. Open the PR from `dev/<you>/fo1-vantage`. The PR title is the commit that reaches `main` if the repo
   squashes (confirm with `gh repo view nimbus-agent/nimbus-mcp-servers --json squashMergeAllowed`): use
   `feat(vantage): add the Vantage cost and recommendations connector` and put the verification summary
   and the risk table (§ 2) in the body. No `!`: nothing a user must change (see the gateway repo's
   guidance on `!`). A `feat` cuts a minor under `bump-minor-pre-major: true`.
2. Wait for CI (Ubuntu, macOS, Windows) to be green. Merge when green.
3. release-please opens `chore(main): release connectors 0.14.0 (#NN)` on the push to `main` (the manifest is 0.13.0 and a `feat` is a minor;
   confirm the number in the release PR title). Merge it
   when green; `release.yml`'s `publish` job runs only if a release was created.
4. Confirm the publish: `npm view @nimbus-dev/connectors version` equals the new minor and the tarball
   contains `connectors/vantage/` (the repo's `scripts/package-contents.test.ts` guards the file list).
5. **FO2 waits for this.** The gateway PR may bump `@nimbus-dev/connectors` only after step 4, because
   `audit:connector-version-skew` fails a pin to an unpublished version. Hand the exact version and the
   four tool names to FO2 (expected `^0.14.0`).

## 4. Order and commits

T0, T1 (red), T2, T3, T4, T5, T6, T7, T8, T9, T10, T11, T12. One commit per task from T4 on; T1+T2 may
share one. Run `git rev-parse --abbrev-ref HEAD` before every commit (a concurrent session once moved HEAD
off a branch).

## 5. Review log

### Round 1 (Antigravity, 2026-11-12), checked against `origin/main` `0e3609c`

Applied (each re-derived from the files, not from the review):
- F1: `scripts/connector-gates.test.ts:43-44` already says 95 on main (95 directories under
  `connectors/`). The plan was written against a stale clone. T0, T1 and the coverage table now go 95 to
  96. The spec's own 94-based sequence is noted in § 0.
- F2: `docs/standalone-launcher.md:28` already says "all 95 ... 50 ... 45"; the test strings are at
  `standalone/src/launcher.test.ts:487-489`. T1 step 3 now sets 96 and 51 (hardened stays 45). T10 lists
  the extra prose spots (`README.md:119`, `docs/adding-a-connector.md:141,159`,
  `docs/configuration.md:140`) and the "One package, not 95" heading, all re-read from main.
- F3: `scripts/connector-boot.test.ts:153` asserts `served.length > 0`. T2 step 8 no longer expects it to
  pass; it goes green at T4. The launcher test replaces it in the T2 check.
- F4: `bun run check` runs four audits (`package.json:145`). T11 said "three"; fixed.
- F5: T8 now pins the pacer to `new URL(url).pathname === "/v2/costs"` with a `/cost_reports` case in the
  same test. (Valid as a guard against a sloppy substring match; the plan did not itself prescribe one.)
- F6: the next release is expected to be 0.14.0 (manifest 0.13.0, `bump-minor-pre-major: true`); T12 says
  so and tells the implementer to confirm it in the release PR title.
- F7: accepted as an alignment choice (`^2.1.0` as in the root `package.json:29`), but noted as metadata
  only: `dbt` and `google-calendar` still say `^2.0.0`, and the only script mentioning the SDK is the
  dependency allow-list (`scripts/check-connector-deps.ts:16`), which does not compare versions.

Rejected: none. Two of the review's phrasings were stronger than the files: F1 says changing nothing
"leaves the test green" (true of main, false of the plan, which was simply stale), and F7 is labelled a
dependency-alignment defect when it is cosmetic.
