# Web Clipper — Gateway (Plan A) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the gateway-side web-clipper surface — HTTP ingest + pairing + related-read routes, an in-memory pairing window, a labeled Vault token map, the `web_clip` item type, the I30 invariant, and the `nimbus clip` CLI — so a browser extension (Plan B) can pair, push clips into the local index, and fetch related items.

**Architecture:** A browser pushes clips over the I13 HTTP write surface, exactly like the existing SCIM/Teams/deployment inbound routes. Two new write routes (`POST /v1/clips`, `POST /v1/clips/pair/confirm`) and one bearer-authed read route (`POST /v1/clips/related`) are added. Authentication is a pairing handshake: the owner opens a short in-memory window via `nimbus clip pair`; the browser redeems the one-time code for a long-lived token stored in a labeled Vault map (`http_api.web_clipper_tokens`). Clip ingest writes a `web_clip` row via the existing `upsertIndexedItem` and schedules its embedding. A new invariant **I30** makes token minting fail-closed without a live owner-opened window.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, `bun:sqlite`, Biome, the existing `dispatchWriteRoute` pipeline, `util/timing-safe-compare.ts`, `node:crypto`.

## Global Constraints

- **No `any`** — use `unknown` for external data; TypeScript strict mode (copy from CLAUDE.md Non-Negotiable #7).
- **No plaintext credentials** — tokens live in Vault only; never in logs/IPC/config (#3). Token values never appear in audit rows, CLI output (`status` prints fingerprints only), or error bodies.
- **Constant-time compare** for the pairing code and every bearer-token comparison — reuse `constantTimeStringEqual` from `packages/gateway/src/util/timing-safe-compare.ts` (I10).
- **LAN bind stays `127.0.0.1`** — no change to bind config (I6); the extension only ever talks to localhost.
- **Coverage floor** — every new source file under `packages/gateway/src` and `packages/cli/src` must hit **≥85% line AND ≥85% branch** (per `AGENTS.md` lines 9–10; `audit:coverage-floor`, Linux-authoritative; verify via Docker before pushing per the `nimbus-preflight` skill). Fix-not-exclude: never add a baseline/exclusion entry to clear the floor. If a provably-dead branch blocks ≥85%, leave the file and flag `blocked: unreachable branch at <file>:<line>` rather than editing source.
- **Cross-platform paths** — `path.join()` / `os.tmpdir()` in tests; never hardcoded separators.
- **Item primary key** is `service:externalId`; clips use `service = "nimbus"`, `type = "web_clip"`.
- **Pre-flight before push:** `bun run preflight:fast` after every task; full `bun run preflight` before the PR.

---

## File Structure

| File | Responsibility |
| --- | --- |
| `packages/gateway/src/clips/clip-token-store.ts` (new) | The labeled Vault token map: load / list-fingerprints / add / revoke / constant-time verify. Pure logic over an injected `NimbusVault`. |
| `packages/gateway/src/clips/pairing-window.ts` (new) | In-memory single pairing window: `open(label)→code`, `confirm(code)→label\|null`, TTL + attempt-cap + single-use, injected `now()` + code generator. |
| `packages/gateway/src/clips/clip-ingest.ts` (new) | Pure clip-payload validation, URL canonicalization, `external_id` derivation, the upsert + embedding schedule. |
| `packages/gateway/src/clips/clip-related.ts` (new) | Builds the related-items query (selection-primary, own-host de-prioritized) and calls the existing hybrid search. |
| `packages/gateway/src/ipc/http-write-routes.ts` (modify) | Add `ROUTE_CLIPS` + `ROUTE_CLIPS_PAIR_CONFIRM`, the `clips` seam on `WriteRouteContext`, resolve + run handlers, `checkAuth` special-case. |
| `packages/gateway/src/ipc/http-server.ts` (modify) | Build the `clips` write-route seam deps; mount the `POST /v1/clips/related` read route. |
| `packages/gateway/src/embedding/routing.ts` (modify) | Add `nimbus:web_clip` to `PROSE_HEAVY_TYPES`. |
| `packages/gateway/src/ipc/clip-rpc.ts` (new) | `dispatchClipRpc` — `clip.pair` / `clip.status` / `clip.revoke` over IPC. |
| `packages/cli/src/commands/clip.ts` (new) | `nimbus clip pair\|status\|revoke` CLI. |
| `packages/gateway/src/security-invariants.test.ts` (modify) | I30 enforcement block + allowlist count 6→8. |
| `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md` (modify) | I30 row + invariant-count prose. |
| vault-key allowlist (locate — see Task 1) | Register `http_api.web_clipper_tokens`. |
| `packages/gateway/src/clips/clip-e2e.test.ts` (new) | Real-gateway pair → clip → `nimbus search` finds it. |
| `docs/roadmap.md`, `docs/CHANGELOG.md` (modify) | Mark the web-clipper row + log the delivery. |

---

## Task 1: Vault token store + key allowlist

**Files:**

- Create: `packages/gateway/src/clips/clip-token-store.ts`
- Test: `packages/gateway/src/clips/clip-token-store.test.ts`
- Modify: the vault-key allowlist (locate first — see Step 0)

**Interfaces:**

- Consumes: `NimbusVault` from `../vault/nimbus-vault.ts` (`get`/`set`/`delete`); `constantTimeStringEqual` from `../util/timing-safe-compare.ts`; `tokenFingerprint` from `../ipc/http-auth.ts`.
- Produces:
  - `CLIP_TOKENS_VAULT_KEY = "http_api.web_clipper_tokens"` (const string)
  - `type ClipTokenMap = Record<string, string>` (label → token)
  - `async loadClipTokens(vault: NimbusVault): Promise<ClipTokenMap>`
  - `async addClipToken(vault: NimbusVault, label: string, token: string): Promise<void>`
  - `async revokeClipToken(vault: NimbusVault, label: string | "*"): Promise<number>` (returns count removed; `"*"` clears all)
  - `async listClipFingerprints(vault: NimbusVault): Promise<Array<{ label: string; fingerprint: string }>>`
  - `async verifyClipToken(vault: NimbusVault, presented: string): Promise<{ label: string } | null>` (constant-time across all entries, no early-return count leak)
  - `generateClipToken(): string` (32-byte hex)

- [ ] **Step 0: Locate the vault-key allowlist and confirm the key must be registered**

Run: `grep -rn "http_api.deployment_token" scripts/ packages/gateway/src/vault packages/gateway/src/config`
Expected: find the allowlist/validation site (e.g. a `scripts/structure-audit/*` allow-list array or a vault-key validator). Note the exact file + array. The new key `http_api.web_clipper_tokens` must be added there in Step 6, or the static audit fails.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/clips/clip-token-store.test.ts
import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import {
  addClipToken,
  CLIP_TOKENS_VAULT_KEY,
  generateClipToken,
  listClipFingerprints,
  loadClipTokens,
  revokeClipToken,
  verifyClipToken,
} from "./clip-token-store.ts";

/** Minimal in-memory vault fake (get/set/delete/listKeys). */
function fakeVault(): NimbusVault {
  const store = new Map<string, string>();
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async (prefix) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
}

describe("clip-token-store", () => {
  test("empty vault → empty map", async () => {
    expect(await loadClipTokens(fakeVault())).toEqual({});
  });

  test("add → load round-trips under the label", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome-work", "tok-abc");
    expect(await loadClipTokens(v)).toEqual({ "chrome-work": "tok-abc" });
    expect(await v.get(CLIP_TOKENS_VAULT_KEY)).toContain("chrome-work");
  });

  test("re-add same label replaces (rotation); new label adds (concurrent)", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome", "tok-1");
    await addClipToken(v, "chrome", "tok-2"); // rotation
    await addClipToken(v, "firefox", "tok-3"); // concurrent
    expect(await loadClipTokens(v)).toEqual({ chrome: "tok-2", firefox: "tok-3" });
  });

  test("verifyClipToken matches a stored token and returns its label", async () => {
    const v = fakeVault();
    await addClipToken(v, "firefox", "tok-3");
    expect(await verifyClipToken(v, "tok-3")).toEqual({ label: "firefox" });
    expect(await verifyClipToken(v, "wrong")).toBeNull();
  });

  test("verify against empty map is null (no throw)", async () => {
    expect(await verifyClipToken(fakeVault(), "anything")).toBeNull();
  });

  test("revoke one label removes only it; returns 1", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome", "t1");
    await addClipToken(v, "firefox", "t2");
    expect(await revokeClipToken(v, "chrome")).toBe(1);
    expect(await loadClipTokens(v)).toEqual({ firefox: "t2" });
  });

  test("revoke '*' clears all; returns count", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome", "t1");
    await addClipToken(v, "firefox", "t2");
    expect(await revokeClipToken(v, "*")).toBe(2);
    expect(await loadClipTokens(v)).toEqual({});
  });

  test("revoke missing label returns 0", async () => {
    expect(await revokeClipToken(fakeVault(), "nope")).toBe(0);
  });

  test("listClipFingerprints returns label + 8-hex fingerprint, never the raw token", async () => {
    const v = fakeVault();
    await addClipToken(v, "chrome", "tok-secret");
    const out = await listClipFingerprints(v);
    expect(out).toHaveLength(1);
    expect(out[0]?.label).toBe("chrome");
    expect(out[0]?.fingerprint).toMatch(/^[0-9a-f]{8}$/);
    expect(JSON.stringify(out)).not.toContain("tok-secret");
  });

  test("generateClipToken yields distinct 64-hex strings", () => {
    const a = generateClipToken();
    const b = generateClipToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
  });

  test("corrupt JSON in vault → empty map (fail-safe, no throw)", async () => {
    const v = fakeVault();
    await v.set(CLIP_TOKENS_VAULT_KEY, "{not json");
    expect(await loadClipTokens(v)).toEqual({});
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/clips/clip-token-store.test.ts`
Expected: FAIL — module `./clip-token-store.ts` not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/clips/clip-token-store.ts
import { randomBytes } from "node:crypto";
import { tokenFingerprint } from "../ipc/http-auth.ts";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

/** Vault key holding the `{ label: token }` JSON map of paired browser tokens. */
export const CLIP_TOKENS_VAULT_KEY = "http_api.web_clipper_tokens";

export type ClipTokenMap = Record<string, string>;

function isStringMap(v: unknown): v is ClipTokenMap {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  return Object.values(v as Record<string, unknown>).every((x) => typeof x === "string");
}

export async function loadClipTokens(vault: NimbusVault): Promise<ClipTokenMap> {
  const raw = await vault.get(CLIP_TOKENS_VAULT_KEY);
  if (raw === null || raw === "") return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return isStringMap(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export async function addClipToken(
  vault: NimbusVault,
  label: string,
  token: string,
): Promise<void> {
  const map = await loadClipTokens(vault);
  map[label] = token;
  await vault.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify(map));
}

export async function revokeClipToken(vault: NimbusVault, label: string): Promise<number> {
  const map = await loadClipTokens(vault);
  if (label === "*") {
    const n = Object.keys(map).length;
    await vault.delete(CLIP_TOKENS_VAULT_KEY);
    return n;
  }
  if (!(label in map)) return 0;
  delete map[label];
  await vault.set(CLIP_TOKENS_VAULT_KEY, JSON.stringify(map));
  return 1;
}

export async function listClipFingerprints(
  vault: NimbusVault,
): Promise<Array<{ label: string; fingerprint: string }>> {
  const map = await loadClipTokens(vault);
  return Object.entries(map).map(([label, token]) => ({
    label,
    fingerprint: tokenFingerprint(token),
  }));
}

export async function verifyClipToken(
  vault: NimbusVault,
  presented: string,
): Promise<{ label: string } | null> {
  const map = await loadClipTokens(vault);
  // Constant-time across EVERY entry; never short-circuit/break (a break would leak token
  // count/presence via loop timing). `constantTimeStringEqual` is length-safe: on a length
  // mismatch it runs a dummy timingSafeEqual and returns false (no throw, no early-exit within
  // an equal-length compare), so a wrong-length presented token leaks nothing of consequence —
  // and tokens are fixed 64-hex (generateClipToken) anyway.
  let matched: string | null = null;
  for (const [label, token] of Object.entries(map)) {
    if (constantTimeStringEqual(presented, token)) {
      matched = label;
    }
  }
  return matched === null ? null : { label: matched };
}

export function generateClipToken(): string {
  return randomBytes(32).toString("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/clips/clip-token-store.test.ts`
Expected: PASS (all cases).

- [ ] **Step 5: Run the type + lint gate**

Run: `bun run preflight:fast`
Expected: PASS (no `any`, Biome clean).

- [ ] **Step 6: Register the new Vault key in the allowlist**

Using the file located in Step 0, add `"http_api.web_clipper_tokens"` next to `"http_api.deployment_token"`. Then:
Run: `bun run audit:nimbus-invariants` (or `bun run preflight:fast`)
Expected: PASS — the vault-key allow-list check accepts the new key.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/clips/clip-token-store.ts packages/gateway/src/clips/clip-token-store.test.ts
git commit -m "feat(clips): labeled Vault token map for web-clipper auth"
```

---

## Task 2: In-memory pairing window

**Files:**

- Create: `packages/gateway/src/clips/pairing-window.ts`
- Test: `packages/gateway/src/clips/pairing-window.test.ts`

**Interfaces:**

- Consumes: `constantTimeStringEqual` from `../util/timing-safe-compare.ts`; `node:crypto` `randomInt`.
- Produces:
  - `interface PairingWindowDeps { nowMs: () => number; genCode?: () => string }`
  - `class PairingWindowController` with:
    - `open(label: string): { code: string; expiresAtMs: number }` (replaces any existing window)
    - `confirm(code: string): { label: string } | null` (single-use, TTL, attempt-capped, constant-time)
    - `isOpen(): boolean`
  - `PAIRING_TTL_MS = 120_000`, `PAIRING_MAX_ATTEMPTS = 5`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/clips/pairing-window.test.ts
import { describe, expect, test } from "bun:test";
import { PAIRING_MAX_ATTEMPTS, PAIRING_TTL_MS, PairingWindowController } from "./pairing-window.ts";

function controllerAt(start: number, code = "123456"): {
  ctl: PairingWindowController;
  setNow: (n: number) => void;
} {
  let now = start;
  const ctl = new PairingWindowController({ nowMs: () => now, genCode: () => code });
  return { ctl, setNow: (n) => void (now = n) };
}

describe("PairingWindowController", () => {
  test("no window open → confirm is null, isOpen false", () => {
    const { ctl } = controllerAt(1000);
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.confirm("123456")).toBeNull();
  });

  test("open → confirm with correct code returns the label (single use)", () => {
    const { ctl } = controllerAt(1000);
    const { code } = ctl.open("chrome-work");
    expect(code).toBe("123456");
    expect(ctl.isOpen()).toBe(true);
    expect(ctl.confirm("123456")).toEqual({ label: "chrome-work" });
    // single-use: window now closed
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.confirm("123456")).toBeNull();
  });

  test("wrong code does not consume the window but counts an attempt", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("dev");
    expect(ctl.confirm("000000")).toBeNull();
    expect(ctl.isOpen()).toBe(true);
    expect(ctl.confirm("123456")).toEqual({ label: "dev" });
  });

  test("expired window → confirm null even with the right code", () => {
    const { ctl, setNow } = controllerAt(1000);
    ctl.open("dev");
    setNow(1000 + PAIRING_TTL_MS + 1);
    expect(ctl.confirm("123456")).toBeNull();
    expect(ctl.isOpen()).toBe(false);
  });

  test("attempt cap: after PAIRING_MAX_ATTEMPTS wrong tries the window closes", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("dev");
    for (let i = 0; i < PAIRING_MAX_ATTEMPTS; i++) {
      expect(ctl.confirm("000000")).toBeNull();
    }
    expect(ctl.isOpen()).toBe(false);
    expect(ctl.confirm("123456")).toBeNull(); // even correct code now rejected
  });

  test("open replaces a prior window (only one active)", () => {
    const { ctl } = controllerAt(1000);
    ctl.open("first");
    ctl.open("second");
    expect(ctl.confirm("123456")).toEqual({ label: "second" });
  });

  test("default code generator yields a 6-digit numeric code", () => {
    const ctl = new PairingWindowController({ nowMs: () => 0 });
    const { code } = ctl.open("x");
    expect(code).toMatch(/^\d{6}$/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/clips/pairing-window.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/clips/pairing-window.ts
import { randomInt } from "node:crypto";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";

export const PAIRING_TTL_MS = 120_000;
export const PAIRING_MAX_ATTEMPTS = 5;

export interface PairingWindowDeps {
  readonly nowMs: () => number;
  readonly genCode?: () => string;
}

interface OpenWindow {
  readonly label: string;
  readonly code: string;
  readonly expiresAtMs: number;
  attempts: number;
}

function defaultCode(): string {
  return String(randomInt(0, 1_000_000)).padStart(6, "0");
}

/**
 * A single, in-memory pairing window. Strictly ephemeral — a gateway restart drops it (I30:
 * a token is minted only behind a live, owner-opened, unexpired, attempts-remaining window).
 */
export class PairingWindowController {
  private window: OpenWindow | null = null;
  private readonly nowMs: () => number;
  private readonly genCode: () => string;

  constructor(deps: PairingWindowDeps) {
    this.nowMs = deps.nowMs;
    this.genCode = deps.genCode ?? defaultCode;
  }

  open(label: string): { code: string; expiresAtMs: number } {
    const code = this.genCode();
    const expiresAtMs = this.nowMs() + PAIRING_TTL_MS;
    this.window = { label, code, expiresAtMs, attempts: 0 };
    return { code, expiresAtMs };
  }

  isOpen(): boolean {
    const w = this.window;
    if (w === null) return false;
    if (this.nowMs() > w.expiresAtMs) {
      this.window = null;
      return false;
    }
    return true;
  }

  confirm(code: string): { label: string } | null {
    const w = this.window;
    if (w === null) return null;
    if (this.nowMs() > w.expiresAtMs) {
      this.window = null;
      return null;
    }
    w.attempts += 1;
    if (constantTimeStringEqual(code, w.code)) {
      this.window = null; // single-use
      return { label: w.label };
    }
    if (w.attempts >= PAIRING_MAX_ATTEMPTS) {
      this.window = null; // attempt cap reached → close
    }
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/clips/pairing-window.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/clips/pairing-window.ts packages/gateway/src/clips/pairing-window.test.ts
git commit -m "feat(clips): in-memory single-use pairing window (I30 substrate)"
```

---

## Task 3: Clip ingest (validation + canonicalization + upsert)

**Files:**

- Create: `packages/gateway/src/clips/clip-ingest.ts`
- Test: `packages/gateway/src/clips/clip-ingest.test.ts`

**Interfaces:**

- Consumes: `Database` from `bun:sqlite`; `upsertIndexedItem` from `../index/item-store.ts`.
- Produces:
  - `interface ClipInput { url: string; canonicalUrl?: string; title: string; mode: "article" | "selection"; body: string; tags?: string[]; capturedAt: number }`
  - `interface ClipResult { id: string; status: "created" | "updated" }`
  - `canonicalizeUrl(raw: string): string` (strips `utm_*`/`fbclid`/`gclid`, drops hash + trailing slash)
  - `validateClipInput(parsed: unknown): ClipInput` (throws `ClipValidationError` with a `.field`)
  - `class ClipValidationError extends Error { field?: string }`
  - `ingestClip(db: Database, input: ClipInput, scheduleEmbedding?: (id: string) => void): ClipResult`

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/clips/clip-ingest.test.ts
import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations } from "../index/migrate.ts";
import {
  canonicalizeUrl,
  ClipValidationError,
  ingestClip,
  validateClipInput,
} from "./clip-ingest.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  applyMigrations(db); // creates the `item` table + FTS triggers
});
afterEach(() => db.close());

function getItem(id: string): Record<string, unknown> | undefined {
  return db.query("SELECT * FROM item WHERE id = ?").get(id) as Record<string, unknown> | undefined;
}

describe("canonicalizeUrl", () => {
  test("strips tracking params and hash, drops trailing slash", () => {
    expect(canonicalizeUrl("https://ex.com/p/?utm_source=x&id=7#frag")).toBe(
      "https://ex.com/p?id=7",
    );
  });
  test("idempotent on a clean URL", () => {
    expect(canonicalizeUrl("https://ex.com/a")).toBe("https://ex.com/a");
  });
  test("root URL keeps its slash (no truncation)", () => {
    expect(canonicalizeUrl("https://ex.com/")).toBe("https://ex.com/");
  });
  test("root URL with and without slash canonicalize identically", () => {
    expect(canonicalizeUrl("https://ex.com")).toBe(canonicalizeUrl("https://ex.com/"));
  });
  test("non-URL string passes through unchanged", () => {
    expect(canonicalizeUrl("not a url")).toBe("not a url");
  });
});

describe("validateClipInput", () => {
  const good = {
    url: "https://ex.com/p",
    title: "Title",
    mode: "article",
    body: "text",
    capturedAt: 1750000000000,
  };
  test("accepts a well-formed article clip", () => {
    expect(validateClipInput(good).mode).toBe("article");
  });
  test("rejects missing title with field=title", () => {
    expect(() => validateClipInput({ ...good, title: undefined })).toThrow(ClipValidationError);
    try {
      validateClipInput({ ...good, title: undefined });
    } catch (e) {
      expect((e as ClipValidationError).field).toBe("title");
    }
  });
  test("rejects an unknown mode", () => {
    expect(() => validateClipInput({ ...good, mode: "weird" })).toThrow(ClipValidationError);
  });
  test("rejects non-object input", () => {
    expect(() => validateClipInput(null)).toThrow(ClipValidationError);
  });
  test("coerces missing tags to []", () => {
    expect(validateClipInput(good).tags).toEqual([]);
  });
});

describe("ingestClip", () => {
  const base = {
    url: "https://ex.com/p?utm_source=z",
    title: "Hello",
    mode: "article" as const,
    body: "The body text",
    tags: ["research"],
    capturedAt: 1750000000000,
  };

  test("article clip → created, web_clip row searchable by FTS", () => {
    const res = ingestClip(db, base);
    expect(res.status).toBe("created");
    const row = getItem(res.id);
    expect(row?.service).toBe("nimbus");
    expect(row?.type).toBe("web_clip");
    expect(row?.canonical_url).toBe("https://ex.com/p");
    const fts = db
      .query("SELECT id FROM item_fts WHERE item_fts MATCH ?")
      .all("Hello") as Array<{ id: string }>;
    expect(fts.some((r) => r.id === res.id)).toBe(true);
  });

  test("re-clipping the same canonical URL (article) updates the same row", () => {
    const a = ingestClip(db, base);
    const b = ingestClip(db, { ...base, title: "Hello v2" });
    expect(b.id).toBe(a.id);
    expect(b.status).toBe("updated");
    expect(getItem(a.id)?.title).toBe("Hello v2");
  });

  test("two distinct selections on the same page get distinct ids", () => {
    const s1 = ingestClip(db, { ...base, mode: "selection", body: "first highlight" });
    const s2 = ingestClip(db, { ...base, mode: "selection", body: "second highlight" });
    expect(s1.id).not.toBe(s2.id);
  });

  test("calls scheduleEmbedding with the upserted id", () => {
    const seen: string[] = [];
    const res = ingestClip(db, base, (id) => seen.push(id));
    expect(seen).toEqual([res.id]);
  });

  test("tags + mode + wordCount land in metadata JSON", () => {
    const res = ingestClip(db, base);
    const meta = JSON.parse(String(getItem(res.id)?.metadata)) as Record<string, unknown>;
    expect(meta.tags).toEqual(["research"]);
    expect(meta.mode).toBe("article");
    expect(meta.wordCount).toBe(3);
  });
});
```

> **Note on `applyMigrations` import:** confirm the exact migration-runner export with `grep -rn "export function applyMigrations\|export async function migrate" packages/gateway/src/index`. If the runner is named differently (e.g. `runMigrations`/`migrateToLatest`), use that name and signature in the test's `beforeEach`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/clips/clip-ingest.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/clips/clip-ingest.ts
import { createHash } from "node:crypto";
import type { Database } from "bun:sqlite";
import { itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";

export interface ClipInput {
  readonly url: string;
  readonly canonicalUrl?: string;
  readonly title: string;
  readonly mode: "article" | "selection";
  readonly body: string;
  readonly tags: readonly string[];
  readonly capturedAt: number;
}

export interface ClipResult {
  readonly id: string;
  readonly status: "created" | "updated";
}

export class ClipValidationError extends Error {
  readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.name = "ClipValidationError";
    if (field !== undefined) this.field = field;
  }
}

const TRACKING_PREFIXES = ["utm_"];
const TRACKING_EXACT = new Set(["fbclid", "gclid", "mc_eid", "igshid"]);

export function canonicalizeUrl(raw: string): string {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return raw;
  }
  u.hash = "";
  for (const key of [...u.searchParams.keys()]) {
    if (TRACKING_EXACT.has(key) || TRACKING_PREFIXES.some((p) => key.startsWith(p))) {
      u.searchParams.delete(key);
    }
  }
  // Strip a trailing slash on NON-root paths only — keep the root "https://host/" intact
  // (truncating it to "https://host" trips some URL parsers and risks dedup mismatch).
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
    u.pathname = u.pathname.slice(0, -1);
  }
  return u.toString();
}

function sha256(s: string): string {
  return createHash("sha256").update(s).digest("hex");
}

function asString(o: Record<string, unknown>, key: string): string {
  const v = o[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ClipValidationError(`${key} (non-empty string) is required`, key);
  }
  return v;
}

export function validateClipInput(parsed: unknown): ClipInput {
  if (parsed === null || typeof parsed !== "object") {
    throw new ClipValidationError("body must be a JSON object");
  }
  const o = parsed as Record<string, unknown>;
  const url = asString(o, "url");
  const title = asString(o, "title");
  const body = asString(o, "body");
  const mode = o["mode"];
  if (mode !== "article" && mode !== "selection") {
    throw new ClipValidationError('mode must be "article" or "selection"', "mode");
  }
  const capturedAt = o["capturedAt"];
  if (typeof capturedAt !== "number" || !Number.isFinite(capturedAt)) {
    throw new ClipValidationError("capturedAt (epoch ms) is required", "capturedAt");
  }
  const rawTags = o["tags"];
  const tags =
    rawTags === undefined
      ? []
      : Array.isArray(rawTags) && rawTags.every((t) => typeof t === "string")
        ? (rawTags as string[])
        : (() => {
            throw new ClipValidationError("tags must be a string array", "tags");
          })();
  const canonicalUrl = typeof o["canonicalUrl"] === "string" ? (o["canonicalUrl"] as string) : undefined;
  return { url, title, body, mode, capturedAt, tags, ...(canonicalUrl ? { canonicalUrl } : {}) };
}

function externalIdFor(input: ClipInput, canonical: string): string {
  const base = `clip:${sha256(canonical)}`;
  return input.mode === "selection" ? `${base}:${sha256(input.body)}` : base;
}

function wordCount(text: string): number {
  const t = text.trim();
  return t === "" ? 0 : t.split(/\s+/).length;
}

export function ingestClip(
  db: Database,
  input: ClipInput,
  scheduleEmbedding?: (id: string) => void,
): ClipResult {
  // Always canonicalize — even a caller-supplied canonicalUrl — so re-clip dedup is consistent
  // regardless of what the extension sends (it might send a raw or partially-normalized URL).
  const canonical = canonicalizeUrl(input.canonicalUrl ?? input.url);
  const externalId = externalIdFor(input, canonical);
  const id = itemPrimaryKey("nimbus", externalId);
  const existed =
    db.query("SELECT 1 FROM item WHERE id = ?").get(id) !== null &&
    db.query("SELECT 1 FROM item WHERE id = ?").get(id) !== undefined;
  upsertIndexedItem(db, {
    service: "nimbus",
    type: "web_clip",
    externalId,
    title: input.title,
    bodyPreview: input.body,
    url: input.url,
    canonicalUrl: canonical,
    modifiedAt: input.capturedAt,
    syncedAt: input.capturedAt,
    metadata: {
      tags: input.tags,
      mode: input.mode,
      wordCount: wordCount(input.body),
      clippedAt: input.capturedAt,
    },
  });
  scheduleEmbedding?.(id);
  return { id, status: existed ? "updated" : "created" };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/clips/clip-ingest.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the type + lint gate**

Run: `bun run preflight:fast`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/clips/clip-ingest.ts packages/gateway/src/clips/clip-ingest.test.ts
git commit -m "feat(clips): web_clip ingest — validate, canonicalize, upsert, embed"
```

---

## Task 4: Embedding routing — `nimbus:web_clip` is prose-heavy

**Files:**

- Modify: `packages/gateway/src/embedding/routing.ts`
- Test: `packages/gateway/src/embedding/routing.test.ts` (existing — add a case; if absent, create it)

**Interfaces:**

- Consumes: `isProseHeavy`, `PROSE_HEAVY_TYPES` from `./routing.ts`.
- Produces: no new symbols — `nimbus:web_clip` joins the set.

- [ ] **Step 1: Add the failing test case**

```typescript
// append inside packages/gateway/src/embedding/routing.test.ts (or new file with imports)
import { describe, expect, test } from "bun:test";
import { isProseHeavy } from "./routing.ts";

describe("routing — web clip", () => {
  test("nimbus:web_clip routes prose-heavy (OpenAI 1536)", () => {
    expect(isProseHeavy("nimbus", "web_clip")).toBe(true);
  });
  test("a non-prose nimbus type is not prose-heavy", () => {
    expect(isProseHeavy("nimbus", "other")).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/embedding/routing.test.ts -t "web clip"`
Expected: FAIL — `isProseHeavy("nimbus","web_clip")` is `false`.

- [ ] **Step 3: Add the type to the set**

In `packages/gateway/src/embedding/routing.ts`, inside `PROSE_HEAVY_TYPES`, after the `"protonmail:email"` entry add:

```typescript
  // Web-clipper readable-article / selection bodies are prose paragraphs — same
  // hybrid posture as gmail:email: MiniLM-384 fallback when openai.api_key is absent.
  "nimbus:web_clip",
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/embedding/routing.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/embedding/routing.ts packages/gateway/src/embedding/routing.test.ts
git commit -m "feat(clips): route nimbus:web_clip embeddings prose-heavy"
```

---

## Task 5: HTTP write routes — clip ingest + pairing confirm

**Files:**

- Modify: `packages/gateway/src/ipc/http-write-routes.ts`
- Modify: `packages/gateway/src/ipc/http-write-routes.test.ts` (allowlist count 6→8 + new-route cases)

**Interfaces:**

- Consumes: `PairingWindowController` (Task 2); `verifyClipToken`, `addClipToken`, `generateClipToken` (Task 1); `ingestClip`, `validateClipInput`, `ClipValidationError` (Task 3); existing `WriteRouteContext` plumbing.
- Produces (added to `http-write-routes.ts`):
  - `ROUTE_CLIPS = "POST /v1/clips"`, `ROUTE_CLIPS_PAIR_CONFIRM = "POST /v1/clips/pair/confirm"` in `WRITE_ROUTE_ALLOWLIST` (now length 8)
  - `interface ClipsWriteSurface { readonly pairing: PairingWindowController; readonly verifyToken: (presented: string) => Promise<{ label: string } | null>; readonly mintToken: (label: string) => Promise<string>; readonly ingest: (input: unknown) => { id: string; status: "created" | "updated" } }`
  - `clips?: ClipsWriteSurface` on `WriteRouteContext`
  - `RouteKind` extended with `"clipIngest" | "clipPairConfirm"`

- [ ] **Step 1: Write the failing tests**

```typescript
// add to packages/gateway/src/ipc/http-write-routes.test.ts
import { PairingWindowController } from "../clips/pairing-window.ts";

function clipsSurface(over: Partial<ClipsWriteSurface> = {}): ClipsWriteSurface {
  const pairing = new PairingWindowController({ nowMs: () => 1000, genCode: () => "123456" });
  return {
    pairing,
    verifyToken: async (t) => (t === "good-token" ? { label: "chrome" } : null),
    mintToken: async () => "minted-token",
    ingest: () => ({ id: "nimbus:clip:abc", status: "created" }),
    ...over,
  };
}

function clipCtx(over: Partial<WriteRouteContext> = {}): WriteRouteContext {
  // reuse the file's existing ctx factory if present; otherwise build a minimal one with
  // writeDb (in-memory), a permissive rateLimiter, nowMs:()=>1000, knownServices:()=>[]
  return { ...baseWriteCtx(), clips: clipsSurface(), ...over };
}

test("WRITE_ROUTE_ALLOWLIST now includes the two clip write routes (length 8)", () => {
  expect(WRITE_ROUTE_ALLOWLIST.length).toBe(8);
  expect([...WRITE_ROUTE_ALLOWLIST]).toEqual([
    "POST /v1/deployments",
    "POST /scim/v2/Users",
    "PATCH /scim/v2/Users/{id}",
    "DELETE /scim/v2/Users/{id}",
    "PUT /v1/admin/policy",
    "POST /v1/messaging/teams/events",
    "POST /v1/clips",
    "POST /v1/clips/pair/confirm",
  ]);
});

test("POST /v1/clips with a valid token ingests and returns 200 created", async () => {
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: JSON.stringify({
      url: "https://ex.com/p",
      title: "T",
      mode: "article",
      body: "b",
      capturedAt: 1750000000000,
    }),
  });
  const res = await dispatchWriteRoute(req, clipCtx());
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ id: "nimbus:clip:abc", status: "created" });
});

test("POST /v1/clips with a bad token → 401 (no ingest)", async () => {
  let ingested = false;
  const ctx = clipCtx({
    clips: clipsSurface({ ingest: () => ((ingested = true), { id: "x", status: "created" }) }),
  });
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer WRONG", "content-type": "application/json" },
    body: JSON.stringify({ url: "u", title: "t", mode: "article", body: "b", capturedAt: 1 }),
  });
  const res = await dispatchWriteRoute(req, ctx);
  expect(res.status).toBe(401);
  expect(ingested).toBe(false);
});

test("POST /v1/clips with invalid payload → 400 with field", async () => {
  const ctx = clipCtx({
    clips: clipsSurface({
      ingest: () => {
        throw new ClipValidationError("mode required", "mode");
      },
    }),
  });
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token", "content-type": "application/json" },
    body: JSON.stringify({ url: "u", title: "t", mode: "x", body: "b", capturedAt: 1 }),
  });
  const res = await dispatchWriteRoute(req, ctx);
  expect(res.status).toBe(400);
});

test("pair/confirm with the right code mints a token (window open)", async () => {
  const surface = clipsSurface();
  surface.pairing.open("chrome-work");
  const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
  const res = await dispatchWriteRoute(req, clipCtx({ clips: surface }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ token: "minted-token", label: "chrome-work" });
});

test("pair/confirm fail-closed: no window open → 403, no mint", async () => {
  let minted = false;
  const surface = clipsSurface({ mintToken: async () => ((minted = true), "x") });
  // window NOT opened
  const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: "123456" }),
  });
  const res = await dispatchWriteRoute(req, clipCtx({ clips: surface }));
  expect(res.status).toBe(403);
  expect(minted).toBe(false);
});

test("clip routes are 404 when the clips seam is absent", async () => {
  const req = new Request("http://127.0.0.1/v1/clips", {
    method: "POST",
    headers: { authorization: "Bearer good-token" },
    body: "{}",
  });
  const res = await dispatchWriteRoute(req, clipCtx({ clips: undefined }));
  expect(res.status).toBe(404);
});
```

> Use the file's existing context factory if one exists (search the test file for how `WriteRouteContext` is built for the deployment tests) and extend it with `clips`. If none exists, add a `baseWriteCtx()` helper that returns a minimal valid `WriteRouteContext` (in-memory `new Database(":memory:")` for `writeDb`, an always-allow `rateLimiter`, `nowMs: () => 1000`, `knownServices: () => []`, `expectedToken: ""`).

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test packages/gateway/src/ipc/http-write-routes.test.ts`
Expected: FAIL — allowlist length is 6; clip routes resolve to 404.

- [ ] **Step 3: Implement the clip routes**

In `http-write-routes.ts`:

(a) Add the route constants + allowlist entries:

```typescript
const ROUTE_CLIPS = "POST /v1/clips";
const ROUTE_CLIPS_PAIR_CONFIRM = "POST /v1/clips/pair/confirm";
```

Append both to `WRITE_ROUTE_ALLOWLIST` (after `ROUTE_TEAMS_EVENTS`).

(b) Add the seam interface + the `clips?` field on `WriteRouteContext`:

```typescript
import { ClipValidationError } from "../clips/clip-ingest.ts";
import type { PairingWindowController } from "../clips/pairing-window.ts";

export interface ClipsWriteSurface {
  readonly pairing: PairingWindowController;
  readonly verifyToken: (presented: string) => Promise<{ label: string } | null>;
  readonly mintToken: (label: string) => Promise<string>;
  readonly ingest: (input: unknown) => { id: string; status: "created" | "updated" };
}
```

Add `readonly clips?: ClipsWriteSurface;` to `WriteRouteContext`. Extend `RouteKind`:

```typescript
type RouteKind = "deployment" | "scim" | "policy" | "teamsEvents" | "clipIngest" | "clipPairConfirm";
```

Add reject-action + hint constants:

```typescript
const CLIP_DISABLED_HINT = "web clipper disabled — pair a browser with 'nimbus clip pair'";
const CLIP_REJECT_ACTION = "clip.ingest_rejected";
const CLIP_PAIR_REJECT_ACTION = "clip.pair_rejected";
```

(c) Add resolvers and register them in `resolveRoute`:

```typescript
function resolveClipIngestRoute(method: string, ctx: WriteRouteContext): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.clips === undefined) return notFound();
  return {
    key: ROUTE_CLIPS,
    kind: "clipIngest",
    expectedToken: "", // verified in-route against the labeled token map (teamsEvents precedent)
    disabledHint: CLIP_DISABLED_HINT,
    rejectAction: CLIP_REJECT_ACTION,
    hasBody: true,
  };
}

function resolveClipPairConfirmRoute(method: string, ctx: WriteRouteContext): ResolvedRoute | Response {
  if (method !== "POST") return methodNotAllowed("POST");
  if (ctx.clips === undefined) return notFound();
  return {
    key: ROUTE_CLIPS_PAIR_CONFIRM,
    kind: "clipPairConfirm",
    expectedToken: "", // gated by the pairing code, not a bearer
    disabledHint: CLIP_DISABLED_HINT,
    rejectAction: CLIP_PAIR_REJECT_ACTION,
    hasBody: true,
  };
}
```

In `resolveRoute`, before the SCIM-item regex, add:

```typescript
  if (path === "/v1/clips") return resolveClipIngestRoute(method, ctx);
  if (path === "/v1/clips/pair/confirm") return resolveClipPairConfirmRoute(method, ctx);
```

(d) In `checkAuth`, skip `requireBearer` for both clip kinds (auth happens in-route, like `teamsEvents`):

```typescript
  if (route.kind === "teamsEvents" || route.kind === "clipPairConfirm") {
    return { fingerprint: route.kind === "teamsEvents" ? "teams-bot" : "clip-pair" };
  }
  if (route.kind === "clipIngest") {
    return { fingerprint: "clip" }; // token verified in runClipIngestRoute
  }
```

(e) Add the two run handlers:

```typescript
function bearerToken(req: Request): string | undefined {
  const raw = req.headers.get("authorization");
  return raw !== null && raw.startsWith("Bearer ") ? raw.slice("Bearer ".length) : undefined;
}

async function runClipIngestRoute(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  req: Request,
  parsed: unknown,
): Promise<Response> {
  const clips = ctx.clips as ClipsWriteSurface;
  const presented = bearerToken(req);
  const verdict = presented === undefined ? null : await clips.verifyToken(presented);
  if (verdict === null) {
    recordRejection(ctx, {
      actionType: CLIP_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 401,
      reason: "unauthorized",
    });
    return jsonResponse({ error: "unauthorized" }, 401, rateLimitHeaders(limit));
  }
  try {
    const out = clips.ingest(parsed);
    return jsonResponse(out, 200, rateLimitHeaders(limit));
  } catch (e) {
    if (e instanceof ClipValidationError) {
      recordRejection(ctx, {
        actionType: CLIP_REJECT_ACTION,
        tokenFingerprint: fingerprint,
        resultCode: 400,
        reason: e.field === undefined ? "invalid_request" : `invalid_${e.field}`,
      });
      return jsonResponse(
        { error: "invalid_request", ...(e.field === undefined ? {} : { field: e.field }) },
        400,
        rateLimitHeaders(limit),
      );
    }
    recordRejection(ctx, {
      actionType: CLIP_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 500,
      reason: "internal_error",
    });
    return jsonResponse({ error: "internal_error" }, 500, rateLimitHeaders(limit));
  }
}

function extractCode(parsed: unknown): string | undefined {
  if (parsed !== null && typeof parsed === "object" && "code" in parsed) {
    const c = (parsed as { code?: unknown }).code;
    return typeof c === "string" ? c : undefined;
  }
  return undefined;
}

async function runClipPairConfirmRoute(
  ctx: WriteRouteContext,
  fingerprint: string,
  limit: RateLimitCheck,
  parsed: unknown,
): Promise<Response> {
  const clips = ctx.clips as ClipsWriteSurface;
  const code = extractCode(parsed);
  const confirmed = code === undefined ? null : clips.pairing.confirm(code);
  if (confirmed === null) {
    recordRejection(ctx, {
      actionType: CLIP_PAIR_REJECT_ACTION,
      tokenFingerprint: fingerprint,
      resultCode: 403,
      reason: "no_active_window_or_bad_code",
    });
    return jsonResponse({ error: "pairing_failed" }, 403, rateLimitHeaders(limit));
  }
  const token = await clips.mintToken(confirmed.label);
  return jsonResponse({ token, label: confirmed.label }, 200, rateLimitHeaders(limit));
}
```

(f) Wire both into `dispatchWriteRoute` (after the `teamsEvents` branch, before the final `runScimRoute`):

```typescript
  if (route.kind === "clipIngest") {
    return runClipIngestRoute(ctx, auth.fingerprint, limit, req, parsed);
  }
  if (route.kind === "clipPairConfirm") {
    return runClipPairConfirmRoute(ctx, auth.fingerprint, limit, parsed);
  }
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc/http-write-routes.test.ts`
Expected: PASS.

- [ ] **Step 5: Run the type + lint gate**

Run: `bun run preflight:fast`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/http-write-routes.ts packages/gateway/src/ipc/http-write-routes.test.ts
git commit -m "feat(clips): POST /v1/clips + pairing-confirm write routes (I13)"
```

---

## Task 6: Related-items read route + http-server seam wiring

**Files:**

- Create: `packages/gateway/src/clips/clip-related.ts`
- Test: `packages/gateway/src/clips/clip-related.test.ts`
- Modify: `packages/gateway/src/ipc/http-server.ts` (mount `POST /v1/clips/related`; build the `clips` write-route seam)

**Interfaces:**

- Consumes: the existing hybrid-search entry — confirm its name with `grep -rn "export .*function .*search" packages/gateway/src/search` (the spec's exploration named `hybrid-internal.ts` / `dual-search.ts`). Use the function that takes a text query + limit and returns ranked items.
- Produces:
  - `interface RelatedInput { title?: string; canonicalUrl?: string; selection?: string; limit?: number }`
  - `buildRelatedQuery(input: RelatedInput): { query: string; excludeHost?: string }` — selection-primary, else title; host parsed from `canonicalUrl`
  - `async runClipRelated(deps: ClipRelatedDeps, input: RelatedInput): Promise<{ items: RelatedHit[] }>` where `ClipRelatedDeps` injects the search function (keeps this unit testable without a full index)

- [ ] **Step 1: Write the failing test (pure query-builder + injected search)**

```typescript
// packages/gateway/src/clips/clip-related.test.ts
import { describe, expect, test } from "bun:test";
import { buildRelatedQuery, runClipRelated } from "./clip-related.ts";

describe("buildRelatedQuery", () => {
  test("selection present → selection is the query", () => {
    expect(buildRelatedQuery({ title: "Docs", selection: "vector index" }).query).toBe(
      "vector index",
    );
  });
  test("no selection → title is the query", () => {
    expect(buildRelatedQuery({ title: "Vector indexes" }).query).toBe("Vector indexes");
  });
  test("canonicalUrl host is parsed into excludeHost", () => {
    expect(buildRelatedQuery({ title: "x", canonicalUrl: "https://ex.com/p" }).excludeHost).toBe(
      "ex.com",
    );
  });
  test("empty inputs → empty query, no host", () => {
    const q = buildRelatedQuery({});
    expect(q.query).toBe("");
    expect(q.excludeHost).toBeUndefined();
  });
});

describe("runClipRelated", () => {
  test("delegates to the injected search and passes the built query", async () => {
    const calls: Array<{ query: string; limit: number }> = [];
    const out = await runClipRelated(
      {
        search: async (query, limit) => {
          calls.push({ query, limit });
          return [{ id: "drive:1", title: "Hit", service: "drive", snippet: "s", url: "u" }];
        },
      },
      { selection: "vector index", limit: 5 },
    );
    expect(calls).toEqual([{ query: "vector index", limit: 5 }]);
    expect(out.items).toHaveLength(1);
  });

  test("empty query short-circuits to no results (no search call)", async () => {
    let called = false;
    const out = await runClipRelated(
      {
        search: async () => {
          called = true;
          return [];
        },
      },
      {},
    );
    expect(called).toBe(false);
    expect(out.items).toEqual([]);
  });

  test("filters out hits whose url host matches excludeHost", async () => {
    const out = await runClipRelated(
      {
        search: async () => [
          { id: "a", title: "self", service: "nimbus", snippet: "", url: "https://ex.com/self" },
          { id: "b", title: "other", service: "drive", snippet: "", url: "https://other.com/x" },
        ],
      },
      { title: "x", canonicalUrl: "https://ex.com/p" },
    );
    expect(out.items.map((i) => i.id)).toEqual(["b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/clips/clip-related.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `clip-related.ts`**

```typescript
// packages/gateway/src/clips/clip-related.ts
export interface RelatedInput {
  readonly title?: string;
  readonly canonicalUrl?: string;
  readonly selection?: string;
  readonly limit?: number;
}

export interface RelatedHit {
  readonly id: string;
  readonly title: string;
  readonly service: string;
  readonly snippet: string;
  readonly url: string | null;
}

export interface ClipRelatedDeps {
  /** Injected hybrid-search adapter (text query + limit → ranked hits). */
  readonly search: (query: string, limit: number) => Promise<RelatedHit[]>;
}

const DEFAULT_LIMIT = 10;
const MAX_LIMIT = 25;

function hostOf(url: string | null | undefined): string | undefined {
  if (url === null || url === undefined) return undefined;
  try {
    return new URL(url).host;
  } catch {
    return undefined;
  }
}

export function buildRelatedQuery(input: RelatedInput): { query: string; excludeHost?: string } {
  const query = (input.selection ?? input.title ?? "").trim();
  const excludeHost = hostOf(input.canonicalUrl);
  return excludeHost === undefined ? { query } : { query, excludeHost };
}

export async function runClipRelated(
  deps: ClipRelatedDeps,
  input: RelatedInput,
): Promise<{ items: RelatedHit[] }> {
  const { query, excludeHost } = buildRelatedQuery(input);
  if (query === "") return { items: [] };
  const limit = Math.min(MAX_LIMIT, Math.max(1, input.limit ?? DEFAULT_LIMIT));
  const hits = await deps.search(query, limit);
  const items =
    excludeHost === undefined ? hits : hits.filter((h) => hostOf(h.url) !== excludeHost);
  return { items };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/clips/clip-related.test.ts`
Expected: PASS.

- [ ] **Step 5: Mount the read route + build the clips write-route seam in `http-server.ts`**

(a) Locate the main `fetch`/request handler in `http-server.ts` and the GET read-route branch. Add a branch handling the bearer-authed read:

```typescript
// inside the http-server request handler, alongside the other route checks:
if (url.pathname === "/v1/clips/related" && req.method === "POST") {
  return handleClipRelated(req, writeRouteDeps, vault, localIndex);
}
```

Add the handler (verify the hybrid-search function name first — `grep -rn "export" packages/gateway/src/search/hybrid-internal.ts packages/gateway/src/search/dual-search.ts`):

```typescript
import { runClipRelated, type RelatedInput } from "../clips/clip-related.ts";
import { verifyClipToken } from "../clips/clip-token-store.ts";

async function handleClipRelated(
  req: Request,
  /* deps: same writeDb / search access used elsewhere */
): Promise<Response> {
  const raw = req.headers.get("authorization");
  const presented = raw !== null && raw.startsWith("Bearer ") ? raw.slice(7) : undefined;
  if (presented === undefined || (await verifyClipToken(vault, presented)) === null) {
    return new Response(JSON.stringify({ error: "unauthorized" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }
  let body: RelatedInput;
  try {
    body = (await req.json()) as RelatedInput;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), { status: 400 });
  }
  const out = await runClipRelated(
    { search: async (query, limit) => /* adapt existing hybrid search → RelatedHit[] */ [] },
    body,
  );
  return new Response(JSON.stringify(out), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}
```

> The `search` adapter must call the real hybrid-search function and map its rows to `RelatedHit`. Because the http-server already owns a read DB handle + (optionally) the embedding pipeline, reuse whatever `index.search` uses internally. Keep the mapping thin.

(b) Build the `clips` seam for the write-route deps. In `resolveWriteRouteDeps` (around line 448), after the other seams, add:

```typescript
import { PairingWindowController } from "../clips/pairing-window.ts";
import { addClipToken, generateClipToken, verifyClipToken } from "../clips/clip-token-store.ts";
import { ingestClip, validateClipInput } from "../clips/clip-ingest.ts";

// `pairingController` is a SINGLETON created once at assemble time and shared with the
// clip-rpc IPC handler (Task 7) — pass it into ReadOnlyHttpServerOptions, do NOT new it per request.
const clips =
  opts.clipsVault === undefined || opts.pairingController === undefined
    ? undefined
    : {
        pairing: opts.pairingController,
        verifyToken: (t: string) => verifyClipToken(opts.clipsVault!, t),
        mintToken: async (label: string) => {
          const token = generateClipToken();
          await addClipToken(opts.clipsVault!, label, token);
          return token;
        },
        ingest: (input: unknown) =>
          ingestClip(writeDb, validateClipInput(input), opts.scheduleEmbedding),
      };

return {
  // ...existing fields...
  ...(clips === undefined ? {} : { clips }),
};
```

Add `clipsVault?`, `pairingController?`, and `scheduleEmbedding?` to `ReadOnlyHttpServerOptions`.

- [ ] **Step 6: Run the gateway suite + types**

Run: `bun test packages/gateway/src/clips packages/gateway/src/ipc/http-write-routes.test.ts && bun run preflight:fast`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/clips/clip-related.ts packages/gateway/src/clips/clip-related.test.ts packages/gateway/src/ipc/http-server.ts
git commit -m "feat(clips): related-items read route + http-server clip seam"
```

---

## Task 7: Clip IPC dispatcher + assemble wiring

**Files:**

- Create: `packages/gateway/src/ipc/clip-rpc.ts`
- Test: `packages/gateway/src/ipc/clip-rpc.test.ts`
- Modify: the IPC dispatcher registry (locate — Step 0) + the assemble/boot site that constructs the HTTP server (to create + share the singleton `PairingWindowController`)

**Interfaces:**

- Consumes: `PairingWindowController` (Task 2); `listClipFingerprints`, `revokeClipToken` (Task 1); `NimbusVault`.
- Produces:
  - `interface ClipRpcDeps { pairing: PairingWindowController; vault: NimbusVault }`
  - `async dispatchClipRpc(method: string, params: unknown, deps: ClipRpcDeps): Promise<{ kind: "hit"; value: unknown } | { kind: "miss" }>`
  - Methods: `clip.pair` (`{ label? }` → `{ code, expiresAtMs, label }`), `clip.status` (→ `{ devices: Array<{ label, fingerprint }> }`), `clip.revoke` (`{ label }` → `{ revoked: number }`)

- [ ] **Step 0: Locate the IPC dispatcher registry**

Run: `grep -rn "dispatchVaultGated\|rpcVaultOrMethodNotFound\|Method not found" packages/gateway/src/ipc/server`
Expected: find where method dispatchers are chained (the `*-dispatch` / `dispatchers.ts` site). Note where to add `dispatchClipRpc`.

- [ ] **Step 1: Write the failing test**

```typescript
// packages/gateway/src/ipc/clip-rpc.test.ts
import { describe, expect, test } from "bun:test";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { PairingWindowController } from "../clips/pairing-window.ts";
import { dispatchClipRpc } from "./clip-rpc.ts";

function fakeVault(seed: Record<string, string> = {}): NimbusVault {
  const store = new Map(Object.entries(seed));
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async () => [...store.keys()],
  };
}

function deps() {
  return {
    pairing: new PairingWindowController({ nowMs: () => 1000, genCode: () => "654321" }),
    vault: fakeVault(),
  };
}

describe("dispatchClipRpc", () => {
  test("clip.pair opens a window and returns the code + label", async () => {
    const d = deps();
    const out = await dispatchClipRpc("clip.pair", { label: "chrome" }, d);
    expect(out).toEqual({
      kind: "hit",
      value: { code: "654321", expiresAtMs: 1000 + 120_000, label: "chrome" },
    });
    expect(d.pairing.isOpen()).toBe(true);
  });

  test("clip.pair defaults the label when omitted", async () => {
    const out = await dispatchClipRpc("clip.pair", {}, deps());
    expect(out).toMatchObject({ kind: "hit" });
    expect((out as { value: { label: string } }).value.label).toMatch(/^device-/);
  });

  test("clip.status lists fingerprints, never raw tokens", async () => {
    const d = { ...deps(), vault: fakeVault({ "http_api.web_clipper_tokens": '{"chrome":"secret-tok"}' }) };
    const out = await dispatchClipRpc("clip.status", {}, d);
    const value = (out as { value: { devices: Array<{ label: string; fingerprint: string }> } }).value;
    expect(value.devices[0]?.label).toBe("chrome");
    expect(JSON.stringify(value)).not.toContain("secret-tok");
  });

  test("clip.revoke removes a label", async () => {
    const d = { ...deps(), vault: fakeVault({ "http_api.web_clipper_tokens": '{"chrome":"t"}' }) };
    const out = await dispatchClipRpc("clip.revoke", { label: "chrome" }, d);
    expect(out).toEqual({ kind: "hit", value: { revoked: 1 } });
  });

  test("unknown method → miss", async () => {
    expect(await dispatchClipRpc("clip.nope", {}, deps())).toEqual({ kind: "miss" });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/ipc/clip-rpc.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `clip-rpc.ts`**

```typescript
// packages/gateway/src/ipc/clip-rpc.ts
import { randomBytes } from "node:crypto";
import { listClipFingerprints, revokeClipToken } from "../clips/clip-token-store.ts";
import type { PairingWindowController } from "../clips/pairing-window.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export interface ClipRpcDeps {
  readonly pairing: PairingWindowController;
  readonly vault: NimbusVault;
}

type Outcome = { kind: "hit"; value: unknown } | { kind: "miss" };

function asRecord(p: unknown): Record<string, unknown> {
  return p !== null && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

export async function dispatchClipRpc(
  method: string,
  params: unknown,
  deps: ClipRpcDeps,
): Promise<Outcome> {
  const rec = asRecord(params);
  switch (method) {
    case "clip.pair": {
      // Random suffix, NOT a memory-only counter: a counter resets to 0 on gateway restart and a
      // fresh "device-1" would overwrite an existing "device-1" token in the Vault map.
      const label =
        typeof rec["label"] === "string" && rec["label"].length > 0
          ? (rec["label"] as string)
          : `device-${randomBytes(3).toString("hex")}`;
      const { code, expiresAtMs } = deps.pairing.open(label);
      return { kind: "hit", value: { code, expiresAtMs, label } };
    }
    case "clip.status": {
      const devices = await listClipFingerprints(deps.vault);
      return { kind: "hit", value: { devices } };
    }
    case "clip.revoke": {
      const label = typeof rec["label"] === "string" ? (rec["label"] as string) : "";
      if (label === "") return { kind: "hit", value: { revoked: 0 } };
      const revoked = await revokeClipToken(deps.vault, label);
      return { kind: "hit", value: { revoked } };
    }
    default:
      return { kind: "miss" };
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc/clip-rpc.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the dispatcher + share the singleton controller**

In the dispatcher registry (Step 0), chain `dispatchClipRpc` (construct `ClipRpcDeps` from the gateway's vault + the shared `PairingWindowController`). At the assemble/boot site that starts the HTTP server, create the controller ONCE:

```typescript
const pairingController = new PairingWindowController({ nowMs: () => Date.now() });
// pass to BOTH:
//  - the clip-rpc deps (so `nimbus clip pair` opens the window)
//  - ReadOnlyHttpServerOptions.pairingController (so /v1/clips/pair/confirm consumes it)
// plus: clipsVault: vault, scheduleEmbedding: embeddingRuntime.scheduleItemEmbedding
```

Run: `bun run preflight:fast`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/ipc/clip-rpc.ts packages/gateway/src/ipc/clip-rpc.test.ts packages/gateway/src/ipc/server/
git commit -m "feat(clips): clip.pair/status/revoke IPC + shared pairing controller"
```

---

## Task 8: `nimbus clip` CLI

**Files:**

- Create: `packages/cli/src/commands/clip.ts`
- Test: `packages/cli/src/commands/clip.test.ts`
- Modify: the CLI command router (locate — Step 0)

**Interfaces:**

- Consumes: the CLI's `withIpc` + `IPCClient` pattern (mirror `packages/cli/src/commands/vault.ts`).
- Produces: `runClip(args: string[]): Promise<void>` dispatching `pair` / `status` / `revoke`; pure helpers `formatStatus(devices)` and the usage string for unit testing.

- [ ] **Step 0: Locate the CLI router + the IPC helper**

Run: `grep -rn "runVault\|withIpc\|case \"vault\"" packages/cli/src`
Expected: find the top-level command switch (where `vault` is registered) and the `withIpc` helper import. Register a `case "clip": return runClip(rest);` there.

- [ ] **Step 1: Write the failing test (pure formatting + arg routing)**

```typescript
// packages/cli/src/commands/clip.test.ts
import { describe, expect, test } from "bun:test";
import { CLIP_USAGE, formatStatus } from "./clip.ts";

describe("clip CLI formatting", () => {
  test("formatStatus lists labels + fingerprints", () => {
    const out = formatStatus([{ label: "chrome", fingerprint: "abcd1234" }]);
    expect(out).toContain("chrome");
    expect(out).toContain("abcd1234");
  });
  test("formatStatus reports empty state", () => {
    expect(formatStatus([])).toMatch(/no clipper tokens/i);
  });
  test("usage mentions pair, status, revoke", () => {
    expect(CLIP_USAGE).toMatch(/pair/);
    expect(CLIP_USAGE).toMatch(/status/);
    expect(CLIP_USAGE).toMatch(/revoke/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/cli/src/commands/clip.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement `clip.ts`**

```typescript
// packages/cli/src/commands/clip.ts
import { withIpc } from "../ipc-helper.ts"; // adjust import to the actual helper found in Step 0
import type { IPCClient } from "../ipc-client.ts"; // adjust to actual type path

export const CLIP_USAGE = `Usage:
  nimbus clip pair [--label <device>]   open a pairing window and print the one-time code
  nimbus clip status                    list paired browsers (labels + token fingerprints)
  nimbus clip revoke <label|--all>      revoke a paired browser's token`;

export function formatStatus(devices: Array<{ label: string; fingerprint: string }>): string {
  if (devices.length === 0) return "No clipper tokens registered.";
  return devices.map((d) => `  ${d.label}\t${d.fingerprint}`).join("\n");
}

export async function runClipPair(client: IPCClient, label: string | undefined): Promise<void> {
  const out = await client.call<{ code: string; expiresAtMs: number; label: string }>(
    "clip.pair",
    label === undefined ? {} : { label },
  );
  console.log(`Pairing code for "${out.label}": ${out.code}`);
  console.log("Enter it in the browser extension within 2 minutes.");
}

export async function runClipStatus(client: IPCClient): Promise<void> {
  const out = await client.call<{ devices: Array<{ label: string; fingerprint: string }> }>(
    "clip.status",
    {},
  );
  console.log(formatStatus(out.devices));
}

export async function runClipRevoke(client: IPCClient, label: string): Promise<void> {
  const out = await client.call<{ revoked: number }>("clip.revoke", { label });
  console.log(`Revoked ${out.revoked} token(s).`);
}

export async function runClip(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "pair": {
      const i = rest.indexOf("--label");
      const label = i >= 0 ? rest[i + 1] : undefined;
      await withIpc((c) => runClipPair(c, label));
      return;
    }
    case "status":
      await withIpc((c) => runClipStatus(c));
      return;
    case "revoke": {
      const label = rest[0] === "--all" ? "*" : rest[0];
      if (label === undefined) throw new Error("Usage: nimbus clip revoke <label|--all>");
      await withIpc((c) => runClipRevoke(c, label));
      return;
    }
    default:
      console.log(CLIP_USAGE);
  }
}
```

> Adjust the `withIpc` / `IPCClient` import paths to match what Step 0 found in `vault.ts`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/commands/clip.test.ts`
Expected: PASS.

- [ ] **Step 5: Register the command + run the CLI gate**

Add `case "clip": return runClip(rest);` to the router (Step 0). Update the CLI help text + `docs/cli-reference.md` with the `clip` subcommands.
Run: `bun run preflight:fast`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/commands/clip.ts packages/cli/src/commands/clip.test.ts packages/cli/src docs/cli-reference.md
git commit -m "feat(clips): nimbus clip pair/status/revoke CLI"
```

---

## Task 9: Invariant I30 + allowlist count + docs

**Files:**

- Modify: `packages/gateway/src/security-invariants.test.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`, `CLAUDE.md`, `GEMINI.md`

**Interfaces:**

- Consumes: `PairingWindowController`, `dispatchWriteRoute`, the `clips` seam factory from the tests above.
- Produces: an I30 `describe` block; the allowlist-length assertion updated to 8.

- [ ] **Step 1: Write the failing I30 invariant tests**

```typescript
// add to packages/gateway/src/security-invariants.test.ts
import { PairingWindowController } from "./clips/pairing-window.ts";

describe("I30 — web-clipper token minting is fail-closed behind an owner-opened pairing window", () => {
  test("WRITE_ROUTE_ALLOWLIST is exactly the 8 sanctioned write routes (adds the 2 clip routes)", async () => {
    const { WRITE_ROUTE_ALLOWLIST } = await import("./ipc/http-write-routes.ts");
    expect(WRITE_ROUTE_ALLOWLIST.length).toBe(8);
    expect([...WRITE_ROUTE_ALLOWLIST]).toContain("POST /v1/clips");
    expect([...WRITE_ROUTE_ALLOWLIST]).toContain("POST /v1/clips/pair/confirm");
  });

  test("confirm with no open window mints nothing (fail-closed)", () => {
    const ctl = new PairingWindowController({ nowMs: () => 0, genCode: () => "111111" });
    expect(ctl.confirm("111111")).toBeNull(); // never opened
  });

  test("an expired window does not mint", () => {
    let now = 0;
    const ctl = new PairingWindowController({ nowMs: () => now, genCode: () => "111111" });
    ctl.open("dev");
    now = 200_000; // past the 120s TTL
    expect(ctl.confirm("111111")).toBeNull();
  });

  test("the pairing confirm route returns 403 (not 500/200) when no window is open", async () => {
    // mirror the http-write-routes.test.ts fail-closed case to prove the wiring, not just the unit
    const { dispatchWriteRoute } = await import("./ipc/http-write-routes.ts");
    const surface = {
      pairing: new PairingWindowController({ nowMs: () => 0, genCode: () => "111111" }),
      verifyToken: async () => null,
      mintToken: async () => "SHOULD-NOT-BE-CALLED",
      ingest: () => ({ id: "x", status: "created" as const }),
    };
    const req = new Request("http://127.0.0.1/v1/clips/pair/confirm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code: "111111" }),
    });
    const res = await dispatchWriteRoute(req, { ...baseInvariantWriteCtx(), clips: surface });
    expect(res.status).toBe(403);
  });
});
```

> Reuse the file's existing minimal `WriteRouteContext` factory; if none, add `baseInvariantWriteCtx()` mirroring the Task 5 `baseWriteCtx()`.

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I30"`
Expected: FAIL until the existing length-6 assertion elsewhere in the file is also updated.

- [ ] **Step 3: Update the existing allowlist assertion + add the docs**

Update the existing `WRITE_ROUTE_ALLOWLIST.length` assertion in `security-invariants.test.ts` (the I13 block) from `6` to `8` and append the two clip routes to its `.toEqual([...])` array.

Add to `docs/SECURITY-INVARIANTS.md` a new section mirroring the I29 format:

```markdown
## I30 — web-clipper token minting is fail-closed behind an owner-opened pairing window

**Statement:** A web-clipper bearer token is minted only behind a live, owner-opened, unexpired, single-use, attempts-remaining pairing window (opened via `nimbus clip pair`). Absent such a window the `POST /v1/clips/pair/confirm` route mints nothing (HTTP 403, fail-closed). The window is strictly in-memory; a gateway restart drops it. Minted tokens live in the Vault map `http_api.web_clipper_tokens` and are revocable via `nimbus clip revoke`.

**Wired at:** `packages/gateway/src/clips/pairing-window.ts` (the controller), `packages/gateway/src/ipc/http-write-routes.ts` (`runClipPairConfirmRoute`), `packages/gateway/src/clips/clip-token-store.ts` (mint/verify/revoke).

**Anti-pattern:** minting a token on caller assertion, persisting the pairing window to disk, early-returning out of the multi-token verify (leaks token count), or echoing a raw token in audit/CLI output.

**How to comply:** every new clipper-token path routes through `verifyClipToken` (constant-time) and only mints after `PairingWindowController.confirm` returns a label.
```

Update the I29→I30 ceiling note at the top of `SECURITY-INVARIANTS.md`. In `CLAUDE.md` and `GEMINI.md`, add the I30 bullet to the Security Invariants list (I28 stays reserved) and bump any "through I29"/"I1–I29" prose to I30.

- [ ] **Step 4: Run the full invariant suite**

Run: `bun test packages/gateway/src/security-invariants.test.ts && bun run audit:nimbus-invariants`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
git commit -m "feat(clips): invariant I30 — fail-closed web-clipper pairing window"
```

---

## Task 10: End-to-end — pair → clip → search

**Files:**

- Create: `packages/gateway/src/clips/clip-e2e.test.ts`

**Interfaces:**

- Consumes: the real gateway subprocess harness used by other E2E tests (find one with `grep -rn "spawn.*gateway\|startGateway\|e2e" packages/gateway/src --include=*.test.ts -l`). Mirror its setup (fresh temp configDir, real Vault, real HTTP server).

- [ ] **Step 1: Write the E2E test**

```typescript
// packages/gateway/src/clips/clip-e2e.test.ts
import { describe, expect, test } from "bun:test";
// import the project's real-gateway harness (mirror an existing *-e2e/*integration test)

describe("web clipper E2E", () => {
  test("pair → POST /v1/clips → the clip is searchable", async () => {
    // 1. Start a real gateway (HTTP server on 127.0.0.1, fresh Vault + index).
    // 2. Open a pairing window: call the clip.pair IPC (or directly open the shared controller),
    //    capture { code }.
    // 3. POST /v1/clips/pair/confirm { code } → capture { token }.
    // 4. POST /v1/clips with Bearer <token> and a sample article clip → expect 200 created.
    // 5. Run a search (index.search IPC or `nimbus search`) for a word in the clip title/body →
    //    expect a hit with id starting "nimbus:clip:".
    expect(true).toBe(true); // replace with the real assertions above
  });
});
```

> This is the one task where the harness import paths must be filled from a real sibling test — do not ship the `expect(true)` placeholder. Find the closest existing real-gateway test, copy its boot/teardown, and implement steps 1–5 with concrete assertions. The deliverable is a green E2E that actually pairs, clips, and finds the clip.

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/src/clips/clip-e2e.test.ts`
Expected: PASS (real pair → clip → search round-trip).

- [ ] **Step 3: Commit**

```bash
git add packages/gateway/src/clips/clip-e2e.test.ts
git commit -m "test(clips): E2E pair → clip → search round-trip"
```

---

## Task 11: Docs — roadmap + CHANGELOG

**Files:**

- Modify: `docs/roadmap.md`, `docs/CHANGELOG.md`

- [ ] **Step 1: Update the roadmap row**

In `docs/roadmap.md` § Phase 6 → Deferred from Phase 5 → Browser & Reading, change the Web clipper row from `- [ ]` to `- [x]` with a dated delivered note, mirroring the ArgoCD/Flux/MLflow style on lines 860–865:

```markdown
- [x] **Web clipper** ✅ delivered 2026-06-21 (gateway side) — Chrome+Firefox MV3 extension clips the readable article or selection into the local index as `nimbus:web_clip` items via `POST /v1/clips` (I13); on-demand sidecar of related items; pairing-handshake auth (`nimbus clip pair`) behind new invariant **I30** (fail-closed pairing window). Browser extension ships in Plan B as a separate repo `nimbus-agent/nimbus-web-clipper` (mirrors the `nimbus-vscode` satellite repo).
```

- [ ] **Step 2: Add a CHANGELOG entry**

Per the connector-docs-changelog convention, add a dated entry to `docs/CHANGELOG.md` describing the web-clipper gateway surface, the new routes, the `nimbus clip` CLI, and invariant I30.

- [ ] **Step 3: Commit**

```bash
git add docs/roadmap.md docs/CHANGELOG.md
git commit -m "docs(clips): mark web-clipper gateway delivered + CHANGELOG"
```

---

## Task 12: Full pre-flight + PR

- [ ] **Step 1: Run the full gate set**

Run: `bun run preflight`
Expected: PASS (all-package tsc, Biome, tests, static invariant audit).

- [ ] **Step 2: Verify the coverage floor (Linux-authoritative)**

Per the `nimbus-preflight` skill, build the lcov in Docker (`oven/bun:latest`) and run `audit:coverage-floor`. Every new `packages/gateway/src/clips/*.ts` and `packages/cli/src/commands/clip.ts` must be **≥85% line AND ≥85% branch** (AGENTS.md). Add targeted tests for any uncovered branch before pushing; fix-not-exclude.

Run (host or Docker per the skill): `bun run audit:coverage-floor`
Expected: PASS — no file below the floor.

- [ ] **Step 3: Whole-branch review + open the PR**

Run: `/code-review` over the branch; fix findings. Then push and open the PR with `gh`.

```bash
git push -u origin dev/asafgolombek/web-clipper
gh pr create --fill
```

---

## Self-Review Notes (author)

- **Spec coverage:** ingest route (T3/T5), pairing (T2/T5/T7/T8), labeled multi-token map + constant-time verify (T1), related-read selection-primary + own-host de-prioritize (T6), Shadow DOM/CSS — *Plan B*, embedding prose-heavy (T4), I30 + allowlist (T9), CLI pair/status/revoke (T8), no-HITL/inbound posture (implicit — clips never call the executor; no egress ledger), E2E (T10), docs (T11). The sidecar overlay UI, popup, content script, and Readability bundling are **Plan B** by design (this is the gateway plan).
- **Vault-key allowlist** (T1 Step 6) and **the dual allowlist-count assertions** (T5 + T9) are the two easy-to-miss static gates — both have explicit steps.
- **Placeholders:** the only intentional "fill from a sibling" points are the real-gateway E2E harness (T10) and three `grep`-to-confirm import names (`applyMigrations` T3, the hybrid-search fn T6, the dispatcher/router sites T7/T8) — each has a concrete locate command. No `expect(true)` ships except as a marked T10 scaffold the implementer must replace.
- **Type consistency:** `ClipsWriteSurface` (T5) is consumed verbatim by the http-server seam (T6); `PairingWindowController.confirm → { label } | null` is used identically in T2/T5/T7/T9; `verifyClipToken → { label } | null` in T1/T5/T6.
