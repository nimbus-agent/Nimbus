# npm Supply-Chain Assurance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the already-live npm OIDC/provenance guarantee verified and non-degradable, and gain liveness visibility on the two publish PATs that cannot yet be retired.

**Architecture:** One tested implementation of each check lives as a composite action in the existing `nimbus-agent/.github` repo. The two npm satellites call the provenance action as a release-time gate; the Nimbus monorepo's existing weekly `secret-health.yml` calls the *same* action in monitor mode and converts its output into a `HealthRow` — exactly mirroring the existing `classifyAppMint` precedent, so no checker logic is duplicated in TypeScript. `nimbus-vscode` gets its own health workflow that probes its PATs where those secrets already live.

**Tech Stack:** GitHub composite actions running dependency-free Node 20 (pre-installed on runners; no `setup-node`, no `npm install`); Bun + `bun:test` for the monorepo-side changes; `vsce` / `ovsx` CLIs for PAT probes.

## Global Constraints

- **No new runtime dependencies.** Node action code uses only Node 20 built-ins (`node:test`, `node:assert`, global `fetch`, `Buffer`) — no `package.json`, no install step. Sub-project 1's precedent: no new dep. This governs code we author; it does not forbid Task A4 invoking the vendor `vsce`/`ovsx` CLIs via `npx` at an exact pin, which is a deliberate, documented choice.
- **Secrets never touch argv.** Tokens flow only through the child process environment. Applies to every probe.
- **Never log a token, request header, or raw response body.** Log only a derived classification and an HTTP status or exit code. Error paths must be scrubbed — client libraries embed request headers in thrown errors.
- **SHA-pin every action reference.** The org sets `sha_pinning_required: true`. Use `uses: nimbus-agent/.github/actions/<name>@<full-40-char-sha>`.
- **Attestation predicate constants (exact strings):**
  - publish: `https://github.com/npm/attestation/tree/main/specs/publish/v0.1`
  - SLSA: `https://slsa.dev/provenance/v1`
- **npm floor for trusted publishing:** `11.5.1`.
- **Fail closed.** Any unrecognised shape maps to `indeterminate`, never a false `ok`.
- **Branch/commit rules:** work on `dev/asafgolombek/<topic>` branches; never commit to `main`. Monorepo work happens in a git worktree under `.claude/worktrees/`.
- **`5fb42792fa88287048fd24f704183b9a9b807a67`** appears in Tasks B2, C1, and D1. It is the 40-character commit SHA of `nimbus-agent/.github` `main` **after Task A3's PR is merged**. Resolve it once with `gh api repos/nimbus-agent/.github/commits/main --jq '.sha'` and substitute the literal value everywhere. A tag or branch ref will fail the org's SHA-pinning requirement.

## Scope of Verification — read before Task A1

The provenance action **parses the DSSE payload** served by the registry over TLS. It asserts *completeness and source-consistency*. It does **not** perform Sigstore cryptographic verification — that would require a heavy dependency and is disproportionate to the threat model here, which is **accidental degradation** (a dropped `id-token: write`, an old npm), not registry compromise.

`npm audit signatures` **does** perform registry-signature verification and is therefore included in the release gate as the cryptographic complement (Task C1). Do not describe the action alone as "verifying signatures" in any comment, log line, or doc — it checks claims, not cryptography.

## File Structure

**Repo `nimbus-agent/.github`** (new `actions/` tree):

| Path | Responsibility |
| --- | --- |
| `actions/verify-npm-provenance/action.yml` | Composite action interface: inputs, outputs, `node` invocation |
| `actions/verify-npm-provenance/src/classify.js` | **Pure**: decode DSSE payloads, classify against expected source. No I/O |
| `actions/verify-npm-provenance/src/fetch-attestations.js` | Retry/backoff around `fetch`. Injected `fetch` + `sleep` |
| `actions/verify-npm-provenance/src/main.js` | Entrypoint: reads inputs from env, wires the two above, writes outputs |
| `actions/verify-npm-provenance/test/classify.test.js` | Classifier unit tests |
| `actions/verify-npm-provenance/test/fetch-attestations.test.js` | Retry/backoff unit tests |
| `actions/verify-npm-provenance/test/fixtures/*.json` | Real captured registry responses, trimmed |
| `actions/probe-publish-token/action.yml` | Composite action wrapping `vsce`/`ovsx verify-pat` |
| `.github/workflows/ci.yml` | Runs `node --test` over `actions/**/test` |

**Repo `nimbus-agent/Nimbus`:**

| Path | Responsibility |
| --- | --- |
| `scripts/release/check-secret-health.ts` | Modify: widen `HealthRow`, add two classifiers, wire env |
| `scripts/release/check-secret-health.test.ts` | Modify: tests for the two new classifiers |
| `.github/workflows/secret-health.yml` | Modify: call provenance action ×2 in monitor mode |
| `docs/ci-secrets.md` | Modify: provenance section + PAT expiry/owner notes |

**Repos `nimbus-sdk`, `nimbus-client`:** `.github/workflows/release.yml` — preflight + post-publish gate.

**Repo `nimbus-vscode`:** `.github/workflows/secret-health.yml` (new), `.github/workflows/publish.yml` (attestation), `README.md` (verify docs).

---

## Task A1: Provenance classifier (pure logic)

**Repo:** `nimbus-agent/.github` · branch `dev/asafgolombek/supply-chain-actions`

**Files:**

- Create: `actions/verify-npm-provenance/src/classify.js`
- Create: `actions/verify-npm-provenance/test/classify.test.js`
- Create: `actions/verify-npm-provenance/test/fixtures/sdk-1.3.0.json`
- Create: `.github/workflows/ci.yml`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `PUBLISH_PREDICATE: string`, `SLSA_PREDICATE: string`
  - `decodeStatements(body: unknown): object[] | null` — `null` means unparseable
  - `classifyProvenance(statements: object[] | null, expected: {repo: string, workflow?: string, sha?: string}): {status: "ok"|"missing-provenance"|"source-mismatch"|"indeterminate", detail: string}`

- [ ] **Step 1: Clone and branch**

```bash
git clone https://github.com/nimbus-agent/.github.git nimbus-org-github
cd nimbus-org-github
git switch -c dev/asafgolombek/supply-chain-actions
mkdir -p actions/verify-npm-provenance/src actions/verify-npm-provenance/test/fixtures
```

- [ ] **Step 2: Capture the real fixture**

The fixture must be a real capture, so a registry shape change surfaces as a test diff.

```bash
curl -s "https://registry.npmjs.org/-/npm/v1/attestations/@nimbus-dev/sdk@1.3.0" \
  -o actions/verify-npm-provenance/test/fixtures/sdk-1.3.0.json
node -e "const d=require('./actions/verify-npm-provenance/test/fixtures/sdk-1.3.0.json');console.log(d.attestations.length)"
```

Expected: `2`

- [ ] **Step 3: Write the failing test**

Create `actions/verify-npm-provenance/test/classify.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { decodeStatements, classifyProvenance } from "../src/classify.js";

const real = JSON.parse(
  readFileSync(new URL("./fixtures/sdk-1.3.0.json", import.meta.url), "utf8"),
);
const EXPECTED = { repo: "nimbus-agent/nimbus-sdk", workflow: ".github/workflows/release.yml" };

function statementsOf(body) {
  const s = decodeStatements(body);
  assert.notEqual(s, null, "fixture should decode");
  return s;
}

test("real published package classifies ok", () => {
  const r = classifyProvenance(statementsOf(real), EXPECTED);
  assert.equal(r.status, "ok");
});

test("missing SLSA predicate is missing-provenance, not ok", () => {
  const only = {
    attestations: real.attestations.filter(
      (a) => a.predicateType === "https://github.com/npm/attestation/tree/main/specs/publish/v0.1",
    ),
  };
  const r = classifyProvenance(statementsOf(only), EXPECTED);
  assert.equal(r.status, "missing-provenance");
});

test("missing npm publish predicate is missing-provenance", () => {
  const only = {
    attestations: real.attestations.filter(
      (a) => a.predicateType === "https://slsa.dev/provenance/v1",
    ),
  };
  const r = classifyProvenance(statementsOf(only), EXPECTED);
  assert.equal(r.status, "missing-provenance");
});

test("wrong repo is source-mismatch", () => {
  const r = classifyProvenance(statementsOf(real), { repo: "attacker/evil" });
  assert.equal(r.status, "source-mismatch");
});

test("wrong workflow path is source-mismatch", () => {
  const r = classifyProvenance(statementsOf(real), {
    repo: "nimbus-agent/nimbus-sdk",
    workflow: ".github/workflows/attacker.yml",
  });
  assert.equal(r.status, "source-mismatch");
});

test("wrong commit sha is source-mismatch", () => {
  const r = classifyProvenance(statementsOf(real), {
    repo: "nimbus-agent/nimbus-sdk",
    sha: "0000000000000000000000000000000000000000",
  });
  assert.equal(r.status, "source-mismatch");
});

test("correct commit sha is ok", () => {
  const r = classifyProvenance(statementsOf(real), {
    repo: "nimbus-agent/nimbus-sdk",
    sha: "7e5a45f325d588a0b21eb5e1718a31c4ccb306cb",
  });
  assert.equal(r.status, "ok");
});

test("empty attestation list is missing-provenance", () => {
  const r = classifyProvenance(statementsOf({ attestations: [] }), EXPECTED);
  assert.equal(r.status, "missing-provenance");
});

test("null statements is indeterminate, never ok", () => {
  const r = classifyProvenance(null, EXPECTED);
  assert.equal(r.status, "indeterminate");
});

test("malformed body decodes to null", () => {
  assert.equal(decodeStatements(null), null);
  assert.equal(decodeStatements({}), null);
  assert.equal(decodeStatements({ attestations: "nope" }), null);
  assert.equal(decodeStatements({ attestations: [{ bundle: {} }] }), null);
});

test("truncated base64 payload decodes to null", () => {
  const broken = {
    attestations: [{ bundle: { dsseEnvelope: { payload: "bm90IGpzb24=" } } }],
  };
  assert.equal(decodeStatements(broken), null);
});

test("detail is a short summary, never the raw statement blob", () => {
  const r = classifyProvenance(statementsOf(real), EXPECTED);
  // Assert the actual content, not merely that it is short: a length bound
  // would pass on a truncated blob just as happily as on a real summary.
  assert.equal(
    r.detail,
    ".github/workflows/release.yml @ https://github.com/nimbus-agent/nimbus-sdk",
  );
  assert.ok(!/[A-Za-z0-9+/]{80,}={0,2}/.test(r.detail), "no base64 payload in detail");
  assert.ok(!r.detail.includes("dsseEnvelope"), "no envelope internals in detail");
});
```

- [ ] **Step 4: Run the test to verify it fails**

Run: `node --test "actions/verify-npm-provenance/test/*.test.js"`

Expected: FAIL — `Cannot find module '../src/classify.js'`

- [ ] **Step 5: Implement the classifier**

Create `actions/verify-npm-provenance/src/classify.js`:

```js
export const PUBLISH_PREDICATE =
  "https://github.com/npm/attestation/tree/main/specs/publish/v0.1";
export const SLSA_PREDICATE = "https://slsa.dev/provenance/v1";

/**
 * Decode the DSSE payloads out of a registry attestation response.
 *
 * The attestation content lives in `bundle.dsseEnvelope.payload` (base64 JSON),
 * NOT at the top level. We read predicateType from the decoded statement rather
 * than the unsigned outer wrapper.
 *
 * Returns null on any unrecognised shape — the caller maps that to
 * "indeterminate", never a false "ok".
 */
export function decodeStatements(body) {
  if (body === null || typeof body !== "object") return null;
  const list = body.attestations;
  if (!Array.isArray(list)) return null;
  const statements = [];
  for (const att of list) {
    const payload = att?.bundle?.dsseEnvelope?.payload;
    if (typeof payload !== "string") return null;
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(payload, "base64").toString("utf8"));
    } catch {
      return null;
    }
    if (decoded === null || typeof decoded !== "object") return null;
    statements.push(decoded);
  }
  return statements;
}

function fail(status, detail) {
  return { status, detail };
}

/**
 * Assert the attestation set is complete AND attested to the expected source.
 * "An attestation exists" is a weaker claim than "attested to us".
 */
export function classifyProvenance(statements, expected) {
  if (statements === null) return fail("indeterminate", "unparseable attestation response");
  if (statements.length === 0) return fail("missing-provenance", "no attestations published");

  const types = new Set(statements.map((s) => s?.predicateType));
  if (!types.has(PUBLISH_PREDICATE)) {
    return fail("missing-provenance", "no npm publish attestation");
  }
  const slsa = statements.find((s) => s?.predicateType === SLSA_PREDICATE);
  if (slsa === undefined) {
    return fail("missing-provenance", "no SLSA provenance predicate — publish degraded");
  }

  const wf = slsa?.predicate?.buildDefinition?.externalParameters?.workflow;
  if (wf === null || typeof wf !== "object") {
    return fail("indeterminate", "provenance carries no workflow claim");
  }

  const wantRepo = `https://github.com/${expected.repo}`;
  if (wf.repository !== wantRepo) {
    return fail("source-mismatch", `repository ${String(wf.repository)} != ${wantRepo}`);
  }
  if (expected.workflow !== undefined && wf.path !== expected.workflow) {
    return fail("source-mismatch", `workflow ${String(wf.path)} != ${expected.workflow}`);
  }
  if (expected.sha !== undefined) {
    const deps = slsa?.predicate?.buildDefinition?.resolvedDependencies;
    const commit = Array.isArray(deps)
      ? deps.find((d) => typeof d?.digest?.gitCommit === "string")?.digest?.gitCommit
      : undefined;
    if (commit !== expected.sha) {
      return fail("source-mismatch", `commit ${String(commit)} != ${expected.sha}`);
    }
  }
  return { status: "ok", detail: `${String(wf.path)} @ ${String(wf.repository)}` };
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `node --test "actions/verify-npm-provenance/test/*.test.js"`

Expected: PASS — 12 tests, 0 failures

- [ ] **Step 7: Add the CI workflow**

Create `.github/workflows/ci.yml`:

```yaml
name: CI

on:
  push:
    branches: [main]
  pull_request:

permissions:
  contents: read

jobs:
  test:
    name: Test composite actions
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@bf7454d06d71f1098171f2acdf0cd4708d7b5920 # v2.20.0
        with:
          egress-policy: audit
      - name: Checkout
        uses: actions/checkout@9c091bb21b7c1c1d1991bb908d89e4e9dddfe3e0 # v7.0.0
        with:
          persist-credentials: false
      - name: Run action tests
        # A bare directory arg worked on Node 20 but fails on Node 24
        # (MODULE_NOT_FOUND); runners now default to 24. Use an explicit glob.
        run: node --test "actions/**/test/*.test.js"
```

- [ ] **Step 8: Commit**

```bash
git add actions/verify-npm-provenance .github/workflows/ci.yml
git commit -m "feat: npm provenance classifier with real-capture fixtures

Asserts both the npm publish and SLSA provenance predicates are present AND
that the SLSA source claim names the expected repo/workflow/commit — 'an
attestation exists' is a weaker claim than 'attested to us'. Fails closed:
any unrecognised shape is indeterminate, never a false ok."
```

---

## Task A2: Fetch with backoff

**Files:**

- Create: `actions/verify-npm-provenance/src/fetch-attestations.js`
- Create: `actions/verify-npm-provenance/test/fetch-attestations.test.js`

**Interfaces:**

- Consumes: nothing from A1 (kept independent so both are testable in isolation).
- Produces:
  - `BACKOFF_MS: readonly number[]` — the deterministic retry schedule
  - `attestationUrl(pkg: string, version: string): string`
  - `fetchAttestations(pkg, version, deps: {fetchFn, sleep, backoff?}): Promise<{outcome: "body"|"absent"|"error", body?: unknown, detail: string}>`

- [ ] **Step 1: Write the failing test**

Create `actions/verify-npm-provenance/test/fetch-attestations.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { BACKOFF_MS, attestationUrl, fetchAttestations } from "../src/fetch-attestations.js";

const noSleep = async () => {};

test("url uses the raw scoped name (all forms verified 200; raw is canonical)", () => {
  assert.equal(
    attestationUrl("@nimbus-dev/sdk", "1.3.0"),
    "https://registry.npmjs.org/-/npm/v1/attestations/@nimbus-dev/sdk@1.3.0",
  );
});

test("backoff is deterministic, ~2.5 min, capped at 30s (no jitter)", () => {
  assert.deepEqual([...BACKOFF_MS], [5000, 10000, 20000, 30000, 30000, 30000, 30000]);
  const total = BACKOFF_MS.reduce((a, b) => a + b, 0);
  assert.equal(total, 155000);
  assert.ok(Math.max(...BACKOFF_MS) === 30000);
});

test("200 on first attempt returns body without sleeping", async () => {
  let slept = 0;
  const r = await fetchAttestations("@x/y", "1.0.0", {
    fetchFn: async () => new Response(JSON.stringify({ attestations: [] }), { status: 200 }),
    sleep: async () => { slept += 1; },
  });
  assert.equal(r.outcome, "body");
  assert.deepEqual(r.body, { attestations: [] });
  assert.equal(slept, 0);
});

test("404 retries the full schedule then reports absent", async () => {
  let calls = 0;
  const slept = [];
  const r = await fetchAttestations("@x/y", "1.0.0", {
    fetchFn: async () => { calls += 1; return new Response("", { status: 404 }); },
    sleep: async (ms) => { slept.push(ms); },
  });
  assert.equal(r.outcome, "absent");
  assert.equal(calls, BACKOFF_MS.length + 1, "initial attempt plus one per backoff step");
  assert.deepEqual(slept, [...BACKOFF_MS]);
});

test("404 then 200 succeeds without exhausting the schedule", async () => {
  let calls = 0;
  const r = await fetchAttestations("@x/y", "1.0.0", {
    fetchFn: async () => {
      calls += 1;
      return calls < 3
        ? new Response("", { status: 404 })
        : new Response(JSON.stringify({ attestations: [1] }), { status: 200 });
    },
    sleep: noSleep,
  });
  assert.equal(r.outcome, "body");
  assert.equal(calls, 3);
});

test("5xx exhausts retries and reports error, not absent", async () => {
  let calls = 0;
  const r = await fetchAttestations("@x/y", "1.0.0", {
    fetchFn: async () => { calls += 1; return new Response("", { status: 503 }); },
    sleep: noSleep,
  });
  assert.equal(r.outcome, "error");
  assert.match(r.detail, /503/);
  // Assert the RETRY, not just the outcome: a branch that returned immediately
  // would still satisfy the outcome check while breaking the module's purpose.
  assert.equal(calls, BACKOFF_MS.length + 1, "5xx is retryable; must exhaust the schedule");
});

test("network throw is error, never absent", async () => {
  let calls = 0;
  const r = await fetchAttestations("@x/y", "1.0.0", {
    fetchFn: async () => { calls += 1; throw new Error("ECONNRESET"); },
    sleep: noSleep,
  });
  assert.equal(r.outcome, "error");
  assert.equal(calls, BACKOFF_MS.length + 1, "network errors are transient; must exhaust the schedule");
});

test("invalid JSON body retries, then reports error — never a false absent", async () => {
  let calls = 0;
  const r = await fetchAttestations("@x/y", "1.0.0", {
    fetchFn: async () => { calls += 1; return new Response("<html>502</html>", { status: 200 }); },
    sleep: noSleep,
  });
  assert.equal(r.outcome, "error");
  assert.equal(calls, BACKOFF_MS.length + 1, "a proxy error page is transient — must retry");
});

test("transient bad body then good body succeeds", async () => {
  let calls = 0;
  const r = await fetchAttestations("@x/y", "1.0.0", {
    fetchFn: async () => {
      calls += 1;
      return calls === 1
        ? new Response("<html>502</html>", { status: 200 })
        : new Response(JSON.stringify({ attestations: [1] }), { status: 200 });
    },
    sleep: noSleep,
  });
  assert.equal(r.outcome, "body");
  assert.equal(calls, 2);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test actions/verify-npm-provenance/test/fetch-attestations.test.js`

Expected: FAIL — `Cannot find module '../src/fetch-attestations.js'`

- [ ] **Step 3: Implement the fetcher**

Create `actions/verify-npm-provenance/src/fetch-attestations.js`:

```js
/**
 * Deterministic retry schedule: 5s doubling to a 30s cap, ~2.5 min total.
 *
 * Jitter is deliberately omitted. Jitter decorrelates a FLEET of clients
 * retrying in lockstep; here exactly one client retries per publish, so it
 * would only add nondeterminism to these tests. Do not re-add it.
 */
export const BACKOFF_MS = Object.freeze([5000, 10000, 20000, 30000, 30000, 30000, 30000]);

const REGISTRY = "https://registry.npmjs.org/-/npm/v1/attestations";

/**
 * All three encodings of a scoped name (raw, fully percent-encoded, mixed)
 * return HTTP 200 — verified against the live registry 2026-07-19. The raw
 * form is canonical here; no encoding is required.
 */
export function attestationUrl(pkg, version) {
  return `${REGISTRY}/${pkg}@${version}`;
}

/**
 * Attestations can trail a publish, and the registry is CDN-fronted, so a 404
 * is only conclusive once the backoff schedule is exhausted.
 *
 * Distinguishes "absent" (404 throughout — the package genuinely has no
 * attestation) from "error" (5xx / network / unparseable). Callers map those
 * to different severities.
 */
export async function fetchAttestations(pkg, version, deps) {
  const backoff = deps.backoff ?? BACKOFF_MS;
  const url = attestationUrl(pkg, version);
  let lastDetail = "no attempt made";

  for (let attempt = 0; attempt <= backoff.length; attempt += 1) {
    if (attempt > 0) await deps.sleep(backoff[attempt - 1]);
    try {
      const res = await deps.fetchFn(url, { headers: { accept: "application/json" } });
      if (res.status === 200) {
        try {
          return { outcome: "body", body: await res.json(), detail: "200" };
        } catch {
          // A 200 carrying unparseable bytes is transient, not authoritative:
          // a CDN/proxy error page or a truncated body both look like this.
          // Retry rather than failing a release on one bad edge response.
          lastDetail = "200 with unparseable JSON body";
          continue;
        }
      }
      if (res.status === 404) {
        lastDetail = "404 after full backoff";
        continue;
      }
      lastDetail = `HTTP ${res.status}`;
    } catch {
      // Never surface the thrown error object: fetch errors can embed request
      // headers, and this action runs in public logs.
      lastDetail = "network error";
    }
  }
  return lastDetail === "404 after full backoff"
    ? { outcome: "absent", detail: lastDetail }
    : { outcome: "error", detail: lastDetail };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "actions/verify-npm-provenance/test/*.test.js"`

Expected: PASS — 21 tests total across both files, 0 failures

- [ ] **Step 5: Commit**

```bash
git add actions/verify-npm-provenance
git commit -m "feat: attestation fetch with deterministic backoff

Distinguishes absent (404 throughout) from error (5xx/network/unparseable) so
callers can map them to different severities. Never surfaces a thrown fetch
error: those can embed request headers and this runs in public logs."
```

---

## Task A3: Action entrypoint and interface

**Files:**

- Create: `actions/verify-npm-provenance/src/main.js`
- Create: `actions/verify-npm-provenance/action.yml`
- Create: `actions/verify-npm-provenance/test/main.test.js`

**Interfaces:**

- Consumes: `classifyProvenance`, `decodeStatements` (A1); `fetchAttestations` (A2).
- Produces: action inputs `package`, `version`, `expected-repo`, `expected-workflow`, `expected-sha`, `severity`; outputs `status`, `detail`.

- [ ] **Step 1: Write the failing test**

Create `actions/verify-npm-provenance/test/main.test.js`:

```js
import { test } from "node:test";
import assert from "node:assert/strict";
import { decide, exitCodeFor } from "../src/main.js";

test("absent attestation is missing-provenance", () => {
  const r = decide({ outcome: "absent", detail: "404 after full backoff" }, { repo: "a/b" });
  assert.equal(r.status, "missing-provenance");
});

test("registry error is indeterminate, not a false failure claim", () => {
  const r = decide({ outcome: "error", detail: "HTTP 503" }, { repo: "a/b" });
  assert.equal(r.status, "indeterminate");
});

test("gate severity fails on anything other than ok", () => {
  assert.equal(exitCodeFor("ok", "gate"), 0);
  assert.equal(exitCodeFor("missing-provenance", "gate"), 1);
  assert.equal(exitCodeFor("source-mismatch", "gate"), 1);
  assert.equal(exitCodeFor("indeterminate", "gate"), 1);
});

test("monitor severity never fails the job — the caller classifies", () => {
  assert.equal(exitCodeFor("ok", "monitor"), 0);
  assert.equal(exitCodeFor("missing-provenance", "monitor"), 0);
  assert.equal(exitCodeFor("indeterminate", "monitor"), 0);
});

test("same input yields different severity, same status", () => {
  const input = { outcome: "error", detail: "HTTP 503" };
  const status = decide(input, { repo: "a/b" }).status;
  assert.equal(exitCodeFor(status, "gate"), 1);
  assert.equal(exitCodeFor(status, "monitor"), 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test actions/verify-npm-provenance/test/main.test.js`

Expected: FAIL — `Cannot find module '../src/main.js'`

- [ ] **Step 3: Implement the entrypoint**

Create `actions/verify-npm-provenance/src/main.js`:

```js
import { appendFileSync } from "node:fs";
import { classifyProvenance, decodeStatements } from "./classify.js";
import { fetchAttestations } from "./fetch-attestations.js";

/** Map a fetch outcome plus the classifier into a single status. */
export function decide(fetched, expected) {
  if (fetched.outcome === "absent") {
    return { status: "missing-provenance", detail: fetched.detail };
  }
  if (fetched.outcome === "error") {
    // A registry problem is NOT evidence the publish was bad.
    return { status: "indeterminate", detail: fetched.detail };
  }
  return classifyProvenance(decodeStatements(fetched.body), expected);
}

/**
 * The gate must not let a possibly-degraded publish through; the monitor must
 * not turn a registry hiccup into issue spam. Same status, different severity.
 */
export function exitCodeFor(status, severity) {
  if (severity === "monitor") return 0;
  return status === "ok" ? 0 : 1;
}

function runbook(pkg, version, status, detail) {
  return [
    "::error::npm provenance verification FAILED",
    `::error::package=${pkg}@${version} status=${status} detail=${detail}`,
    "::error::RUNBOOK:",
    "::error::  1. This version is already on the registry. npm allows unpublish",
    "::error::     only within 72h of publish — check the publish timestamp now.",
    "::error::  2. Within 72h: `npm unpublish <pkg>@<version>`, fix the cause, republish.",
    "::error::  3. After 72h: `npm deprecate <pkg>@<version> \"no provenance; use <next>\"`",
    "::error::     then publish a patch version with provenance.",
    "::error::  4. Common causes: `id-token: write` missing from the publish job;",
    "::error::     npm older than 11.5.1; trusted-publisher binding removed on npmjs.com.",
  ].join("\n");
}

if (process.env["NODE_ENV"] !== "test" && process.argv[1]?.endsWith("main.js")) {
  const pkg = process.env["INPUT_PACKAGE"] ?? "";
  const version = process.env["INPUT_VERSION"] ?? "";
  const severity = process.env["INPUT_SEVERITY"] === "monitor" ? "monitor" : "gate";
  const expected = { repo: process.env["INPUT_EXPECTED_REPO"] ?? "" };
  const wf = process.env["INPUT_EXPECTED_WORKFLOW"];
  const sha = process.env["INPUT_EXPECTED_SHA"];
  if (wf) expected.workflow = wf;
  if (sha) expected.sha = sha;

  const fetched = await fetchAttestations(pkg, version, {
    fetchFn: fetch,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const { status, detail } = decide(fetched, expected);

  const out = process.env["GITHUB_OUTPUT"];
  if (out) appendFileSync(out, `status=${status}\ndetail=${detail}\n`);
  console.log(`npm provenance: ${pkg}@${version} -> ${status} (${detail})`);
  if (status !== "ok" && severity === "gate") console.log(runbook(pkg, version, status, detail));
  // Assign exitCode; do NOT call process.exit(). exit() tears the process down
  // while undici's keep-alive sockets from fetch() are still open, which trips a
  // libuv assertion (observed: exit 127 on a SUCCESSFUL verification) and can
  // truncate buffered stdout, silently dropping the GITHUB_OUTPUT write.
  process.exitCode = exitCodeFor(status, severity);
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "actions/verify-npm-provenance/test/*.test.js"`

Expected: PASS — 26 tests total, 0 failures

- [ ] **Step 5: Create the action interface**

Create `actions/verify-npm-provenance/action.yml`:

```yaml
name: Verify npm provenance
description: >-
  Assert a published npm version carries both the npm publish attestation and a
  SLSA provenance predicate, and that the provenance names the expected source
  repo/workflow/commit. Checks claims, not cryptography — pair with
  `npm audit signatures` for signature verification.

inputs:
  package:
    description: "npm package name, e.g. @nimbus-dev/sdk"
    required: true
  version:
    description: "Published version to verify"
    required: true
  expected-repo:
    description: "owner/repo that must appear in the provenance source claim"
    required: true
  expected-workflow:
    description: "Workflow path that must have produced it, e.g. .github/workflows/release.yml"
    required: false
  expected-sha:
    description: "Commit SHA the build must have come from"
    required: false
  severity:
    description: "'gate' (default) fails the job on any non-ok status; 'monitor' always exits 0"
    required: false
    default: gate

outputs:
  status:
    description: "ok | missing-provenance | source-mismatch | indeterminate"
    value: ${{ steps.verify.outputs.status }}
  detail:
    description: "Short human-readable reason"
    value: ${{ steps.verify.outputs.detail }}

runs:
  using: composite
  steps:
    - id: verify
      shell: bash
      # Node 20+ is preinstalled on GitHub runners; no setup-node, no install.
      run: node "${{ github.action_path }}/src/main.js"
      env:
        INPUT_PACKAGE: ${{ inputs.package }}
        INPUT_VERSION: ${{ inputs.version }}
        INPUT_EXPECTED_REPO: ${{ inputs.expected-repo }}
        INPUT_EXPECTED_WORKFLOW: ${{ inputs.expected-workflow }}
        INPUT_EXPECTED_SHA: ${{ inputs.expected-sha }}
        INPUT_SEVERITY: ${{ inputs.severity }}
```

- [ ] **Step 6: Smoke-test the entrypoint against the live registry**

```bash
INPUT_PACKAGE='@nimbus-dev/sdk' INPUT_VERSION=1.3.0 \
INPUT_EXPECTED_REPO=nimbus-agent/nimbus-sdk \
INPUT_EXPECTED_WORKFLOW=.github/workflows/release.yml \
node actions/verify-npm-provenance/src/main.js; echo "exit=$?"
```

Expected: `npm provenance: @nimbus-dev/sdk@1.3.0 -> ok (.github/workflows/release.yml @ https://github.com/nimbus-agent/nimbus-sdk)` and `exit=0`

Then verify the failure path exits non-zero:

```bash
INPUT_PACKAGE='@nimbus-dev/sdk' INPUT_VERSION=1.3.0 \
INPUT_EXPECTED_REPO=attacker/evil \
node actions/verify-npm-provenance/src/main.js; echo "exit=$?"
```

Expected: status `source-mismatch`, runbook printed, `exit=1`

- [ ] **Step 7: Commit and open the PR**

```bash
git add actions/verify-npm-provenance
git commit -m "feat: verify-npm-provenance composite action

Gate severity fails on any non-ok status; monitor severity always exits 0 and
lets the caller classify — so a registry hiccup cannot spam the weekly issue
filer while a degraded release still fails loudly. Prints an operator runbook
on gate failure, including the 72h unpublish window and the deprecate path."
git push -u origin dev/asafgolombek/supply-chain-actions
gh pr create --repo nimbus-agent/.github --fill
```

---

## Task A4: `probe-publish-token` action

**Files:**

- Create: `actions/probe-publish-token/action.yml`

**Interfaces:**

- Consumes: nothing.
- Produces: action inputs `tool` (`vsce`|`ovsx`), `namespace`; output `status` (`ok`|`dead`|`not-configured`|`indeterminate`); token supplied by the caller as the `PUBLISH_TOKEN` env var.

**Design note:** both CLIs ship a first-class `verify-pat` command and both read the token from the environment (`VSCE_PAT` / `OVSX_PAT`). Using them means our own code never handles the token at all — the non-disclosure contract is satisfied structurally rather than by careful coding. Do not hand-roll an HTTP probe here.

**Two hazards this task must handle — do not simplify them away:**

1. **A non-zero exit does not mean the token is dead.** Registry downtime, a network timeout, or marketplace rate-limiting all produce a non-zero exit. Treating those as `dead` would file a false critical alert claiming a working credential is revoked — worse than silence, because it trains the operator to ignore the alarm. The probe therefore distinguishes "the service said no" from "we could not reach the service" by checking a public unauthenticated endpoint after a failure, and reports `indeterminate` when the service is unreachable.
2. **An unset secret is not a revoked secret.** The empty-token branch reports `not-configured`, never `dead` — it contacts nothing, so it has no evidence of revocation. Emitting `dead` there would file a "token revoked, rotate now" alert for a credential that was never provisioned.
3. **The token is handed to whatever `npx` resolves.** `npx --yes <pkg>` with no version pulls `@latest` — so a compromised release of `@vscode/vsce` or `ovsx` would receive a live publish credential. Pin **exact** versions, not ranges: a `^` range still resolves to the newest match and provides no protection here. This is a supply-chain program; running unpinned third-party code with a credential in scope would undercut its own premise.

- [ ] **Step 1: Create the action**

Create `actions/probe-publish-token/action.yml`:

```yaml
name: Probe publish token
description: >-
  Liveness probe for a marketplace publish token using the vendor CLI's own
  verify-pat command. The token is passed only via environment — never argv —
  and neither the token nor any response body is logged.

inputs:
  tool:
    description: "'vsce' (VS Code Marketplace) or 'ovsx' (Open VSX)"
    required: true
  namespace:
    description: "Publisher / namespace to verify against, e.g. nimbus-agent"
    required: true

outputs:
  status:
    description: "ok | dead | not-configured | indeterminate"
    value: ${{ steps.probe.outputs.status }}

runs:
  using: composite
  steps:
    - id: probe
      shell: bash
      # PUBLISH_TOKEN is mapped by the caller from the appropriate secret.
      # It is exported into the vendor CLI's expected env var and never echoed.
      # Output is discarded wholesale: error messages from these CLIs can echo
      # request context, and this runs in a public repository's logs.
      #
      # CLI versions are pinned EXACTLY, not by range: this hands a live publish
      # credential to the resolved package, so `@latest` (or a `^` range, which
      # still floats) would put a third-party release in the credential's trust
      # boundary. Bumping these is a deliberate, reviewed change.
      run: |
        set +e
        if [ -z "${PUBLISH_TOKEN}" ]; then
          # NOT `dead`: this branch never contacts the vendor and never runs the
          # reachability check, so it cannot know the token was revoked — the
          # secret simply is not set. `dead` is reserved for a confirmed
          # rejection by a reachable service, so the alert text stays truthful.
          # Severity is the CALLER's decision: a repo that requires this token
          # may still treat not-configured as a hard failure.
          echo "status=not-configured" >> "$GITHUB_OUTPUT"
          echo "probe ${TOOL}: secret not configured (not a revocation signal)"
          exit 0
        fi
        if [ "${TOOL}" = "vsce" ]; then
          VSCE_PAT="${PUBLISH_TOKEN}" npx --yes @vscode/vsce@3.9.2 verify-pat "${NAMESPACE}" >/dev/null 2>&1
          code=$?
          reach_url="https://marketplace.visualstudio.com/"
        else
          OVSX_PAT="${PUBLISH_TOKEN}" npx --yes ovsx@1.0.2 verify-pat "${NAMESPACE}" >/dev/null 2>&1
          code=$?
          reach_url="https://open-vsx.org/api/-/search?size=1"
        fi

        if [ $code -eq 0 ]; then
          echo "status=ok" >> "$GITHUB_OUTPUT"
          echo "probe ${TOOL} (${NAMESPACE}): ok"
          exit 0
        fi

        # A non-zero exit alone does NOT mean the token is revoked — registry
        # downtime, a timeout or rate-limiting look identical. Only call it dead
        # if the service is actually reachable; otherwise report indeterminate
        # so the caller warns instead of raising a false revocation alarm.
        http="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 20 "$reach_url" 2>/dev/null)"
        if [ "$http" = "200" ]; then
          echo "status=dead" >> "$GITHUB_OUTPUT"
          echo "probe ${TOOL} (${NAMESPACE}): failed (exit=${code}) and service reachable -> dead"
        else
          echo "status=indeterminate" >> "$GITHUB_OUTPUT"
          echo "probe ${TOOL} (${NAMESPACE}): failed (exit=${code}) and service unreachable (http=${http}) -> indeterminate"
        fi
        exit 0
      env:
        TOOL: ${{ inputs.tool }}
        NAMESPACE: ${{ inputs.namespace }}
```

- [ ] **Step 2: Verify `verify-pat` exists in both CLIs before relying on it**

Check the **exact pinned versions**, not `@latest` — those are what will run.

```bash
npx --yes @vscode/vsce@3.9.2 --help 2>&1 | grep -i "verify-pat"
npx --yes ovsx@1.0.2 --help 2>&1 | grep -i "verify-pat"
```

Expected: both print a `verify-pat` line.

If a newer version has since shipped, that is fine — do **not** float the pin to pick it up. Bump the pinned version deliberately, re-run this check, and note it in the commit.

**If either does not:** stop and report. Do not substitute an invented HTTP endpoint — re-check the CLI's current docs and adjust the command, then continue.

- [ ] **Step 3: Commit**

```bash
git add actions/probe-publish-token
git commit -m "feat: probe-publish-token action via vendor verify-pat

Uses each CLI's own verify-pat with the token in env, never argv, and discards
all command output — these CLIs can echo request context in errors and this
runs in public logs. Our code never handles the token itself."
git push
```

---

## Task B1: Monorepo health classifiers

**Repo:** `nimbus-agent/Nimbus` · worktree `.claude/worktrees/npm-supply-chain-assurance` · branch `dev/asafgolombek/npm-supply-chain-assurance` (already exists, carries the spec commits)

**Files:**

- Modify: `scripts/release/check-secret-health.ts:58-85` (`HealthRow`, `summarize`)
- Modify: `scripts/release/check-secret-health.ts:313-377` (`import.meta.main` block)
- Modify: `scripts/release/check-secret-health.test.ts`

**Interfaces:**

- Consumes: the `status` output of `verify-npm-provenance` in monitor mode (Task A3), passed in as an env var — exactly like the existing `APP_MINT_STATUS` pattern.
- Produces:
  - `ProvenanceStatus = "ok" | "missing-provenance" | "source-mismatch" | "indeterminate" | "not-configured"`
  - `classifyProvenanceOutcome(status: string): ProvenanceStatus`
  - `classifySecretAbsence(value: string | undefined): "ok" | "present"`
  - Widened `HealthRow.kind` to include `"provenance" | "absence"`

- [ ] **Step 1: Write the failing tests**

Append to `scripts/release/check-secret-health.test.ts`:

```ts
import {
  classifyProvenanceOutcome,
  classifySecretAbsence,
  summarize,
  type HealthRow,
} from "./check-secret-health.ts";

describe("classifyProvenanceOutcome", () => {
  test("passes through the action's known statuses", () => {
    expect(classifyProvenanceOutcome("ok")).toBe("ok");
    expect(classifyProvenanceOutcome("missing-provenance")).toBe("missing-provenance");
    expect(classifyProvenanceOutcome("source-mismatch")).toBe("source-mismatch");
    expect(classifyProvenanceOutcome("indeterminate")).toBe("indeterminate");
  });

  test("fails closed: unset or unrecognised is never ok", () => {
    expect(classifyProvenanceOutcome("")).toBe("not-configured");
    expect(classifyProvenanceOutcome("weird")).toBe("indeterminate");
  });
});

describe("classifySecretAbsence", () => {
  test("absent secret is ok — that is the desired state", () => {
    expect(classifySecretAbsence(undefined)).toBe("ok");
    expect(classifySecretAbsence("")).toBe("ok");
  });

  test("a returned secret is present, which is a failure", () => {
    expect(classifySecretAbsence("npm_something")).toBe("present");
  });
});

describe("summarize with the new row kinds", () => {
  test("missing-provenance and source-mismatch are hard failures", () => {
    for (const status of ["missing-provenance", "source-mismatch"] as const) {
      const rows: HealthRow[] = [
        { name: "@nimbus-dev/sdk", kind: "provenance", status, detail: "latest" },
      ];
      expect(summarize(rows).hasHardFailure).toBe(true);
    }
  });

  test("a returned NPM_TOKEN is a hard failure", () => {
    const rows: HealthRow[] = [
      { name: "NPM_TOKEN", kind: "absence", status: "present", detail: "must not exist" },
    ];
    expect(summarize(rows).hasHardFailure).toBe(true);
  });

  test("provenance indeterminate warns but does not hard-fail", () => {
    const rows: HealthRow[] = [
      { name: "@nimbus-dev/sdk", kind: "provenance", status: "indeterminate", detail: "HTTP 503" },
    ];
    const s = summarize(rows);
    expect(s.hasHardFailure).toBe(false);
    expect(s.hasWarning).toBe(true);
  });

  test("all-clear stays clean", () => {
    const rows: HealthRow[] = [
      { name: "@nimbus-dev/sdk", kind: "provenance", status: "ok", detail: "latest" },
      { name: "NPM_TOKEN", kind: "absence", status: "ok", detail: "absent" },
    ];
    const s = summarize(rows);
    expect(s.hasHardFailure).toBe(false);
    expect(s.hasWarning).toBe(false);
  });
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `bun test scripts/release/check-secret-health.test.ts`

Expected: FAIL — `classifyProvenanceOutcome is not a function`

- [ ] **Step 3: Widen the row types and add the classifiers**

In `scripts/release/check-secret-health.ts`, replace the `HealthRow` interface (currently lines 58-63) with:

```ts
export type ProvenanceStatus =
  | "ok"
  | "missing-provenance"
  | "source-mismatch"
  | "indeterminate"
  | "not-configured";
export type AbsenceStatus = "ok" | "present";

/**
 * The `verify-npm-provenance` composite action runs in monitor mode before this
 * check and its `steps.<id>.outputs.status` is passed in via env — the same
 * shape as the App-mint probe above. Fail closed: an unset value means the step
 * never ran, and an unrecognised value is never silently "ok".
 */
export function classifyProvenanceOutcome(status: string): ProvenanceStatus {
  if (status === "") return "not-configured";
  if (
    status === "ok" ||
    status === "missing-provenance" ||
    status === "source-mismatch" ||
    status === "indeterminate"
  ) {
    return status;
  }
  return "indeterminate";
}

/**
 * Regression guard for a secret that must NOT exist. `NPM_TOKEN` was revoked and
 * deleted 2026-07-19; publishing is OIDC-only. An absent secret interpolates to
 * the empty string, so emptiness is the healthy state. Tests emptiness only —
 * the value is never logged or passed on.
 */
export function classifySecretAbsence(value: string | undefined): AbsenceStatus {
  return value === undefined || value.length === 0 ? "ok" : "present";
}

export interface HealthRow {
  readonly name: string;
  readonly kind: "pat" | "cert" | "provenance" | "absence";
  readonly status: PatStatus | CertStatus | ProvenanceStatus | AbsenceStatus;
  readonly detail: string;
}
```

Then in `summarize`, replace the `hard` set (currently line 71) with:

```ts
  const hard = new Set<string>([
    "dead",
    "insufficient",
    "expired",
    "missing-provenance",
    "source-mismatch",
    "present",
  ]);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `bun test scripts/release/check-secret-health.test.ts`

Expected: PASS — all tests including the pre-existing ones

- [ ] **Step 5: Wire the new rows into the entrypoint**

In the `import.meta.main` block, after the existing `appMintRow` definition (currently line 362-367), add:

```ts
  const provenanceRows: HealthRow[] = [
    {
      name: "@nimbus-dev/sdk",
      kind: "provenance",
      status: classifyProvenanceOutcome(process.env["SDK_PROVENANCE_STATUS"] ?? ""),
      detail: "latest published version",
    },
    {
      name: "@nimbus-dev/client",
      kind: "provenance",
      status: classifyProvenanceOutcome(process.env["CLIENT_PROVENANCE_STATUS"] ?? ""),
      detail: "latest published version",
    },
  ];
  const npmTokenRow: HealthRow = {
    name: "NPM_TOKEN",
    kind: "absence",
    status: classifySecretAbsence(process.env["NPM_TOKEN"]),
    detail: "revoked 2026-07-19; publishing is OIDC-only",
  };
```

Then change the `extraRows` argument (currently line 374) to:

```ts
    extraRows: [appMintRow, ...provenanceRows, npmTokenRow],
```

- [ ] **Step 6: Verify types and lint**

Run: `bun run preflight:fast`

Expected: PASS. If Biome reports the worktree issue from the known trap, validate instead with `bunx biome check scripts`.

- [ ] **Step 7: Commit**

```bash
git add scripts/release/check-secret-health.ts scripts/release/check-secret-health.test.ts
git commit -m "feat(secret-health): provenance + secret-absence health rows

Reuses the classifyAppMint pattern: the verify-npm-provenance action runs in
monitor mode and this classifies its output, so no checker logic is duplicated
in TypeScript. missing-provenance and source-mismatch are hard failures;
indeterminate only warns, so a registry hiccup cannot spam the issue filer.

Adds a regression guard asserting NPM_TOKEN stays absent — it is bound as env
and tested for emptiness only, since GITHUB_TOKEN cannot list repo secrets."
```

---

## Task B2: Monitor workflow and docs

**Files:**

- Modify: `.github/workflows/secret-health.yml`
- Modify: `docs/ci-secrets.md`

**Interfaces:**

- Consumes: `classifyProvenanceOutcome` / `classifySecretAbsence` env contract from B1 (`SDK_PROVENANCE_STATUS`, `CLIENT_PROVENANCE_STATUS`, `NPM_TOKEN`); the `verify-npm-provenance` action from A3.

- [ ] **Step 1: Resolve the pinned SHA of the actions PR merge commit**

```bash
gh api repos/nimbus-agent/.github/commits/main --jq '.sha'
```

Record this value; it is `5fb42792fa88287048fd24f704183b9a9b807a67` below. Task A3's PR must be merged first.

- [ ] **Step 2: Add the version-resolution and provenance probe steps**

In `.github/workflows/secret-health.yml`, insert this block after the "Mint release-bot token (health probe)" step and before "Run secret-health check". Add it exactly as written — the probes depend on the `versions` step id defined here.

```yaml
      - name: Resolve latest published versions
        id: versions
        run: |
          set -euo pipefail
          echo "sdk=$(npm view @nimbus-dev/sdk version)" >> "$GITHUB_OUTPUT"
          echo "client=$(npm view @nimbus-dev/client version)" >> "$GITHUB_OUTPUT"

      - name: Probe @nimbus-dev/sdk provenance
        id: sdk-provenance
        uses: nimbus-agent/.github/actions/verify-npm-provenance@5fb42792fa88287048fd24f704183b9a9b807a67
        with:
          package: "@nimbus-dev/sdk"
          version: ${{ steps.versions.outputs.sdk }}
          expected-repo: nimbus-agent/nimbus-sdk
          expected-workflow: .github/workflows/release.yml
          severity: monitor

      - name: Probe @nimbus-dev/client provenance
        id: client-provenance
        uses: nimbus-agent/.github/actions/verify-npm-provenance@5fb42792fa88287048fd24f704183b9a9b807a67
        with:
          package: "@nimbus-dev/client"
          version: ${{ steps.versions.outputs.client }}
          expected-repo: nimbus-agent/nimbus-client
          expected-workflow: .github/workflows/release.yml
          severity: monitor
```

Note there is no `expected-sha` here: the monitor checks whatever version is currently latest, whose commit is not knowable from this workflow. The release-time gate in Task C1 is where the commit is pinned.

- [ ] **Step 3: Wire the outputs into the check's environment**

In the "Run secret-health check" step's `env:` block, add:

```yaml
          SDK_PROVENANCE_STATUS: ${{ steps.sdk-provenance.outputs.status }}
          CLIENT_PROVENANCE_STATUS: ${{ steps.client-provenance.outputs.status }}
          NPM_TOKEN: ${{ secrets.NPM_TOKEN }}
```

`secrets.NPM_TOKEN` no longer exists, so it interpolates to the empty string — which is exactly the healthy state the absence guard asserts. Binding a deleted secret is intentional, not an oversight.

- [ ] **Step 4: Validate the workflow parses**

```bash
bunx --yes @action-validator/cli@latest .github/workflows/secret-health.yml || \
  python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/secret-health.yml')); print('yaml ok')"
```

Expected: no parse errors.

- [ ] **Step 5: Update `docs/ci-secrets.md`**

Add this section (place it after the existing npm/OIDC paragraph near line 197-201):

````markdown
### npm provenance verification

Both `@nimbus-dev/sdk` and `@nimbus-dev/client` publish via OIDC trusted
publishing and carry two attestations: the npm publish attestation and a
SLSA provenance predicate naming the source repo, workflow, and commit.

Publishing access on both packages is set to **require two-factor
authentication and disallow tokens**, so OIDC is the only path that can
publish — a leaked token cannot. `NPM_TOKEN` was revoked and deleted on
2026-07-19; the weekly secret-health run asserts it stays absent.

Verify a published version yourself:

```bash
npm audit signatures                       # registry signature verification
curl -s "https://registry.npmjs.org/-/npm/v1/attestations/@nimbus-dev/sdk@1.3.0" \
  | jq -r '.attestations[].predicateType'  # expect both predicates
```

The release workflows gate on this automatically: a pre-publish preflight
asserts OIDC is available and npm meets the 11.5.1 floor, and a post-publish
step fails the release if provenance is missing or names the wrong source.

### Publish PATs that cannot yet be retired

| Secret | Repo | Owner | Notes |
| --- | --- | --- | --- |
| `VSCE_PAT` | `nimbus-vscode` | @AsafGolombek | Azure DevOps PAT. ⚠️ **Global ADO PATs are decommissioned 2026-12-01** and cannot be regenerated since 2026-03-15. Marketplace trusted publishing is unshipped (microsoft/vsmarketplace#1422). |
| `OVSX_PAT` | `nimbus-vscode` | @AsafGolombek | Open VSX token. No OIDC path exists (eclipse-openvsx/openvsx#1534); rotation is the only mitigation. |

Both are probed weekly for liveness by `nimbus-vscode`'s own `secret-health.yml`.
````

- [ ] **Step 6: Lint the docs**

Run: `bunx markdownlint-cli2 --config .markdownlint-cli2.jsonc docs/ci-secrets.md`

Expected: `Summary: 0 error(s)`

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/secret-health.yml docs/ci-secrets.md
git commit -m "feat(secret-health): weekly npm provenance monitoring

Runs verify-npm-provenance in monitor mode for both packages and feeds the
result into the existing de-duped issue filer. Binds the deleted NPM_TOKEN
secret deliberately: it interpolates empty, which is the healthy state the
absence guard asserts.

Documents the provenance verification recipe and the two publish PATs that
cannot be retired, including the 2026-12-01 ADO decommission deadline."
```

---

## Task C1: Satellite release gates (`nimbus-sdk` and `nimbus-client`)

**Repos:** `nimbus-agent/nimbus-sdk`, then `nimbus-agent/nimbus-client` — identical change, applied twice.

**Files:**

- Modify: `.github/workflows/release.yml` (publish job)

**Interfaces:**

- Consumes: `verify-npm-provenance` at `5fb42792fa88287048fd24f704183b9a9b807a67` (Task A3).

**Per-repo values** — do not mix these up:

| Repo | `expected-repo` | package |
| --- | --- | --- |
| `nimbus-sdk` | `nimbus-agent/nimbus-sdk` | `@nimbus-dev/sdk` |
| `nimbus-client` | `nimbus-agent/nimbus-client` | `@nimbus-dev/client` |

- [ ] **Step 1: Clone and branch (repeat per repo)**

```bash
git clone https://github.com/nimbus-agent/nimbus-sdk.git
cd nimbus-sdk
git switch -c dev/asafgolombek/provenance-gate
```

- [ ] **Step 2: Add the pre-publish preflight**

In `.github/workflows/release.yml`, insert immediately **before** the "Publish to npm with provenance" step:

```yaml
      # Catch the two dominant causes of silent provenance degradation BEFORE
      # publishing. npm cannot unpublish after 72h, so a post-publish failure
      # reports damage rather than preventing it.
      - name: Preflight — OIDC available and npm meets the trusted-publishing floor
        run: |
          set -euo pipefail
          if [ -z "${ACTIONS_ID_TOKEN_REQUEST_TOKEN:-}" ]; then
            echo "::error::ACTIONS_ID_TOKEN_REQUEST_TOKEN is unset — the job lacks 'id-token: write'."
            echo "::error::Publishing now would succeed WITHOUT provenance and cannot be undone after 72h."
            exit 1
          fi
          have="$(npm --version)"
          need="11.5.1"
          # `sort -V` is a GNU coreutils extension. Both satellites run on
          # ubuntu-24.04, where it is guaranteed. If this job is ever moved to a
          # macOS runner, BSD sort has no -V and this comparison breaks — switch
          # to `gsort` or a Node one-liner at that point.
          if [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -n1)" != "$need" ]; then
            echo "::error::npm $have is below the $need floor required for OIDC trusted publishing."
            exit 1
          fi
          echo "preflight ok: OIDC token present, npm $have >= $need"
```

- [ ] **Step 3: Resolve the published version and verify after publishing**

Insert immediately **after** the "Publish to npm with provenance" step:

```yaml
      - name: Resolve published version
        id: published
        run: echo "version=$(node -p "require('./package.json').version")" >> "$GITHUB_OUTPUT"

      - name: Verify npm signatures (cryptographic)
        run: npm audit signatures

      - name: Verify provenance names this repo, workflow and commit
        uses: nimbus-agent/.github/actions/verify-npm-provenance@5fb42792fa88287048fd24f704183b9a9b807a67
        with:
          package: "@nimbus-dev/sdk"
          version: ${{ steps.published.outputs.version }}
          expected-repo: nimbus-agent/nimbus-sdk
          expected-workflow: .github/workflows/release.yml
          expected-sha: ${{ github.sha }}
          severity: gate
```

**For `nimbus-client`,** use `package: "@nimbus-dev/client"` and `expected-repo: nimbus-agent/nimbus-client`. Everything else is identical.

- [ ] **Step 4: Validate the workflow parses**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"
```

Expected: `yaml ok`

- [ ] **Step 5: Verify the preflight logic locally**

The version comparison is the only non-trivial line; confirm it behaves:

```bash
for have in 11.5.0 11.5.1 11.9.0 12.0.0; do
  need=11.5.1
  if [ "$(printf '%s\n%s\n' "$need" "$have" | sort -V | head -n1)" != "$need" ]; then
    echo "$have -> REJECT"
  else
    echo "$have -> accept"
  fi
done
```

Expected:

```text
11.5.0 -> REJECT
11.5.1 -> accept
11.9.0 -> accept
12.0.0 -> accept
```

- [ ] **Step 6: Commit and open the PR**

```bash
git add .github/workflows/release.yml
git commit -m "ci: gate releases on npm provenance

Pre-publish preflight asserts OIDC is available and npm meets the 11.5.1
trusted-publishing floor — the two dominant causes of silent degradation,
both detectable before the irreversible step. Post-publish, npm audit
signatures verifies cryptographically and verify-npm-provenance asserts the
SLSA source claim names this repo, workflow and commit."
git push -u origin dev/asafgolombek/provenance-gate
gh pr create --fill
```

- [ ] **Step 7: Repeat Steps 1-6 for `nimbus-client`**

Use the `nimbus-client` row from the table above. Do not copy the `nimbus-sdk` values.

---

## Task D1: `nimbus-vscode` health, attestation, and deadline issue

**Repo:** `nimbus-agent/nimbus-vscode` · branch `dev/asafgolombek/publish-token-health`

**Files:**

- Create: `.github/workflows/secret-health.yml`
- Modify: `.github/workflows/publish.yml`
- Modify: `README.md`

**Interfaces:**

- Consumes: `probe-publish-token` at `5fb42792fa88287048fd24f704183b9a9b807a67` (Task A4).

- [ ] **Step 1: Create the health workflow**

The secrets stay where they are. Copying `VSCE_PAT`/`OVSX_PAT` into the monorepo to centralise monitoring would spread credentials to save a workflow file — a net loss.

Create `.github/workflows/secret-health.yml`:

```yaml
name: Secret health

on:
  schedule:
    - cron: "0 9 * * 1" # Mondays 09:00 UTC, matching the monorepo monitor
  workflow_dispatch:

permissions:
  contents: read

jobs:
  check:
    name: Probe publish credentials
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    environment: release
    permissions:
      contents: read
      issues: write
    steps:
      - name: Harden Runner
        uses: step-security/harden-runner@bf7454d06d71f1098171f2acdf0cd4708d7b5920 # v2.20.0
        with:
          egress-policy: audit

      - name: Probe VSCE_PAT
        id: vsce
        uses: nimbus-agent/.github/actions/probe-publish-token@5fb42792fa88287048fd24f704183b9a9b807a67
        with:
          tool: vsce
          namespace: nimbus-agent
        env:
          PUBLISH_TOKEN: ${{ secrets.VSCE_PAT }}

      - name: Probe OVSX_PAT
        id: ovsx
        uses: nimbus-agent/.github/actions/probe-publish-token@5fb42792fa88287048fd24f704183b9a9b807a67
        with:
          tool: ovsx
          namespace: nimbus-agent
        env:
          PUBLISH_TOKEN: ${{ secrets.OVSX_PAT }}

      - name: Report
        env:
          GH_TOKEN: ${{ github.token }}
          VSCE_STATUS: ${{ steps.vsce.outputs.status }}
          OVSX_STATUS: ${{ steps.ovsx.outputs.status }}
        run: |
          set -euo pipefail
          echo "| Credential | Status |" >> "$GITHUB_STEP_SUMMARY"
          echo "|---|---|" >> "$GITHUB_STEP_SUMMARY"
          echo "| VSCE_PAT | ${VSCE_STATUS} |" >> "$GITHUB_STEP_SUMMARY"
          echo "| OVSX_PAT | ${OVSX_STATUS} |" >> "$GITHUB_STEP_SUMMARY"

          # Mirror the monorepo's warn/hard split. Only `dead` is a hard failure —
          # `indeterminate` means we could not reach the service, which is NOT
          # evidence the token is revoked. Filing a revocation alert on a network
          # blip trains the operator to ignore the alarm.
          # Both tokens are REQUIRED to publish this extension, so `dead` and
          # `not-configured` are both hard failures here — but they are reported
          # distinctly, because "revoked" and "never provisioned" need different
          # remedies. `indeterminate` means we could not reach the service, which
          # is NOT evidence about the token; it only warns.
          hard=""
          for s in "${VSCE_STATUS}" "${OVSX_STATUS}"; do
            case "$s" in dead|not-configured) hard="yes" ;; esac
          done

          if [ -n "$hard" ]; then
            title="🔑 Publish credential health alert"
            existing="$(gh issue list --state open --search "$title" --json number --jq '.[0].number // empty')"
            body="VSCE_PAT=${VSCE_STATUS}, OVSX_PAT=${OVSX_STATUS}. \`dead\` = the marketplace rejected a configured token (rotate it); \`not-configured\` = the secret is missing entirely (provision it — do NOT rotate). Either blocks the next extension release. Cross-check the marketplace status page first — see docs/ci-secrets.md in the Nimbus monorepo."
            if [ -n "$existing" ]; then
              gh issue comment "$existing" --body "$body"
            else
              gh issue create --title "$title" --body "$body"
            fi
            exit 1
          fi

          if [ "${VSCE_STATUS}" != "ok" ] || [ "${OVSX_STATUS}" != "ok" ]; then
            echo "::warning::probe inconclusive (VSCE_PAT=${VSCE_STATUS}, OVSX_PAT=${OVSX_STATUS}) — service unreachable, not a revocation signal"
            exit 0
          fi
          echo "both publish credentials healthy"
```

- [ ] **Step 2: Attest the `.vsix`**

In `.github/workflows/publish.yml`, add `attestations: write` and `id-token: write` to the `publish` job's `permissions:` block, so it reads:

```yaml
    permissions:
      contents: read
      id-token: write
      attestations: write
```

Then insert immediately **after** the "Package .vsix" step:

```yaml
      # Verifiable for anyone who downloads the .vsix from the GitHub Release.
      # The Marketplace does its own repository signing and does not surface
      # this attestation; we do not claim it covers a Marketplace download.
      - name: Attest .vsix build provenance
        uses: actions/attest-build-provenance@a2bbfa25375fe432b6a289bc6b6cd05ecd0c4c32 # v4.1.0
        with:
          subject-path: dist-vsix/nimbus-${{ steps.version.outputs.version }}.vsix
```

- [ ] **Step 3: Document verification in `README.md`**

Add this section:

````markdown
## Verifying a release

Every release attaches a signed `.vsix` to the GitHub Release with a build
provenance attestation. To verify the file you downloaded was built by this
repository's publish workflow:

```bash
gh attestation verify nimbus-<version>.vsix --repo nimbus-agent/nimbus-vscode
```

This covers the `.vsix` attached to the **GitHub Release**. The Visual Studio
Marketplace performs its own repository signing, which VS Code verifies at
install time; that is a separate mechanism and this attestation is not
surfaced through it.
````

- [ ] **Step 4: Validate and lint**

```bash
python -c "import yaml; yaml.safe_load(open('.github/workflows/secret-health.yml')); yaml.safe_load(open('.github/workflows/publish.yml')); print('yaml ok')"
npx --yes markdownlint-cli2 README.md
```

Expected: `yaml ok`, then `Summary: 0 error(s)`

- [ ] **Step 5: Trigger the health workflow once to confirm the probes work**

Merge the PR first, then:

```bash
gh workflow run secret-health.yml --repo nimbus-agent/nimbus-vscode
sleep 60
gh run list --workflow secret-health.yml --repo nimbus-agent/nimbus-vscode --limit 1
```

Expected: a completed run. **Read the step summary** and interpret it precisely:

| Reported | Meaning | Action |
| --- | --- | --- |
| `ok` | Token valid | Nothing |
| `dead` | Service reachable and rejected the token | **A real finding** — the token is already expired and the next release would have failed. Report it; do not adjust the probe to pass. |
| `not-configured` | The secret is unset | The secret was never provisioned or has been deleted. Provision it — do **not** rotate a credential that does not exist. |
| `indeterminate` | Service unreachable — no signal either way | Re-run once. If it persists, check the marketplace status page before concluding anything about the token. |

- [ ] **Step 6: File the deadline issue**

```bash
gh issue create --repo nimbus-agent/nimbus-vscode \
  --title "Determine VSCE_PAT scope before the 2026-12-01 ADO global-PAT decommission" \
  --body "$(cat <<'EOF'
Global Azure DevOps PATs were blocked from creation on 2026-03-15 and are
decommissioned on **2026-12-01**. If our `VSCE_PAT` is a global PAT, Marketplace
publishing breaks then and the PAT **cannot be regenerated**.

Investigate in this order — the cheap answer may end it:

1. **Is the current `VSCE_PAT` global or org-scoped?** Check its scope in Azure
   DevOps user settings. If org-scoped, the decommission may not apply at all.
2. **Is an org-scoped PAT accepted for Marketplace publishing?** This is the
   pivotal unknown: https://github.com/microsoft/vscode/issues/322741 (open,
   unanswered). If yes, an org-scoped PAT is the fallback and **no Azure tenant
   is needed** — this becomes a credential swap, not an infrastructure project.
3. **Only if both answers are unfavourable**, price the token-less path:
   `azure/login` (GitHub OIDC → federated credential on an Entra user-assigned
   managed identity) + `vsce publish --azure-credential`. This requires an Azure
   subscription and tenant, and for GitHub Actions it is community-documented,
   not officially supported.

Context: true Marketplace trusted publishing is an open, unassigned feature
request (https://github.com/microsoft/vsmarketplace/issues/1422). Open VSX has
no OIDC path at all (https://github.com/eclipse-openvsx/openvsx/issues/1534), so
`OVSX_PAT` remains long-lived regardless; rotation is its only mitigation.

Weekly liveness probes now run in `.github/workflows/secret-health.yml`, so a
dead token surfaces within 7 days instead of at the next release.
EOF
)"
```

- [ ] **Step 7: Commit and open the PR**

```bash
git add .github/workflows/secret-health.yml .github/workflows/publish.yml README.md
git commit -m "ci: probe publish credentials weekly, attest the .vsix

VSCE_PAT and OVSX_PAT cannot be retired — Marketplace trusted publishing is
unshipped and Open VSX has no OIDC path — so probe them where the secrets
already live rather than copying credentials into the monorepo. A dead token
now surfaces within 7 days instead of at the next release.

Attests the .vsix and documents gh attestation verify for the GitHub Release
copy, without claiming it covers a Marketplace download."
git push -u origin dev/asafgolombek/publish-token-health
gh pr create --fill
```

---

## Task E1: Close out

- [ ] **Step 1: Confirm every PR is green and merged**

```bash
for r in .github Nimbus nimbus-sdk nimbus-client nimbus-vscode; do
  echo "=== $r ==="
  gh pr list --repo "nimbus-agent/$r" --state open --json number,title,statusCheckRollup \
    --jq '.[] | "\(.number) \(.title) \(.statusCheckRollup | map(.conclusion) | unique)"'
done
```

Expected: no open PRs from this plan. Do not merge anything not fully green.

- [ ] **Step 2: Trigger the monorepo monitor and confirm the new rows appear**

```bash
gh workflow run secret-health.yml --repo nimbus-agent/Nimbus
sleep 90
gh run list --workflow secret-health.yml --repo nimbus-agent/Nimbus --limit 1
```

Expected: the step summary table contains `@nimbus-dev/sdk | provenance | ok`, `@nimbus-dev/client | provenance | ok`, and `NPM_TOKEN | absence | ok`.

- [ ] **Step 3: Update the spec's cleanup table**

Mark row 4 (the regression assertion) as done in
`docs/superpowers/specs/2026-07-19-npm-supply-chain-assurance-design.md`, then commit.

- [ ] **Step 4: Record the outcome in `docs/CHANGELOG.md`**

Follow the connector-docs convention: log the delivery in `docs/CHANGELOG.md`, not the `CLAUDE.md` status line.

---

## Verification Gate

Do not report this plan complete until all of the following hold:

- [ ] `node --test "actions/**/test/*.test.js"` passes in `nimbus-agent/.github` (26 tests)
- [ ] `bun test scripts/release/check-secret-health.test.ts` passes in the monorepo
- [ ] `bun run preflight:fast` passes in the monorepo worktree
- [ ] The live smoke test in Task A3 Step 6 returns `ok` / exit 0 for the real package **and** exit 1 for the wrong-repo case
- [ ] `nimbus-vscode`'s `secret-health.yml` has completed one real run with both credentials `ok`
- [ ] The monorepo `secret-health.yml` has completed one real run showing all three new rows
- [ ] All five PRs merged green

**Do not claim success on any step you have not actually run.** If a check fails, fix the cause — never adjust the check to pass.
