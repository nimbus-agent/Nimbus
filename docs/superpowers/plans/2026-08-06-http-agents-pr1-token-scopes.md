# HTTP API Token Scopes (PR 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give the gateway's HTTP bearer tokens a scope field, so that the agent-invocation, resolve-by-URL and fetch routes landing in PRs 2–4 cannot be reached by a token minted to clip a web page.

**Architecture:** The Vault map `http_api.web_clipper_tokens` changes value shape from a bare token string to `{token, scopes[]}`, with the bare string still parsed as a legacy record granting exactly `["clip","briefs"]`. A new route→auth table declares the required scope for every HTTP route — including the public ones — and a completeness test source-scans the server for route literals so a route cannot join the surface without a decision. Enforcement happens at the three existing sites that verify a clip token.

**Tech Stack:** Bun v1.2+, TypeScript strict, `bun:test`, `bun:sqlite`, Biome.

## Global Constraints

- **No `any`** — use `unknown` for external data. TypeScript strict is non-negotiable.
- **No plaintext credentials** in logs, IPC responses, or config. `listApiTokens` returns fingerprints, never token values.
- **Constant-time compare** for token matching (`I10`): `constantTimeStringEqual` from `util/timing-safe-compare.ts`. The verify loop must **never** `break` or early-return on match — it iterates every entry and records the match, so loop timing leaks neither token count nor position.
- **`CLIP_TOKENS_VAULT_KEY` must remain the literal `"http_api.web_clipper_tokens"`.** It is on `VAULT_KEY_ALLOW_LIST` (`scripts/structure-audit/check-nimbus-invariants.ts:30`) and every already-paired browser's token lives under it. Renaming it strands them.
- **Legacy tokens gain nothing.** A pre-scopes token resolves to exactly `["clip","briefs"]` — never `agents`, `resolve` or `fetch`.
- **Cross-platform:** `path.join()` / `os.tmpdir()`, never hardcoded separators.
- **Commit on the branch `dev/asaf/spec-http-agents-route`** in worktree `.claude/worktrees/http-agents`. Never on `main`.
- Run `bun run preflight:fast` after each task; the full `bun run preflight` before the PR.

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/clips/api-scopes.ts` (create) | The scope vocabulary and `LEGACY_SCOPES`. Dependency-free so both the token store and the route table can import it without a cycle. |
| `packages/gateway/src/clips/clip-token-store.ts` (modify) | Record parsing, load/add/verify/list over the new shape. Keeps the Vault key. |
| `packages/gateway/src/clips/pairing-window.ts` (modify) | A window carries the scopes the minted token will get. |
| `packages/gateway/src/ipc/http-route-auth.ts` (create) | The route→auth table + `hasScope` + the 403 body builder. |
| `packages/gateway/src/ipc/http-route-auth.test.ts` (create) | Completeness guard: every route literal in the server has a table entry. |
| `packages/gateway/src/ipc/http-write-routes.ts` (modify) | Scope check for clip-kind write routes. |
| `packages/gateway/src/ipc/http-server.ts` (modify) | Scope check for the two bearer-gated reads; pass scopes when minting. |
| `packages/gateway/src/ipc/clip-rpc.ts` (modify) | `clip.pair` accepts scopes; new `clip.scopes`; `clip.status` reports them. |
| `packages/cli/src/commands/clip.ts` (modify) | `--scopes` on pair; new `nimbus clip scopes` subcommand. |

---

### Task 1: Scope vocabulary and token-record parsing

**Files:**
- Create: `packages/gateway/src/clips/api-scopes.ts`
- Modify: `packages/gateway/src/clips/clip-token-store.ts`
- Test: `packages/gateway/src/clips/clip-token-store.test.ts` (modify), `packages/gateway/src/clips/api-scopes.test.ts` (create)

**Interfaces:**
- Consumes: nothing from earlier tasks.
- Produces:
  - `API_SCOPES: readonly ["clip","briefs","agents","resolve","fetch"]`, `type ApiScope`
  - `LEGACY_SCOPES: readonly ApiScope[]`
  - `isApiScope(v: unknown): v is ApiScope`
  - `type ApiTokenRecord = { readonly token: string; readonly scopes: readonly ApiScope[] }`
  - `type ApiTokenMap = Record<string, ApiTokenRecord>`
  - `loadApiTokens(vault: NimbusVault): Promise<ApiTokenMap>`
  - `addApiToken(vault: NimbusVault, label: string, token: string, scopes: readonly ApiScope[]): Promise<void>`
  - `verifyApiToken(vault: NimbusVault, presented: string): Promise<{ label: string; scopes: readonly ApiScope[] } | null>`
  - `listApiTokens(vault: NimbusVault): Promise<Array<{ label: string; fingerprint: string; scopes: readonly ApiScope[] }>>`
  - `setApiTokenScopes(vault: NimbusVault, label: string, scopes: readonly ApiScope[]): Promise<boolean>`
  - **Unchanged and NOT renamed:** `revokeClipToken`, `generateClipToken`, `CLIP_TOKENS_VAULT_KEY`.

> **Why only four renames.** Rename exactly the functions whose contract changes shape — `load`, `add`, `verify`, `list`. `revokeClipToken` and `generateClipToken` are untouched by scopes, and renaming them would add churn to a security-sensitive file for symmetry alone. The compiler finding every call site is the point of renaming; there is nothing to find for the other two.

- [ ] **Step 1: Write the failing test for the scope vocabulary**

Create `packages/gateway/src/clips/api-scopes.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { API_SCOPES, isApiScope, LEGACY_SCOPES } from "./api-scopes.ts";

describe("api-scopes", () => {
  test("the vocabulary is exactly the five scopes, in declaration order", () => {
    expect([...API_SCOPES]).toEqual(["clip", "briefs", "agents", "resolve", "fetch"]);
  });

  test("LEGACY_SCOPES grants exactly what a pre-scopes token could already do", () => {
    // The whole point of the migration: a token in the wild gains NOTHING.
    expect([...LEGACY_SCOPES]).toEqual(["clip", "briefs"]);
    expect(LEGACY_SCOPES).not.toContain("agents");
    expect(LEGACY_SCOPES).not.toContain("resolve");
    expect(LEGACY_SCOPES).not.toContain("fetch");
  });

  test("isApiScope accepts known scopes and rejects everything else", () => {
    expect(isApiScope("agents")).toBe(true);
    expect(isApiScope("admin")).toBe(false);
    expect(isApiScope("")).toBe(false);
    expect(isApiScope(null)).toBe(false);
    expect(isApiScope(42)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to confirm it fails**

Run: `bun test packages/gateway/src/clips/api-scopes.test.ts`
Expected: FAIL — `Cannot find module './api-scopes.ts'`.

- [ ] **Step 3: Create the scope vocabulary**

Create `packages/gateway/src/clips/api-scopes.ts`:

```ts
/**
 * What a local HTTP API bearer token is allowed to reach.
 *
 * Kept in its own dependency-free module so both the token store and the route→auth table can
 * import it without a cycle.
 *
 * `clip` and `briefs` are the surfaces that shipped before scopes existed; `agents`, `resolve` and
 * `fetch` are the ones this design adds. That split is not cosmetic — it is exactly the boundary
 * LEGACY_SCOPES draws.
 */
export const API_SCOPES = ["clip", "briefs", "agents", "resolve", "fetch"] as const;

export type ApiScope = (typeof API_SCOPES)[number];

/**
 * What a token stored in the pre-scopes bare-string form is granted on upgrade: exactly what it
 * could already do, and nothing this design adds.
 *
 * Granting all scopes here would be the easy migration and the wrong one — it would hand every
 * token already in the wild the ability to run any read-only agent over the whole index and to
 * resolve any URL, which is precisely the escalation scopes exist to prevent
 * (docs/ecosystem-roadmap.md: "Add scopes before the second consumer, not the fifth").
 */
export const LEGACY_SCOPES: readonly ApiScope[] = Object.freeze<ApiScope[]>(["clip", "briefs"]);

export function isApiScope(v: unknown): v is ApiScope {
  return typeof v === "string" && (API_SCOPES as readonly string[]).includes(v);
}
```

- [ ] **Step 4: Run it to confirm it passes**

Run: `bun test packages/gateway/src/clips/api-scopes.test.ts`
Expected: PASS, 3 tests.

- [ ] **Step 5: Write the failing tests for record parsing**

Append to `packages/gateway/src/clips/clip-token-store.test.ts`, inside the existing `describe("clip-token-store", …)` block. Add `loadApiTokens`, `addApiToken`, `verifyApiToken`, `listApiTokens`, `setApiTokenScopes` to the import from `./clip-token-store.ts`, and add `import { LEGACY_SCOPES } from "./api-scopes.ts";`:

```ts
  test("a legacy bare-string entry parses as a record with LEGACY_SCOPES only", async () => {
    const v = fakeVault();
    // Exactly the on-disk shape written by every gateway before this change.
    await v.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify({ chrome: "tok-legacy" }));
    expect(await loadApiTokens(v)).toEqual({
      chrome: { token: "tok-legacy", scopes: LEGACY_SCOPES },
    });
  });

  test("a legacy token is REJECTED for a scope this design adds", async () => {
    const v = fakeVault();
    await v.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify({ chrome: "tok-legacy" }));
    const verified = await verifyApiToken(v, "tok-legacy");
    expect(verified).not.toBeNull();
    expect(verified?.scopes).toEqual(LEGACY_SCOPES);
    expect(verified?.scopes).not.toContain("agents");
  });

  test("addApiToken round-trips the scope list", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "tok-1", ["clip", "agents"]);
    expect(await loadApiTokens(v)).toEqual({
      chrome: { token: "tok-1", scopes: ["clip", "agents"] },
    });
  });

  test("unknown scopes in a stored record are dropped, not carried", async () => {
    const v = fakeVault();
    // A record written by a NEWER binary that knows a scope this one does not.
    await v.set(
      CLIP_TOKENS_VAULT_KEY,
      JSON.stringify({ chrome: { token: "t", scopes: ["clip", "telepathy"] } }),
    );
    const loaded = await loadApiTokens(v);
    // Dropped rather than preserved: an unrecognised scope this binary cannot enforce must not
    // be treated as granting anything. Fail closed.
    expect(loaded["chrome"]?.scopes).toEqual(["clip"]);
  });

  test("a malformed entry is dropped entirely rather than defaulting to a grant", async () => {
    const v = fakeVault();
    await v.set(
      CLIP_TOKENS_VAULT_KEY,
      JSON.stringify({ good: "tok-ok", bad: { scopes: ["clip"] }, alsoBad: 7 }),
    );
    const loaded = await loadApiTokens(v);
    expect(Object.keys(loaded)).toEqual(["good"]);
  });

  test("verifyApiToken returns label AND scopes for a scoped record", async () => {
    const v = fakeVault();
    await addApiToken(v, "firefox", "tok-3", ["clip", "briefs", "agents"]);
    expect(await verifyApiToken(v, "tok-3")).toEqual({
      label: "firefox",
      scopes: ["clip", "briefs", "agents"],
    });
    expect(await verifyApiToken(v, "wrong")).toBeNull();
  });

  test("listApiTokens reports scopes and a fingerprint, never the token value", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "tok-secret", ["clip"]);
    const out = await listApiTokens(v);
    expect(out).toEqual([{ label: "chrome", fingerprint: expect.any(String), scopes: ["clip"] }]);
    expect(JSON.stringify(out)).not.toContain("tok-secret");
  });

  test("setApiTokenScopes rewrites scopes in place and leaves the token value untouched", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "tok-keep", ["clip"]);
    expect(await setApiTokenScopes(v, "chrome", ["clip", "agents"])).toBe(true);
    expect(await loadApiTokens(v)).toEqual({
      chrome: { token: "tok-keep", scopes: ["clip", "agents"] },
    });
    // A paired client must keep working across a scope edit.
    expect(await verifyApiToken(v, "tok-keep")).not.toBeNull();
  });

  test("setApiTokenScopes can NARROW, and reports false for an unknown label", async () => {
    const v = fakeVault();
    await addApiToken(v, "chrome", "t", ["clip", "agents"]);
    expect(await setApiTokenScopes(v, "chrome", ["clip"])).toBe(true);
    expect((await loadApiTokens(v))["chrome"]?.scopes).toEqual(["clip"]);
    expect(await setApiTokenScopes(v, "nope", ["clip"])).toBe(false);
  });
```

> **Note on the existing tests in this file:** the four that assert `loadClipTokens(v)` equals a bare-string map (e.g. `{ "chrome-work": "tok-abc" }`) must be updated to `loadApiTokens` and the record shape, and `verifyClipToken` → `verifyApiToken`. Do that in Step 7, not now — they should fail first.

- [ ] **Step 6: Run to confirm the new tests fail**

Run: `bun test packages/gateway/src/clips/clip-token-store.test.ts`
Expected: FAIL — `loadApiTokens is not a function` (and similar) on the new tests.

- [ ] **Step 7: Rewrite the token store over the record shape**

Replace the body of `packages/gateway/src/clips/clip-token-store.ts` with:

```ts
import { randomBytes } from "node:crypto";
import { tokenFingerprint } from "../ipc/http-auth.ts";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { type ApiScope, isApiScope, LEGACY_SCOPES } from "./api-scopes.ts";

/**
 * Vault key holding the paired-client token map.
 *
 * The name is HISTORICAL. This map started as web-clipper-only and now backs every bearer-authed
 * HTTP surface (clips, research briefs, and from PR 2 onward agents/resolve/fetch). It is NOT
 * renamed: the key is on VAULT_KEY_ALLOW_LIST, and every already-paired browser's token lives
 * under it — a rename would strand them all for a cosmetic gain.
 */
export const CLIP_TOKENS_VAULT_KEY = "http_api.web_clipper_tokens";

export type ApiTokenRecord = {
  readonly token: string;
  readonly scopes: readonly ApiScope[];
};

export type ApiTokenMap = Record<string, ApiTokenRecord>;

/**
 * Parses one stored entry, in either the legacy or the scoped form.
 *
 * Returns null for anything unrecognised, and the caller DROPS that label. Dropping is the
 * fail-closed choice: a malformed entry that defaulted to a grant would be a credential nobody
 * can see in `clip status` but that still opens doors.
 */
function parseEntry(v: unknown): ApiTokenRecord | null {
  // Legacy: a bare token string, written by every gateway before scopes existed.
  if (typeof v === "string") {
    return v === "" ? null : { token: v, scopes: LEGACY_SCOPES };
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) return null;
  const rec = v as { token?: unknown; scopes?: unknown };
  if (typeof rec.token !== "string" || rec.token === "") return null;
  if (!Array.isArray(rec.scopes)) return null;
  // Unknown scopes are DROPPED, not preserved. A record written by a newer binary may name a
  // scope this one cannot enforce; carrying it forward would let it read as granted.
  return { token: rec.token, scopes: rec.scopes.filter(isApiScope) };
}

export async function loadApiTokens(vault: NimbusVault): Promise<ApiTokenMap> {
  const raw = await vault.get(CLIP_TOKENS_VAULT_KEY);
  if (raw === null || raw === "") return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
  const out: Record<string, ApiTokenRecord> = {};
  for (const [label, entry] of Object.entries(parsed as Record<string, unknown>)) {
    const rec = parseEntry(entry);
    if (rec !== null) out[label] = rec;
  }
  return out;
}

async function saveApiTokens(vault: NimbusVault, map: ApiTokenMap): Promise<void> {
  await vault.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify(map));
}

export async function addApiToken(
  vault: NimbusVault,
  label: string,
  token: string,
  scopes: readonly ApiScope[],
): Promise<void> {
  const map = await loadApiTokens(vault);
  map[label] = { token, scopes };
  await saveApiTokens(vault, map);
}

/** Rewrites one label's scopes, leaving its token value alone. False when the label is unknown. */
export async function setApiTokenScopes(
  vault: NimbusVault,
  label: string,
  scopes: readonly ApiScope[],
): Promise<boolean> {
  const map = await loadApiTokens(vault);
  const existing = map[label];
  if (existing === undefined) return false;
  map[label] = { token: existing.token, scopes };
  await saveApiTokens(vault, map);
  return true;
}

export async function revokeClipToken(vault: NimbusVault, label: string): Promise<number> {
  const map = await loadApiTokens(vault);
  if (label === "*") {
    const n = Object.keys(map).length;
    await vault.delete(CLIP_TOKENS_VAULT_KEY);
    return n;
  }
  if (!(label in map)) return 0;
  delete map[label];
  await saveApiTokens(vault, map);
  return 1;
}

export async function listApiTokens(
  vault: NimbusVault,
): Promise<Array<{ label: string; fingerprint: string; scopes: readonly ApiScope[] }>> {
  const map = await loadApiTokens(vault);
  return Object.entries(map).map(([label, rec]) => ({
    label,
    fingerprint: tokenFingerprint(rec.token),
    scopes: rec.scopes,
  }));
}

export async function verifyApiToken(
  vault: NimbusVault,
  presented: string,
): Promise<{ label: string; scopes: readonly ApiScope[] } | null> {
  const map = await loadApiTokens(vault);
  // Constant-time across EVERY entry; never short-circuit or break (a break would leak token
  // count/presence via loop timing). The scope read happens only AFTER the loop, off the
  // recorded match, so it cannot reintroduce a data-dependent branch inside the compare.
  let matched: { label: string; scopes: readonly ApiScope[] } | null = null;
  for (const [label, rec] of Object.entries(map)) {
    if (constantTimeStringEqual(presented, rec.token)) {
      matched = { label, scopes: rec.scopes };
    }
  }
  return matched;
}

export function generateClipToken(): string {
  return randomBytes(32).toString("hex");
}
```

- [ ] **Step 8: Update the pre-existing tests in that file to the new names and shape**

In `clip-token-store.test.ts`, update the imports and these existing assertions:
- `loadClipTokens` → `loadApiTokens` everywhere.
- `addClipToken(v, "chrome-work", "tok-abc")` → `addApiToken(v, "chrome-work", "tok-abc", ["clip"])`, and the expectation becomes `{ "chrome-work": { token: "tok-abc", scopes: ["clip"] } }`.
- The rotation test: both `addApiToken(v, "chrome", "tok-1", ["clip"])` and `…"tok-2", ["clip"]`; expectation `{ chrome: { token: "tok-2", scopes: ["clip"] }, firefox: { token: "tok-3", scopes: ["clip"] } }`.
- `verifyClipToken(v, "tok-3")` → `verifyApiToken(v, "tok-3")`, expecting `{ label: "firefox", scopes: ["clip"] }`.
- `listClipFingerprints` → `listApiTokens`; the existing assertion gains `scopes`.
- `revokeClipToken` assertions: the `loadApiTokens` expectation becomes the record shape.

- [ ] **Step 9: Run the file to confirm all tests pass**

Run: `bun test packages/gateway/src/clips/clip-token-store.test.ts`
Expected: PASS. If `tokenFingerprint` import causes a cycle warning, note that `http-auth.ts` imports nothing from `clips/` — it does not.

- [ ] **Step 10: Typecheck to find every remaining call site**

Run: `bun run typecheck`
Expected: FAIL, with errors in `packages/gateway/src/ipc/http-server.ts` (3 sites: lines ~483, ~553, ~583–586, ~611) and `packages/gateway/src/ipc/clip-rpc.ts` (`listClipFingerprints`). **Do not fix them yet** — Tasks 4 and 5 own those files. Record the list; it is the proof the rename found every consumer.

- [ ] **Step 11: Commit**

```bash
git add packages/gateway/src/clips/api-scopes.ts packages/gateway/src/clips/api-scopes.test.ts packages/gateway/src/clips/clip-token-store.ts packages/gateway/src/clips/clip-token-store.test.ts
git commit -m "feat(clips): scope field on HTTP API tokens, legacy tokens capped at clip+briefs"
```

---

### Task 2: The pairing window carries the scopes it will mint

**Files:**
- Modify: `packages/gateway/src/clips/pairing-window.ts`
- Test: `packages/gateway/src/clips/pairing-window.test.ts`

**Interfaces:**
- Consumes: `ApiScope` from `clips/api-scopes.ts` (Task 1).
- Produces: `PairingWindowController.open(label: string, scopes: readonly ApiScope[]): { code: string; expiresAtMs: number }` and `confirm(code: string): { label: string; scopes: readonly ApiScope[] } | null`.

- [ ] **Step 1: Write the failing test**

Add to `packages/gateway/src/clips/pairing-window.test.ts`:

```ts
  test("confirm returns the scopes the OWNER opened the window with", () => {
    let now = 1_000;
    const c = new PairingWindowController({ nowMs: () => now, genCode: () => "123456" });
    c.open("chrome", ["clip", "agents"]);
    expect(c.confirm("123456")).toEqual({ label: "chrome", scopes: ["clip", "agents"] });
  });

  test("a second window's scopes replace the first's", () => {
    let now = 1_000;
    const c = new PairingWindowController({ nowMs: () => now, genCode: () => "123456" });
    c.open("chrome", ["clip", "agents"]);
    c.open("chrome", ["clip"]);
    expect(c.confirm("123456")).toEqual({ label: "chrome", scopes: ["clip"] });
  });
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun test packages/gateway/src/clips/pairing-window.test.ts`
Expected: FAIL — `Expected 1 arguments, but got 2` at the `open(…)` call, or a missing `scopes` in the `confirm` result.

- [ ] **Step 3: Thread scopes through the window**

In `packages/gateway/src/clips/pairing-window.ts`:

```ts
import type { ApiScope } from "./api-scopes.ts";
```

Extend the private window shape and the two methods:

```ts
interface OpenWindow {
  readonly label: string;
  readonly code: string;
  readonly scopes: readonly ApiScope[];
  readonly expiresAtMs: number;
  attempts: number;
}
```

```ts
  /**
   * `scopes` is what the minted token will carry. It is recorded HERE, at the moment the OWNER
   * opens the window from the CLI — never taken from the confirming request. A requester that
   * could name its own scopes would simply grant itself the set, which is the same
   * server-derived-not-caller-supplied rule I23 relies on for reply targets.
   */
  open(label: string, scopes: readonly ApiScope[]): { code: string; expiresAtMs: number } {
    const code = this.genCode();
    const expiresAtMs = this.nowMs() + PAIRING_TTL_MS;
    this.window = { label, code, scopes, expiresAtMs, attempts: 0 };
    return { code, expiresAtMs };
  }
```

```ts
  confirm(code: string): { label: string; scopes: readonly ApiScope[] } | null {
```

and in the success branch:

```ts
    if (constantTimeStringEqual(code, w.code)) {
      this.window = null; // single-use
      return { label: w.label, scopes: w.scopes };
    }
```

- [ ] **Step 4: Run to confirm it passes**

Run: `bun test packages/gateway/src/clips/pairing-window.test.ts`
Expected: PASS. Existing tests calling `open("label")` now fail to typecheck — update each to `open("label", ["clip"])`.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/clips/pairing-window.ts packages/gateway/src/clips/pairing-window.test.ts
git commit -m "feat(clips): pairing window records the scopes its token will be minted with"
```

---

### Task 3: Route→auth table and the completeness guard

**Files:**
- Create: `packages/gateway/src/ipc/http-route-auth.ts`
- Test: `packages/gateway/src/ipc/http-route-auth.test.ts`

**Interfaces:**
- Consumes: `ApiScope` from `clips/api-scopes.ts`; `WRITE_ROUTE_ALLOWLIST` from `ipc/http-write-routes.ts`.
- Produces:
  - `type RouteAuth` (discriminated union on `kind`)
  - `HTTP_ROUTE_AUTH: Readonly<Record<string, RouteAuth>>`
  - `hasScope(granted: readonly ApiScope[], required: ApiScope): boolean`
  - `insufficientScopeBody(required: ApiScope, granted: readonly ApiScope[]): { error: string; required: string; granted: string[] }`

> **Why this table also lists the PUBLIC routes.** The existing GET table is ungated *by convention*, and a convention is exactly what a new route joins silently. Enumerating the public routes costs nothing and buys the one thing a gated-only table cannot: a route that is public **by decision** becomes distinguishable from one that is public **by omission**.

- [ ] **Step 1: Write the failing completeness test**

Create `packages/gateway/src/ipc/http-route-auth.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { HTTP_ROUTE_AUTH, hasScope, insufficientScopeBody } from "./http-route-auth.ts";
import { WRITE_ROUTE_ALLOWLIST } from "./http-write-routes.ts";

const SERVER_SRC = "packages/gateway/src/ipc/http-server.ts";

/**
 * Routes matched by a REGEX rather than a path literal, so the scan below cannot see them.
 *
 * Listed explicitly rather than silently tolerated: each entry is a route the guard does not
 * protect, and naming them is what keeps that list from growing unnoticed.
 */
const REGEX_ROUTED_GET = new Set<string>([
  "/v1/briefs/*", // matched by BRIEF_GET_RE in http-server.ts
]);

/**
 * Every `path === "/…"` / `path.startsWith("/…")` literal in the HTTP server.
 *
 * Source-scanned rather than hand-mirrored ON PURPOSE. A hand-written second list of routes is
 * exactly the drift that produced four wrong param shapes in #1059 — it agrees with reality on
 * the day it is written and never again. A scan self-updates: add a route, and this test demands
 * a decision about it.
 *
 * Two regexes, not one with a branch: the `startsWith` form has NO space after `path`, so a
 * single pattern with `path ` in it silently matches only the `===` form — a scan that finds
 * half the routes and reports success.
 */
async function routeLiteralsInServer(): Promise<string[]> {
  const src = await Bun.file(SERVER_SRC).text();
  const out = new Set<string>();
  for (const m of src.matchAll(/path\s*===\s*"(\/[^"]*)"/g)) {
    out.add(m[1] as string);
  }
  // `startsWith` literals are prefixes; the table keys them with a trailing `*`.
  for (const m of src.matchAll(/path\.startsWith\("(\/[^"]*)"\)/g)) {
    out.add(`${m[1] as string}*`);
  }
  return [...out];
}

describe("http-route-auth", () => {
  test("every WRITE_ROUTE_ALLOWLIST entry has an auth decision", () => {
    const missing = WRITE_ROUTE_ALLOWLIST.filter((r) => !(r in HTTP_ROUTE_AUTH));
    expect(missing).toEqual([]);
  });

  test("every GET route literal in http-server.ts has an auth decision", async () => {
    const literals = await routeLiteralsInServer();
    // Guard the guard, twice over: if the scan finds nothing the regex has rotted, and if it
    // finds no `*` entry the startsWith half has rotted while the `===` half still passes.
    expect(literals.length).toBeGreaterThan(8);
    expect(literals.some((p) => p.endsWith("*"))).toBe(true);
    const missing = literals.filter((p) => !(`GET ${p}` in HTTP_ROUTE_AUTH));
    expect(missing).toEqual([]);
  });

  test("no table entry is a route that no longer exists", async () => {
    const literals = new Set(await routeLiteralsInServer());
    const stale = Object.keys(HTTP_ROUTE_AUTH)
      .filter((k) => k.startsWith("GET "))
      .map((k) => k.slice("GET ".length))
      .filter((p) => !literals.has(p) && !REGEX_ROUTED_GET.has(p));
    expect(stale).toEqual([]);
  });

  test("hasScope is exact membership, never a prefix or superset match", () => {
    expect(hasScope(["clip", "briefs"], "clip")).toBe(true);
    expect(hasScope(["clip", "briefs"], "agents")).toBe(false);
    expect(hasScope([], "clip")).toBe(false);
  });

  test("the 403 body names what was required and what was granted, and no token value", () => {
    const body = insufficientScopeBody("agents", ["clip"]);
    expect(body).toEqual({ error: "insufficient_scope", required: "agents", granted: ["clip"] });
  });
});
```

- [ ] **Step 2: Run to confirm it fails**

Run: `bun test packages/gateway/src/ipc/http-route-auth.test.ts`
Expected: FAIL — `Cannot find module './http-route-auth.ts'`.

- [ ] **Step 3: Write the table**

Create `packages/gateway/src/ipc/http-route-auth.ts`:

```ts
import type { ApiScope } from "../clips/api-scopes.ts";

/**
 * How one HTTP route is authenticated.
 *
 * There are FOUR distinct credentials on this surface, not one: the labeled client token map
 * (`clip`), the admin token, the SCIM token and the deployment token. Collapsing them into
 * "bearer" would let a scope check appear to cover a route that a different credential guards.
 */
export type RouteAuth =
  | { readonly kind: "public" }
  | { readonly kind: "clip"; readonly scope: ApiScope }
  | { readonly kind: "pairing" }
  | { readonly kind: "admin" }
  | { readonly kind: "scim" }
  | { readonly kind: "deploy" }
  | { readonly kind: "teams" };

/**
 * The auth decision for every route on the local HTTP surface, keyed `"<METHOD> <path>"`.
 *
 * TOTAL over the surface, including the routes that are deliberately unauthenticated. See the
 * completeness test: a new route with no entry here fails the suite rather than inheriting
 * whatever the surrounding code happens to do.
 */
export const HTTP_ROUTE_AUTH: Readonly<Record<string, RouteAuth>> = Object.freeze({
  // --- Unauthenticated reads. Public BY DECISION, recorded so the next one is a decision too.
  "GET /v1/health": { kind: "public" },
  "GET /v1/items": { kind: "public" },
  "GET /v1/items/*": { kind: "public" },
  "GET /v1/connectors": { kind: "public" },
  "GET /v1/people": { kind: "public" },
  "GET /v1/people/*": { kind: "public" },
  "GET /v1/audit": { kind: "public" },
  "GET /v1/metrics/dora": { kind: "public" },
  "GET /v1/preflight/deploy": { kind: "public" },
  "GET /v1/openapi.json": { kind: "public" },

  // --- Admin-token reads.
  "GET /v1/admin/status": { kind: "admin" },
  "GET /metrics": { kind: "admin" },
  "GET /admin": { kind: "admin" },
  "GET /admin/*": { kind: "admin" },

  // --- Client-token reads.
  "GET /v1/briefs/*": { kind: "clip", scope: "briefs" },

  // --- Writes (must cover WRITE_ROUTE_ALLOWLIST exactly).
  "POST /v1/deployments": { kind: "deploy" },
  "POST /scim/v2/Users": { kind: "scim" },
  "PATCH /scim/v2/Users/:id": { kind: "scim" },
  "DELETE /scim/v2/Users/:id": { kind: "scim" },
  "PUT /v1/admin/policy": { kind: "admin" },
  "POST /v1/messaging/teams/events": { kind: "teams" },
  "POST /v1/clips": { kind: "clip", scope: "clip" },
  // Gated by the short-lived pairing CODE, not a bearer — it is how a token is obtained, so it
  // cannot require one.
  "POST /v1/clips/pair/confirm": { kind: "pairing" },
  "POST /v1/briefs": { kind: "clip", scope: "briefs" },
  "POST /v1/briefs/:id/sources": { kind: "clip", scope: "briefs" },
  "POST /v1/briefs/:id/run": { kind: "clip", scope: "briefs" },
  "POST /v1/briefs/:id/save": { kind: "clip", scope: "briefs" },
  // Bearer-authed read mounted in the fetch handler, not the GET table.
  "POST /v1/clips/related": { kind: "clip", scope: "clip" },
});

export function hasScope(granted: readonly ApiScope[], required: ApiScope): boolean {
  return granted.includes(required);
}

export function insufficientScopeBody(
  required: ApiScope,
  granted: readonly ApiScope[],
): { error: string; required: string; granted: string[] } {
  return { error: "insufficient_scope", required, granted: [...granted] };
}
```

- [ ] **Step 4: Run and reconcile the keys against reality**

Run: `bun test packages/gateway/src/ipc/http-route-auth.test.ts`
Expected: the first test tells you the exact `WRITE_ROUTE_ALLOWLIST` string values. **Use its failure output to correct the write-side keys above verbatim** — do not assume the SCIM/brief route constants match what is written here. Read `packages/gateway/src/ipc/http-write-routes.ts:24-63` for the `ROUTE_*` constants and copy their values exactly.

Iterate on Steps 3–4 until all five tests pass.

- [ ] **Step 5: Red-prove the guard**

Temporarily delete the `"GET /v1/health"` line from the table.

Run: `bun test packages/gateway/src/ipc/http-route-auth.test.ts`
Expected: FAIL on "every GET route literal … has an auth decision", listing `/v1/health`.

Then temporarily add `"GET /v1/nonexistent": { kind: "public" },`.

Run again. Expected: FAIL on "no table entry is a route that no longer exists".

Restore the table. **A guard that has never failed is a guard nobody has checked.**

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/http-route-auth.ts packages/gateway/src/ipc/http-route-auth.test.ts
git commit -m "feat(ipc): total route-to-auth table with a source-scanned completeness guard"
```

---

### Task 4: Enforce scopes at the three verification sites

**Files:**
- Modify: `packages/gateway/src/ipc/http-write-routes.ts` (the `ClipsWriteSurface` / `BriefsWriteSurface` `verifyToken` types + the brief auth helper)
- Modify: `packages/gateway/src/ipc/http-server.ts` (`handleClipRelated` ~line 483, `handleBriefGet` ~line 553, `buildClipsSeam` ~line 583, `buildBriefsSeam` ~line 611)
- Test: `packages/gateway/src/ipc/http-scope-enforcement.test.ts` (create)

**Interfaces:**
- Consumes: `verifyApiToken` (Task 1), `hasScope` / `insufficientScopeBody` / `HTTP_ROUTE_AUTH` (Task 3).
- Produces: `verifyToken` on both write surfaces now resolves `{ label: string; scopes: readonly ApiScope[] } | null`.

- [ ] **Step 1: Write the failing enforcement tests**

Create `packages/gateway/src/ipc/http-scope-enforcement.test.ts`. Build the server with the existing test helper used by `brief-http.test.ts` — read `packages/gateway/src/briefs/brief-test-server.ts` first and reuse it rather than standing up a second harness.

```ts
import { describe, expect, test } from "bun:test";
// Import the shared brief/clip test server helper here; see brief-http.test.ts for the exact
// factory name and options it takes. Do NOT write a second harness.

describe("HTTP scope enforcement", () => {
  test("a legacy-scoped token still reaches POST /v1/clips", async () => {
    // legacy => ["clip","briefs"], and POST /v1/clips requires "clip"
    // expect 200/201, NOT 403
  });

  test("a legacy-scoped token still reaches GET /v1/briefs/{id}", async () => {
    // The no-regression assertion: scopes must not break already-paired clients.
  });

  test("a clip-only token is REFUSED on a briefs route with 403 insufficient_scope", async () => {
    // mint with scopes ["clip"]; call POST /v1/briefs
    // expect 403 and body.error === "insufficient_scope", body.required === "briefs"
  });

  test("an unknown token is still 401, not 403", async () => {
    // Authentication failure must stay distinguishable from authorization failure.
  });

  test("the 403 body never contains the token value", async () => {
    // expect(JSON.stringify(body)).not.toContain(theToken)
  });
});
```

Fill each body against the real harness. Every assertion above must be concrete before moving on — a test that only describes itself is not a test.

- [ ] **Step 2: Run to confirm they fail**

Run: `bun test packages/gateway/src/ipc/http-scope-enforcement.test.ts`
Expected: the three refusal tests FAIL with 200/201 instead of 403 (no enforcement exists yet).

- [ ] **Step 3: Widen the surface types**

In `packages/gateway/src/ipc/http-write-routes.ts`, change both surface interfaces:

```ts
import type { ApiScope } from "../clips/api-scopes.ts";
```

```ts
export interface ClipsWriteSurface {
  readonly pairing: PairingWindowController;
  readonly verifyToken: (
    presented: string,
  ) => Promise<{ label: string; scopes: readonly ApiScope[] } | null>;
  /** Mints with the scopes the OWNER put on the pairing window — never caller-supplied. */
  readonly mintToken: (label: string, scopes: readonly ApiScope[]) => Promise<string>;
  readonly ingest: (input: unknown) => { id: string; status: "created" | "updated" };
}
```

Apply the same `verifyToken` signature change to `BriefsWriteSurface`.

- [ ] **Step 4: Enforce in the write dispatcher**

In the clip/brief auth path of `http-write-routes.ts`, after a successful `verifyToken`, look the route's requirement up in `HTTP_ROUTE_AUTH` and refuse on mismatch:

```ts
import { hasScope, HTTP_ROUTE_AUTH, insufficientScopeBody } from "./http-route-auth.ts";
```

```ts
/**
 * Refuses an authenticated-but-unscoped caller with 403.
 *
 * 403 rather than 401 deliberately: the token IS valid, so reporting 401 would send a client into
 * a re-pair loop that cannot fix anything. Returns null when the route needs no scope.
 */
function scopeRefusal(
  routeKey: string,
  granted: readonly ApiScope[],
  limit: RateLimitCheck,
): Response | null {
  const auth = HTTP_ROUTE_AUTH[routeKey];
  if (auth === undefined || auth.kind !== "clip") return null;
  if (hasScope(granted, auth.scope)) return null;
  return jsonResponse(insufficientScopeBody(auth.scope, granted), 403, rateLimitHeaders(limit));
}
```

Call it at each clip-token-authenticated write route, using the same route key the dispatcher already resolved. Also call `recordRejection` on refusal, matching how the existing 401/403 paths audit — read the neighbouring `recordRejection` calls and mirror their `actionType` / `reason` shape rather than inventing fields.

- [ ] **Step 5: Enforce at the two bearer reads**

In `packages/gateway/src/ipc/http-server.ts`:

```ts
// handleClipRelated (~line 483)
const presented = bearerToken(req);
const verified = presented === undefined ? null : await verifyApiToken(clipsVault, presented);
if (verified === null) return json({ error: "unauthorized" }, 401);
if (!hasScope(verified.scopes, "clip")) {
  return json(insufficientScopeBody("clip", verified.scopes), 403);
}
```

```ts
// handleBriefGet (~line 553) — same shape, requiring "briefs"
if (!hasScope(verified.scopes, "briefs")) {
  return json(insufficientScopeBody("briefs", verified.scopes), 403);
}
```

- [ ] **Step 6: Update the two seam builders**

```ts
// buildClipsSeam (~line 583)
    verifyToken: (t: string) => verifyApiToken(clipsVault, t),
    mintToken: async (label: string, scopes: readonly ApiScope[]): Promise<string> => {
      const token = generateClipToken();
      await addApiToken(clipsVault, label, token, scopes);
      return token;
    },
```

```ts
// buildBriefsSeam (~line 611)
    verifyToken: (t: string) => verifyApiToken(clipsVault, t),
```

And in `runClipPairConfirmRoute` (`http-write-routes.ts` ~line 941), pass the window's scopes through:

```ts
  const token = await clips.mintToken(confirmed.label, confirmed.scopes);
  return jsonResponse(
    { token, label: confirmed.label, scopes: [...confirmed.scopes] },
    200,
    rateLimitHeaders(limit),
  );
```

- [ ] **Step 7: Run the tests**

Run: `bun test packages/gateway/src/ipc/ packages/gateway/src/briefs/ packages/gateway/src/clips/`
Expected: PASS, including the pre-existing brief and clip HTTP tests. Any pre-existing test that mints a token must now pass scopes — update it to `["clip","briefs"]` so it keeps testing what it tested.

- [ ] **Step 8: Typecheck**

Run: `bun run typecheck`
Expected: PASS (0 errors). The `clip-rpc.ts` `listClipFingerprints` error from Task 1 Step 10 is still open — Task 5 closes it. If it is the only remaining error, proceed.

- [ ] **Step 9: Commit**

```bash
git add packages/gateway/src/ipc/http-write-routes.ts packages/gateway/src/ipc/http-server.ts packages/gateway/src/ipc/http-scope-enforcement.test.ts
git commit -m "feat(ipc): refuse an out-of-scope token with 403 at every clip-token gate"
```

---

### Task 5: `clip.pair --scopes`, `nimbus clip scopes`, and scopes in `clip status`

**Files:**
- Modify: `packages/gateway/src/ipc/clip-rpc.ts`
- Modify: `packages/cli/src/commands/clip.ts`
- Test: `packages/gateway/src/ipc/clip-rpc.test.ts`, `packages/cli/src/commands/clip.test.ts`

**Interfaces:**
- Consumes: `setApiTokenScopes`, `listApiTokens` (Task 1); `PairingWindowController.open(label, scopes)` (Task 2); `API_SCOPES`, `isApiScope`, `LEGACY_SCOPES` (Task 1).
- Produces: IPC `clip.scopes` → `{ updated: boolean; scopes: string[] }`; `clip.pair` accepts optional `scopes: string[]`; `clip.status` devices gain `scopes: string[]`.

- [ ] **Step 1: Write the failing gateway tests**

Add to `packages/gateway/src/ipc/clip-rpc.test.ts`:

```ts
  test("clip.pair with no scopes opens the window with LEGACY_SCOPES", async () => {
    // Conservative default: an operator who does not think about scopes gets today's capability,
    // never tomorrow's.
  });

  test("clip.pair passes only RECOGNISED scopes to the window", async () => {
    // params.scopes = ["clip", "telepathy"] => window opened with ["clip"]
  });

  test("clip.pair with an empty recognised set still opens with LEGACY_SCOPES", async () => {
    // ["telepathy"] filters to [] — minting a token that can do nothing is a support ticket,
    // not a security win.
  });

  test("clip.scopes updates an existing label and reports the stored set", async () => {
    // => { updated: true, scopes: ["clip","agents"] }
  });

  test("clip.scopes on an unknown label reports updated:false", async () => {
    // => { updated: false, scopes: [] }
  });

  test("clip.status reports each device's scopes", async () => {
    // devices[0].scopes === ["clip","briefs"]
  });
```

Fill the bodies against the existing test harness in that file.

- [ ] **Step 2: Run to confirm they fail**

Run: `bun test packages/gateway/src/ipc/clip-rpc.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement the gateway side**

In `packages/gateway/src/ipc/clip-rpc.ts`:

```ts
import { type ApiScope, isApiScope, LEGACY_SCOPES } from "../clips/api-scopes.ts";
import { listApiTokens, revokeClipToken, setApiTokenScopes } from "../clips/clip-token-store.ts";
```

```ts
/**
 * Reads a caller-supplied scope list, dropping anything unrecognised.
 *
 * An empty result falls back to LEGACY_SCOPES rather than minting a scope-less token: a token
 * that can reach nothing is a support ticket, not a safety property, and the operator's intent
 * when they typo a scope name is plainly not "give me a dead credential".
 */
function readScopes(v: unknown): readonly ApiScope[] {
  if (!Array.isArray(v)) return LEGACY_SCOPES;
  const picked = v.filter(isApiScope);
  return picked.length === 0 ? LEGACY_SCOPES : picked;
}
```

`handleClipPair` — replace the `open` call:

```ts
  const scopes = readScopes(rec["scopes"]);
  const { code, expiresAtMs } = deps.pairing.open(label, scopes);
  return {
    code,
    expiresAtMs,
    label,
    scopes: [...scopes],
    ...(deps.httpBaseUrl === undefined ? {} : { gatewayUrl: deps.httpBaseUrl }),
  };
```

`handleClipStatus` — swap the list call:

```ts
  const devices = await listApiTokens(deps.vault);
  return { devices, briefsEnabled: deps.briefsEnabled };
```

Add the new handler and register it in the dispatch map beside `"clip.revoke"`:

```ts
async function handleClipScopes(params: unknown, deps: ClipRpcDeps): Promise<unknown> {
  const rec = asRecord(params);
  const label = typeof rec["label"] === "string" ? (rec["label"] as string) : "";
  if (label === "") return { updated: false, scopes: [] };
  const scopes = readScopes(rec["scopes"]);
  const updated = await setApiTokenScopes(deps.vault, label, scopes);
  return { updated, scopes: updated ? [...scopes] : [] };
}
```

```ts
  "clip.scopes": handleClipScopes,
```

- [ ] **Step 4: Run to confirm they pass**

Run: `bun test packages/gateway/src/ipc/clip-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing CLI tests**

Add to `packages/cli/src/commands/clip.test.ts`:

```ts
  test("formatStatus shows each device's scopes", () => {
    const out = formatStatus([
      { label: "chrome", fingerprint: "abcd1234", scopes: ["clip", "briefs"] },
    ]);
    expect(out).toContain("chrome");
    expect(out).toContain("clip,briefs");
  });

  test("parseScopesFlag splits a comma list and trims", () => {
    expect(parseScopesFlag("clip, agents")).toEqual(["clip", "agents"]);
    expect(parseScopesFlag(undefined)).toBeUndefined();
  });
```

- [ ] **Step 6: Run to confirm they fail**

Run: `bun test packages/cli/src/commands/clip.test.ts`
Expected: FAIL — `parseScopesFlag` is not exported; `formatStatus` output lacks scopes.

- [ ] **Step 7: Implement the CLI side**

In `packages/cli/src/commands/clip.ts`, update the usage string:

```ts
export const CLIP_USAGE = `Usage:
  nimbus clip pair [--label <device>] [--scopes <a,b>]   open a pairing window and print the one-time code
  nimbus clip scopes <label> --set <a,b>                 change a paired client's scopes in place
  nimbus clip status                    list paired browsers (labels + fingerprints + scopes)
                                         and whether research briefs are enabled
  nimbus clip revoke <label|--all>      revoke a paired browser's token
  nimbus clip list [--tag <t>] [--limit N] [--json]   list saved clips
  nimbus clip delete <id|url> | --all [--yes]         delete clips

Scopes: clip, briefs, agents, resolve, fetch (default: clip,briefs)`;
```

```ts
/** `--scopes clip,agents` → ["clip","agents"]. Undefined when the flag is absent. */
export function parseScopesFlag(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const parts = raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  return parts.length === 0 ? undefined : parts;
}
```

```ts
export function formatStatus(
  devices: Array<{ label: string; fingerprint: string; scopes: readonly string[] }>,
): string {
  if (devices.length === 0) return "No clipper tokens registered.";
  return devices.map((d) => `  ${d.label}\t${d.fingerprint}\t${d.scopes.join(",")}`).join("\n");
}
```

Extend `runClipPair` to accept and send scopes, and add:

```ts
export async function runClipScopes(
  client: IPCClient,
  label: string,
  scopes: string[],
): Promise<void> {
  const out = await client.call<{ updated: boolean; scopes: string[] }>("clip.scopes", {
    label,
    scopes,
  });
  if (!out.updated) {
    throw new Error(`No paired client labelled "${label}". See: nimbus clip status`);
  }
  console.log(`Scopes for "${label}" are now: ${out.scopes.join(",")}`);
}
```

In `runClip`, extend the `pair` case and add the `scopes` case:

```ts
    case "pair": {
      const i = rest.indexOf("--label");
      const label = i >= 0 ? rest[i + 1] : undefined;
      const s = rest.indexOf("--scopes");
      const scopes = parseScopesFlag(s >= 0 ? rest[s + 1] : undefined);
      await withIpc((c) => runClipPair(c, label, scopes));
      return;
    }
    case "scopes": {
      const label = rest[0];
      const s = rest.indexOf("--set");
      const scopes = parseScopesFlag(s >= 0 ? rest[s + 1] : undefined);
      if (label === undefined || label.startsWith("--") || scopes === undefined) {
        throw new Error("Usage: nimbus clip scopes <label> --set <a,b>");
      }
      await withIpc((c) => runClipScopes(c, label, scopes));
      return;
    }
```

- [ ] **Step 8: Run both test files**

Run: `bun test packages/cli/src/commands/clip.test.ts packages/gateway/src/ipc/clip-rpc.test.ts`
Expected: PASS.

- [ ] **Step 9: Typecheck**

Run: `bun run typecheck`
Expected: PASS, 0 errors — this closes the last call site from Task 1 Step 10.

- [ ] **Step 10: Commit**

```bash
git add packages/gateway/src/ipc/clip-rpc.ts packages/gateway/src/ipc/clip-rpc.test.ts packages/cli/src/commands/clip.ts packages/cli/src/commands/clip.test.ts
git commit -m "feat(cli): nimbus clip pair --scopes and nimbus clip scopes"
```

---

### Task 6: Documentation and full pre-flight

**Files:**
- Modify: `docs/CHANGELOG.md`, `docs/cli-reference.md`, `docs/SECURITY-INVARIANTS.md` (the `I30` section)

- [ ] **Step 1: Update `docs/cli-reference.md`**

Add `nimbus clip scopes <label> --set <a,b>` to the `clip` section, document `--scopes` on `pair`, and list the five scope names with what each unlocks. State that a client paired before this change holds `clip,briefs` and needs `nimbus clip scopes` to gain more.

- [ ] **Step 2: Update the `I30` section of `docs/SECURITY-INVARIANTS.md`**

`I30` describes what minting produces, and minting now produces a scoped token. Add: the scopes are recorded on the owner-opened pairing window and read from the window at confirm time — never from the confirming request body — so the set is server-derived. Note that a legacy bare-string token parses as `clip,briefs` and gains nothing.

Do **not** add a new invariant number. This is a refinement of `I30`, not a new defense.

- [ ] **Step 3: Update `docs/CHANGELOG.md`**

Add an entry under the unreleased heading describing the scope field, the legacy-token rule, and the two CLI changes.

- [ ] **Step 4: Run the docs and static gates**

```bash
bun run audit:links
bun run audit:doc-refs
bun run audit:readme-cli
bun run audit:invariants
```

Expected: all exit 0. `audit:readme-cli` reds when a doc names a `nimbus <cmd>` absent from the command registry — if `clip scopes` trips it, add the subcommand where the registry expects it rather than removing it from the docs.

- [ ] **Step 5: Full pre-flight**

```bash
bun run preflight > /tmp/preflight.log 2>&1
echo "EXIT=$?" >> /tmp/preflight.log
grep -E "ALL GATES PASS|FAILED|EXIT=" /tmp/preflight.log
```

**Do not pipe the command into `tee` or `tail`** — a pipeline reports the *last* command's status, which has previously turned a failing run into a reported "exit code 0". Redirect, then grep the log.

Expected: `ALL GATES PASS` and `EXIT=0`.

- [ ] **Step 6: Coverage floor**

Run: `bun run audit:coverage-floor`

This gate is **CI-Linux-authoritative** — a Windows run produces false violations on some files. If it reports violations only on files this PR did not touch, confirm with `git diff --name-only` before believing them, and re-check under `bun run verify:docker` if in doubt. New files (`api-scopes.ts`, `http-route-auth.ts`) must meet ≥85% line and ≥80% branch.

- [ ] **Step 7: Commit**

```bash
git add docs/
git commit -m "docs: HTTP API token scopes — CLI reference, I30 refinement, changelog"
```

---

## Self-Review

**Spec coverage (§3 of the design):**

| Spec requirement | Task |
| --- | --- |
| Value becomes `{token, scopes[]}`, bare string still parsed | 1 |
| `CLIP_TOKENS_VAULT_KEY` unchanged | 1 (Global Constraints + module docstring) |
| `verifyClipToken` → `verifyApiToken` returning `{label, scopes}` | 1, 4 |
| Five scopes; legacy = `clip`+`briefs` exactly | 1 |
| Owner-set scopes on the pairing window; confirm body ignored | 2, 4 Step 6, 5 |
| Scope edit in place without re-pair | 1 (`setApiTokenScopes`), 5 (`clip.scopes`) |
| Route→scope table + completeness guard | 3 |
| Table total over public GETs too | 3 |
| `constantTimeStringEqual` loop preserved | 1 Step 7 |
| `I13` posture (body caps, rate limiter) | unchanged in PR 1 — no new routes land here |

**Deferred to later PRs by design:** the `agents`, `resolve` and `fetch` scopes exist in the vocabulary but no route consumes them until PRs 2–4. That is deliberate: the vocabulary must ship first so a legacy token can be *denied* those scopes before the routes that honour them exist.

**Type consistency:** `ApiScope` / `ApiTokenRecord` / `ApiTokenMap` are defined in Task 1 and used unchanged in 2–5. `verifyToken`'s resolved shape is `{ label: string; scopes: readonly ApiScope[] } | null` in Tasks 1, 3 and 4 alike. `mintToken` takes `(label, scopes)` in Task 4 Steps 3 and 6. `open(label, scopes)` / `confirm → {label, scopes}` match between Tasks 2 and 4.

**Known follow-through:** Task 1 Step 10 deliberately leaves the tree failing `typecheck`; Task 4 Step 8 and Task 5 Step 9 close it. An implementer stopping between tasks will see red, and that is expected rather than a defect.
