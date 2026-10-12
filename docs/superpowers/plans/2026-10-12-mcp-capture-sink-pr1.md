# S3 MCP Capture Sink — PR 1 (notes end to end) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An MCP client connected to `nimbus mcp-server` can call `capture_note` to write a note into the local index. The note is searchable at once and labelled agent-authored. The owner can list, show and revoke notes with `nimbus captures`. All of this goes through the new I28 gate.

**Architecture:** A new gateway module `mcp-sink/` owns one table, `capture` (V66), and one gate, `capture-gate.ts`. Submit runs a fixed ordered check sequence, then writes the capture row, the `nimbus:capture` item and the audit row in ONE transaction. The new `capture.*` / `captures.*` IPC namespaces route through the existing phase-4 platform dispatcher table. On the CLI side, a `capture-tools.ts` module registers `capture_note` only when `capture.status` says the sink is enabled. A new `nimbus captures` command group gives the owner review and revoke.

**Tech Stack:** Bun 1.3, TypeScript strict, `bun:sqlite`, `bun:test`, zod (CLI MCP tool schemas), `@modelcontextprotocol/sdk` 1.32 (CLI only).

**Spec:** `docs/superpowers/specs/2026-10-11-mcp-capture-sink-design.md` (branch `dev/asaf/s3-mcp-capture-sink`). Read §1–§8, §10, §11 and §14. PR 2 (proposals) and PR 3 (act door) are NOT in this plan.

## Global Constraints

- Work in worktree `C:\gitrep\Nimbus\.claude\worktrees\s3-mcp-capture-sink`, branch `dev/asaf/s3-mcp-capture-sink`. Verify with `git rev-parse --abbrev-ref HEAD` before EVERY commit.
- The spec and this plan never land on `main`. Strip `docs/superpowers/` before opening the PR (Task 12).
- Run `bun install` once in the fresh worktree, then `bun run build:sandbox-helper:win32` on Windows. A fresh worktree otherwise shows unrelated toolgen failures.
- No `any`. External data enters as `unknown`.
- Every SQLite write goes through `dbRun`/`dbExec`/`dbStmtRun` (`db/write.ts`, I14/D12). Reads may use `db.query(...).get/all`.
- Build test fixtures through the real writers (`upsertIndexedItem`, the migration runner), never hand-written `item` rows. Test DBs come from `openMigratedMemoryDb()` (`index/migrated-db-template.ts`) or `new Database(":memory:")` + `runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION)`.
- New files must clear the per-file coverage floor: **≥85% line AND ≥80% branch**. Write the branch tests up front.
- Default off: `[mcp_sink] enabled = false`.
- Limits (spec §8.1): `max_per_hour` 1..1000, default 30; `max_pending` 1..10000, default 100. The attempt limit is `max_per_hour × 4`. Out-of-range values or unknown kinds REFUSE at config load, naming the key and the value. They are never clamped.
- Note caps (spec §4.2): title truncates at 200; body truncates at `BODY_MAX_PROSE` (16,384) and refuses when empty; tags ≤ 10 entries, each ≤ 50 chars, refuse beyond; relatesTo ≤ 10 ids, each must exist; client label truncates at 100; the rebuilt payload refuses above **64 KiB** of UTF-8 JSON.
- Error codes, used verbatim: `ERR_CAPTURE_DISABLED`, `ERR_CAPTURE_FORBIDDEN_CLIENT`, `ERR_CAPTURE_RATE_LIMITED`, `ERR_CAPTURE_KIND_NOT_ALLOWED`, `ERR_CAPTURE_INVALID`, `ERR_CAPTURE_UNKNOWN_ITEM`, `ERR_CAPTURE_QUEUE_FULL`, `ERR_CAPTURE_NOT_FOUND`, `ERR_CAPTURE_STATE`.
- Audit action types: `capture.submit` and `capture.revoke`. A successful submit records `hitl_status = 'not_required'`. Refusals at steps 4–8 record `'rejected'`, following the exec-gate convention that a refusal is never `not_required`. Revoke records `'approved'`.
- IPC: `capture.status` and `capture.submit`; `captures.list`, `captures.get`, `captures.revoke`. All of them are LAN-forbidden by NAMESPACE. None go on the Tauri allowlist, and none get an HTTP route.
- Org-policy capability name: `mcp_capture`, the eighth `AI_V2_CAPABILITIES` entry. Policy is read live per call and fails closed when the accessor is absent. Config is read at boot, like every other section, so a config change takes effect on gateway restart.
- PR title: `feat(mcp): capture sink — agent notes over MCP (S3, I28)`. No `!`.
- After every task: `bun run typecheck` and `bun run lint`. Before the PR: `bun run preflight:fast`, then the CI test paths `bun test packages/gateway packages/cli scripts`.

## Review Focus

1. **Terminal escape injection.** A malicious `clientInfo.name` or note title containing ANSI/control characters is printed by `nimbus captures list|show`. Control characters must be stripped from every agent-supplied string before printing. Pinned in Task 10.
2. **Concurrent revoke.** Two `nimbus captures revoke cap_x` calls racing: the second must report success without error and write no second audit row. Pinned in Task 6.
3. **Gateway down when the editor spawns the MCP server.** No capture tool is registered, the read-only tools are still served, and the server does not crash. Pinned in Task 9.
4. **Long non-ASCII note.** A 16,384-character CJK body must TRUNCATE rather than refuse, because the 64 KiB payload cap must not fire for a body at the body cap. Pinned in Task 2.
5. **Reference to a revoked note.** `relatesTo` naming a revoked note's former item id must refuse with `ERR_CAPTURE_UNKNOWN_ITEM`, because the item is gone. Pinned in Task 6.

---

## File Structure

Gateway (`packages/gateway/src/`):

| File | Responsibility |
|---|---|
| `index/capture-v66-sql.ts` | V66 DDL |
| `mcp-sink/capture-types.ts` | kinds, states, error codes, `CaptureError`, payload + row types |
| `mcp-sink/capture-validate.ts` | whitelist rebuild of a note payload; client-label sanitising |
| `mcp-sink/capture-store.ts` | `CaptureStore`, the ONLY module that names the `capture` table |
| `config/mcp-sink-toml.ts` | `[mcp_sink]` loader |
| `mcp-sink/capture-capability.ts` | resolves config + live policy into enabled or a disabled reason |
| `mcp-sink/capture-client-policy.ts` | total `Record<ClientKind, CaptureRole>` |
| `mcp-sink/capture-rate-limit.ts` | gateway-wide attempt window + refusal counter |
| `mcp-sink/capture-gate.ts` | `submitCapture`, `revokeCapture`, `listCaptures`, `getCapture`, `captureStatus` |
| `ipc/capture-rpc.ts` | dispatcher for both namespaces |

CLI (`packages/cli/src/`):

| File | Responsibility |
|---|---|
| `mcp/capture-tools.ts` | `capture_note` spec + `captureToolsFor(deps)` |
| `commands/captures.ts` | `nimbus captures` argv, IPC and exit codes |
| `commands/captures-format.ts` | wire-shape parsing, sanitised table and detail rendering, doctor line |

Tests sit beside each file (`*.test.ts`), plus `packages/gateway/test/integration/mcp-sink/capture-notes.test.ts` and `packages/gateway/test/e2e/mcp-capture.e2e.test.ts`.

---

### Task 1: V66 — the `capture` table

**Files:**
- Create: `packages/gateway/src/index/capture-v66-sql.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts` (import near :82; append a step after the 64→65 entry at about :588)
- Modify: `packages/gateway/src/index/local-index.ts:282` (`CURRENT_SCHEMA_VERSION = 66`)
- Modify: `packages/gateway/src/index/migrations/runner.test.ts:785-788` (65 → 66)
- Create: `packages/gateway/src/index/migrations/runner-v66.test.ts`
- Modify docs the status-drift gate scans: `CLAUDE.md:8` and `GEMINI.md:8` ("schema V65" → "schema V66"); `docs/architecture.md:5` and `:2678`; `docs/schema-reference.md:5` (currently says V64 → V66), plus a V66 entry after the V65 block at about :1022

**Interfaces:**
- Produces: `CAPTURE_V66_SQL: readonly string[]` and the `capture` table, with columns `id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, native_ref, created_at, decided_at`.

- [ ] **Step 1: Write the failing test** — `runner-v66.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { CURRENT_SCHEMA_VERSION } from "../local-index.ts";
import { runIndexedSchemaMigrations } from "./runner.ts";

function migrated(): Database {
  const db = new Database(":memory:");
  runIndexedSchemaMigrations(db, 66);
  return db;
}

const INSERT =
  "INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";

describe("V66 migration — capture sink queue", () => {
  test("CURRENT_SCHEMA_VERSION is at least 66", () => {
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(66);
  });

  test("applies on a V65 database and sets user_version", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 65);
    runIndexedSchemaMigrations(db, 66);
    expect((db.query("PRAGMA user_version").get() as { user_version: number }).user_version).toBe(66);
    db.close();
  });

  test("a live note with a payload is accepted", () => {
    const db = migrated();
    db.run(INSERT, ["cap_1", "note", "live", "nimbus:cap_1", "{}", 2, "x", "s1", 1]);
    expect(db.query("SELECT state FROM capture WHERE id = 'cap_1'").get()).toEqual({ state: "live" });
    db.close();
  });

  test.each([
    ["a note cannot be proposed", ["cap_2", "note", "proposed", null, "{}", 2, null, "s", 1]],
    ["a decision cannot be live", ["cap_3", "decision", "live", null, "{}", 2, null, "s", 1]],
    ["revoked must have no payload", ["cap_4", "note", "revoked", null, "{}", 2, null, "s", 1]],
    ["a live row must keep its payload", ["cap_5", "note", "live", null, null, 2, null, "s", 1]],
    ["an unknown kind is refused", ["cap_6", "action", "proposed", null, "{}", 2, null, "s", 1]],
  ])("CHECK: %s", (_name, row) => {
    const db = migrated();
    expect(() => db.run(INSERT, row as (string | number | null)[])).toThrow(/CHECK constraint failed/);
    db.close();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/index/migrations/runner-v66.test.ts`
Expected: FAIL, because no step reaches version 66.

- [ ] **Step 3: Create the DDL module** — `index/capture-v66-sql.ts`:

```ts
/**
 * V66 — the MCP capture sink's queue (spec 2026-10-11 § 4.1, invariant I28).
 *
 * Only `mcp-sink/capture-store.ts` names this table at runtime (static rule D32(a)); this module is
 * the other allow-listed file. `session_id` is kept for forensics and deliberately NOT indexed: it
 * is a per-connection UUID, useless as a rate-limit key. `idx_capture_created` serves the durable
 * hourly cap and retention.
 */
export const CAPTURE_V66_SQL: readonly string[] = [
  `CREATE TABLE IF NOT EXISTS capture (
     id            TEXT PRIMARY KEY,
     kind          TEXT NOT NULL CHECK(kind IN ('note','decision','term','link')),
     state         TEXT NOT NULL CHECK(state IN ('live','proposed','accepted','rejected','revoked')),
     item_id       TEXT,
     payload_json  TEXT,
     payload_bytes INTEGER NOT NULL,
     client_label  TEXT,
     session_id    TEXT NOT NULL,
     native_ref    TEXT,
     created_at    INTEGER NOT NULL,
     decided_at    INTEGER,
     CHECK (
       (kind = 'note' AND state IN ('live','revoked'))
       OR (kind <> 'note' AND state IN ('proposed','accepted','rejected','revoked'))
     ),
     CHECK ((state = 'revoked') = (payload_json IS NULL))
   )`,
  "CREATE INDEX IF NOT EXISTS idx_capture_state_created ON capture(state, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_capture_created ON capture(created_at)",
];
```

- [ ] **Step 4: Register the step.** In `runner.ts`, add `import { CAPTURE_V66_SQL } from "../capture-v66-sql.ts";` beside the V65 import, and append after the `simpleStep(64, 65, …)` entry:

```ts
  simpleStep(65, 66, "MCP capture sink queue (capture)", CAPTURE_V66_SQL),
```

Set `CURRENT_SCHEMA_VERSION = 66` in `local-index.ts:282`. In `runner.test.ts:785-788`, change the title and assertion to 66.

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/index/migrations/`
Expected: PASS, including `runner.test.ts`'s drift guard (`maxRegisteredIndexedSchemaVersion()` equals the constant).

- [ ] **Step 6: Update the drift-scanned docs.** Replace "schema V65" with "schema V66" in `CLAUDE.md:8` and `GEMINI.md:8`, and update `docs/architecture.md:5` and `:2678` (both the "V65" and the `CURRENT_SCHEMA_VERSION = 65` mention). In `docs/schema-reference.md`, set line 5 to "Latest applied migration: V66" and add after the V65 block:

```markdown
### V66 — `capture` (MCP capture sink, I28)

One row per capture an MCP client submitted through `mcp-sink/capture-gate.ts`. `kind` is
`note|decision|term|link`; a note is `live|revoked`, every other kind
`proposed|accepted|rejected|revoked` (CHECK). `revoked` clears `payload_json` (CHECK) and keeps
everything else. Only `mcp-sink/capture-store.ts` names the table (static D32(a)).
```

Run: `bun run audit:status-drift`
Expected: exit 0.

- [ ] **Step 7: Commit**

```bash
git rev-parse --abbrev-ref HEAD   # must print dev/asaf/s3-mcp-capture-sink
git add packages/gateway/src/index CLAUDE.md GEMINI.md docs/architecture.md docs/schema-reference.md
git commit -m "feat(mcp-sink): V66 capture table"
```

---

### Task 2: Capture types and note validation

**Files:**
- Create: `packages/gateway/src/mcp-sink/capture-types.ts`
- Create: `packages/gateway/src/mcp-sink/capture-validate.ts`
- Test: `packages/gateway/src/mcp-sink/capture-validate.test.ts`

**Interfaces:**
- Consumes: `BODY_MAX_PROSE`, `clampBody` from `index/body-caps.ts`.
- Produces:
  - `CAPTURE_KINDS`, `CaptureKind`, `CaptureState`, `SUBMITTABLE_KINDS: ReadonlySet<CaptureKind>` (PR 1 = `{"note"}`)
  - `CaptureErrorCode`, `class CaptureError extends Error { readonly code: CaptureErrorCode }` (message = `${code}: ${detail}`)
  - `NotePayload { title: string; body: string; tags: string[]; relatesTo: string[] }`
  - `CaptureRow` (camelCase of the V66 columns)
  - `validateNotePayload(raw: unknown): NotePayload`
  - `sanitizeClientLabel(raw: unknown): string | null`
  - `PAYLOAD_MAX_BYTES = 65_536`

- [ ] **Step 1: Write the failing test** — `capture-validate.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { BODY_MAX_PROSE } from "../index/body-caps.ts";
import { CaptureError } from "./capture-types.ts";
import { sanitizeClientLabel, validateNotePayload } from "./capture-validate.ts";

function code(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected a CaptureError");
}

describe("validateNotePayload", () => {
  test("rebuilds from named fields only — unknown sibling keys never survive", () => {
    const p = validateNotePayload({ title: "t", body: "b", junk: "x", __proto__: { evil: 1 } });
    expect(p).toEqual({ title: "t", body: "b", tags: [], relatesTo: [] });
    expect(Object.keys(p).sort()).toEqual(["body", "relatesTo", "tags", "title"]);
  });

  test("prose truncates: title at 200, body at BODY_MAX_PROSE", () => {
    const p = validateNotePayload({ title: "t".repeat(500), body: "b".repeat(BODY_MAX_PROSE + 10) });
    expect(p.title).toHaveLength(200);
    expect(p.body).toHaveLength(BODY_MAX_PROSE);
  });

  test("a max-length NON-ASCII body truncates instead of tripping the 64 KiB payload cap", () => {
    const p = validateNotePayload({ title: "日本", body: "語".repeat(BODY_MAX_PROSE + 100) });
    expect(p.body).toHaveLength(BODY_MAX_PROSE);
  });

  test("an empty or missing title becomes (untitled)", () => {
    expect(validateNotePayload({ title: "   ", body: "b" }).title).toBe("(untitled)");
    expect(validateNotePayload({ body: "b" }).title).toBe("(untitled)");
  });

  test.each([
    ["not an object", "x"],
    ["null", null],
    ["missing body", { title: "t" }],
    ["blank body", { title: "t", body: "  \n " }],
    ["non-string body", { title: "t", body: 3 }],
    ["non-string title", { title: 3, body: "b" }],
    ["11 tags", { body: "b", tags: Array.from({ length: 11 }, (_, i) => `t${String(i)}`) }],
    ["a 51-char tag", { body: "b", tags: ["x".repeat(51)] }],
    ["a non-string tag", { body: "b", tags: [1] }],
    ["tags not an array", { body: "b", tags: "a" }],
    ["11 relatesTo", { body: "b", relatesTo: Array.from({ length: 11 }, (_, i) => `github:${String(i)}`) }],
    ["an empty relatesTo id", { body: "b", relatesTo: [""] }],
    ["relatesTo not an array", { body: "b", relatesTo: "github:1" }],
  ])("structured fields REFUSE: %s", (_n, raw) => {
    expect(code(() => validateNotePayload(raw))).toBe("ERR_CAPTURE_INVALID");
  });

  test("tags and relatesTo are trimmed and de-duplicated, order kept", () => {
    const p = validateNotePayload({ body: "b", tags: [" a", "a", "b"], relatesTo: ["x:1", "x:1"] });
    expect(p.tags).toEqual(["a", "b"]);
    expect(p.relatesTo).toEqual(["x:1"]);
  });
});

describe("sanitizeClientLabel", () => {
  test("strips control characters and truncates to 100", () => {
    expect(sanitizeClientLabel("claude\u001b[31m-code\n")).toBe("claude[31m-code");
    expect(sanitizeClientLabel("x".repeat(150))).toHaveLength(100);
  });

  test("non-strings and empty labels become null", () => {
    expect(sanitizeClientLabel(undefined)).toBeNull();
    expect(sanitizeClientLabel(42)).toBeNull();
    expect(sanitizeClientLabel("\u0007")).toBeNull();
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/mcp-sink/capture-validate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `capture-types.ts`**

```ts
/** Shared vocabulary of the MCP capture sink (spec 2026-10-11, invariant I28). */

export const CAPTURE_KINDS = ["note", "decision", "term", "link"] as const;
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

export function isCaptureKind(v: unknown): v is CaptureKind {
  return typeof v === "string" && (CAPTURE_KINDS as readonly string[]).includes(v);
}

/** The kinds this gateway version accepts on submit. PR 2 widens this to all four. */
export const SUBMITTABLE_KINDS: ReadonlySet<CaptureKind> = new Set<CaptureKind>(["note"]);

export const CAPTURE_STATES = ["live", "proposed", "accepted", "rejected", "revoked"] as const;
export type CaptureState = (typeof CAPTURE_STATES)[number];

export function isCaptureState(v: unknown): v is CaptureState {
  return typeof v === "string" && (CAPTURE_STATES as readonly string[]).includes(v);
}

export type CaptureErrorCode =
  | "ERR_CAPTURE_DISABLED"
  | "ERR_CAPTURE_FORBIDDEN_CLIENT"
  | "ERR_CAPTURE_RATE_LIMITED"
  | "ERR_CAPTURE_KIND_NOT_ALLOWED"
  | "ERR_CAPTURE_INVALID"
  | "ERR_CAPTURE_UNKNOWN_ITEM"
  | "ERR_CAPTURE_QUEUE_FULL"
  | "ERR_CAPTURE_NOT_FOUND"
  | "ERR_CAPTURE_STATE";

export class CaptureError extends Error {
  constructor(
    readonly code: CaptureErrorCode,
    detail: string,
  ) {
    super(`${code}: ${detail}`);
    this.name = "CaptureError";
  }
}

export interface NotePayload {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly relatesTo: readonly string[];
}

export interface CaptureRow {
  readonly id: string;
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly itemId: string | null;
  readonly payloadJson: string | null;
  readonly payloadBytes: number;
  readonly clientLabel: string | null;
  readonly sessionId: string;
  readonly nativeRef: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}
```

- [ ] **Step 4: Implement `capture-validate.ts`**

```ts
import { BODY_MAX_PROSE, clampBody } from "../index/body-caps.ts";
import { CaptureError, type NotePayload } from "./capture-types.ts";

export const NOTE_TITLE_MAX = 200;
export const TAG_MAX_COUNT = 10;
export const TAG_MAX_LEN = 50;
export const REF_MAX_COUNT = 10;
export const CLIENT_LABEL_MAX = 100;
/**
 * Total cap on the rebuilt payload, in UTF-8 bytes of its JSON. 64 KiB rather than the 32 KiB first
 * drafted: a body AT the 16,384-code-unit cap in non-ASCII text is up to ~48 KiB, and the body cap
 * says such a body TRUNCATES — the total cap must not refuse it.
 */
export const PAYLOAD_MAX_BYTES = 65_536;

// C0 controls, DEL, C1 controls. Agent-supplied strings are printed to a terminal by
// `nimbus captures`; an ESC here would let a client restyle or rewrite the owner's screen.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

function invalid(detail: string): never {
  throw new CaptureError("ERR_CAPTURE_INVALID", detail);
}

function asObject(raw: unknown): Record<string, unknown> {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    invalid("payload must be an object");
  }
  return raw as Record<string, unknown>;
}

function stringList(raw: unknown, field: string, maxCount: number, maxLen: number): string[] {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) invalid(`${field} must be an array of strings`);
  if (raw.length > maxCount) invalid(`${field} allows at most ${String(maxCount)} entries`);
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== "string") invalid(`${field} entries must be strings`);
    const t = v.trim();
    if (t === "") invalid(`${field} entries must not be empty`);
    if (t.length > maxLen) invalid(`${field} entries must be at most ${String(maxLen)} characters`);
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

/** Whitelist-rebuild a note payload (spec § 4.2, the I32 shape): prose truncates, structure refuses. */
export function validateNotePayload(raw: unknown): NotePayload {
  const o = asObject(raw);
  const titleRaw = o["title"];
  if (titleRaw !== undefined && typeof titleRaw !== "string") invalid("title must be a string");
  const bodyRaw = o["body"];
  if (typeof bodyRaw !== "string") invalid("body must be a string");
  if (bodyRaw.trim() === "") invalid("body must not be empty");
  const title = typeof titleRaw === "string" ? titleRaw.trim() : "";
  const payload: NotePayload = {
    title: title === "" ? "(untitled)" : clampBody(title, NOTE_TITLE_MAX),
    body: clampBody(bodyRaw, BODY_MAX_PROSE),
    tags: stringList(o["tags"], "tags", TAG_MAX_COUNT, TAG_MAX_LEN),
    // Ids are bounded by the existence check, not by length; 512 only stops a pathological string.
    relatesTo: stringList(o["relatesTo"], "relatesTo", REF_MAX_COUNT, 512),
  };
  if (Buffer.byteLength(JSON.stringify(payload), "utf8") > PAYLOAD_MAX_BYTES) {
    invalid(`payload exceeds ${String(PAYLOAD_MAX_BYTES)} bytes`);
  }
  return payload;
}

/** Display-only label from MCP `clientInfo.name`: attacker-controlled, so stripped and truncated. */
export function sanitizeClientLabel(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const cleaned = raw.replace(CONTROL_RE, "").trim();
  return cleaned === "" ? null : clampBody(cleaned, CLIENT_LABEL_MAX);
}
```

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/mcp-sink/capture-validate.test.ts`
Expected: PASS. The `__proto__` case passes because the object literal's `__proto__` sets the prototype rather than creating an own key, and the rebuild never reads it.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/mcp-sink
git commit -m "feat(mcp-sink): capture types and note whitelist validation"
```

---

### Task 3: `CaptureStore`

**Files:**
- Create: `packages/gateway/src/mcp-sink/capture-store.ts`
- Test: `packages/gateway/src/mcp-sink/capture-store.test.ts`

**Interfaces:**
- Consumes: `CaptureRow`, `CaptureKind`, `CaptureState`, `isCaptureKind`, `isCaptureState` (Task 2); `dbRun` from `db/write.ts`.
- Produces `class CaptureStore`:
  - `constructor(db: Database)`
  - `insert(row: NewCaptureRow): void`, where `NewCaptureRow = Omit<CaptureRow, "nativeRef" | "decidedAt">`
  - `get(id: string): CaptureRow | undefined`
  - `list(filter: { state?: CaptureState; kind?: CaptureKind; limit: number }): CaptureRow[]` (newest first)
  - `countByState(state: CaptureState): number`
  - `countCreatedSince(sinceMs: number): number`
  - `stateOfItem(itemId: string): CaptureState | undefined`
  - `markRevoked(id: string, expected: CaptureState, nowMs: number): boolean` (false = lost race / wrong state)
  - `pruneRejected(cutoffMs: number): number`

- [ ] **Step 1: Write the failing test** — `capture-store.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Database } from "bun:sqlite";

import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { CaptureStore, type NewCaptureRow } from "./capture-store.ts";

let db: Database;
let store: CaptureStore;

function note(id: string, createdAt: number, over: Partial<NewCaptureRow> = {}): NewCaptureRow {
  return {
    id,
    kind: "note",
    state: "live",
    itemId: `nimbus:${id}`,
    payloadJson: '{"title":"t"}',
    payloadBytes: 13,
    clientLabel: "claude-code",
    sessionId: "s1",
    createdAt,
    ...over,
  };
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  store = new CaptureStore(db);
});
afterEach(() => db.close());

describe("CaptureStore", () => {
  test("insert then get round-trips every column", () => {
    store.insert(note("cap_a", 1000));
    expect(store.get("cap_a")).toEqual({ ...note("cap_a", 1000), nativeRef: null, decidedAt: null });
    expect(store.get("cap_missing")).toBeUndefined();
  });

  test("list is newest first and filters by state and kind", () => {
    store.insert(note("cap_a", 1000));
    store.insert(note("cap_b", 2000));
    expect(store.list({ limit: 10 }).map((r) => r.id)).toEqual(["cap_b", "cap_a"]);
    expect(store.list({ state: "revoked", limit: 10 })).toEqual([]);
    expect(store.list({ kind: "note", limit: 1 }).map((r) => r.id)).toEqual(["cap_b"]);
  });

  test("counts by state and by creation window", () => {
    store.insert(note("cap_a", 1000));
    store.insert(note("cap_b", 5000));
    expect(store.countByState("live")).toBe(2);
    expect(store.countByState("proposed")).toBe(0);
    expect(store.countCreatedSince(2000)).toBe(1);
  });

  test("stateOfItem finds the capture behind an item id", () => {
    store.insert(note("cap_a", 1000));
    expect(store.stateOfItem("nimbus:cap_a")).toBe("live");
    expect(store.stateOfItem("github:1")).toBeUndefined();
  });

  test("markRevoked clears payload + item, keeps the rest, and refuses a lost race", () => {
    store.insert(note("cap_a", 1000));
    expect(store.markRevoked("cap_a", "live", 9000)).toBe(true);
    const r = store.get("cap_a");
    expect(r).toMatchObject({ state: "revoked", payloadJson: null, itemId: null, decidedAt: 9000 });
    expect(r?.payloadBytes).toBe(13);
    expect(r?.clientLabel).toBe("claude-code");
    expect(store.markRevoked("cap_a", "live", 9001)).toBe(false);
  });

  test("pruneRejected deletes by decided_at, never other states", () => {
    store.insert(note("cap_a", 1000));
    db.run(
      "INSERT INTO capture (id, kind, state, payload_json, payload_bytes, session_id, created_at, decided_at) VALUES ('cap_r', 'term', 'rejected', '{}', 2, 's', 1, 5000)",
    );
    expect(store.pruneRejected(4000)).toBe(0);
    expect(store.pruneRejected(6000)).toBe(1);
    expect(store.get("cap_r")).toBeUndefined();
    expect(store.get("cap_a")).toBeDefined();
  });

  test("a row whose kind or state is unrecognised is rejected on read, not mis-typed", () => {
    db.run("PRAGMA ignore_check_constraints = ON");
    db.run(
      "INSERT INTO capture (id, kind, state, payload_json, payload_bytes, session_id, created_at) VALUES ('cap_x', 'bogus', 'live', '{}', 2, 's', 1)",
    );
    expect(() => store.get("cap_x")).toThrow(/unrecognised capture row/);
  });
});
```

(The `db.run` inserts in this test file are fixture setup for states PR 1 cannot produce. D12 exempts test files.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/mcp-sink/capture-store.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `capture-store.ts`**

```ts
import type { Database } from "bun:sqlite";

import { dbRun } from "../db/write.ts";
import {
  type CaptureKind,
  type CaptureRow,
  type CaptureState,
  isCaptureKind,
  isCaptureState,
} from "./capture-types.ts";

/**
 * The ONLY module that names the `capture` table at runtime (static rule D32(a), invariant I28).
 * Every state change is a guarded `UPDATE … WHERE state = <expected>` with a row-count check, so a
 * lost race refuses instead of double-applying.
 */
export type NewCaptureRow = Omit<CaptureRow, "nativeRef" | "decidedAt">;

type RawRow = {
  id: string;
  kind: string;
  state: string;
  item_id: string | null;
  payload_json: string | null;
  payload_bytes: number;
  client_label: string | null;
  session_id: string;
  native_ref: string | null;
  created_at: number;
  decided_at: number | null;
};

function toRow(r: RawRow): CaptureRow {
  if (!isCaptureKind(r.kind) || !isCaptureState(r.state)) {
    throw new Error(`unrecognised capture row ${r.id}: kind=${r.kind} state=${r.state}`);
  }
  return {
    id: r.id,
    kind: r.kind,
    state: r.state,
    itemId: r.item_id,
    payloadJson: r.payload_json,
    payloadBytes: r.payload_bytes,
    clientLabel: r.client_label,
    sessionId: r.session_id,
    nativeRef: r.native_ref,
    createdAt: r.created_at,
    decidedAt: r.decided_at,
  };
}

export class CaptureStore {
  constructor(private readonly db: Database) {}

  insert(row: NewCaptureRow): void {
    dbRun(
      this.db,
      `INSERT INTO capture (id, kind, state, item_id, payload_json, payload_bytes, client_label, session_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        row.id,
        row.kind,
        row.state,
        row.itemId,
        row.payloadJson,
        row.payloadBytes,
        row.clientLabel,
        row.sessionId,
        row.createdAt,
      ],
    );
  }

  get(id: string): CaptureRow | undefined {
    const r = this.db.query("SELECT * FROM capture WHERE id = ?").get(id) as RawRow | null;
    return r === null ? undefined : toRow(r);
  }

  list(filter: { state?: CaptureState; kind?: CaptureKind; limit: number }): CaptureRow[] {
    const where: string[] = [];
    const args: (string | number)[] = [];
    if (filter.state !== undefined) {
      where.push("state = ?");
      args.push(filter.state);
    }
    if (filter.kind !== undefined) {
      where.push("kind = ?");
      args.push(filter.kind);
    }
    const clause = where.length === 0 ? "" : `WHERE ${where.join(" AND ")}`;
    args.push(filter.limit);
    const rows = this.db
      .query(`SELECT * FROM capture ${clause} ORDER BY created_at DESC, id DESC LIMIT ?`)
      .all(...args) as RawRow[];
    return rows.map(toRow);
  }

  countByState(state: CaptureState): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM capture WHERE state = ?").get(state) as {
      n: number;
    };
    return r.n;
  }

  countCreatedSince(sinceMs: number): number {
    const r = this.db.query("SELECT COUNT(*) AS n FROM capture WHERE created_at > ?").get(sinceMs) as {
      n: number;
    };
    return r.n;
  }

  stateOfItem(itemId: string): CaptureState | undefined {
    const r = this.db.query("SELECT state FROM capture WHERE item_id = ?").get(itemId) as {
      state: string;
    } | null;
    return r !== null && isCaptureState(r.state) ? r.state : undefined;
  }

  markRevoked(id: string, expected: CaptureState, nowMs: number): boolean {
    const res = dbRun(
      this.db,
      `UPDATE capture SET state = 'revoked', payload_json = NULL, item_id = NULL, decided_at = ?
       WHERE id = ? AND state = ?`,
      [nowMs, id, expected],
    );
    return res.changes === 1;
  }

  pruneRejected(cutoffMs: number): number {
    return dbRun(
      this.db,
      "DELETE FROM capture WHERE state = 'rejected' AND COALESCE(decided_at, created_at) < ?",
      [cutoffMs],
    ).changes;
  }
}
```

(If `dbRun`'s return type is not `{ changes: number }`, check `db/write.ts`. `oncall-push/push-store.ts:187` already uses `.changes` on it.)

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/mcp-sink/capture-store.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/mcp-sink
git commit -m "feat(mcp-sink): CaptureStore, sole owner of the capture table"
```

---

### Task 4: `[mcp_sink]` config, capability and the `mcp_capture` policy name

**Files:**
- Create: `packages/gateway/src/config/mcp-sink-toml.ts`
- Test: `packages/gateway/src/config/mcp-sink-toml.test.ts`
- Modify: `packages/gateway/src/policy/types.ts:49-63` (append `"mcp_capture"`)
- Modify: `packages/gateway/src/policy/types.test.ts` (membership assertion)
- Create: `packages/gateway/src/mcp-sink/capture-capability.ts`
- Test: `packages/gateway/src/mcp-sink/capture-capability.test.ts`

**Interfaces:**
- Consumes: `CAPTURE_KINDS`, `CaptureKind`, `SUBMITTABLE_KINDS` (Task 2); `EnforcedPolicy` from `policy/policy-gate.ts`; the `toml-primitives.ts` helpers.
- Produces:
  - `NimbusMcpSinkToml { enabled: boolean; kinds: readonly CaptureKind[]; maxPerHour: number; maxPending: number }`
  - `DEFAULT_MCP_SINK_CONFIG`
  - `class McpSinkConfigError extends Error`
  - `parseNimbusTomlMcpSink(source: string): NimbusMcpSinkToml`
  - `loadNimbusMcpSinkFromPath(tomlPath: string): McpSinkConfigLoad`, where `McpSinkConfigLoad = { ok: true; config } | { ok: false; error: string }`
  - `MCP_CAPTURE_CAPABILITY = "mcp_capture"`
  - `CaptureCapability = { enabled: true; config: NimbusMcpSinkToml; kinds: readonly CaptureKind[] } | { enabled: false; reason: "config" | "config_error" | "policy"; config: NimbusMcpSinkToml; kinds: readonly CaptureKind[] }`
  - `resolveCaptureCapability(load: McpSinkConfigLoad, enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined): CaptureCapability`

- [ ] **Step 1: Write the failing config test** — `mcp-sink-toml.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_MCP_SINK_CONFIG,
  loadNimbusMcpSinkFromPath,
  McpSinkConfigError,
  parseNimbusTomlMcpSink,
} from "./mcp-sink-toml.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("parseNimbusTomlMcpSink", () => {
  test("defaults: off, all four kinds, 30/h, 100 pending; frozen", () => {
    const c = parseNimbusTomlMcpSink("");
    expect(c).toEqual(DEFAULT_MCP_SINK_CONFIG);
    expect(c).toEqual({
      enabled: false,
      kinds: ["note", "decision", "term", "link"],
      maxPerHour: 30,
      maxPending: 100,
    });
    expect(Object.isFrozen(c)).toBe(true);
  });

  test("reads every key inside [mcp_sink] only", () => {
    const c = parseNimbusTomlMcpSink(
      [
        "[other]",
        "enabled = true",
        "[mcp_sink]",
        "enabled = true # on",
        'kinds = ["note"]',
        "max_per_hour = 5",
        "max_pending = 7",
        "unknown_key = 1",
      ].join("\n"),
    );
    expect(c).toEqual({ enabled: true, kinds: ["note"], maxPerHour: 5, maxPending: 7 });
  });

  test("a header that merely starts with [mcp_sink is not the section", () => {
    expect(parseNimbusTomlMcpSink("[mcp_sink.extra]\nenabled = true").enabled).toBe(false);
  });

  test.each([
    ["max_per_hour = 0", /max_per_hour must be an integer 1\.\.1000 \(got: 0\)/],
    ["max_per_hour = 1001", /max_per_hour/],
    ["max_per_hour = 2.5", /max_per_hour/],
    ["max_pending = 0", /max_pending must be an integer 1\.\.10000/],
    ["max_pending = 10001", /max_pending/],
    ['kinds = ["note", "action"]', /kinds: unknown kind "action"/],
    ["kinds = []", /kinds must not be empty/],
    ['kinds = "note"', /kinds must be an array/],
    ['enabled = "yes"', /enabled must be true or false/],
  ])("refuses loudly, never clamps: %s", (line, msg) => {
    expect(() => parseNimbusTomlMcpSink(`[mcp_sink]\n${line}`)).toThrow(McpSinkConfigError);
    expect(() => parseNimbusTomlMcpSink(`[mcp_sink]\n${line}`)).toThrow(msg);
  });
});

describe("loadNimbusMcpSinkFromPath", () => {
  test("missing file → defaults; bad file → ok:false with the message", () => {
    const d = mkdtempSync(join(tmpdir(), "mcp-sink-"));
    dirs.push(d);
    expect(loadNimbusMcpSinkFromPath(join(d, "absent.toml"))).toEqual({
      ok: true,
      config: DEFAULT_MCP_SINK_CONFIG,
    });
    const p = join(d, "nimbus.toml");
    writeFileSync(p, "[mcp_sink]\nmax_pending = 0\n");
    const r = loadNimbusMcpSinkFromPath(p);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("max_pending");
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/config/mcp-sink-toml.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `config/mcp-sink-toml.ts`**

```ts
import { existsSync, readFileSync } from "node:fs";

import { CAPTURE_KINDS, type CaptureKind, isCaptureKind } from "../mcp-sink/capture-types.ts";
import {
  isTableHeader,
  parseBool,
  parseIntDec,
  parseStringArray,
  splitKeyValue,
  stripComment,
} from "./toml-primitives.ts";

/** `[mcp_sink]` — the MCP capture sink (spec 2026-10-11 § 8.1). DEFAULT OFF. */
export type NimbusMcpSinkToml = {
  readonly enabled: boolean;
  readonly kinds: readonly CaptureKind[];
  readonly maxPerHour: number;
  readonly maxPending: number;
};

export const DEFAULT_MCP_SINK_CONFIG: NimbusMcpSinkToml = Object.freeze({
  enabled: false,
  kinds: Object.freeze([...CAPTURE_KINDS]),
  maxPerHour: 30,
  maxPending: 100,
});

export class McpSinkConfigError extends Error {}

export type McpSinkConfigLoad =
  | { readonly ok: true; readonly config: NimbusMcpSinkToml }
  | { readonly ok: false; readonly error: string };

type Draft = { -readonly [K in keyof NimbusMcpSinkToml]: NimbusMcpSinkToml[K] };

function boundedInt(key: string, valRaw: string, min: number, max: number): number {
  const n = parseIntDec(valRaw);
  if (n === undefined || n < min || n > max) {
    throw new McpSinkConfigError(
      `[mcp_sink].${key} must be an integer ${String(min)}..${String(max)} (got: ${valRaw})`,
    );
  }
  return n;
}

function parseKinds(valRaw: string): CaptureKind[] {
  let list: string[];
  try {
    list = parseStringArray(valRaw);
  } catch {
    throw new McpSinkConfigError(`[mcp_sink].kinds must be an array of strings (got: ${valRaw})`);
  }
  if (list.length === 0) throw new McpSinkConfigError("[mcp_sink].kinds must not be empty");
  const out: CaptureKind[] = [];
  for (const k of list) {
    if (!isCaptureKind(k)) {
      throw new McpSinkConfigError(
        `[mcp_sink].kinds: unknown kind ${JSON.stringify(k)} (allowed: ${CAPTURE_KINDS.join(", ")})`,
      );
    }
    if (!out.includes(k)) out.push(k);
  }
  return out;
}

function applyKey(out: Draft, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b === undefined) {
        throw new McpSinkConfigError(`[mcp_sink].enabled must be true or false (got: ${valRaw})`);
      }
      out.enabled = b;
      return;
    }
    case "kinds":
      out.kinds = Object.freeze(parseKinds(valRaw));
      return;
    case "max_per_hour":
      out.maxPerHour = boundedInt("max_per_hour", valRaw, 1, 1000);
      return;
    case "max_pending":
      out.maxPending = boundedInt("max_pending", valRaw, 1, 10_000);
      return;
    default:
      return;
  }
}

/** Parse `[mcp_sink]`. Throws `McpSinkConfigError` on any out-of-range value — never clamps. */
export function parseNimbusTomlMcpSink(source: string): NimbusMcpSinkToml {
  const out: Draft = { ...DEFAULT_MCP_SINK_CONFIG };
  let inSection = false;
  for (const line of source.split(/\r?\n/)) {
    const trimmed = stripComment(line).trim();
    if (trimmed === "") continue;
    if (isTableHeader(trimmed)) {
      inSection = trimmed === "[mcp_sink]";
      continue;
    }
    if (!inSection) continue;
    const kv = splitKeyValue(trimmed);
    if (kv !== undefined) applyKey(out, kv.key, kv.valRaw);
  }
  return Object.freeze(out);
}

/** Load from disk. A bad file is a VALUE (`ok: false`), so the gateway boots with the sink off. */
export function loadNimbusMcpSinkFromPath(tomlPath: string): McpSinkConfigLoad {
  const raw = existsSync(tomlPath) ? readFileSync(tomlPath, "utf8") : "";
  try {
    return { ok: true, config: parseNimbusTomlMcpSink(raw) };
  } catch (e) {
    if (e instanceof McpSinkConfigError) return { ok: false, error: e.message };
    throw e;
  }
}
```

Check: `parseBool` must return `undefined` for `"yes"`. Read `toml-primitives.ts:77` to confirm. If it accepts other spellings, keep the test's `enabled = "yes"` case anyway, since a quoted string is not a TOML bool.

- [ ] **Step 4: Run the config test**

Run: `bun test packages/gateway/src/config/mcp-sink-toml.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing capability test** — `capture-capability.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { MCP_CAPTURE_CAPABILITY, resolveCaptureCapability } from "./capture-capability.ts";

const ON = { ok: true as const, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } };
const OPEN = { capabilitiesDisabled: new Set<string>() };

describe("resolveCaptureCapability", () => {
  test("mcp_capture is a recognised AI v2 capability name", () => {
    expect(AI_V2_CAPABILITIES).toContain(MCP_CAPTURE_CAPABILITY);
  });

  test("enabled config + open policy → enabled, kinds = config ∩ submittable", () => {
    const c = resolveCaptureCapability(ON, OPEN);
    expect(c.enabled).toBe(true);
    expect(c.kinds).toEqual(["note"]);
  });

  test("config off → disabled: config", () => {
    const c = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    expect(c).toMatchObject({ enabled: false, reason: "config" });
  });

  test("bad config file → disabled: config_error", () => {
    expect(resolveCaptureCapability({ ok: false, error: "x" }, OPEN)).toMatchObject({
      enabled: false,
      reason: "config_error",
    });
  });

  test("policy lock-off → disabled: policy; ABSENT accessor fails closed the same way", () => {
    const locked = { capabilitiesDisabled: new Set<string>(["mcp_capture"]) };
    expect(resolveCaptureCapability(ON, locked)).toMatchObject({ enabled: false, reason: "policy" });
    expect(resolveCaptureCapability(ON, undefined)).toMatchObject({ enabled: false, reason: "policy" });
  });

  test("kinds naming only unsubmittable kinds → enabled flag stays true but kinds is empty", () => {
    const c = resolveCaptureCapability(
      { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, kinds: ["term"] } },
      OPEN,
    );
    expect(c.kinds).toEqual([]);
  });
});
```

- [ ] **Step 6: Implement.** Append `"mcp_capture",` as the last entry of `AI_V2_CAPABILITIES` in `policy/types.ts`, and add a `toContain("mcp_capture")` assertion beside the existing membership checks in `policy/types.test.ts`. Then create `mcp-sink/capture-capability.ts`:

```ts
import { DEFAULT_MCP_SINK_CONFIG, type McpSinkConfigLoad, type NimbusMcpSinkToml } from "../config/mcp-sink-toml.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { AI_V2_CAPABILITIES } from "../policy/types.ts";
import { type CaptureKind, SUBMITTABLE_KINDS } from "./capture-types.ts";

export const MCP_CAPTURE_CAPABILITY =
  "mcp_capture" as const satisfies (typeof AI_V2_CAPABILITIES)[number];

export type CaptureDisabledReason = "config" | "config_error" | "policy";

export type CaptureCapability =
  | { readonly enabled: true; readonly config: NimbusMcpSinkToml; readonly kinds: readonly CaptureKind[] }
  | {
      readonly enabled: false;
      readonly reason: CaptureDisabledReason;
      readonly config: NimbusMcpSinkToml;
      readonly kinds: readonly CaptureKind[];
    };

/**
 * Config (read at boot) + org policy (read LIVE by the caller, I22). An ABSENT policy accessor is
 * DISABLED, never enabled — the same fail-closed shape as `isUserMcpModelAccessEnabled`.
 */
export function resolveCaptureCapability(
  load: McpSinkConfigLoad,
  enforced: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined,
): CaptureCapability {
  if (!load.ok) {
    return { enabled: false, reason: "config_error", config: DEFAULT_MCP_SINK_CONFIG, kinds: [] };
  }
  const config = load.config;
  const kinds = config.kinds.filter((k) => SUBMITTABLE_KINDS.has(k));
  if (!config.enabled) return { enabled: false, reason: "config", config, kinds };
  if (enforced === undefined || enforced.capabilitiesDisabled.has(MCP_CAPTURE_CAPABILITY)) {
    return { enabled: false, reason: "policy", config, kinds };
  }
  return { enabled: true, config, kinds };
}
```

- [ ] **Step 7: Run the tests**

Run: `bun test packages/gateway/src/mcp-sink packages/gateway/src/config/mcp-sink-toml.test.ts packages/gateway/src/policy`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/config/mcp-sink-toml.* packages/gateway/src/mcp-sink packages/gateway/src/policy/types.ts packages/gateway/src/policy/types.test.ts
git commit -m "feat(mcp-sink): [mcp_sink] config, capability resolution, mcp_capture policy name"
```

---

### Task 5: Client-kind role table, attempt limiter and refusal counter

**Files:**
- Create: `packages/gateway/src/mcp-sink/capture-client-policy.ts`
- Create: `packages/gateway/src/mcp-sink/capture-rate-limit.ts`
- Test: `packages/gateway/src/mcp-sink/capture-client-policy.test.ts`, `packages/gateway/src/mcp-sink/capture-rate-limit.test.ts`

**Interfaces:**
- Consumes: `ClientKind` from `ipc/server/client-kind.ts`.
- Produces:
  - `CaptureRole = "submit" | "owner" | "refuse"`
  - `CAPTURE_ROLE_BY_KIND: Readonly<Record<ClientKind, CaptureRole>>`
  - `class CaptureAttemptLimiter { constructor(windowMs?: number); tryAcquire(nowMs: number, capPerWindow: number): boolean }`
  - `class CaptureRefusalCounter { bump(code: CaptureErrorCode): void; snapshot(): Readonly<Record<string, number>> }`

- [ ] **Step 1: Write the failing tests**

`capture-client-policy.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";

describe("CAPTURE_ROLE_BY_KIND", () => {
  test("only mcp submits; mcp is never owner; derived kinds are refused", () => {
    expect(CAPTURE_ROLE_BY_KIND).toEqual({
      mcp: "submit",
      cli: "owner",
      ui: "owner",
      unknown: "owner",
      http: "refuse",
      chatops: "refuse",
      fleet: "refuse",
      push: "refuse",
    });
  });
});
```

`capture-rate-limit.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";

describe("CaptureAttemptLimiter", () => {
  test("allows cap attempts per window, then refuses until the oldest ages out", () => {
    const l = new CaptureAttemptLimiter(1000);
    expect(l.tryAcquire(0, 2)).toBe(true);
    expect(l.tryAcquire(10, 2)).toBe(true);
    expect(l.tryAcquire(20, 2)).toBe(false);
    expect(l.tryAcquire(999, 2)).toBe(false);
    expect(l.tryAcquire(1000, 2)).toBe(true); // attempt at 0 aged out (window is (now-1000, now])
  });

  test("a refused attempt does not consume a slot", () => {
    const l = new CaptureAttemptLimiter(1000);
    l.tryAcquire(0, 1);
    for (let i = 1; i < 50; i++) l.tryAcquire(i, 1);
    expect(l.tryAcquire(1000, 1)).toBe(true);
  });

  test("ONE window for the whole gateway — there is no per-connection key to reset", () => {
    const l = new CaptureAttemptLimiter(1000);
    expect(l.tryAcquire(0, 1)).toBe(true);
    // A reconnecting client is the same limiter instance; nothing in the API takes a client id.
    expect(l.tryAcquire(1, 1)).toBe(false);
  });
});

describe("CaptureRefusalCounter", () => {
  test("counts per code and snapshots a copy", () => {
    const c = new CaptureRefusalCounter();
    c.bump("ERR_CAPTURE_DISABLED");
    c.bump("ERR_CAPTURE_DISABLED");
    c.bump("ERR_CAPTURE_RATE_LIMITED");
    const s = c.snapshot();
    expect(s).toEqual({ ERR_CAPTURE_DISABLED: 2, ERR_CAPTURE_RATE_LIMITED: 1 });
    c.bump("ERR_CAPTURE_DISABLED");
    expect(s["ERR_CAPTURE_DISABLED"]).toBe(2);
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/gateway/src/mcp-sink/capture-client-policy.test.ts packages/gateway/src/mcp-sink/capture-rate-limit.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement**

`capture-client-policy.ts`:

```ts
import type { ClientKind } from "../ipc/server/client-kind.ts";

export type CaptureRole = "submit" | "owner" | "refuse";

/**
 * TOTAL over `ClientKind` on purpose: a new kind is a compile error here (the
 * `USER_MCP_OFFER_BY_KIND` precedent). `unknown` is the plain CLI, which connects undeclared, so
 * it is `owner`. That is not a weakening: `cli` is itself declarable, so the trust boundary is
 * socket access, as for `vault.set`. What this table DOES guarantee is that a connection that
 * declared `mcp` (first declaration wins) can never reach an owner method.
 */
export const CAPTURE_ROLE_BY_KIND: Readonly<Record<ClientKind, CaptureRole>> = {
  mcp: "submit",
  cli: "owner",
  ui: "owner",
  unknown: "owner",
  http: "refuse",
  chatops: "refuse",
  fleet: "refuse",
  push: "refuse",
};
```

`capture-rate-limit.ts`:

```ts
import type { CaptureErrorCode } from "./capture-types.ts";

const HOUR_MS = 3_600_000;

/**
 * ONE gateway-wide sliding window over every capture ATTEMPT (spec § 5.1 step 3). Deliberately
 * keyed on nothing: a per-connection key would reset whenever a client restarts `nimbus
 * mcp-server`, since `clientId` is a fresh UUID per socket. In-memory; a gateway restart resets
 * it — the durable hourly cap (step 7) is the bound that survives.
 */
export class CaptureAttemptLimiter {
  private readonly stamps: number[] = [];

  constructor(private readonly windowMs: number = HOUR_MS) {}

  tryAcquire(nowMs: number, capPerWindow: number): boolean {
    while (this.stamps.length > 0 && (this.stamps[0] ?? 0) <= nowMs - this.windowMs) {
      this.stamps.shift();
    }
    if (this.stamps.length >= capPerWindow) return false;
    this.stamps.push(nowMs);
    return true;
  }
}

/** Refusals at gate steps 1–3 are counted here instead of audited (spec § 5.1). */
export class CaptureRefusalCounter {
  private readonly counts = new Map<CaptureErrorCode, number>();

  bump(code: CaptureErrorCode): void {
    this.counts.set(code, (this.counts.get(code) ?? 0) + 1);
  }

  snapshot(): Readonly<Record<string, number>> {
    return Object.fromEntries(this.counts);
  }
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test packages/gateway/src/mcp-sink`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/mcp-sink
git commit -m "feat(mcp-sink): client-kind roles, gateway-wide attempt limiter, refusal counter"
```

---

### Task 6: The gate — submit, revoke, list, get, status

**Files:**
- Create: `packages/gateway/src/mcp-sink/capture-gate.ts`
- Test: `packages/gateway/src/mcp-sink/capture-gate.test.ts`
- Modify: `packages/gateway/src/embedding/routing.ts` (add `"nimbus:capture"` to `LOCAL_ONLY_PROSE_TYPES`, with a comment)
- Modify: `packages/gateway/src/embedding/routing.test.ts` (assert membership + disjointness still holds)

**Interfaces:**
- Consumes: Tasks 2–5. `upsertIndexedItem`, `itemPrimaryKey`, `deleteItemByPrimaryKey` from `index/item-store.ts`. `appendAuditEntry` from `db/audit-chain.ts`. `ClientKind`.
- Produces:
  - `CaptureGateDeps { db; store: CaptureStore; capability(): CaptureCapability; limiter: CaptureAttemptLimiter; refusals: CaptureRefusalCounter; newId(): string; now(): number; scheduleEmbedding?(itemId: string): void }`
  - `CaptureCaller { clientId: string; kind: ClientKind }`
  - `CaptureSummary { id; kind; state; title: string; clientLabel: string | null; createdAt: number; decidedAt: number | null }`
  - `CaptureDetail = CaptureSummary & { payload: unknown | null; payloadBytes: number; itemId: string | null; nativeRef: string | null }`
  - `CaptureStatus { enabled; kinds; pending; maxPending; maxPerHour; refusedSinceStart; disabledReason? }`
  - `submitCapture(deps, caller, input: unknown): { id: string; state: CaptureState }`
  - `revokeCapture(deps, caller, id: unknown): { id: string; state: "revoked" }`
  - `listCaptures(deps, caller, params: unknown): { captures: CaptureSummary[] }`
  - `getCapture(deps, caller, id: unknown): CaptureDetail`
  - `captureStatus(deps): CaptureStatus`
  - `CAPTURE_ITEM_SERVICE = "nimbus"`, `CAPTURE_ITEM_TYPE = "capture"`

- [ ] **Step 1: Write the failing test** — `capture-gate.test.ts`:

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import { type CaptureCapability, resolveCaptureCapability } from "./capture-capability.ts";
import {
  type CaptureGateDeps,
  captureStatus,
  getCapture,
  listCaptures,
  revokeCapture,
  submitCapture,
} from "./capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import { CaptureStore } from "./capture-store.ts";
import { CaptureError } from "./capture-types.ts";

const MCP = { clientId: "c-mcp", kind: "mcp" as const };
const OWNER = { clientId: "c-cli", kind: "unknown" as const };
const OPEN = { capabilitiesDisabled: new Set<string>() };

let db: Database;
let deps: CaptureGateDeps;
let cap: CaptureCapability;
let clock: number;
let seq: number;
let embedded: string[];

function onConfig(over: Partial<typeof DEFAULT_MCP_SINK_CONFIG> = {}): CaptureCapability {
  return resolveCaptureCapability({ ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true, ...over } }, OPEN);
}

beforeEach(() => {
  db = openMigratedMemoryDb();
  clock = 1_000_000;
  seq = 0;
  embedded = [];
  cap = onConfig();
  deps = {
    db,
    store: new CaptureStore(db),
    capability: () => cap,
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => clock,
    scheduleEmbedding: (id) => embedded.push(id),
  };
});
afterEach(() => db.close());

function codeOf(fn: () => unknown): string {
  try {
    fn();
  } catch (e) {
    if (e instanceof CaptureError) return e.code;
    throw e;
  }
  throw new Error("expected CaptureError");
}

function auditRows(): Array<{ action_type: string; hitl_status: string; action_json: string; session_id: string | null }> {
  return db
    .query("SELECT action_type, hitl_status, action_json, session_id FROM audit_log WHERE action_type LIKE 'capture.%' ORDER BY id")
    .all() as Array<{ action_type: string; hitl_status: string; action_json: string; session_id: string | null }>;
}

const NOTE = { kind: "note", payload: { title: "Why WAL", body: "We chose WAL because…" }, clientLabel: "claude-code" };

describe("submitCapture — success", () => {
  test("writes row + item + one audit row in one go, schedules embedding, returns live", () => {
    expect(submitCapture(deps, MCP, NOTE)).toEqual({ id: "cap_1", state: "live" });
    const row = deps.store.get("cap_1");
    expect(row).toMatchObject({ kind: "note", state: "live", itemId: "nimbus:cap_1", clientLabel: "claude-code", sessionId: "c-mcp" });
    const item = db.query("SELECT service, type, title, body FROM item WHERE id = 'nimbus:cap_1'").get();
    expect(item).toEqual({ service: "nimbus", type: "capture", title: "Why WAL", body: "We chose WAL because…" });
    const meta = JSON.parse((db.query("SELECT metadata FROM item WHERE id = 'nimbus:cap_1'").get() as { metadata: string }).metadata) as Record<string, unknown>;
    expect(meta).toMatchObject({ captureKind: "note", captureId: "cap_1", agentAuthored: true, clientLabel: "claude-code" });
    expect(embedded).toEqual(["nimbus:cap_1"]);
    const a = auditRows();
    expect(a).toHaveLength(1);
    expect(a[0]).toMatchObject({ action_type: "capture.submit", hitl_status: "not_required", session_id: "c-mcp" });
    expect(JSON.parse(a[0]?.action_json ?? "{}")).toMatchObject({ captureId: "cap_1", kind: "note", outcome: "captured" });
  });

  test("audit failure rolls the whole write back (fail-closed)", () => {
    db.run("DROP TABLE audit_log");
    expect(() => submitCapture(deps, MCP, NOTE)).toThrow();
    expect(deps.store.get("cap_1")).toBeUndefined();
    expect(db.query("SELECT 1 FROM item WHERE id = 'nimbus:cap_1'").get()).toBeNull();
    expect(embedded).toEqual([]);
  });
});

describe("submitCapture — ordered refusals", () => {
  test("1 disabled: refuses BEFORE reading the payload; counted, not audited", () => {
    cap = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "note", payload: "not even an object" }))).toBe("ERR_CAPTURE_DISABLED");
    expect(auditRows()).toEqual([]);
    expect(deps.refusals.snapshot()).toEqual({ ERR_CAPTURE_DISABLED: 1 });
  });

  test("2 a non-mcp client cannot submit; counted, not audited", () => {
    expect(codeOf(() => submitCapture(deps, OWNER, NOTE))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(codeOf(() => submitCapture(deps, { clientId: "h", kind: "http" }, NOTE))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(auditRows()).toEqual([]);
  });

  test("3 attempt limit (4 × max_per_hour) fires before validation; counted, not audited", () => {
    cap = onConfig({ maxPerHour: 1 });
    for (let i = 0; i < 4; i++) codeOf(() => submitCapture(deps, MCP, { kind: "note", payload: {} }));
    expect(codeOf(() => submitCapture(deps, MCP, NOTE))).toBe("ERR_CAPTURE_RATE_LIMITED");
    expect(auditRows().every((r) => JSON.parse(r.action_json).outcome === "ERR_CAPTURE_INVALID")).toBe(true);
    expect(deps.refusals.snapshot()["ERR_CAPTURE_RATE_LIMITED"]).toBe(1);
  });

  test("4 a kind outside config ∩ submittable is refused and audited", () => {
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "decision", payload: {} }))).toBe("ERR_CAPTURE_KIND_NOT_ALLOWED");
    cap = onConfig({ kinds: ["term"] });
    expect(codeOf(() => submitCapture(deps, MCP, NOTE))).toBe("ERR_CAPTURE_KIND_NOT_ALLOWED");
    const a = auditRows();
    expect(a).toHaveLength(2);
    expect(a.every((r) => r.hitl_status === "rejected")).toBe(true);
  });

  test("5 invalid payload is refused and audited without the payload", () => {
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "note", payload: { body: "" } }))).toBe("ERR_CAPTURE_INVALID");
    const j = JSON.parse(auditRows()[0]?.action_json ?? "{}") as Record<string, unknown>;
    expect(j).toEqual({ kind: "note", clientLabel: null, outcome: "ERR_CAPTURE_INVALID" });
  });

  test("6 relatesTo must name existing items; a capture item only while live", () => {
    upsertIndexedItem(db, { service: "github", type: "pr", externalId: "1", title: "PR", modifiedAt: 1, syncedAt: 1 });
    expect(submitCapture(deps, MCP, { kind: "note", payload: { body: "b", relatesTo: ["github:1"] } }).state).toBe("live");
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "note", payload: { body: "b", relatesTo: ["github:404"] } }))).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
    // Review Focus 5: a revoked note's former item id is gone.
    revokeCapture(deps, OWNER, "cap_1");
    expect(codeOf(() => submitCapture(deps, MCP, { kind: "note", payload: { body: "b", relatesTo: ["nimbus:cap_1"] } }))).toBe("ERR_CAPTURE_UNKNOWN_ITEM");
  });

  test("7 durable hourly cap reads the TABLE, so a fresh limiter (restart) does not reset it", () => {
    cap = onConfig({ maxPerHour: 1 });
    submitCapture(deps, MCP, NOTE);
    deps = { ...deps, limiter: new CaptureAttemptLimiter() };
    expect(codeOf(() => submitCapture(deps, MCP, NOTE))).toBe("ERR_CAPTURE_RATE_LIMITED");
    clock += 3_600_001;
    expect(submitCapture(deps, MCP, NOTE).state).toBe("live");
  });

  test("the client label is sanitised before storage", () => {
    submitCapture(deps, MCP, { ...NOTE, clientLabel: "evil\u001b[2J" });
    expect(deps.store.get("cap_1")?.clientLabel).toBe("evil[2J");
  });

  test("a non-object input is refused as invalid", () => {
    expect(codeOf(() => submitCapture(deps, MCP, "x"))).toBe("ERR_CAPTURE_INVALID");
  });
});

describe("revokeCapture", () => {
  test("owner revokes a live note: item gone, tombstone kept, one audit row", () => {
    submitCapture(deps, MCP, NOTE);
    clock += 5;
    expect(revokeCapture(deps, OWNER, "cap_1")).toEqual({ id: "cap_1", state: "revoked" });
    expect(db.query("SELECT 1 FROM item WHERE id = 'nimbus:cap_1'").get()).toBeNull();
    expect(deps.store.get("cap_1")).toMatchObject({ state: "revoked", payloadJson: null, decidedAt: clock });
    const revokes = auditRows().filter((r) => r.action_type === "capture.revoke");
    expect(revokes).toHaveLength(1);
    expect(revokes[0]?.hitl_status).toBe("approved");
  });

  test("Review Focus 2: revoking twice is a no-op success with no second audit row", () => {
    submitCapture(deps, MCP, NOTE);
    revokeCapture(deps, OWNER, "cap_1");
    expect(revokeCapture(deps, OWNER, "cap_1")).toEqual({ id: "cap_1", state: "revoked" });
    expect(auditRows().filter((r) => r.action_type === "capture.revoke")).toHaveLength(1);
  });

  test("works while the sink is DISABLED (withdrawing agent text is always possible)", () => {
    submitCapture(deps, MCP, NOTE);
    cap = resolveCaptureCapability({ ok: true, config: DEFAULT_MCP_SINK_CONFIG }, OPEN);
    expect(revokeCapture(deps, OWNER, "cap_1").state).toBe("revoked");
  });

  test("an mcp client cannot revoke; unknown ids are NOT_FOUND; a bad id is INVALID", () => {
    submitCapture(deps, MCP, NOTE);
    expect(codeOf(() => revokeCapture(deps, MCP, "cap_1"))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
    expect(codeOf(() => revokeCapture(deps, OWNER, "cap_404"))).toBe("ERR_CAPTURE_NOT_FOUND");
    expect(codeOf(() => revokeCapture(deps, OWNER, 7))).toBe("ERR_CAPTURE_INVALID");
  });

  test("a live note whose item was already deleted (data.delete) still revokes", () => {
    submitCapture(deps, MCP, NOTE);
    db.run("DELETE FROM item WHERE id = 'nimbus:cap_1'");
    expect(revokeCapture(deps, OWNER, "cap_1").state).toBe("revoked");
  });
});

describe("list / get / status", () => {
  test("list returns every state, newest first, limit 1..200", () => {
    submitCapture(deps, MCP, NOTE);
    clock += 1;
    submitCapture(deps, MCP, { ...NOTE, payload: { title: "Second", body: "b" } });
    const out = listCaptures(deps, OWNER, {});
    expect(out.captures.map((c) => [c.id, c.title])).toEqual([["cap_2", "Second"], ["cap_1", "Why WAL"]]);
    expect(listCaptures(deps, OWNER, { state: "revoked" }).captures).toEqual([]);
    expect(codeOf(() => listCaptures(deps, OWNER, { limit: 0 }))).toBe("ERR_CAPTURE_INVALID");
    expect(codeOf(() => listCaptures(deps, OWNER, { state: "bogus" }))).toBe("ERR_CAPTURE_INVALID");
    expect(codeOf(() => listCaptures(deps, MCP, {}))).toBe("ERR_CAPTURE_FORBIDDEN_CLIENT");
  });

  test("get returns the parsed payload; revoked returns payload null", () => {
    submitCapture(deps, MCP, NOTE);
    expect(getCapture(deps, OWNER, "cap_1").payload).toEqual({ title: "Why WAL", body: "We chose WAL because…", tags: [], relatesTo: [] });
    revokeCapture(deps, OWNER, "cap_1");
    expect(getCapture(deps, OWNER, "cap_1").payload).toBeNull();
  });

  test("status reports enabled, kinds, counts and refusal counters; disabled names the reason", () => {
    submitCapture(deps, MCP, NOTE);
    expect(captureStatus(deps)).toEqual({ enabled: true, kinds: ["note"], pending: 0, maxPending: 100, maxPerHour: 30, refusedSinceStart: {} });
    cap = resolveCaptureCapability({ ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } }, undefined);
    expect(captureStatus(deps)).toMatchObject({ enabled: false, disabledReason: "policy" });
  });
});
```

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/mcp-sink/capture-gate.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `capture-gate.ts`**

```ts
import type { Database } from "bun:sqlite";

import { appendAuditEntry } from "../db/audit-chain.ts";
import { deleteItemByPrimaryKey, itemPrimaryKey, upsertIndexedItem } from "../index/item-store.ts";
import type { ClientKind } from "../ipc/server/client-kind.ts";
import type { CaptureCapability } from "./capture-capability.ts";
import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";
import type { CaptureAttemptLimiter, CaptureRefusalCounter } from "./capture-rate-limit.ts";
import type { CaptureStore } from "./capture-store.ts";
import {
  CaptureError,
  type CaptureErrorCode,
  type CaptureKind,
  type CaptureRow,
  type CaptureState,
  isCaptureKind,
  isCaptureState,
} from "./capture-types.ts";
import { sanitizeClientLabel, validateNotePayload } from "./capture-validate.ts";

/**
 * Invariant I28 — the ONE door by which content from an MCP client enters Nimbus (spec § 5).
 * Submit runs a FIXED order; read it top to bottom in `submitCapture`. Static D32(b) confines the
 * callers of `submitCapture`/`revokeCapture` to `ipc/capture-rpc.ts`.
 */
export const CAPTURE_ITEM_SERVICE = "nimbus";
export const CAPTURE_ITEM_TYPE = "capture";
const HOUR_MS = 3_600_000;
const ATTEMPT_MULTIPLIER = 4;
const LIST_LIMIT_DEFAULT = 50;
const LIST_LIMIT_MAX = 200;

export interface CaptureGateDeps {
  readonly db: Database;
  readonly store: CaptureStore;
  capability(): CaptureCapability;
  readonly limiter: CaptureAttemptLimiter;
  readonly refusals: CaptureRefusalCounter;
  newId(): string;
  now(): number;
  scheduleEmbedding?(itemId: string): void;
}

export interface CaptureCaller {
  readonly clientId: string;
  readonly kind: ClientKind;
}

export interface CaptureSummary {
  readonly id: string;
  readonly kind: CaptureKind;
  readonly state: CaptureState;
  readonly title: string;
  readonly clientLabel: string | null;
  readonly createdAt: number;
  readonly decidedAt: number | null;
}

export type CaptureDetail = CaptureSummary & {
  readonly payload: unknown;
  readonly payloadBytes: number;
  readonly itemId: string | null;
  readonly nativeRef: string | null;
};

export interface CaptureStatus {
  readonly enabled: boolean;
  readonly kinds: readonly CaptureKind[];
  readonly pending: number;
  readonly maxPending: number;
  readonly maxPerHour: number;
  readonly refusedSinceStart: Readonly<Record<string, number>>;
  readonly disabledReason?: string;
}

// ---- helpers -------------------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new CaptureError("ERR_CAPTURE_INVALID", "params must be an object");
  }
  return v as Record<string, unknown>;
}

/** Steps 1–3 refuse without an audit row: counted instead, so the attempt limit stays a bound. */
function refuseUnaudited(deps: CaptureGateDeps, code: CaptureErrorCode, detail: string): never {
  deps.refusals.bump(code);
  throw new CaptureError(code, detail);
}

/** Steps 4–8 refuse WITH an audit row — their rate is bounded by step 3. */
function refuseAudited(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  kind: string,
  clientLabel: string | null,
  code: CaptureErrorCode,
  detail: string,
): never {
  appendAuditEntry(deps.db, {
    actionType: "capture.submit",
    hitlStatus: "rejected",
    actionJson: JSON.stringify({ kind, clientLabel, outcome: code }),
    timestamp: deps.now(),
    sessionId: caller.clientId,
  });
  throw new CaptureError(code, detail);
}

function requireOwner(caller: CaptureCaller): void {
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "owner") {
    throw new CaptureError("ERR_CAPTURE_FORBIDDEN_CLIENT", `a ${caller.kind} client cannot review captures`);
  }
}

function requireId(raw: unknown): string {
  if (typeof raw !== "string" || !raw.startsWith("cap_")) {
    throw new CaptureError("ERR_CAPTURE_INVALID", "id must be a capture id (cap_…)");
  }
  return raw;
}

function missingItem(deps: CaptureGateDeps, ids: readonly string[]): string | undefined {
  for (const id of ids) {
    const exists = deps.db.query("SELECT 1 FROM item WHERE id = ?").get(id) !== null;
    if (!exists) return id;
    const st = deps.store.stateOfItem(id);
    if (st !== undefined && st !== "live" && st !== "accepted") return id;
  }
  return undefined;
}

function titleOf(row: CaptureRow): string {
  if (row.payloadJson === null) return "(revoked)";
  const p = JSON.parse(row.payloadJson) as Record<string, unknown>;
  const t = p["title"] ?? p["statement"] ?? p["term"];
  return typeof t === "string" ? t.slice(0, 120) : "";
}

function summarize(row: CaptureRow): CaptureSummary {
  return {
    id: row.id,
    kind: row.kind,
    state: row.state,
    title: titleOf(row),
    clientLabel: row.clientLabel,
    createdAt: row.createdAt,
    decidedAt: row.decidedAt,
  };
}

// ---- submit (spec § 5.1) -------------------------------------------------------------------------

export function submitCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  input: unknown,
): { id: string; state: CaptureState } {
  // 1. Capability (config + live org policy, fail-closed).
  const cap = deps.capability();
  if (!cap.enabled) refuseUnaudited(deps, "ERR_CAPTURE_DISABLED", `the capture sink is off (${cap.reason})`);
  // 2. Client kind: only a declared `mcp` connection submits.
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "submit") {
    refuseUnaudited(deps, "ERR_CAPTURE_FORBIDDEN_CLIENT", `a ${caller.kind} client cannot submit captures`);
  }
  // 3. Gateway-wide attempt limit, BEFORE any validation.
  const now = deps.now();
  if (!deps.limiter.tryAcquire(now, cap.config.maxPerHour * ATTEMPT_MULTIPLIER)) {
    refuseUnaudited(deps, "ERR_CAPTURE_RATE_LIMITED", "too many capture attempts this hour");
  }
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    refuseAudited(deps, caller, "unknown", null, "ERR_CAPTURE_INVALID", "params must be an object");
  }
  const params = input as Record<string, unknown>;
  const clientLabel = sanitizeClientLabel(params["clientLabel"]);
  const kindRaw = params["kind"];
  const kindName = typeof kindRaw === "string" ? kindRaw.slice(0, 20) : "unknown";
  // 4. Kind allowed by config AND supported by this gateway version.
  if (!isCaptureKind(kindRaw) || !cap.kinds.includes(kindRaw)) {
    refuseAudited(deps, caller, kindName, clientLabel, "ERR_CAPTURE_KIND_NOT_ALLOWED", `kind ${kindName} is not enabled`);
  }
  // 5. Whitelist rebuild.
  let payload: ReturnType<typeof validateNotePayload>;
  try {
    payload = validateNotePayload(params["payload"]);
  } catch (e) {
    if (e instanceof CaptureError) refuseAudited(deps, caller, kindRaw, clientLabel, e.code, e.message);
    throw e;
  }
  // 6. Referenced items exist (a capture item only while live/accepted).
  const missing = missingItem(deps, payload.relatesTo);
  if (missing !== undefined) {
    refuseAudited(deps, caller, kindRaw, clientLabel, "ERR_CAPTURE_UNKNOWN_ITEM", `no indexed item ${missing}`);
  }
  // 7. Durable hourly cap — read from the table, survives restarts.
  if (deps.store.countCreatedSince(now - HOUR_MS) >= cap.config.maxPerHour) {
    refuseAudited(deps, caller, kindRaw, clientLabel, "ERR_CAPTURE_RATE_LIMITED", "hourly capture cap reached");
  }
  // 8. Pending cap applies to proposals only; a note is never pending (PR 2 adds the check here).

  // 9 + 10. One transaction: capture row, item, audit. An audit failure rolls all of it back.
  const id = deps.newId();
  const itemId = itemPrimaryKey(CAPTURE_ITEM_SERVICE, id);
  const payloadJson = JSON.stringify(payload);
  const payloadBytes = Buffer.byteLength(payloadJson, "utf8");
  deps.db.transaction(() => {
    deps.store.insert({
      id,
      kind: kindRaw,
      state: "live",
      itemId,
      payloadJson,
      payloadBytes,
      clientLabel,
      sessionId: caller.clientId,
      createdAt: now,
    });
    upsertIndexedItem(deps.db, {
      service: CAPTURE_ITEM_SERVICE,
      type: CAPTURE_ITEM_TYPE,
      externalId: id,
      title: payload.title,
      body: payload.body,
      modifiedAt: now,
      syncedAt: now,
      metadata: {
        captureKind: kindRaw,
        captureId: id,
        agentAuthored: true,
        clientLabel,
        tags: payload.tags,
        relatesTo: payload.relatesTo,
      },
    });
    appendAuditEntry(deps.db, {
      actionType: "capture.submit",
      hitlStatus: "not_required",
      actionJson: JSON.stringify({ captureId: id, kind: kindRaw, payloadBytes, clientLabel, outcome: "captured" }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  deps.scheduleEmbedding?.(itemId);
  return { id, state: "live" };
}

// ---- revoke (spec § 5.3) -------------------------------------------------------------------------

export function revokeCapture(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  idRaw: unknown,
): { id: string; state: "revoked" } {
  requireOwner(caller);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  if (row.state === "revoked") return { id, state: "revoked" };
  if (row.state !== "live") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} is ${row.state}; only a live note can be revoked in this version`);
  }
  const now = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.markRevoked(id, "live", now);
    if (!won) return; // lost a race to another revoke: nothing to write
    if (row.itemId !== null) deleteItemByPrimaryKey(deps.db, row.itemId);
    appendAuditEntry(deps.db, {
      actionType: "capture.revoke",
      hitlStatus: "approved",
      actionJson: JSON.stringify({ captureId: id, kind: row.kind, outcome: "revoked" }),
      timestamp: now,
      sessionId: caller.clientId,
    });
  })();
  if (!won && deps.store.get(id)?.state !== "revoked") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${id} changed state concurrently`);
  }
  return { id, state: "revoked" };
}

// ---- owner reads ---------------------------------------------------------------------------------

export function listCaptures(
  deps: CaptureGateDeps,
  caller: CaptureCaller,
  paramsRaw: unknown,
): { captures: CaptureSummary[] } {
  requireOwner(caller);
  const p = paramsRaw === undefined ? {} : asRecord(paramsRaw);
  const state = p["state"];
  const kind = p["kind"];
  const limit = p["limit"] ?? LIST_LIMIT_DEFAULT;
  if (state !== undefined && !isCaptureState(state)) throw new CaptureError("ERR_CAPTURE_INVALID", "unknown state");
  if (kind !== undefined && !isCaptureKind(kind)) throw new CaptureError("ERR_CAPTURE_INVALID", "unknown kind");
  if (typeof limit !== "number" || !Number.isInteger(limit) || limit < 1 || limit > LIST_LIMIT_MAX) {
    throw new CaptureError("ERR_CAPTURE_INVALID", `limit must be an integer 1..${String(LIST_LIMIT_MAX)}`);
  }
  const filter: { state?: CaptureState; kind?: CaptureKind; limit: number } = { limit };
  if (state !== undefined) filter.state = state;
  if (kind !== undefined) filter.kind = kind;
  return { captures: deps.store.list(filter).map(summarize) };
}

export function getCapture(deps: CaptureGateDeps, caller: CaptureCaller, idRaw: unknown): CaptureDetail {
  requireOwner(caller);
  const id = requireId(idRaw);
  const row = deps.store.get(id);
  if (row === undefined) throw new CaptureError("ERR_CAPTURE_NOT_FOUND", `no capture ${id}`);
  return {
    ...summarize(row),
    payload: row.payloadJson === null ? null : (JSON.parse(row.payloadJson) as unknown),
    payloadBytes: row.payloadBytes,
    itemId: row.itemId,
    nativeRef: row.nativeRef,
  };
}

export function captureStatus(deps: CaptureGateDeps): CaptureStatus {
  const cap = deps.capability();
  const base = {
    enabled: cap.enabled,
    kinds: cap.enabled ? cap.kinds : [],
    pending: deps.store.countByState("proposed"),
    maxPending: cap.config.maxPending,
    maxPerHour: cap.config.maxPerHour,
    refusedSinceStart: deps.refusals.snapshot(),
  };
  return cap.enabled ? base : { ...base, disabledReason: cap.reason };
}
```

Note for the implementer: steps 1–3 sit before the `input` object check on purpose. A disabled sink must refuse without reading the payload (spec §5.1, and pinned by the "refuses BEFORE reading the payload" test). If `bun:sqlite`'s `db.transaction(fn)()` rethrows, the `scheduleEmbedding` call after it is never reached, which is what the rollback test asserts.

- [ ] **Step 4: Add `nimbus:capture` to `LOCAL_ONLY_PROSE_TYPES`.** In `embedding/routing.ts`, add to the set (after the multimodal entries):

```ts
  // MCP capture sink (spec 2026-10-11 § 4.3): agent-authored notes ABOUT the private index. Local
  // embedding keeps "nothing here is egress" true (success criterion 5); membership also gives the
  // 16,384 body cap via LONG_BODY_TYPES.
  "nimbus:capture",
```

In `routing.test.ts`, add:

```ts
test("nimbus:capture is local-only prose and never remote-routable", () => {
  expect(LOCAL_ONLY_PROSE_TYPES.has("nimbus:capture")).toBe(true);
  expect(PROSE_HEAVY_TYPES.has("nimbus:capture")).toBe(false);
});
```

(Import names: use whatever `routing.test.ts` already imports. Both sets are exported from `routing.ts`.)

- [ ] **Step 5: Run the tests**

Run: `bun test packages/gateway/src/mcp-sink packages/gateway/src/embedding/routing.test.ts packages/gateway/src/index/body-caps.test.ts`
Expected: PASS. If the body test in `capture-gate.test.ts` shows a 512-char body, Step 4 is missing.

- [ ] **Step 6: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/mcp-sink packages/gateway/src/embedding/routing.ts packages/gateway/src/embedding/routing.test.ts
git commit -m "feat(mcp-sink): I28 capture gate — ordered submit, owner revoke/list/get, status"
```

---

### Task 7: IPC dispatcher, routing, LAN denylist and boot wiring

**Files:**
- Create: `packages/gateway/src/ipc/capture-rpc.ts`
- Test: `packages/gateway/src/ipc/capture-rpc.test.ts`
- Modify: `packages/gateway/src/ipc/server/options.ts` (add `captureRpcCtx?: CaptureRpcCtx;` beside `notificationsRpcCtx` at :186)
- Modify: `packages/gateway/src/ipc/server/dispatchers.ts` (new `tryDispatchCaptureRpc`; insert it into `PHASE4_PLATFORM_DISPATCHERS` right after `tryDispatchNotificationsRpc`; add it to the re-export list at about :1747)
- Modify: `packages/gateway/src/ipc/lan-rpc.ts:10` (add `"capture", "captures"` to `FORBIDDEN_OVER_LAN`)
- Modify: `packages/gateway/src/ipc/lan-rpc.test.ts` (new `test.each` beside the oncall one at :122)
- Modify: `packages/gateway/src/platform/assemble.ts` (build deps; boot prune; `ipcOpts.captureRpcCtx = …` beside :4068)

**Interfaces:**
- Consumes: the gate functions (Task 6), `RpcMethodError`, `dispatchByMethod`, `ServerCtx.getClientKind`.
- Produces:
  - `CaptureRpcCtx { readonly gate: CaptureGateDeps }`
  - `dispatchCaptureRpc(method: string, params: unknown, ctx: CaptureRpcCtx, caller: CaptureCaller): Promise<RpcMissOrHit>`
  - Wire methods `capture.status`, `capture.submit`, `captures.list`, `captures.get`, `captures.revoke`
  - Errors map to `RpcMethodError(-32001, "<CODE>: <detail>", { code })`.

- [ ] **Step 1: Write the failing test** — `ipc/capture-rpc.test.ts`:

```ts
import type { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { DEFAULT_MCP_SINK_CONFIG } from "../config/mcp-sink-toml.ts";
import { openMigratedMemoryDb } from "../index/migrated-db-template.ts";
import { resolveCaptureCapability } from "../mcp-sink/capture-capability.ts";
import type { CaptureGateDeps } from "../mcp-sink/capture-gate.ts";
import { CaptureAttemptLimiter, CaptureRefusalCounter } from "../mcp-sink/capture-rate-limit.ts";
import { CaptureStore } from "../mcp-sink/capture-store.ts";
import { createMockVault } from "../vault/mock.ts";
import { type CaptureRpcCtx, dispatchCaptureRpc } from "./capture-rpc.ts";
import { ConsentCoordinatorImpl } from "./consent.ts";
import { createStreamRegistry } from "./engine-ask-stream.ts";
import { checkLanMethodAllowed, LanError } from "./lan-rpc.ts";
import type { ClientKind } from "./server/client-kind.ts";
import type { ServerCtx } from "./server/context.ts";
import { tryDispatchPhase4Rpc } from "./server/dispatchers.ts";
import type { CreateIpcServerOptions } from "./server/options.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

let db: Database;
let ctx: CaptureRpcCtx;

beforeEach(() => {
  db = openMigratedMemoryDb();
  let seq = 0;
  const gate: CaptureGateDeps = {
    db,
    store: new CaptureStore(db),
    capability: () =>
      resolveCaptureCapability(
        { ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } },
        { capabilitiesDisabled: new Set() },
      ),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${String(++seq)}`,
    now: () => 1_000,
  };
  ctx = { gate };
});
afterEach(() => db.close());

function serverCtx(overrides: Partial<CreateIpcServerOptions>, kinds: Record<string, ClientKind>): ServerCtx {
  return {
    options: { listenPath: "", vault: createMockVault(), version: "test", ...overrides },
    consentImpl: new ConsentCoordinatorImpl(() => undefined),
    startedAtMs: Date.now(),
    streamRegistry: createStreamRegistry(),
    broadcastNotification: () => {},
    getAgentInvokeHandler: () => undefined,
    getWorkflowRunHandler: () => undefined,
    getClientKind: (id) => kinds[id] ?? "unknown",
  };
}

const NOTE = { kind: "note", payload: { title: "t", body: "b" } };

describe("dispatchCaptureRpc", () => {
  test("hits every method and misses others", async () => {
    const mcp = { clientId: "m", kind: "mcp" as const };
    const own = { clientId: "o", kind: "cli" as const };
    expect((await dispatchCaptureRpc("capture.status", {}, ctx, mcp)).kind).toBe("hit");
    const sub = await dispatchCaptureRpc("capture.submit", NOTE, ctx, mcp);
    expect(sub).toEqual({ kind: "hit", value: { id: "cap_1", state: "live" } });
    expect((await dispatchCaptureRpc("captures.list", {}, ctx, own)).kind).toBe("hit");
    expect((await dispatchCaptureRpc("captures.get", { id: "cap_1" }, ctx, own)).kind).toBe("hit");
    expect(await dispatchCaptureRpc("captures.revoke", { id: "cap_1" }, ctx, own)).toEqual({
      kind: "hit",
      value: { id: "cap_1", state: "revoked" },
    });
    expect(await dispatchCaptureRpc("captures.accept", { id: "cap_1" }, ctx, own)).toEqual({ kind: "miss" });
  });
});

describe("routing through tryDispatchPhase4Rpc (the entry server.ts calls)", () => {
  test("capture.submit reaches the gate with the CONNECTION's kind, not a param", async () => {
    const s = serverCtx({ captureRpcCtx: ctx }, { m: "mcp", o: "cli" });
    expect(await tryDispatchPhase4Rpc(s, "capture.submit", NOTE, "m")).toEqual({ id: "cap_1", state: "live" });
    // A params-level "kind" cannot promote an owner connection to submit.
    await expect(tryDispatchPhase4Rpc(s, "capture.submit", { ...NOTE, clientKind: "mcp" }, "o")).rejects.toThrow(
      /ERR_CAPTURE_FORBIDDEN_CLIENT/,
    );
  });

  test("a CaptureError becomes RpcMethodError -32001 carrying the code", async () => {
    const s = serverCtx({ captureRpcCtx: ctx }, { m: "mcp" });
    try {
      await tryDispatchPhase4Rpc(s, "captures.list", {}, "m");
      throw new Error("expected a refusal");
    } catch (e) {
      expect(e).toBeInstanceOf(RpcMethodError);
      expect((e as RpcMethodError).rpcCode).toBe(-32001);
      expect((e as RpcMethodError).rpcData).toEqual({ code: "ERR_CAPTURE_FORBIDDEN_CLIENT" });
    }
  });
});

describe("LAN", () => {
  test.each(["capture.status", "capture.submit", "captures.list", "captures.get", "captures.revoke", "captures.accept"])(
    "%s is not callable over LAN (namespace denial covers future methods)",
    (method) => {
      expect(() => checkLanMethodAllowed(method, { peerId: "p", writeAllowed: true })).toThrow(LanError);
    },
  );
});
```

Check the `LanPeerContext` shape at `lan-rpc.ts` before running, and adjust the literal `{ peerId, writeAllowed }` to match its fields exactly.

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/gateway/src/ipc/capture-rpc.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `ipc/capture-rpc.ts`**

```ts
import {
  type CaptureCaller,
  type CaptureGateDeps,
  captureStatus,
  getCapture,
  listCaptures,
  revokeCapture,
  submitCapture,
} from "../mcp-sink/capture-gate.ts";
import { CaptureError } from "../mcp-sink/capture-types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

/**
 * `capture.*` (MCP-facing) and `captures.*` (owner-facing) — invariant I28. LAN-forbidden by
 * namespace (I5), absent from the Tauri allowlist (I7), no HTTP route. The caller's kind comes
 * from the CONNECTION (`ServerCtx.getClientKind`), never from params.
 */
export interface CaptureRpcCtx {
  readonly gate: CaptureGateDeps;
}

type Ctx = { readonly gate: CaptureGateDeps; readonly caller: CaptureCaller };

function idParam(params: unknown): unknown {
  return typeof params === "object" && params !== null ? (params as Record<string, unknown>)["id"] : undefined;
}

export async function dispatchCaptureRpc(
  method: string,
  params: unknown,
  ctx: CaptureRpcCtx,
  caller: CaptureCaller,
): Promise<RpcMissOrHit> {
  try {
    return await dispatchByMethod<Ctx, unknown>(method, params, { gate: ctx.gate, caller }, {
      "capture.status": (_p, c) => captureStatus(c.gate),
      "capture.submit": (p, c) => submitCapture(c.gate, c.caller, p),
      "captures.list": (p, c) => listCaptures(c.gate, c.caller, p),
      "captures.get": (p, c) => getCapture(c.gate, c.caller, idParam(p)),
      "captures.revoke": (p, c) => revokeCapture(c.gate, c.caller, idParam(p)),
    });
  } catch (e) {
    if (e instanceof CaptureError) throw new RpcMethodError(-32001, e.message, { code: e.code });
    throw e;
  }
}
```

- [ ] **Step 4: Wire the dispatcher.** In `ipc/server/options.ts`, beside `notificationsRpcCtx`:

```ts
  /** MCP capture sink (I28). LAN-forbidden (I5), not Tauri (I7); the dispatcher skips when unset. */
  captureRpcCtx?: CaptureRpcCtx;
```

(Import the type from `../capture-rpc.ts`.) In `ipc/server/dispatchers.ts`, next to `tryDispatchNotificationsRpc`:

```ts
export async function tryDispatchCaptureRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!method.startsWith("capture.") && !method.startsWith("captures.")) return phase4RpcSkipped;
  const rpc = ctx.options.captureRpcCtx;
  if (rpc === undefined) return phase4RpcSkipped;
  const out = await dispatchCaptureRpc(method, params, rpc, {
    clientId,
    kind: ctx.getClientKind(clientId),
  });
  return out.kind === "hit" ? out.value : phase4RpcSkipped;
}
```

Insert `tryDispatchCaptureRpc` into `PHASE4_PLATFORM_DISPATCHERS` immediately after `tryDispatchNotificationsRpc`, and add it to the re-export list. In `lan-rpc.ts`, add `"capture", "captures",` after `"notifications"` in `FORBIDDEN_OVER_LAN`.

- [ ] **Step 5: Wire boot in `platform/assemble.ts`.** Near the notifications runtime (about :3337), where `db`, `activeTomlPath`, `policyGate` and `scheduleItemEmbedding` are in scope:

```ts
  // MCP capture sink (I28, spec 2026-10-11). Config at boot; policy LIVE per call (I22).
  const mcpSinkLoad = loadNimbusMcpSinkFromPath(activeTomlPath);
  if (!mcpSinkLoad.ok) {
    syncLogger.error({ event: "mcp_sink.config_invalid", error: mcpSinkLoad.error }, "[mcp_sink] is invalid; the capture sink is OFF");
  }
  const captureStore = new CaptureStore(db);
  captureStore.pruneRejected(Date.now() - 90 * 86_400_000);
  const captureGate: CaptureGateDeps = {
    db,
    store: captureStore,
    capability: () => resolveCaptureCapability(mcpSinkLoad, policyGate.enforced()),
    limiter: new CaptureAttemptLimiter(),
    refusals: new CaptureRefusalCounter(),
    newId: () => `cap_${randomUUID()}`,
    now: () => Date.now(),
    scheduleEmbedding: (id) => scheduleItemEmbedding?.(id),
  };
```

Beside `ipcOpts.notificationsRpcCtx = …` (about :4068):

```ts
  ipcOpts.captureRpcCtx = { gate: captureGate };
```

Before writing this: open `assemble.ts` and confirm the exact names of the logger variable (`syncLogger`), the toml path (`activeTomlPath`), the policy gate (`policyGate.enforced()`), and `scheduleItemEmbedding`, which may be `undefined` when the embedding runtime is skipped, hence the `?.`. If `policyGate.enforced()` can be undefined before policy load, pass it through unchanged: `resolveCaptureCapability` fails closed on `undefined`. Import `randomUUID` from `node:crypto` if not already imported.

- [ ] **Step 6: Run the tests**

Run: `bun test packages/gateway/src/ipc/capture-rpc.test.ts packages/gateway/src/ipc/lan-rpc.test.ts packages/gateway/src/platform`
Expected: PASS.

- [ ] **Step 7: Typecheck the whole repo** (`assemble.ts` is large and this catches name mismatches).

Run: `bun run typecheck`
Expected: exit 0.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/src/ipc packages/gateway/src/platform/assemble.ts
git commit -m "feat(mcp-sink): capture.*/captures.* IPC, LAN namespace denial, boot wiring"
```

---

### Task 8: I28 and D32 — the invariant triple

The wiring, the docs and the test land in ONE commit (the triple rule).

**Files:**
- Modify: `scripts/structure-audit/check-nimbus-invariants.ts` (add D32(a) and D32(b) beside D27(b) at about :1786; register them in the runner block at about :2728)
- Modify: `scripts/structure-audit/check-nimbus-invariants.test.ts` (red-proof tests; import the two new functions)
- Modify: `packages/gateway/src/security-invariants.test.ts` (new `describe("I28 — …")` block placed before I29)
- Modify: `docs/SECURITY-INVARIANTS.md` (line 3's ceiling paragraph; a new `## I28` section placed before `## I29`)
- Modify: `CLAUDE.md` and `GEMINI.md` (replace the I28 "reserved" bullet; update "Invariants through I42 (I28 reserved)" → "Invariants I1–I42"; append D32 to the static-complement paragraph)
- Modify: `scripts/structure-audit/check-coderabbit-config.test.ts:98-102` (that test forbids a path instruction enforcing the RESERVED I28. Update its premise: I28 is now live, so delete the test or invert it, whichever the file's other tests make natural)
- Modify: `scripts/structure-audit/check-status-drift.ts:61` (comment says "I28 is reserved today"; update it)

**Interfaces:**
- Produces: `checkCaptureTableConfinement(files: readonly FileEntry[]): Violation[]` (D32(a)) and `checkCaptureGateCallers(files: readonly FileEntry[]): Violation[]` (D32(b)).

- [ ] **Step 1: Write the failing static-rule tests** in `check-nimbus-invariants.test.ts` (add both names to the existing import from `./check-nimbus-invariants.ts`):

```ts
describe("D32(a) — the capture table is named only by its store and its DDL", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });
  const store = "packages/gateway/src/mcp-sink/capture-store.ts";
  const sql = "packages/gateway/src/index/capture-v66-sql.ts";

  test("allows the store and the V66 SQL module", () => {
    expect(
      checkCaptureTableConfinement([
        file(store, "SELECT * FROM capture WHERE id = ?"),
        file(sql, "CREATE TABLE IF NOT EXISTS capture ("),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a read", "SELECT 1 FROM capture"],
    ["a write", "INSERT INTO capture (id) VALUES (?)"],
    ["an update", "UPDATE capture SET state = 'x'"],
    ["a quoted name", 'SELECT 1 FROM "capture"'],
    ["a backtick name", "SELECT 1 FROM `capture`"],
    ["a bracket name", "SELECT 1 FROM [capture]"],
  ])("FAILS on %s from anywhere else", (_n, sqlText) => {
    expect(checkCaptureTableConfinement([file("packages/gateway/src/ipc/capture-rpc.ts", sqlText)])).toHaveLength(1);
  });

  test("does not match look-alike identifiers or comments", () => {
    expect(
      checkCaptureTableConfinement([
        file("packages/gateway/src/x.ts", "SELECT 1 FROM capture_log; // FROM capture\nconst tribalCapture = 1;"),
      ]),
    ).toEqual([]);
  });

  test("ignores test files", () => {
    expect(checkCaptureTableConfinement([file("packages/gateway/src/x.test.ts", "FROM capture")])).toEqual([]);
  });
});

describe("D32(b) — gate entry points are called only from ipc/capture-rpc.ts", () => {
  const file = (relPath: string, contents: string): FileEntry => ({ relPath, contents });

  test("allows the rpc dispatcher and the gate's own definitions", () => {
    expect(
      checkCaptureGateCallers([
        file("packages/gateway/src/ipc/capture-rpc.ts", "submitCapture(c.gate, c.caller, p); revokeCapture(a, b, c);"),
        file("packages/gateway/src/mcp-sink/capture-gate.ts", "export function submitCapture(deps) {}"),
      ]),
    ).toEqual([]);
  });

  test.each(["submitCapture", "acceptCapture", "rejectCapture", "revokeCapture"])(
    "FAILS when %s is called anywhere else",
    (fn) => {
      expect(checkCaptureGateCallers([file("packages/gateway/src/platform/assemble.ts", `${fn}(deps, caller, x)`)])).toHaveLength(1);
    },
  );

  test("an aliased import is also caught", () => {
    expect(
      checkCaptureGateCallers([
        file("packages/gateway/src/x.ts", 'import { submitCapture as sc } from "../mcp-sink/capture-gate.ts";'),
      ]),
    ).toHaveLength(1);
  });
});
```

(If `FileEntry` is not already imported in that test file, add it to the type import from `./lib.ts` or `./check-nimbus-invariants.ts`, wherever the existing tests import it from.)

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts -t "D32"`
Expected: FAIL, the exports do not exist.

- [ ] **Step 3: Implement the rules** in `check-nimbus-invariants.ts`, after `checkMediaGrantStoreConfinement`:

```ts
// ---- D32 (I28) — the MCP capture sink ------------------------------------------------------------
// (a) The `capture` table is named only by its store and its DDL. Same shape as D27(b): SQL keyword
//     + optional quote + the bare identifier + a non-identifier lookahead, so `capture_log` and
//     `tribalCapture` never match. Comments are stripped; string literals are NOT (SQL lives there).
//     Stated bound: a dynamically composed identifier evades a text scan; capability confinement —
//     only CaptureStore is ever handed queries against the table — is the real defense.
const D32_CAPTURE_TABLE_RE =
  /\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+[`"[]?capture[`"\]]?(?![A-Za-z0-9_])/i;
const D32_CAPTURE_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/mcp-sink/capture-store.ts",
  "packages/gateway/src/index/capture-v66-sql.ts",
];

export function checkCaptureTableConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D32_CAPTURE_TABLE_ALLOWED.includes(f.relPath)) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D32_CAPTURE_TABLE_RE.source, "gi"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({ rule: "capture-table-confined", file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    }
  }
  return out;
}

// (b) The four gate entry points are CALLED only from ipc/capture-rpc.ts and DEFINED only in
//     capture-gate.ts. Any other mention — a call or an import (aliased or not) — is a violation, so
//     a second door cannot be opened by importing the function under another name.
const D32_GATE_FN_RE = /\b(?:submitCapture|acceptCapture|rejectCapture|revokeCapture)\b/g;
const D32_GATE_ALLOWED: readonly string[] = [
  "packages/gateway/src/ipc/capture-rpc.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];

export function checkCaptureGateCallers(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D32_GATE_ALLOWED.includes(f.relPath)) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    for (const m of code.matchAll(D32_GATE_FN_RE)) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({ rule: "capture-gate-callers", file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    }
  }
  return out;
}
```

Import `stripStringLiterals` from `./lib.ts` if the file does not already. It does: line 5 imports it. Register both rules in the main runner block beside D27(b):

```ts
  if (mode === "binary-only" || mode === "all") {
    const a = checkCaptureTableConfinement(files);
    for (const e of a) {
      console.error(`::error file=${e.file},line=${e.line}::D32(a) the capture table reached outside mcp-sink/capture-store.ts — I28 regression: ${e.snippet}`);
    }
    const b = checkCaptureGateCallers(files);
    for (const e of b) {
      console.error(`::error file=${e.file},line=${e.line}::D32(b) a capture gate entry point named outside ipc/capture-rpc.ts — I28 regression: ${e.snippet}`);
    }
    if (a.length > 0 || b.length > 0) exit = 1;
  }
```

Note: the gate's string literal `'capture.submit'` contains no SQL keyword before `capture`, so D32(a) does not fire on it. `"FROM capture"` inside a TS string in `capture-store.ts` is allow-listed.

- [ ] **Step 4: Run the static rules against the live repo**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts -t "D32"` and then `bun run audit:invariants`
Expected: PASS and exit 0. If the live audit flags a real file (for example a test helper outside `.test.ts`), fix the file, never the rule.

- [ ] **Step 5: Write the I28 runtime test** in `security-invariants.test.ts`, before the I29 block. Use the file's existing `read()` helper:

```ts
describe("I28 — MCP content enters only through the capture gate, in a fixed order", () => {
  test("submitCapture checks capability → client kind → attempt limit → kind → validate → items → durable cap, in that order", async () => {
    const src = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    const body = src.slice(src.indexOf("export function submitCapture"));
    const order = [
      "deps.capability()",
      "CAPTURE_ROLE_BY_KIND[caller.kind]",
      "deps.limiter.tryAcquire",
      "cap.kinds.includes",
      "validateNotePayload",
      "missingItem(",
      "deps.store.countCreatedSince",
      "deps.db.transaction",
    ];
    const idx = order.map((s) => body.indexOf(s));
    expect(idx.every((i) => i >= 0)).toBe(true);
    expect([...idx].sort((a, b) => a - b)).toEqual(idx);
  });

  test("the role table is total and only mcp submits; mcp is never owner", async () => {
    const { CAPTURE_ROLE_BY_KIND } = await import("./mcp-sink/capture-client-policy.ts");
    const submitters = Object.entries(CAPTURE_ROLE_BY_KIND).filter(([, r]) => r === "submit").map(([k]) => k);
    expect(submitters).toEqual(["mcp"]);
  });

  test("an absent policy accessor DISABLES the sink (fail-closed, I22)", async () => {
    const { resolveCaptureCapability } = await import("./mcp-sink/capture-capability.ts");
    const { DEFAULT_MCP_SINK_CONFIG } = await import("./config/mcp-sink-toml.ts");
    const c = resolveCaptureCapability({ ok: true, config: { ...DEFAULT_MCP_SINK_CONFIG, enabled: true } }, undefined);
    expect(c.enabled).toBe(false);
  });

  test("both namespaces are LAN-forbidden and absent from the Tauri allowlist", async () => {
    const lan = await read("packages/gateway/src/ipc/lan-rpc.ts");
    expect(lan).toMatch(/"capture",\s*"captures"/);
    const tauri = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(tauri).not.toMatch(/"captures?\./);
  });

  test("capture items are never extraction input", async () => {
    const { DECISION_SOURCE_TYPES } = await import("./decisions/decision-source-types.ts");
    const { GLOSSARY_SOURCE_TYPES } = await import("./glossary/glossary-source-types.ts");
    expect(DECISION_SOURCE_TYPES.has("nimbus:capture")).toBe(false);
    expect(GLOSSARY_SOURCE_TYPES.has("nimbus:capture")).toBe(false);
  });

  test("capture items embed LOCALLY only (no remote egress through the embedder)", async () => {
    const { LOCAL_ONLY_PROSE_TYPES, PROSE_HEAVY_TYPES } = await import("./embedding/routing.ts");
    expect(LOCAL_ONLY_PROSE_TYPES.has("nimbus:capture")).toBe(true);
    expect(PROSE_HEAVY_TYPES.has("nimbus:capture")).toBe(false);
  });
});
```

(`stripComments` is already imported at the top of this file, line 19.)

- [ ] **Step 6: Write the docs half of the triple.**

`docs/SECURITY-INVARIANTS.md` line 3: change the ceiling to "invariants I1–I42 (static rules D10–D32; …)" and delete the closing "Note: I28 is reserved …" sentence. Add before `## I29`:

```markdown
## I28 — MCP content enters only through the capture gate

**Statement:** content from an MCP client enters Nimbus only through `mcp-sink/capture-gate.ts`'s
`submitCapture()`. Submit runs a fixed order: capability (config + live org policy `mcp_capture`,
fail-closed on an absent accessor) → declared `mcp` client kind only → ONE gateway-wide attempt
limit (4 × `max_per_hour`, before any validation) → kind allowed → whitelist rebuild → referenced
items exist → durable hourly cap read from the table → one-transaction write of the `capture` row,
the `nimbus:capture` item and the `capture.submit` audit row (an audit failure rolls all of it
back). Owner methods (`captures.*`) refuse the `mcp` kind, and the MCP adapter registers no tool
that reaches them. Capture items are excluded from decision/glossary extraction and embed locally
only (`LOCAL_ONLY_PROSE_TYPES`).

**Wiring:** `mcp-sink/{capture-gate,capture-store,capture-capability,capture-client-policy,capture-rate-limit,capture-validate}.ts`, `ipc/capture-rpc.ts`, `ipc/server/dispatchers.ts` (`tryDispatchCaptureRpc`), `ipc/lan-rpc.ts`, `platform/assemble.ts`.

**Static complement:** D32(a) confines the `capture` table identifier to `capture-store.ts` + `index/capture-v66-sql.ts`; D32(b) confines every mention of `submitCapture`/`acceptCapture`/`rejectCapture`/`revokeCapture` to `ipc/capture-rpc.ts` + `capture-gate.ts`. Stated bound: a dynamically composed identifier evades D32(a); capability confinement is the real defense.

**Bounds:** a live note is searchable unreviewed, by design (PR 1 ships notes only; proposals that
count only after owner acceptance are PR 2); text reaching a model is delimited by I11, not
sanitised; the attempt limit is in-memory and resets on gateway restart (the durable hourly cap does
not); refusals before the attempt limit are counted (`capture.status`), not audited; `data.delete
--service nimbus` removes capture items but not `capture` rows.

**Enforcement test:** `security-invariants.test.ts` → `I28 — …`.
```

`CLAUDE.md` and `GEMINI.md`: replace the `**I28** — _reserved …_` bullet with:

```markdown
- **I28** — content from an MCP client enters Nimbus only through `mcp-sink/capture-gate.ts` `submitCapture()`, in a fixed order (capability incl. live policy `mcp_capture`, fail-closed → declared `mcp` kind only → gateway-wide attempt limit → kind → whitelist rebuild → referenced items exist → durable hourly cap → one-transaction write + audit); owner methods `captures.*` refuse `mcp`; capture items never feed extraction and embed locally only (static D32) · `mcp-sink/*`, `ipc/capture-rpc.ts`
```

In both files, update "Invariants through I42 (I28 reserved)" → "Invariants I1–I42", update "Each live invariant (I1–I27, I29–I42)" → "(I1–I42)", delete "I28 is reserved and has neither", and append `, I28 (D32 — two rules: the capture table and the gate entry points)` to the static-complement list.

- [ ] **Step 7: Run everything this touches**

Run: `bun test packages/gateway/src/security-invariants.test.ts -t "I28" && bun test scripts/structure-audit && bun run audit:invariants && bun run audit:status-drift && bun run audit:doc-refs`
Expected: all PASS / exit 0. `check-status-drift` takes the ceiling from the highest `## I<N>` heading, so adding `## I28` does not change it. If the drift gate complains about the live-invariant count, update the number it names in the doc it names.

- [ ] **Step 8: Commit (ONE commit: wiring is already in; this adds rule + docs + test)**

```bash
git rev-parse --abbrev-ref HEAD
git add scripts/structure-audit packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
git commit -m "feat(mcp-sink): I28 invariant + static D32 (capture table, gate callers)"
```

---

### Task 9: MCP adapter — item ids, `agentAuthored`, `capture_note`

**Files:**
- Modify: `packages/cli/src/mcp/adapter.ts` (`projectRankedItem` at :103; `META_WHITELIST` at :45; `buildMcpServer` / `buildMcpServerForGateway` at :609-635)
- Create: `packages/cli/src/mcp/capture-tools.ts`
- Test: `packages/cli/src/mcp/capture-tools.test.ts`; add cases to `packages/cli/src/mcp/adapter.test.ts`
- Modify: `packages/cli/src/commands/mcp-server.ts` (`formatHelp`) and `packages/cli/src/commands/mcp-server.test.ts`

**Interfaces:**
- Consumes: `IpcCallable`, `AdapterDeps`, `ToolResult`, `jsonResult`, `errorResult`, `runTool` from `tool-runtime.ts` / `client-surface.ts`. Gateway `capture.status` / `capture.submit` (Task 7).
- Produces:
  - `CaptureToolSpec { name; description; schema; annotations; run(deps: AdapterDeps, args: Record<string, unknown>, clientLabel: () => string | undefined): Promise<ToolResult> }`
  - `CAPTURE_TOOL_SPECS: readonly CaptureToolSpec[]`
  - `captureToolsFor(deps: AdapterDeps): Promise<readonly CaptureToolSpec[]>`
  - `buildMcpServer(deps, includeAgentTools = true, captureTools: readonly CaptureToolSpec[] = [])`

- [ ] **Step 1: Write the failing tests.** Add to `adapter.test.ts` (in the `projectRankedItem` describe):

```ts
  test("projects the index primary key as id, and agentAuthored from meta", () => {
    const out = projectRankedItem({
      name: "Why WAL",
      service: "nimbus",
      indexedType: "capture",
      indexPrimaryKey: "nimbus:cap_1",
      rawMeta: { agentAuthored: true, captureId: "cap_1" },
    });
    expect(out).toEqual({ id: "nimbus:cap_1", name: "Why WAL", service: "nimbus", type: "capture", meta: { agentAuthored: true } });
  });
```

Create `capture-tools.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { CAPTURE_TOOL_SPECS, captureToolsFor } from "./capture-tools.ts";
import type { IpcCallable } from "./client-surface.ts";
import type { AdapterDeps } from "./tool-runtime.ts";

function deps(impl: (method: string, params: unknown) => Promise<unknown>, extra: Partial<AdapterDeps> = {}): {
  deps: AdapterDeps;
  calls: Array<[string, unknown]>;
} {
  const calls: Array<[string, unknown]> = [];
  const client: IpcCallable = {
    call: async <T>(m: string, p?: unknown) => {
      calls.push([m, p]);
      return (await impl(m, p)) as T;
    },
    disconnect: async () => {},
  };
  return { calls, deps: { getClient: async () => client, ...extra } };
}

const ENABLED = { enabled: true, kinds: ["note"], pending: 0, maxPending: 100, maxPerHour: 30, refusedSinceStart: {} };

describe("captureToolsFor", () => {
  test("enabled + note kind → capture_note registered", async () => {
    const { deps: d } = deps(async () => ENABLED);
    expect((await captureToolsFor(d)).map((s) => s.name)).toEqual(["capture_note"]);
  });

  test.each([
    ["disabled", async () => ({ ...ENABLED, enabled: false, kinds: [], disabledReason: "config" })],
    ["note not in kinds", async () => ({ ...ENABLED, kinds: [] })],
    ["an old gateway (Method not found)", async () => { throw Object.assign(new Error("Method not found"), { code: -32601 }); }],
    ["a malformed status", async () => ({ enabled: "yes" })],
  ])("%s → no capture tool", async (_n, impl) => {
    const { deps: d } = deps(impl);
    expect(await captureToolsFor(d)).toEqual([]);
  });

  test("Review Focus 3: gateway DOWN at spawn → no capture tool, and no throw", async () => {
    const d: AdapterDeps = { getClient: async () => { throw new Error("not running"); } };
    expect(await captureToolsFor(d)).toEqual([]);
  });

  test("declareKind failed (agent tools disabled) → no capture tool: the gateway cannot see us as mcp", async () => {
    const { deps: d, calls } = deps(async () => ENABLED, { agentToolsDisabledReason: () => "old gateway" });
    expect(await captureToolsFor(d)).toEqual([]);
    expect(calls).toEqual([]);
  });
});

describe("capture_note", () => {
  const spec = CAPTURE_TOOL_SPECS.find((s) => s.name === "capture_note");

  test("is annotated as a non-destructive, non-idempotent, closed-world write", () => {
    expect(spec?.annotations).toEqual({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false });
  });

  test("submits kind note with the client label and returns the stored-locally text", async () => {
    const { deps: d, calls } = deps(async () => ({ id: "cap_1", state: "live" }));
    const res = await spec?.run(d, { title: "t", body: "b", tags: ["x"] }, () => "claude-code");
    expect(calls).toEqual([["capture.submit", { kind: "note", payload: { title: "t", body: "b", tags: ["x"] }, clientLabel: "claude-code" }]]);
    expect(res?.isError).toBeUndefined();
    expect(res?.content[0]?.text).toContain("Captured note cap_1");
    expect(res?.content[0]?.text).toContain("nimbus captures revoke cap_1");
  });

  test("a gateway refusal surfaces as an isError result with the code", async () => {
    const { deps: d } = deps(async () => { throw new Error("ERR_CAPTURE_RATE_LIMITED: hourly capture cap reached"); });
    const res = await spec?.run(d, { title: "t", body: "b" }, () => undefined);
    expect(res?.isError).toBe(true);
    expect(res?.content[0]?.text).toContain("ERR_CAPTURE_RATE_LIMITED");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `bun test packages/cli/src/mcp/capture-tools.test.ts packages/cli/src/mcp/adapter.test.ts`
Expected: FAIL, module not found, and the projection lacks `id`.

- [ ] **Step 3: Implement the projection changes** in `adapter.ts`. Add `"agentAuthored",` to `META_WHITELIST`. At the top of `projectRankedItem`, after `const out = …`:

```ts
  // The index primary key: the only id `capture_note`'s relatesTo (and PR 2's evidence/link
  // endpoints) can name. Conditional, so rows without one project exactly as before.
  if (typeof r["indexPrimaryKey"] === "string") {
    out["id"] = r["indexPrimaryKey"];
  }
```

Confirm that `pickMeta` keeps booleans; it already keeps `merged`/`draft`. If it drops them, extend it to accept `boolean`.

- [ ] **Step 4: Implement `capture-tools.ts`**

```ts
import { z } from "zod";

import type { IpcCallable } from "./client-surface.ts";
import { type AdapterDeps, errorResult, runTool, type ToolResult } from "./tool-runtime.ts";

/**
 * MCP WRITE tools (spec 2026-10-11 § 6, invariant I28). Never imports adapter.ts (the agent-tools
 * rule: no runtime import cycle). Registered only when the gateway's `capture.status` says the
 * sink is enabled for the kind — see `captureToolsFor`.
 */
export interface CaptureToolSpec {
  readonly name: string;
  readonly description: string;
  readonly schema: Record<string, z.core.$ZodType>;
  readonly annotations: {
    readonly readOnlyHint: false;
    readonly destructiveHint: false;
    readonly idempotentHint: false;
    readonly openWorldHint: false;
  };
  readonly kind: "note";
  run(deps: AdapterDeps, args: Record<string, unknown>, clientLabel: () => string | undefined): Promise<ToolResult>;
}

const WRITE_ANNOTATIONS = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;

function idOf(v: unknown): string {
  const id = typeof v === "object" && v !== null ? (v as Record<string, unknown>)["id"] : undefined;
  if (typeof id !== "string") throw new Error("gateway returned no capture id");
  return id;
}

export const CAPTURE_TOOL_SPECS: readonly CaptureToolSpec[] = [
  {
    name: "capture_note",
    kind: "note",
    description:
      "Save a note into the user's LOCAL Nimbus index (stored on their machine; nothing leaves it). " +
      "The note is searchable immediately via searchIndex and is labelled agent-authored. " +
      "relatesTo takes item ids exactly as the `id` field returned by searchIndex or another read tool. " +
      "The user can revoke any note with `nimbus captures revoke <id>`.",
    // Never stricter than the gateway, which is authoritative and truncates prose itself.
    schema: {
      title: z.string(),
      body: z.string(),
      tags: z.array(z.string()).optional(),
      relatesTo: z.array(z.string()).optional(),
    },
    annotations: WRITE_ANNOTATIONS,
    run: (deps, args, clientLabel) =>
      runTool(deps, async (c: IpcCallable) => {
        const payload: Record<string, unknown> = { title: args["title"], body: args["body"] };
        if (args["tags"] !== undefined) payload["tags"] = args["tags"];
        if (args["relatesTo"] !== undefined) payload["relatesTo"] = args["relatesTo"];
        const label = clientLabel();
        const params: Record<string, unknown> = { kind: "note", payload };
        if (label !== undefined) params["clientLabel"] = label;
        const id = idOf(await c.call<unknown>("capture.submit", params));
        return {
          content: [
            {
              type: "text",
              text: `Captured note ${id}. It is stored locally, searchable now, and labelled agent-authored. The owner can revoke it with \`nimbus captures revoke ${id}\`.`,
            },
          ],
        };
      }),
  },
];

function enabledKinds(raw: unknown): readonly string[] {
  if (typeof raw !== "object" || raw === null) return [];
  const r = raw as Record<string, unknown>;
  if (r["enabled"] !== true || !Array.isArray(r["kinds"])) return [];
  return r["kinds"].filter((k): k is string => typeof k === "string");
}

/**
 * Decide which capture tools to register. Unlike `agentToolsSupported`, a gateway that is DOWN
 * yields NONE: an unreachable gateway cannot say the sink is on, and a write tool must never be
 * offered on a guess. A failed `session.declareKind` also yields none, because the gateway would
 * not see this connection as `mcp` and would refuse every submit.
 */
export async function captureToolsFor(deps: AdapterDeps): Promise<readonly CaptureToolSpec[]> {
  let client: IpcCallable;
  try {
    client = await deps.getClient();
  } catch {
    return [];
  }
  if (deps.agentToolsDisabledReason?.() !== undefined) return [];
  let kinds: readonly string[];
  try {
    kinds = enabledKinds(await client.call<unknown>("capture.status", {}));
  } catch {
    return [];
  }
  return CAPTURE_TOOL_SPECS.filter((s) => kinds.includes(s.kind));
}
```

(The import line is then `import { type AdapterDeps, runTool, type ToolResult } from "./tool-runtime.ts";`, without `errorResult`.)

- [ ] **Step 5: Register them in `adapter.ts`**

```ts
export function buildMcpServer(
  deps: AdapterDeps,
  includeAgentTools = true,
  captureTools: readonly CaptureToolSpec[] = [],
): McpServer {
  const server = new McpServer({ name: "nimbus", version: "0.1.0" });
  for (const s of includeAgentTools ? TOOL_SPECS : INDEX_TOOL_SPECS) {
    server.registerTool(
      s.name,
      { description: s.description, inputSchema: s.schema },
      (args: unknown) => s.run(deps, asRecord(args)),
    );
  }
  for (const s of captureTools) {
    server.registerTool(
      s.name,
      { description: s.description, inputSchema: s.schema, annotations: s.annotations },
      (args: unknown) => s.run(deps, asRecord(args), () => server.server.getClientVersion()?.name),
    );
  }
  return server;
}

export async function buildMcpServerForGateway(deps: AdapterDeps): Promise<McpServer> {
  const agent = await agentToolsSupported(deps);
  return buildMcpServer(deps, agent, await captureToolsFor(deps));
}
```

Import `{ type CaptureToolSpec, captureToolsFor }` from `./capture-tools.ts`. If `server.server.getClientVersion` does not exist on SDK 1.32's `McpServer`, check `node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.d.ts` for the accessor of the client's `initialize` info and use that.

Add a composition test to `adapter.coverage.test.ts`, next to the existing `connectEditor` tests (`connectEditor(server)` at :321 returns a connected SDK `Client`). The fake gateway answers `session.declareKind` with `{ kind: "mcp" }` and `capture.status` with the value under test:

```ts
  test.each([
    [{ enabled: true, kinds: ["note"], pending: 0, maxPending: 100, maxPerHour: 30, refusedSinceStart: {} }, true],
    [{ enabled: false, kinds: [], pending: 0, maxPending: 100, maxPerHour: 30, refusedSinceStart: {}, disabledReason: "config" }, false],
  ])("tools/list carries capture_note only when the sink is enabled (%#)", async (status, present) => {
    const client: IpcCallable = {
      call: async <T>(m: string): Promise<T> => (m === "capture.status" ? status : { kind: "mcp" }) as T,
      disconnect: async () => {},
    };
    const deps: AdapterDeps = { getClient: async () => client };
    const editor = await connectEditor(await buildMcpServerForGateway(deps));
    const names = (await editor.listTools()).tools.map((t) => t.name);
    expect(names.includes("capture_note")).toBe(present);
    expect(names).toContain("searchIndex");
  });
```

(Use the import names this file already has for `IpcCallable`, `AdapterDeps` and `buildMcpServerForGateway`. If `connectEditor` returns something other than an SDK `Client`, adapt `listTools()` to what it returns.)

- [ ] **Step 6: Update `formatHelp`** in `commands/mcp-server.ts`. Replace the paragraph starting `Every tool is read-only:` with:

```ts
Every tool above is read-only. One WRITE tool, capture_note, is added only when
the Gateway's [mcp_sink] is enabled in nimbus.toml: it stores an agent-authored
note in the LOCAL index, which you review with \`nimbus captures\`. The Gateway
must be running (start it with: ${gatewayStartCommand(demo)}).
```

Change the summary line to `nimbus mcp-server — expose the Nimbus local index to editor AIs over MCP (read; optional local note capture)`, keeping every line ≤ 90 characters. In `mcp-server.test.ts`, add:

```ts
  it("names the opt-in write tool and how to review it", () => {
    const help = formatHelp();
    expect(help).toContain("capture_note");
    expect(help).toContain("[mcp_sink]");
    expect(help).toContain("nimbus captures");
  });
```

- [ ] **Step 7: Run the CLI tests**

Run: `bun test packages/cli/src/mcp packages/cli/src/commands/mcp-server.test.ts`
Expected: PASS. The tool-count assertions (`adapter.test.ts:441`, `:948`, `:632`) still hold, because `TOOL_SPECS` is unchanged and capture tools are a separate list.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/cli/src/mcp packages/cli/src/commands/mcp-server.ts packages/cli/src/commands/mcp-server.test.ts
git commit -m "feat(mcp): capture_note write tool, item ids + agentAuthored in read results"
```

---

### Task 10: `nimbus captures` and the doctor lines

**Files:**
- Create: `packages/cli/src/commands/captures-format.ts`
- Create: `packages/cli/src/commands/captures.ts`
- Test: `packages/cli/src/commands/captures.test.ts`
- Modify: `packages/cli/src/commands/index.ts` (export `runCapturesCmd`), `packages/cli/src/index.ts` (`captures: runCapturesCmd` in `COMMAND_HANDLERS`), `packages/cli/src/commands/registry.ts` (add `"captures"` in alphabetical position), `packages/cli/src/commands/help.ts` (a line under CONFIG & DIAGNOSTICS, beside notifications)
- Modify: `packages/cli/src/commands/doctor-core.ts` (`doctorPrintCaptures` called after `doctorPrintNotifications` at about :830); test in `captures.test.ts`

**Interfaces:**
- Consumes: `IPCClient`, `withGatewayIpc`, `CliExit`, `getCliPlatformPaths`. Gateway `captures.list|get|revoke`, `capture.status` (Task 7).
- Produces:
  - `parseCapturesArgs(argv: string[]): CapturesArgs | undefined`
  - `runCapturesWith(c: Pick<IPCClient, "call">, a: CapturesArgs, sink: { out(s: string): void; err(s: string): void }): Promise<number>`
  - `runCapturesCmd(argv: string[]): Promise<void>`
  - `stripControl(s: string): string`
  - `formatCaptureTable(rows: CaptureSummaryView[], now: number): string`
  - `formatCaptureDetail(d: CaptureDetailView): string`
  - `doctorCapturesLines(s: CaptureStatusView): { lines: string[]; exit: number }`
  - `doctorPrintCaptures(client): Promise<number>`

- [ ] **Step 1: Write the failing test** — `captures.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { doctorPrintCaptures } from "./doctor-core.ts";
import { doctorCapturesLines, formatCaptureTable, stripControl } from "./captures-format.ts";
import { parseCapturesArgs, runCapturesWith } from "./captures.ts";

const ROW = {
  id: "cap_1",
  kind: "note",
  state: "live",
  title: "Why WAL",
  clientLabel: "claude-code",
  createdAt: 1_000,
  decidedAt: null,
};

function fake(impl: (m: string, p: unknown) => unknown) {
  const calls: Array<[string, unknown]> = [];
  return {
    calls,
    client: {
      call: async <T>(m: string, p?: unknown): Promise<T> => {
        calls.push([m, p]);
        return impl(m, p) as T;
      },
    },
  };
}

function sink() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, s: { out: (x: string) => out.push(x), err: (x: string) => err.push(x) } };
}

describe("parseCapturesArgs", () => {
  test.each([
    [[], { verb: "list", json: false }],
    [["list", "--state", "revoked", "--kind", "note", "--json"], { verb: "list", state: "revoked", kind: "note", json: true }],
    [["show", "cap_1"], { verb: "show", id: "cap_1", json: false }],
    [["revoke", "cap_1"], { verb: "revoke", id: "cap_1", json: false }],
  ])("%j", (argv, want) => {
    expect(parseCapturesArgs(argv)).toEqual(want);
  });

  test.each([[["show"]], [["revoke"]], [["accept", "cap_1"]], [["list", "--state"]], [["list", "--bogus"]]])(
    "usage error: %j",
    (argv) => {
      expect(parseCapturesArgs(argv)).toBeUndefined();
    },
  );
});

describe("runCapturesWith", () => {
  test("list prints a table and exits 0", async () => {
    const { client, calls } = fake(() => ({ captures: [ROW] }));
    const { out, s } = sink();
    expect(await runCapturesWith(client, { verb: "list", json: false }, s)).toBe(0);
    expect(calls).toEqual([["captures.list", {}]]);
    expect(out.join("")).toContain("cap_1");
    expect(out.join("")).toContain("Why WAL");
  });

  test("Review Focus 1: control characters in agent-supplied strings never reach the terminal", async () => {
    const evil = { ...ROW, title: "x\u001b[2J\u001b]0;pwned\u0007y", clientLabel: "c\u001b[31m" };
    const { client } = fake(() => ({ captures: [evil] }));
    const { out, s } = sink();
    await runCapturesWith(client, { verb: "list", json: false }, s);
    expect(out.join("")).not.toMatch(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/);
  });

  test("revoke prints confirmation; a refusal prints the code and exits 1", async () => {
    const ok = fake(() => ({ id: "cap_1", state: "revoked" }));
    const a = sink();
    expect(await runCapturesWith(ok.client, { verb: "revoke", id: "cap_1", json: false }, a.s)).toBe(0);
    expect(a.out.join("")).toContain("Revoked cap_1");
    const bad = fake(() => {
      throw new Error("ERR_CAPTURE_NOT_FOUND: no capture cap_9");
    });
    const b = sink();
    expect(await runCapturesWith(bad.client, { verb: "revoke", id: "cap_9", json: false }, b.s)).toBe(1);
    expect(b.err.join("")).toContain("ERR_CAPTURE_NOT_FOUND");
  });

  test("--json prints raw JSON, and an error as {error}", async () => {
    const { client } = fake(() => ({ captures: [ROW] }));
    const { out, s } = sink();
    await runCapturesWith(client, { verb: "list", json: true }, s);
    expect(JSON.parse(out.join(""))).toEqual({ captures: [ROW] });
    const bad = fake(() => {
      throw new Error("ERR_CAPTURE_STATE: x");
    });
    const b = sink();
    expect(await runCapturesWith(bad.client, { verb: "show", id: "cap_1", json: true }, b.s)).toBe(1);
    expect(JSON.parse(b.out.join(""))).toEqual({ error: "ERR_CAPTURE_STATE: x" });
  });

  test("show prints the agent-authored banner and the payload", async () => {
    const { client } = fake(() => ({ ...ROW, payload: { title: "Why WAL", body: "Because" }, payloadBytes: 9, itemId: "nimbus:cap_1", nativeRef: null }));
    const { out, s } = sink();
    await runCapturesWith(client, { verb: "show", id: "cap_1", json: false }, s);
    expect(out.join("")).toContain("Agent-authored");
    expect(out.join("")).toContain("Because");
  });
});

describe("doctor", () => {
  const BASE = { enabled: true, kinds: ["note"], pending: 0, maxPending: 100, maxPerHour: 30, refusedSinceStart: {} };

  test("disabled → nothing printed, exit 0", () => {
    expect(doctorCapturesLines({ ...BASE, enabled: false, disabledReason: "config" })).toEqual({ lines: [], exit: 0 });
  });

  test("enabled quiet → one ok line", () => {
    expect(doctorCapturesLines(BASE).lines).toEqual(["[ok] MCP capture sink: on (kinds: note). Review with `nimbus captures`."]);
  });

  test("queue full → warning, exit 1", () => {
    const r = doctorCapturesLines({ ...BASE, pending: 100 });
    expect(r.exit).toBe(1);
    expect(r.lines.join("\n")).toContain("capture queue full (100/100)");
  });

  test("refusals since start → warning naming codes and counts", () => {
    const r = doctorCapturesLines({ ...BASE, refusedSinceStart: { ERR_CAPTURE_RATE_LIMITED: 4 } });
    expect(r.exit).toBe(1);
    expect(r.lines.join("\n")).toContain("ERR_CAPTURE_RATE_LIMITED×4");
  });

  test("config_error → warning, exit 1", () => {
    const r = doctorCapturesLines({ ...BASE, enabled: false, disabledReason: "config_error" });
    expect(r.exit).toBe(1);
    expect(r.lines[0]).toContain("[mcp_sink] is invalid");
  });

  test("doctorPrintCaptures: Method not found is quiet", async () => {
    const { client } = fake(() => {
      throw Object.assign(new Error("nope"), { code: -32601 });
    });
    expect(await doctorPrintCaptures(client)).toBe(0);
  });
});

describe("stripControl / formatCaptureTable", () => {
  test("strip keeps printable text", () => {
    expect(stripControl("a\u001bb\nc")).toBe("abc");
  });

  test("table has a header row", () => {
    expect(formatCaptureTable([], 0)).toContain("ID");
  });
});
```

(Test with no `beforeEach`/`afterEach` stdout swapping: the sink is injected. Remove the unused imports if lint complains.)

- [ ] **Step 2: Run it to verify it fails**

Run: `bun test packages/cli/src/commands/captures.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `captures-format.ts`**

```ts
/** Wire-shape parsing + rendering for `nimbus captures`. Every agent-supplied string is stripped. */

export interface CaptureSummaryView {
  id: string;
  kind: string;
  state: string;
  title: string;
  clientLabel: string | null;
  createdAt: number;
  decidedAt: number | null;
}

export interface CaptureDetailView extends CaptureSummaryView {
  payload: unknown;
  payloadBytes: number;
  itemId: string | null;
  nativeRef: string | null;
}

export interface CaptureStatusView {
  enabled: boolean;
  kinds: string[];
  pending: number;
  maxPending: number;
  maxPerHour: number;
  refusedSinceStart: Record<string, number>;
  disabledReason?: string;
}

// Keep \t and \n only where WE put them; strip everything else in C0/DEL/C1 from agent text.
const CONTROL_RE = /[\u0000-\u001f\u007f-\u009f]/g;

export function stripControl(s: string): string {
  return s.replace(CONTROL_RE, "");
}

function rec(v: unknown, what: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`malformed ${what}`);
  return v as Record<string, unknown>;
}

function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== "string") throw new Error(`malformed field ${k}`);
  return v;
}

function num(r: Record<string, unknown>, k: string): number {
  const v = r[k];
  if (typeof v !== "number") throw new Error(`malformed field ${k}`);
  return v;
}

export function parseSummary(v: unknown): CaptureSummaryView {
  const r = rec(v, "capture");
  const label = r["clientLabel"];
  const decided = r["decidedAt"];
  return {
    id: str(r, "id"),
    kind: str(r, "kind"),
    state: str(r, "state"),
    title: str(r, "title"),
    clientLabel: typeof label === "string" ? label : null,
    createdAt: num(r, "createdAt"),
    decidedAt: typeof decided === "number" ? decided : null,
  };
}

export function parseList(v: unknown): CaptureSummaryView[] {
  const caps = rec(v, "captures.list result")["captures"];
  if (!Array.isArray(caps)) throw new Error("malformed captures.list result");
  return caps.map(parseSummary);
}

export function parseDetail(v: unknown): CaptureDetailView {
  const r = rec(v, "captures.get result");
  const item = r["itemId"];
  const native = r["nativeRef"];
  return {
    ...parseSummary(v),
    payload: r["payload"] ?? null,
    payloadBytes: num(r, "payloadBytes"),
    itemId: typeof item === "string" ? item : null,
    nativeRef: typeof native === "string" ? native : null,
  };
}

export function parseStatus(v: unknown): CaptureStatusView {
  const r = rec(v, "capture.status result");
  const kinds = r["kinds"];
  const refused = r["refusedSinceStart"];
  const reason = r["disabledReason"];
  const out: CaptureStatusView = {
    enabled: r["enabled"] === true,
    kinds: Array.isArray(kinds) ? kinds.filter((k): k is string => typeof k === "string") : [],
    pending: num(r, "pending"),
    maxPending: num(r, "maxPending"),
    maxPerHour: num(r, "maxPerHour"),
    refusedSinceStart: {},
  };
  if (typeof refused === "object" && refused !== null) {
    for (const [k, n] of Object.entries(refused)) if (typeof n === "number") out.refusedSinceStart[k] = n;
  }
  if (typeof reason === "string") out.disabledReason = reason;
  return out;
}

function ago(ms: number, now: number): string {
  const s = Math.max(0, Math.round((now - ms) / 1000));
  if (s < 60) return `${String(s)}s ago`;
  if (s < 3600) return `${String(Math.round(s / 60))}m ago`;
  if (s < 86_400) return `${String(Math.round(s / 3600))}h ago`;
  return `${String(Math.round(s / 86_400))}d ago`;
}

function cell(s: string, w: number): string {
  const t = s.length > w ? `${s.slice(0, w - 1)}…` : s;
  return t.padEnd(w);
}

export function formatCaptureTable(rows: CaptureSummaryView[], now: number): string {
  const head = `${cell("ID", 42)} ${cell("KIND", 8)} ${cell("STATE", 9)} ${cell("SUBMITTED", 10)} ${cell("CLIENT", 14)} PREVIEW`;
  const lines = rows.map(
    (r) =>
      `${cell(r.id, 42)} ${cell(r.kind, 8)} ${cell(r.state, 9)} ${cell(ago(r.createdAt, now), 10)} ${cell(stripControl(r.clientLabel ?? "-"), 14)} ${stripControl(r.title).slice(0, 60)}`,
  );
  return `${[head, ...lines].join("\n")}\n${rows.length === 0 ? "(no captures)\n" : ""}`;
}

export function formatCaptureDetail(d: CaptureDetailView): string {
  const lines = [
    `${d.id}  ${d.kind}  ${d.state}`,
    `Agent-authored — submitted by ${stripControl(d.clientLabel ?? "an unnamed MCP client")} at ${new Date(d.createdAt).toISOString()}.`,
  ];
  if (d.decidedAt !== null) lines.push(`Decided: ${new Date(d.decidedAt).toISOString()}`);
  if (d.itemId !== null) lines.push(`Item: ${d.itemId}`);
  lines.push("");
  if (d.payload === null) {
    lines.push("(payload cleared on revoke)");
  } else {
    const p = d.payload as Record<string, unknown>;
    for (const [k, v] of Object.entries(p)) {
      const text = typeof v === "string" ? v : JSON.stringify(v);
      lines.push(`${k}: ${stripControl(text)}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

export function doctorCapturesLines(s: CaptureStatusView): { lines: string[]; exit: number } {
  if (!s.enabled) {
    if (s.disabledReason === "config_error") {
      return { lines: ["[warn] MCP capture sink: [mcp_sink] is invalid in nimbus.toml; the sink is OFF (see the gateway log)."], exit: 1 };
    }
    return { lines: [], exit: 0 };
  }
  const lines: string[] = [];
  let exit = 0;
  if (s.pending >= s.maxPending) {
    lines.push(`[warn] MCP capture sink: capture queue full (${String(s.pending)}/${String(s.maxPending)}): new proposals are being refused — nimbus captures`);
    exit = 1;
  } else if (s.pending > 0) {
    lines.push(`[info] MCP capture sink: ${String(s.pending)} captures awaiting review — nimbus captures`);
  }
  const refused = Object.entries(s.refusedSinceStart);
  if (refused.length > 0) {
    lines.push(`[warn] MCP capture sink: refused since gateway start: ${refused.map(([k, n]) => `${k}×${String(n)}`).join(", ")}`);
    exit = 1;
  }
  if (lines.length === 0) {
    lines.push(`[ok] MCP capture sink: on (kinds: ${s.kinds.join(", ")}). Review with \`nimbus captures\`.`);
  }
  return { lines, exit };
}
```

- [ ] **Step 4: Implement `captures.ts`**

```ts
import type { IPCClient } from "../ipc-client.ts";
import { CliExit } from "../lib/cli-exit.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";
import { formatCaptureDetail, formatCaptureTable, parseDetail, parseList } from "./captures-format.ts";

export const CAPTURES_USAGE =
  "usage: nimbus captures [list] [--state live|proposed|accepted|rejected|revoked] [--kind note|decision|term|link] [--json]\n" +
  "       nimbus captures show <id> [--json]\n" +
  "       nimbus captures revoke <id> [--json]";

export type CapturesArgs =
  | { verb: "list"; state?: string; kind?: string; json: boolean }
  | { verb: "show" | "revoke"; id: string; json: boolean };

export function parseCapturesArgs(argv: string[]): CapturesArgs | undefined {
  const json = argv.includes("--json");
  const rest = argv.filter((a) => a !== "--json");
  const verb = rest[0] ?? "list";
  if (verb === "show" || verb === "revoke") {
    const id = rest[1];
    if (id === undefined || id.startsWith("--") || rest.length !== 2) return undefined;
    return { verb, id, json };
  }
  if (verb !== "list" && !verb.startsWith("--")) return undefined;
  const flags = verb === "list" ? rest.slice(1) : rest;
  const out: { verb: "list"; state?: string; kind?: string; json: boolean } = { verb: "list", json };
  for (let i = 0; i < flags.length; i += 2) {
    const k = flags[i];
    const v = flags[i + 1];
    if (v === undefined || v.startsWith("--")) return undefined;
    if (k === "--state") out.state = v;
    else if (k === "--kind") out.kind = v;
    else return undefined;
  }
  return out;
}

type Sink = { out(s: string): void; err(s: string): void };

export async function runCapturesWith(c: Pick<IPCClient, "call">, a: CapturesArgs, sink: Sink): Promise<number> {
  try {
    if (a.verb === "list") {
      const params: Record<string, unknown> = {};
      if (a.state !== undefined) params["state"] = a.state;
      if (a.kind !== undefined) params["kind"] = a.kind;
      const raw = await c.call<unknown>("captures.list", params);
      sink.out(a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : formatCaptureTable(parseList(raw), Date.now()));
      return 0;
    }
    if (a.verb === "show") {
      const raw = await c.call<unknown>("captures.get", { id: a.id });
      sink.out(a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : formatCaptureDetail(parseDetail(raw)));
      return 0;
    }
    const raw = await c.call<unknown>("captures.revoke", { id: a.id });
    sink.out(a.json ? `${JSON.stringify(raw, undefined, 2)}\n` : `Revoked ${a.id}: its item and embeddings are deleted; the record keeps no payload.\n`);
    return 0;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (a.json) sink.out(`${JSON.stringify({ error: msg })}\n`);
    else sink.err(`${msg}\n`);
    return 1;
  }
}

export async function runCapturesCmd(argv: string[]): Promise<void> {
  const a = parseCapturesArgs(argv);
  if (a === undefined) {
    process.stderr.write(`${CAPTURES_USAGE}\n`);
    throw new CliExit(2);
  }
  const paths = getCliPlatformPaths();
  const code = await withGatewayIpc(
    (c) => runCapturesWith(c, a, { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }),
    paths,
  );
  if (code !== 0) throw new CliExit(code);
}
```

Check the import path of `IPCClient` against `notifications.ts`, and copy whatever it uses. `oncall-pushed.ts` shows the `withGatewayIpc` + `CliExit` shape used here.

- [ ] **Step 5: Add the doctor hook** in `doctor-core.ts`, next to `doctorPrintNotifications`:

```ts
export async function doctorPrintCaptures(client: Pick<IPCClient, "call">): Promise<number> {
  let raw: unknown;
  try {
    raw = await client.call<unknown>("capture.status", {});
  } catch (e) {
    if (isMethodNotFound(e)) return 0;
    console.log(`[warn] MCP capture sink: status check failed (${e instanceof Error ? e.message : String(e)}).`);
    return 1;
  }
  try {
    const { lines, exit } = doctorCapturesLines(parseStatus(raw));
    for (const l of lines) console.log(l);
    return exit;
  } catch (e) {
    console.log(`[warn] MCP capture sink: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }
}
```

In `doctorRunGatewayRpcs`, after the notifications line, add `exit = Math.max(exit, await doctorPrintCaptures(client));`. Import `doctorCapturesLines` and `parseStatus` from `./captures-format.ts`.

- [ ] **Step 6: Register the command.** Add `export { runCapturesCmd } from "./captures.ts";` to `commands/index.ts`, `captures: runCapturesCmd,` to `COMMAND_HANDLERS` in `src/index.ts`, and `"captures",` to `COMMAND_NAMES` in alphabetical position. In `help.ts`, beside the notifications line:

```
  captures [list|show|revoke]   Review notes MCP clients captured into the local index
```

(Match the column alignment of the neighbouring lines exactly.)

- [ ] **Step 7: Run the CLI tests**

Run: `bun test packages/cli/src/commands`
Expected: PASS, including `help.test.ts`'s COMMAND_NAMES-vs-help guard and `tool-runtime.test.ts`'s command-name check.

- [ ] **Step 8: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/cli/src
git commit -m "feat(cli): nimbus captures list|show|revoke + doctor capture-sink lines"
```

---

### Task 11: End-to-end — a real gateway, a real `nimbus mcp-server`, over stdio

**Files:**
- Create: `packages/gateway/test/e2e/mcp-capture.e2e.test.ts`

**Interfaces:**
- Consumes: `packages/gateway/test/e2e/_fixtures/gateway-runner.ts` (boots a real gateway from `NIMBUS_E2E_PATHS_JSON` and logs `[gateway] ready (e2e)`); the CLI entry `packages/cli/src/index.ts`.

**Why this shape:** no existing test drives `nimbus mcp-server` over real stdio, and the gateway package does not depend on the MCP SDK. The MCP stdio transport is newline-delimited JSON-RPC 2.0, so the test speaks it directly. The MCP server finds the gateway through `<dataDir>/gateway.json` (`packages/cli/src/lib/gateway-process.ts:38`). The test points the CLI's per-OS data dir at a temp root, using the env sandbox `packages/cli/test/e2e/demo-flag.e2e.test.ts:22-52` uses, and writes that file itself.

- [ ] **Step 1: Write the test**

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { Subprocess } from "bun";

const RUNNER = join(import.meta.dir, "_fixtures", "gateway-runner.ts");
const REPO = resolve(import.meta.dir, "..", "..", "..", "..");
const CLI_ENTRY = join(REPO, "packages", "cli", "src", "index.ts");

const root = mkdtempSync(join(tmpdir(), "nimbus-mcp-capture-"));
const dirs = {
  roaming: join(root, "r"),
  local: join(root, "l"),
  home: join(root, "h"),
  xdgConfig: join(root, "c"),
  xdgData: join(root, "d"),
  run: join(root, "u"),
  tmp: join(root, "t"),
};
for (const d of Object.values(dirs)) mkdirSync(d, { recursive: true });

/** The data dir the CLI resolves under this env (mirrors packages/cli/src/paths.ts). */
function cliDataDir(): string {
  if (process.platform === "win32") return join(dirs.local, "Nimbus", "data");
  if (process.platform === "darwin") return join(dirs.home, "Library", "Application Support", "Nimbus");
  return join(dirs.xdgData, "nimbus");
}

function cliEnv(): Record<string, string> {
  const env: Record<string, string> = { ...(process.env as Record<string, string>) };
  for (const k of ["NIMBUS_DEMO", "NIMBUS_CONFIG_DIR", "NIMBUS_GATEWAY_SOCKET", "NIMBUS_PROFILE"]) delete env[k];
  return {
    ...env,
    APPDATA: dirs.roaming,
    LOCALAPPDATA: dirs.local,
    HOME: dirs.home,
    USERPROFILE: dirs.home,
    XDG_CONFIG_HOME: dirs.xdgConfig,
    XDG_DATA_HOME: dirs.xdgData,
    XDG_RUNTIME_DIR: dirs.run,
    TMPDIR: dirs.tmp,
    TEMP: dirs.tmp,
    TMP: dirs.tmp,
  };
}

const gw = {
  configDir: join(root, "gw-config"),
  dataDir: join(root, "gw-data"),
  logDir: join(root, "gw-log"),
  extensionsDir: join(root, "gw-ext"),
  tempDir: join(root, "gw-tmp"),
  sandboxDir: join(root, "gw-sandbox"),
  socketPath:
    process.platform === "win32"
      ? `\\\\.\\pipe\\nimbus-capture-${String(process.pid)}-${randomUUID().slice(0, 8)}`
      : join(root, "gw.sock"),
};
for (const d of [gw.configDir, gw.dataDir, gw.logDir, gw.extensionsDir, gw.tempDir, gw.sandboxDir]) {
  mkdirSync(d, { recursive: true });
}

let gateway: Subprocess<"ignore", "pipe", "pipe"> | undefined;
let gatewayLog = "";

async function until<T>(probe: () => T | undefined, what: string, ms: number): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = probe();
    if (v !== undefined) return v;
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${what}\n--- gateway log ---\n${gatewayLog}`);
}

async function bootGateway(enabled: boolean): Promise<void> {
  writeFileSync(
    join(gw.configDir, "nimbus.toml"),
    ["[mcp_sink]", `enabled = ${String(enabled)}`, 'kinds = ["note"]', "max_per_hour = 30"].join("\n"),
  );
  gatewayLog = "";
  gateway = Bun.spawn(["bun", RUNNER], {
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...(process.env as Record<string, string>),
      NIMBUS_E2E_PATHS_JSON: JSON.stringify(gw),
      NIMBUS_SKIP_EMBEDDING_RUNTIME: "1",
      NIMBUS_NOTIFICATIONS: "off",
    },
  });
  for (const stream of [gateway.stdout, gateway.stderr]) {
    void (async () => {
      for await (const chunk of stream) gatewayLog += new TextDecoder().decode(chunk);
    })();
  }
  await until(() => (gatewayLog.includes("[gateway] ready (e2e)") ? true : undefined), "gateway ready", 60_000);
  mkdirSync(cliDataDir(), { recursive: true });
  writeFileSync(join(cliDataDir(), "gateway.json"), JSON.stringify({ pid: gateway.pid, socketPath: gw.socketPath }));
}

async function stopGateway(): Promise<void> {
  gateway?.kill();
  await gateway?.exited;
  gateway = undefined;
}

/** A minimal MCP stdio client: newline-delimited JSON-RPC 2.0. */
class StdioMcp {
  private readonly proc = Bun.spawn(["bun", CLI_ENTRY, "mcp-server", "--stdio"], {
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    env: cliEnv(),
  });
  private buf = "";
  private nextId = 1;
  private readonly pending = new Map<number, (msg: Record<string, unknown>) => void>();

  constructor() {
    void (async () => {
      for await (const chunk of this.proc.stdout) {
        this.buf += new TextDecoder().decode(chunk);
        let nl = this.buf.indexOf("\n");
        while (nl >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (line !== "") {
            const msg = JSON.parse(line) as Record<string, unknown>;
            const id = msg["id"];
            if (typeof id === "number") this.pending.get(id)?.(msg);
          }
          nl = this.buf.indexOf("\n");
        }
      }
    })();
  }

  private send(msg: Record<string, unknown>): void {
    this.proc.stdin.write(`${JSON.stringify(msg)}\n`);
    this.proc.stdin.flush();
  }

  async request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const id = this.nextId++;
    const reply = new Promise<Record<string, unknown>>((res) => this.pending.set(id, res));
    this.send({ jsonrpc: "2.0", id, method, params });
    const msg = await Promise.race([
      reply,
      Bun.sleep(30_000).then(() => {
        throw new Error(`MCP ${method} timed out`);
      }),
    ]);
    if (msg["error"] !== undefined) throw new Error(JSON.stringify(msg["error"]));
    return msg["result"] as Record<string, unknown>;
  }

  async initialize(): Promise<void> {
    await this.request("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "e2e-editor", version: "1.0.0" },
    });
    this.send({ jsonrpc: "2.0", method: "notifications/initialized" });
  }

  async toolNames(): Promise<string[]> {
    const r = await this.request("tools/list");
    return (r["tools"] as Array<{ name: string }>).map((t) => t.name);
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<{ text: string; isError: boolean }> {
    const r = await this.request("tools/call", { name, arguments: args });
    const content = r["content"] as Array<{ text: string }>;
    return { text: content[0]?.text ?? "", isError: r["isError"] === true };
  }

  async close(): Promise<void> {
    this.proc.kill();
    await this.proc.exited;
  }
}

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bun", CLI_ENTRY, ...args], { stdout: "pipe", stderr: "pipe", stdin: "ignore", env: cliEnv() });
  const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
  return { code, stdout, stderr };
}

afterAll(async () => {
  await stopGateway();
  try {
    rmSync(root, { recursive: true, force: true });
  } catch {
    // Windows may hold the pipe briefly; the OS temp sweep collects it.
  }
});

describe("MCP capture sink — end to end", () => {
  beforeAll(async () => {
    await bootGateway(true);
  }, 180_000);

  test("capture_note → searchable via searchIndex → listed → revoked → gone", async () => {
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      expect(await mcp.toolNames()).toContain("capture_note");

      const marker = `zebracapture${randomUUID().slice(0, 6)}`;
      const cap = await mcp.callTool("capture_note", { title: `Decision ${marker}`, body: `We chose WAL. ${marker}` });
      expect(cap.isError).toBe(false);
      const id = /Captured note (cap_[0-9a-f-]+)/.exec(cap.text)?.[1];
      expect(id).toBeDefined();

      const found = await mcp.callTool("searchIndex", { query: marker });
      expect(found.text).toContain(`nimbus:${String(id)}`);
      expect(found.text).toContain('"agentAuthored": true');

      const listed = await runCli(["captures", "list", "--json"]);
      expect(listed.code).toBe(0);
      expect(listed.stdout).toContain(String(id));
      expect(listed.stdout).toContain("e2e-editor");

      const revoked = await runCli(["captures", "revoke", String(id)]);
      expect(revoked.code).toBe(0);

      const after = await mcp.callTool("searchIndex", { query: marker });
      expect(after.text).not.toContain(`nimbus:${String(id)}`);
    } finally {
      await mcp.close();
    }
  }, 120_000);

  test("an MCP connection cannot reach the owner methods (no tool, and the gateway refuses)", async () => {
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      const names = await mcp.toolNames();
      expect(names.some((n) => /revoke|accept|reject/i.test(n))).toBe(false);
    } finally {
      await mcp.close();
    }
  }, 60_000);

  test("sink OFF → capture_note is absent from tools/list", async () => {
    await stopGateway();
    await bootGateway(false);
    const mcp = new StdioMcp();
    try {
      await mcp.initialize();
      const names = await mcp.toolNames();
      expect(names).not.toContain("capture_note");
      expect(names).toContain("searchIndex");
    } finally {
      await mcp.close();
    }
  }, 180_000);
});
```

- [ ] **Step 2: Run it**

Run: `bun test packages/gateway/test/e2e/mcp-capture.e2e.test.ts`
Expected: PASS. If `searchIndex` cannot find the marker:
- Confirm that FTS covers `item.body`. The `item_fts` triggers are in `body-store-v48-sql.ts`.
- Confirm that the tool's projection returns `id`; that's Task 9.

If the CLI cannot find the gateway, check the error in `stderr`. The usual cause is `cliDataDir()` not matching `packages/cli/src/paths.ts` on this OS.

- [ ] **Step 3: Run it on the other OS families too**

Run: `bun run verify:docker -- --changed`. That covers Linux. macOS is covered by the PR's macOS leg.
Expected: PASS. This test spawns a gateway, so it belongs in the E2E tree, where Linux has D-Bus.

- [ ] **Step 4: Commit**

```bash
git rev-parse --abbrev-ref HEAD
git add packages/gateway/test/e2e/mcp-capture.e2e.test.ts
git commit -m "test(e2e): capture_note over real stdio MCP against a real gateway"
```

---

### Task 12: Docs, final gates, PR

**Files:**
- Modify: `docs/cli-reference.md` (rewrite `### nimbus mcp-server` at :1482-1517, which is already stale: it says seventeen tools and is missing five. Add `### nimbus captures`.)
- Modify: `docs/architecture.md` (new `## Spine S3 Subsystems` → `### MCP capture sink`, plus the IPC catalogue rows for the five methods)
- Modify: `docs/CHANGELOG.md` (dated entry)
- Modify: `docs/roadmap.md` (S3 row at :1261: record the lean scope, with PR 1 shipped, PR 2 next and PR 3 own spec; the § Active "Next slot" paragraph at :1241)
- Modify: `docs/README.md:65` (tool wording: 21 read-only tools plus the opt-in `capture_note`)
- Modify: `CLAUDE.md` / `GEMINI.md` status paragraph (one sentence for S3 PR 1, in the same register as the surrounding text)

- [ ] **Step 1: Write the docs.** Write `cli-reference.md` from the code, not from this plan. List the tools from `TOOL_SPECS` and `CAPTURE_TOOL_SPECS`, and the `nimbus captures` flags from `CAPTURES_USAGE`. The CHANGELOG entry must state what did NOT ship:
  - proposals (decision/term/link): PR 2
  - the act door: PR 3, which has its own spec
  - no desktop UI
  - `data.delete` does not clear `capture` rows
  - the macOS live run is unverified, if that is true at the time

- [ ] **Step 2: Run the doc gates**

Run: `bun run audit:doc-refs && bun run audit:status-drift`
Expected: exit 0.

- [ ] **Step 3: Full local gate**

Run: `bun run preflight:fast`, then `bun test packages/gateway packages/cli scripts --path-ignore-patterns='**/install-remote-windows.test.ts'`
Expected: all green. Fix every failure before going on. For a coverage-floor miss on any new file, add branch tests; never exclude.

- [ ] **Step 4: Strip the spec and the plan, then push.** They never land on `main`.

```bash
git switch -c dev/asaf/s3-mcp-capture-sink-pr1
git rm -r --cached docs/superpowers
git commit -m "chore: drop the working spec and plan from the PR branch"
git push -u origin dev/asaf/s3-mcp-capture-sink-pr1
```

(The working branch `dev/asaf/s3-mcp-capture-sink` keeps both documents for PR 2.)

- [ ] **Step 5: Open the PR.** Title: `feat(mcp): capture sink — agent notes over MCP (S3, I28)`. The body explains the I28 order, D32, the default-off config, what is NOT in this PR, and the test layers. End it with the Claude Code attribution line. Do not merge; merging is the owner's call. Then watch the required checks and fix any that go red.
