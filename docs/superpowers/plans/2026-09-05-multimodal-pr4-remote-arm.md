# S2 Multimodal PR 4 — The Remote Arm Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a user send specific, individually-granted image artifacts to a frontier vision model, and nothing else — every ungranted artifact keeps captioning locally exactly as it does today.

**Architecture:** A durable `media_grant` table (V59) records per-(artifact, modality, vendor) consent written by a deliberate CLI act, never by a prompt inside the pass. `media-gate.ts` gains a remote ARM: it resolves local-vs-remote per CANDIDATE (not per modality, which is what the current seam supports) by asking a grant store, and refuses rather than degrading in both directions. Remote `VlmProvider` adapters are constructed at exactly one wiring site, wrapped by the already-shipped `wrapLedgeredVlm`, and confined there by a new static rule D27.

**Tech Stack:** Bun v1.2+ / TypeScript strict, `bun:sqlite`, Biome, `bun test`. No new runtime dependencies — the remote adapters are `fetch` against vendor HTTP APIs, mirroring `llm/anthropic-provider.ts` and `multimodal/vlm/ollama-vlm.ts`.

**Spec:** [`docs/superpowers/specs/2026-09-02-s2-multimodal-io-design.md`](../specs/2026-09-02-s2-multimodal-io-design.md) — §§ 18 and 19 are binding. § 19 overrides § 18 wherever they disagree (§ 19 is the review disposition and is later). § 20 records the PR 3 acceptance run and is background, not requirements.

## Global Constraints

Copied verbatim from the spec and `CLAUDE.md`. Every task's requirements implicitly include this section.

- **No `any`** — use `unknown` for external data; TypeScript strict is non-negotiable (Non-Negotiable #7).
- **No plaintext credentials** — Vault only, never environment, never logs/IPC/config (Non-Negotiable #3). Vendor keys come from `llm/vendor-vault-keys.ts`'s `VENDOR_API_KEY_NAMES`; do not mint a second key surface (§ 18.2).
- **SQLite writes go through `dbRun`/`dbExec`/`dbStmtRun`** — invariant I14, static rule D12. A bare `.run()` fails the structure audit before the tests run.
- **Bound-param SQL only** — invariant I9. Identifiers via `escapeIdentifier`.
- **A grant is a PERMISSION, not a mandate** (§ 19.3): a grant with no configured remote arm resolves as if no grant existed — use the local VLM. Consent must never remove a capability the user already had.
- **Never silently degrade to local on remote failure** (§ 19.3, last row): a remote failure is terminal for that artifact.
- **Never degrade to remote**: absent a grant the gate refuses (I37).
- **Locality is DERIVED from `provider.isLocal`** (I34), never supplied by a caller.
- **The pass never prompts** (§ 18.4): granting is a separate CLI act. No consent broker.
- **Images only** (§ 18, § 19.4): `understanderFor("av")` resolves the all-local composite unconditionally; the grant store REFUSES to write a `modality = 'av'` row in this PR.
- **`UNDERSTANDING_VERSION` stays at `2`.** Do not bump it. § 17 declined a bump because it re-runs `whisper-cli` over an entire library; § 19.1's discovery predicate exists precisely so a bump is unnecessary.
- **Absent is not zero.** Use conditional spread for optional counts and fields, matching `media-gate.ts`.
- **Wiring + docs + test land in the SAME commit** for any invariant or static rule — the triple rule. Retiring means deleting the row, never leaving drift.
- **Run `bun run preflight:fast` before declaring any task done.** If logic or tests changed, also run the scoped suite (`bun test packages/gateway/src/multimodal packages/gateway/src/egress`).

## Sequencing note — the substrate is droppable-safe

Tasks 1–9 build the grant substrate and the gate's remote arm **without any remote provider existing**. At the end of Task 9 the feature is INERT in production: `understanderFor` can never return a non-local provider because none is constructed, so the gate's remote path is unreachable and every artifact still captions locally. Tasks 10–12 add the adapters and the confinement rule that makes the path reachable. This mirrors § 3.3 — the gate shipped in PR 1 before the thing it gates — and means a reviewer can stop after Task 9 with a coherent, shippable tree.

## File Structure

**Created:**

- `packages/gateway/src/index/media-grant-v59-sql.ts` — the V59 table + partial unique index, SQL only. Mirrors `media-pass-v58-sql.ts`.
- `packages/gateway/src/index/migrations/runner-v59.test.ts` — proves the 58→59 STEP is registered.
- `packages/gateway/src/multimodal/media-grant-store.ts` — the ONLY module that names `media_grant`. `createGrant` / `revokeGrant` / `listActiveGrants` / `hasActiveGrant` / `revokeOrphanedGrants`.
- `packages/gateway/src/multimodal/media-grant-store.test.ts`
- `packages/gateway/src/multimodal/vlm/image-mime.ts` — magic-byte sniffer, pure, no I/O.
- `packages/gateway/src/multimodal/vlm/image-mime.test.ts`
- `packages/gateway/src/multimodal/vlm/remote/remote-vlm-shared.ts` — ONE factory, `createRemoteVlm`, dispatching on vendor internally. Deliberately not three per-vendor files: they would each hold one `case` of a switch with identical leak-rule handling (verbatim duplication jscpd would flag), and three factory NAMES would need three D27(a) allow-list entries, one of which would eventually be added without one.
- `packages/gateway/src/multimodal/vlm/remote/remote-vlm.test.ts`
- `packages/cli/src/commands/media-grants-cmd.ts` — `allow-remote`, `grants list`, `grants revoke` arg parsing + rendering, kept out of `media-cmd.ts` which is already large.
- `packages/cli/src/commands/media-grants-cmd.test.ts`

**Modified:**

- `packages/gateway/src/index/local-index.ts:265` — `CURRENT_SCHEMA_VERSION` 58 → 59.
- `packages/gateway/src/index/migrations/runner.ts` — import + one `simpleStep(58, 59, …)` row.
- `packages/gateway/src/multimodal/media-types.ts` — two new `SkipReason` members; `RemoteVlmVendor` union.
- `packages/gateway/src/multimodal/media-discovery.ts` — the grant-driven re-offer predicate (§ 19.1).
- `packages/gateway/src/multimodal/media-gate.ts` — `Understander` rename, per-candidate `understanderFor`, the remote arm.
- `packages/gateway/src/multimodal/orphan-prune.ts` — revoke grants whose source item left the index.
- `packages/gateway/src/multimodal/multimodal-config.ts` — `remote_vlm` key + validation.
- `packages/gateway/src/multimodal/build-media-pass-deps.ts` — construct + wrap the remote provider; thread the grant store.
- `packages/gateway/src/multimodal/vlm/vlm-types.ts` — `mimeType` on `VlmDescribeInput`.
- `packages/gateway/src/multimodal/vlm/image-understander.ts` — pass the sniffed mime.
- `packages/gateway/src/multimodal/frames/av-understander.ts` — pass `image/jpeg` for frames.
- `packages/gateway/src/ipc/server/dispatchers.ts` — `media.allowRemote`, `media.grants.list`, `media.grants.revoke`.
- `packages/gateway/src/ipc/lan-rpc.ts` — the three new methods LAN-forbidden.
- `packages/cli/src/commands/media-cmd.ts` — `SkipReasonKey` mirror gains the two new reasons; subcommand dispatch.
- `scripts/structure-audit/check-nimbus-invariants.ts` — D27(a) and D27(b).
- `packages/gateway/src/security-invariants.test.ts` — I37 enforcement test.
- `CLAUDE.md`, `GEMINI.md`, `docs/SECURITY-INVARIANTS.md`, `docs/architecture.md`, `docs/cli-reference.md`, `docs/roadmap.md`, `docs/CHANGELOG.md`.

---

### Task 1: V59 schema — the `media_grant` table

**Files:**

- Create: `packages/gateway/src/index/media-grant-v59-sql.ts`
- Create: `packages/gateway/src/index/migrations/runner-v59.test.ts`
- Modify: `packages/gateway/src/index/migrations/runner.ts`
- Modify: `packages/gateway/src/index/local-index.ts:265`

**Interfaces:**

- Consumes: nothing.
- Produces: `MEDIA_GRANT_V59_SQL: string`; `CURRENT_SCHEMA_VERSION === 59`; table `media_grant` with columns `id TEXT PK, item_id TEXT, modality TEXT CHECK IN ('image','av'), model_vendor TEXT, granted_at INTEGER, revoked_at INTEGER NULL` and partial unique index `idx_media_grant_active`.

- [ ] **Step 1: Write the failing migration test**

Create `packages/gateway/src/index/migrations/runner-v59.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readIndexedUserVersion, runIndexedSchemaMigrations } from "./runner.ts";

describe("V59 — media_grant", () => {
  /**
   * Migrating to the literal 59 rather than `CURRENT_SCHEMA_VERSION` is the point: this proves the
   * 58→59 STEP is registered. Migrating to the constant would keep passing if the step were
   * deleted and the constant lowered back to 58 — the table would simply never be created and the
   * assertion would move with it. Copied deliberately from `runner-v58.test.ts`.
   */
  test("the 58→59 step is registered: user_version advances and the table appears", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 58);
    expect(readIndexedUserVersion(db)).toBe(58);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='media_grant'",
        )
        .get(),
    ).toBeNull();

    runIndexedSchemaMigrations(db, 59);
    expect(readIndexedUserVersion(db)).toBe(59);
    expect(
      db
        .query<{ name: string }, []>(
          "SELECT name FROM sqlite_master WHERE type='table' AND name='media_grant'",
        )
        .get()?.name,
    ).toBe("media_grant");
    db.close();
  });

  /**
   * The partial index is the whole reason revocation is not terminal (§ 18.3). A plain
   * UNIQUE(item_id, modality, model_vendor) would make a revoked row occupy the slot forever, so
   * the same artifact could never be re-granted without mutating history.
   */
  test("one ACTIVE grant per (item, modality, vendor), but re-granting after revocation works", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 59);
    const ins = (id: string, revokedAt: number | null) =>
      db.run(
        "INSERT INTO media_grant (id, item_id, modality, model_vendor, granted_at, revoked_at) VALUES (?, ?, 'image', 'openai', 1000, ?)",
        [id, "item-1", revokedAt],
      );

    ins("g1", null);
    expect(() => ins("g2", null)).toThrow(); // second ACTIVE grant is refused
    db.run("UPDATE media_grant SET revoked_at = 2000 WHERE id = 'g1'");
    expect(() => ins("g3", null)).not.toThrow(); // re-grant after revocation is allowed
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_grant").get()?.n,
    ).toBe(2); // the revoked row SURVIVES — append-only audit trail
    db.close();
  });

  test("the modality CHECK constraint rejects an unknown modality", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, 59);
    expect(() =>
      db.run(
        "INSERT INTO media_grant (id, item_id, modality, model_vendor, granted_at, revoked_at) VALUES ('g', 'i', 'text', 'openai', 1, NULL)",
      ),
    ).toThrow();
    db.close();
  });
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/index/migrations/runner-v59.test.ts`
Expected: FAIL — `runIndexedSchemaMigrations(db, 59)` leaves `user_version` at 58 and no `media_grant` table exists.

- [ ] **Step 3: Write the SQL module**

Create `packages/gateway/src/index/media-grant-v59-sql.ts`:

```ts
/**
 * V59 — durable, artifact-scoped remote-model grants (spec § 18.3).
 *
 * The unit of consent is (artifact, modality, vendor). There is deliberately no `'all'` vendor:
 * a wildcard is broader than anyone means when they approve one, and it would silently extend to
 * a vendor added after the grant was given. Authorising two vendors means two grants.
 *
 * `modality` retains `'av'` even though PR 4 grants only images, because the column outlives the
 * scope — a later remote STT tier writes `'av'` rows into this same table rather than migrating
 * it. The column is forward-looking; the WRITER is not, and `media-grant-store.ts` refuses to
 * write an `'av'` row in this release (§ 19.4).
 */
export const MEDIA_GRANT_V59_SQL = `
CREATE TABLE IF NOT EXISTS media_grant (
  id            TEXT PRIMARY KEY,
  item_id       TEXT NOT NULL,
  modality      TEXT NOT NULL CHECK (modality IN ('image', 'av')),
  model_vendor  TEXT NOT NULL,
  granted_at    INTEGER NOT NULL,
  revoked_at    INTEGER
) WITHOUT ROWID;

CREATE UNIQUE INDEX IF NOT EXISTS idx_media_grant_active
  ON media_grant (item_id, modality, model_vendor)
  WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_media_grant_item
  ON media_grant (item_id)
  WHERE revoked_at IS NULL;
`;
```

The second index is not decoration: `media-discovery.ts`'s re-offer predicate (Task 4) runs an
`EXISTS` correlated on `item_id` for every candidate row, and the partial unique index is on the
three-column tuple, so it cannot serve a lookup keyed on `item_id` alone.

- [ ] **Step 4: Register the migration step**

In `packages/gateway/src/index/migrations/runner.ts`, add the import beside the other V5x imports
(near line 45):

```ts
import { MEDIA_GRANT_V59_SQL } from "../media-grant-v59-sql.ts";
```

and add one row immediately after the `simpleStep(57, 58, …)` entry (near line 563):

```ts
  simpleStep(58, 59, "multimodal remote-model grants", MEDIA_GRANT_V59_SQL),
```

- [ ] **Step 5: Raise the schema version**

In `packages/gateway/src/index/local-index.ts:265`:

```ts
export const CURRENT_SCHEMA_VERSION = 59;
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/gateway/src/index`
Expected: PASS, including the pre-existing `runner.test.ts` (which walks every version).

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/index/
git commit -m "feat(multimodal): V59 media_grant table for artifact-scoped remote consent"
```

---

### Task 2: The grant store — the only module that names `media_grant`

**Files:**

- Create: `packages/gateway/src/multimodal/media-grant-store.ts`
- Create: `packages/gateway/src/multimodal/media-grant-store.test.ts`
- Modify: `packages/gateway/src/multimodal/media-types.ts`

**Interfaces:**

- Consumes: `MEDIA_GRANT_V59_SQL`'s table from Task 1.
- Produces:
  - `type RemoteVlmVendor = "anthropic" | "openai" | "gemini"` (exported from `media-types.ts`)
  - `interface MediaGrant { readonly id: string; readonly itemId: string; readonly modality: "image" | "av"; readonly modelVendor: string; readonly grantedAt: number; readonly revokedAt: number | null }`
  - `createGrant(db, args: { itemId: string; modality: "image" | "av"; modelVendor: string; nowMs: number }): { id: string; alreadyActive: boolean }`
  - `revokeGrant(db, args: { itemId: string; modelVendor?: string; nowMs: number }): number`
  - `listActiveGrants(db): MediaGrant[]`
  - `hasActiveGrant(db, args: { itemId: string; modality: "image" | "av"; modelVendor: string }): boolean`
  - `revokeOrphanedGrants(db, nowMs: number): number`
  - `class MediaGrantRefusedError extends Error`

- [ ] **Step 1: Add the vendor union to `media-types.ts`**

Append to `packages/gateway/src/multimodal/media-types.ts`:

```ts
/**
 * Vendors with a SHIPPED remote VLM adapter — deliberately NARROWER than the text-vendor set
 * (`llm/vendor-vault-keys.ts`'s `VendorWithApiKey`, which also carries `xai`). A vendor with a
 * text adapter and no vision adapter must be refused at config load naming the reason, never
 * accepted and failed per-artifact at describe time (§ 19.8).
 */
export type RemoteVlmVendor = "anthropic" | "openai" | "gemini";

export const REMOTE_VLM_VENDORS: readonly RemoteVlmVendor[] = ["anthropic", "openai", "gemini"];

export function isRemoteVlmVendor(v: string): v is RemoteVlmVendor {
  return (REMOTE_VLM_VENDORS as readonly string[]).includes(v);
}
```

- [ ] **Step 2: Write the failing store test**

Create `packages/gateway/src/multimodal/media-grant-store.test.ts`:

```ts
import { Database } from "bun:sqlite";
import { beforeEach, describe, expect, test } from "bun:test";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";
import { upsertIndexedItem } from "../index/item-store.ts";
import {
  createGrant,
  hasActiveGrant,
  listActiveGrants,
  MediaGrantRefusedError,
  revokeGrant,
  revokeOrphanedGrants,
} from "./media-grant-store.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
});

describe("createGrant", () => {
  test("writes an active grant and reports it as new", () => {
    const out = createGrant(db, {
      itemId: "i1",
      modality: "image",
      modelVendor: "openai",
      nowMs: 1000,
    });
    expect(out.alreadyActive).toBe(false);
    expect(hasActiveGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai" })).toBe(
      true,
    );
  });

  /**
   * Idempotent, and it must return the EXISTING id rather than `INSERT OR IGNORE`-ing: the batch
   * preview has to print "16 new (4 already granted)", which needs the caller to distinguish the
   * two cases. `INSERT OR IGNORE` succeeds silently while returning nothing to distinguish with.
   */
  test("is idempotent — a second identical grant returns the existing id, never throws", () => {
    const first = createGrant(db, {
      itemId: "i1",
      modality: "image",
      modelVendor: "openai",
      nowMs: 1000,
    });
    const second = createGrant(db, {
      itemId: "i1",
      modality: "image",
      modelVendor: "openai",
      nowMs: 2000,
    });
    expect(second.alreadyActive).toBe(true);
    expect(second.id).toBe(first.id);
    expect(listActiveGrants(db)).toHaveLength(1);
  });

  test("a different vendor on the same artifact is a SEPARATE grant, never an upgrade", () => {
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 1000 });
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "anthropic", nowMs: 1000 });
    expect(listActiveGrants(db)).toHaveLength(2);
  });

  /**
   * § 19.4: `av` is refused at WRITE time. The CHECK constraint keeps the value because the column
   * outlives this release, but writing a row nothing will ever read is the ships-inert pattern one
   * layer up — the exact failure this slice has hit three times.
   */
  test("REFUSES an av grant in this release, naming the bound", () => {
    expect(() =>
      createGrant(db, { itemId: "i1", modality: "av", modelVendor: "openai", nowMs: 1000 }),
    ).toThrow(MediaGrantRefusedError);
    expect(listActiveGrants(db)).toHaveLength(0);
  });
});

describe("revokeGrant", () => {
  test("revocation is append-only: the row survives with revoked_at set", () => {
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(revokeGrant(db, { itemId: "i1", nowMs: 2000 })).toBe(1);
    expect(hasActiveGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai" })).toBe(
      false,
    );
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_grant").get()?.n,
    ).toBe(1);
  });

  test("re-granting after revocation works and leaves both rows", () => {
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 1000 });
    revokeGrant(db, { itemId: "i1", nowMs: 2000 });
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 3000 });
    expect(listActiveGrants(db)).toHaveLength(1);
    expect(
      db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM media_grant").get()?.n,
    ).toBe(2);
  });

  test("--vendor narrows the revocation to one vendor", () => {
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "openai", nowMs: 1000 });
    createGrant(db, { itemId: "i1", modality: "image", modelVendor: "anthropic", nowMs: 1000 });
    expect(revokeGrant(db, { itemId: "i1", modelVendor: "openai", nowMs: 2000 })).toBe(1);
    expect(listActiveGrants(db).map((g) => g.modelVendor)).toEqual(["anthropic"]);
  });

  test("revoking a grant that does not exist reports zero rather than throwing", () => {
    expect(revokeGrant(db, { itemId: "nope", nowMs: 2000 })).toBe(0);
  });
});

describe("revokeOrphanedGrants", () => {
  /**
   * § 19.7. Revoked, never DELETEd: § 18.3's whole argument for the partial index is that
   * revocation is an append-only audit trail, and a pruner that deleted rows would be the one
   * caller allowed to rewrite history.
   */
  test("revokes grants whose source item has left the index, and leaves live ones alone", () => {
    upsertIndexedItem(db, {
      service: "google_drive",
      type: "file",
      externalId: "live",
      title: "live",
      bodyPreview: "",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: { mimeType: "image/png" },
    });
    const liveId = db
      .query<{ id: string }, []>("SELECT id FROM item WHERE external_id = 'live'")
      .get()?.id as string;

    createGrant(db, { itemId: liveId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    createGrant(db, { itemId: "gone", modality: "image", modelVendor: "openai", nowMs: 1000 });

    expect(revokeOrphanedGrants(db, 5000)).toBe(1);
    expect(listActiveGrants(db).map((g) => g.itemId)).toEqual([liveId]);
  });
});
```

- [ ] **Step 3: Run it and watch it fail**

Run: `bun test packages/gateway/src/multimodal/media-grant-store.test.ts`
Expected: FAIL — `Cannot find module './media-grant-store.ts'`.

- [ ] **Step 4: Write the store**

Create `packages/gateway/src/multimodal/media-grant-store.ts`:

```ts
/**
 * The ONLY module that names the `media_grant` table (static rule D27(b), spec § 18.7).
 *
 * Confining table access here is what stops a caller synthesising a grant or reading around the
 * active-row filter: every read goes through `hasActiveGrant`/`listActiveGrants`, both of which
 * apply `revoked_at IS NULL` themselves rather than trusting a caller to remember it.
 *
 * I9-safe throughout: every value is bound, every identifier is a literal in this source.
 * I14/D12: writes go through `dbRun`, never a bare `.run()`.
 */
import type { Database } from "bun:sqlite";
import { randomUUID } from "node:crypto";
import { dbRun } from "../db/write.ts";

export interface MediaGrant {
  readonly id: string;
  readonly itemId: string;
  readonly modality: "image" | "av";
  readonly modelVendor: string;
  readonly grantedAt: number;
  readonly revokedAt: number | null;
}

/**
 * Thrown for a grant this RELEASE will not write, as distinct from one the schema rejects.
 * Named so the CLI can render the bound rather than surfacing a SQLite constraint error.
 */
export class MediaGrantRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MediaGrantRefusedError";
  }
}

type GrantRow = {
  id: string;
  item_id: string;
  modality: string;
  model_vendor: string;
  granted_at: number;
  revoked_at: number | null;
};

function toGrant(r: GrantRow): MediaGrant {
  return {
    id: r.id,
    itemId: r.item_id,
    // The CHECK constraint guarantees this, so the narrow restates what the schema proved.
    modality: r.modality === "av" ? "av" : "image",
    modelVendor: r.model_vendor,
    grantedAt: r.granted_at,
    revokedAt: r.revoked_at,
  };
}

function findActive(
  db: Database,
  itemId: string,
  modality: "image" | "av",
  modelVendor: string,
): MediaGrant | undefined {
  const row = db
    .query<GrantRow, [string, string, string]>(
      `SELECT id, item_id, modality, model_vendor, granted_at, revoked_at
         FROM media_grant
        WHERE item_id = ? AND modality = ? AND model_vendor = ? AND revoked_at IS NULL`,
    )
    .get(itemId, modality, modelVendor);
  return row === null ? undefined : toGrant(row);
}

/**
 * Idempotent by lookup-then-insert rather than `INSERT OR IGNORE`: the batch preview must
 * distinguish "granted now" from "already granted" (§ 19.6), and `OR IGNORE` succeeds silently
 * with nothing to distinguish on. `alreadyActive` is that distinction.
 */
export function createGrant(
  db: Database,
  args: {
    readonly itemId: string;
    readonly modality: "image" | "av";
    readonly modelVendor: string;
    readonly nowMs: number;
  },
): { id: string; alreadyActive: boolean } {
  if (args.modality === "av") {
    throw new MediaGrantRefusedError(
      "remote understanding is images-only in this release: an audio/video artifact cannot be granted. " +
        "Its transcript is produced locally by whisper-cli and never leaves the machine.",
    );
  }
  const existing = findActive(db, args.itemId, args.modality, args.modelVendor);
  if (existing !== undefined) return { id: existing.id, alreadyActive: true };

  const id = randomUUID();
  dbRun(
    db,
    `INSERT INTO media_grant (id, item_id, modality, model_vendor, granted_at, revoked_at)
     VALUES (?, ?, ?, ?, ?, NULL)`,
    [id, args.itemId, args.modality, args.modelVendor, args.nowMs],
  );
  return { id, alreadyActive: false };
}

/** Returns the number of grants revoked. Omitting `modelVendor` revokes every vendor's grant. */
export function revokeGrant(
  db: Database,
  args: { readonly itemId: string; readonly modelVendor?: string; readonly nowMs: number },
): number {
  if (args.modelVendor === undefined) {
    return dbRun(
      db,
      "UPDATE media_grant SET revoked_at = ? WHERE item_id = ? AND revoked_at IS NULL",
      [args.nowMs, args.itemId],
    ).changes;
  }
  return dbRun(
    db,
    `UPDATE media_grant SET revoked_at = ?
      WHERE item_id = ? AND model_vendor = ? AND revoked_at IS NULL`,
    [args.nowMs, args.itemId, args.modelVendor],
  ).changes;
}

export function listActiveGrants(db: Database): MediaGrant[] {
  return db
    .query<GrantRow, []>(
      `SELECT id, item_id, modality, model_vendor, granted_at, revoked_at
         FROM media_grant WHERE revoked_at IS NULL ORDER BY granted_at, id`,
    )
    .all()
    .map(toGrant);
}

export function hasActiveGrant(
  db: Database,
  args: {
    readonly itemId: string;
    readonly modality: "image" | "av";
    readonly modelVendor: string;
  },
): boolean {
  return findActive(db, args.itemId, args.modality, args.modelVendor) !== undefined;
}

/**
 * Spec § 19.7. REVOKES rather than deletes — § 18.3's argument for the partial index is that
 * revocation is an append-only audit trail, and a pruner that deleted rows would be the one
 * caller allowed to rewrite history.
 *
 * STATED BOUND: an item that leaves the index transiently (a reindex that drops and re-adds rows)
 * loses its grant, and the owner must grant again. That is the safe direction of the failure, and
 * it is the same premise `pruneOrphanedUnderstandings` has run on since PR 3.
 */
export function revokeOrphanedGrants(db: Database, nowMs: number): number {
  return dbRun(
    db,
    `UPDATE media_grant
        SET revoked_at = ?
      WHERE revoked_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM item AS src WHERE src.id = media_grant.item_id)`,
    [nowMs],
  ).changes;
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/media-grant-store.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/media-grant-store.ts packages/gateway/src/multimodal/media-grant-store.test.ts packages/gateway/src/multimodal/media-types.ts
git commit -m "feat(multimodal): media_grant store, the sole namer of the V59 table"
```

---

### Task 3: Sweep orphaned grants at pass start

**Files:**

- Modify: `packages/gateway/src/multimodal/orphan-prune.ts`
- Modify: `packages/gateway/src/multimodal/orphan-prune.test.ts`

**Interfaces:**

- Consumes: `revokeOrphanedGrants(db, nowMs)` from Task 2.
- Produces: `pruneOrphanedMedia(db, nowMs): { understandings: number; grants: number }` — a new named export beside the existing `pruneOrphanedUnderstandings`, which stays as-is so its own callers and tests are untouched.

- [ ] **Step 1: Write the failing test**

Append to `packages/gateway/src/multimodal/orphan-prune.test.ts`:

```ts
describe("pruneOrphanedMedia", () => {
  /**
   * BOTH halves, in one call, with a live row present. The whole reason the two sweeps were
   * combined into one function is that a future third derived artifact cannot be added to one and
   * forgotten in the other — and that property is only guarded if the test exercises both. The
   * live grant is what proves the sweep is SELECTIVE: one that revoked everything would pass a
   * test that only counted what disappeared.
   */
  test("sweeps orphaned derived rows AND orphaned grants, sparing live ones", () => {
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    // A live source item, with a grant that must SURVIVE.
    upsertIndexedItem(db, {
      service: "google_drive",
      type: "file",
      externalId: "live",
      title: "live",
      bodyPreview: "",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: { mimeType: "image/png" },
    });
    const liveId = db
      .query<{ id: string }, []>("SELECT id FROM item WHERE external_id = 'live'")
      .get()?.id as string;
    createGrant(db, { itemId: liveId, modality: "image", modelVendor: "openai", nowMs: 1 });

    // An orphaned derived understanding — same shape the existing
    // `pruneOrphanedUnderstandings` tests use, so the two agree on what an orphan is.
    upsertIndexedItem(db, {
      service: "nimbus",
      type: "image_understanding",
      externalId: "missing:understanding",
      title: "Caption — missing",
      bodyPreview: "a caption",
      modifiedAt: 1,
      syncedAt: 1,
      metadata: { derivedFrom: "missing", understandingVersion: 2 },
    });

    // An orphaned grant.
    createGrant(db, { itemId: "gone", modality: "image", modelVendor: "openai", nowMs: 1 });

    const out = pruneOrphanedMedia(db, 5000);
    expect(out.understandings).toBe(1);
    expect(out.grants).toBe(1);
    expect(listActiveGrants(db).map((g) => g.itemId)).toEqual([liveId]);
    db.close();
  });
});
```

Add the imports this needs at the top of the file: `createGrant`, `listActiveGrants` from
`./media-grant-store.ts`, and `pruneOrphanedMedia` from `./orphan-prune.ts`.

- [ ] **Step 2: Run it and watch it fail**

Run: `bun test packages/gateway/src/multimodal/orphan-prune.test.ts`
Expected: FAIL — `pruneOrphanedMedia` is not exported.

- [ ] **Step 3: Add the combined sweeper**

Append to `packages/gateway/src/multimodal/orphan-prune.ts`:

```ts
/**
 * Both orphan sweeps, run together at pass start (spec § 19.7).
 *
 * One function rather than two calls at the call site so a future third derived artifact cannot be
 * added to one sweep and forgotten in the other — the same reason the egress exclusion list lives
 * inside `recordSyncEgress` rather than at each of its four call sites.
 */
export function pruneOrphanedMedia(
  db: Database,
  nowMs: number,
): { understandings: number; grants: number } {
  return {
    understandings: pruneOrphanedUnderstandings(db),
    grants: revokeOrphanedGrants(db, nowMs),
  };
}
```

with `import { revokeOrphanedGrants } from "./media-grant-store.ts";` at the top.

- [ ] **Step 4: Call it from the pass**

In `packages/gateway/src/multimodal/media-pass.ts`, replace the existing
`pruneOrphanedUnderstandings(deps.db)` call at pass start with:

```ts
  pruneOrphanedMedia(deps.db, deps.nowMs());
```

updating the import on the same edit.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/orphan-prune.ts packages/gateway/src/multimodal/orphan-prune.test.ts packages/gateway/src/multimodal/media-pass.ts
git commit -m "feat(multimodal): revoke grants orphaned by a deleted source item"
```

---

### Task 4: The grant-driven re-offer predicate

This is spec finding § 19.1 — the CRITICAL one. Without it the whole feature ships inert: an image
already captioned locally sits at the current `UNDERSTANDING_VERSION`, so granting it remote access
changes nothing and the pass reports `Understood 0 of 0`.

**Files:**

- Modify: `packages/gateway/src/multimodal/media-discovery.ts`
- Modify: `packages/gateway/src/multimodal/media-discovery.test.ts`

**Interfaces:**

- Consumes: the `media_grant` table (Task 1); `idx_media_grant_item` for the correlated lookup.
- Produces: `DiscoveryOptions` gains `readonly remoteVendor?: string | undefined` — when absent, the new clause is NOT emitted and no parameter is bound, so an unconfigured install runs exactly today's query.

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/multimodal/media-discovery.test.ts`:

```ts
describe("grant-driven re-offer (§ 19.1)", () => {
  /** The defect this whole task exists to close. */
  test("re-offers a LOCALLY-understood item once an active grant names the configured vendor", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);

    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(
      findCandidates(db, { limit: 10, remoteVendor: "openai" }).map((c) => c.itemId),
    ).toEqual([itemId]);
  });

  /**
   * The bound vendor is the CONFIGURED one. With `remote_vlm` unset the clause is omitted
   * entirely, so an unconfigured install re-offers ZERO items and the query costs what it costs
   * today. A grant for a vendor the user no longer runs is inert, not a standing re-offer.
   */
  test("re-offers NOTHING when no remote vendor is configured", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(findCandidates(db, { limit: 10 })).toHaveLength(0);
  });

  test("a grant for a DIFFERENT vendor than the configured one does not re-offer", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    createGrant(db, { itemId, modality: "image", modelVendor: "anthropic", nowMs: 1000 });
    expect(findCandidates(db, { limit: 10, remoteVendor: "openai" })).toHaveLength(0);
  });

  /**
   * Without the isLocal clause an item understood REMOTELY is re-offered on every subsequent pass
   * and re-sent to the vendor each time — a consent surface that bills the user forever off one
   * approval. This clause is what makes the upgrade one-directional.
   */
  test("does NOT re-offer an item already understood REMOTELY", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: false });
    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(findCandidates(db, { limit: 10, remoteVendor: "openai" })).toHaveLength(0);
  });

  test("a REVOKED grant does not re-offer", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    revokeGrant(db, { itemId, nowMs: 2000 });
    expect(findCandidates(db, { limit: 10, remoteVendor: "openai" })).toHaveLength(0);
  });

  /**
   * `json_extract` RAISES on malformed JSON in SQLite, and the existing version predicate already
   * guards with COALESCE. A derived row whose metadata does not round-trip must not blow up the
   * whole discovery query.
   */
  test("survives a derived row with unparseable metadata", () => {
    const itemId = seedUnderstoodImage(db, { isLocal: true });
    db.run("UPDATE item SET metadata = '{not json' WHERE service='nimbus'");
    createGrant(db, { itemId, modality: "image", modelVendor: "openai", nowMs: 1000 });
    expect(() => findCandidates(db, { limit: 10, remoteVendor: "openai" })).not.toThrow();
  });
});
```

Add a helper at the top of that describe block's file if one does not already exist:

```ts
/** Seeds a Drive image plus its derived understanding row at the CURRENT version. */
function seedUnderstoodImage(db: Database, opts: { readonly isLocal: boolean }): string {
  upsertIndexedItem(db, {
    service: "google_drive",
    type: "file",
    externalId: "img-1",
    title: "img-1",
    bodyPreview: "",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: { mimeType: "image/png" },
  });
  const itemId = db
    .query<{ id: string }, []>("SELECT id FROM item WHERE external_id = 'img-1'")
    .get()?.id as string;
  upsertIndexedItem(db, {
    service: "nimbus",
    type: "image_understanding",
    externalId: `${itemId}:understanding`,
    title: "Caption — img-1",
    bodyPreview: "a caption",
    modifiedAt: 1000,
    syncedAt: 1000,
    metadata: {
      derivedFrom: itemId,
      understandingVersion: UNDERSTANDING_VERSION,
      isLocal: opts.isLocal,
      model: opts.isLocal ? "qwen2.5vl:7b" : "gpt-5",
    },
  });
  return itemId;
}
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test packages/gateway/src/multimodal/media-discovery.test.ts`
Expected: FAIL — `remoteVendor` is not a `DiscoveryOptions` field (typecheck), and the re-offer
test finds zero candidates.

- [ ] **Step 3: Add the option and the clause**

In `packages/gateway/src/multimodal/media-discovery.ts`, add to `DiscoveryOptions`:

```ts
  /**
   * The vendor named by `[multimodal] remote_vlm`, when one is configured.
   *
   * ABSENT means the whole grant clause is omitted and no parameter is bound — an install with no
   * remote arm runs exactly the query it ran before PR 4, at the same cost. Present, it re-offers
   * items whose existing understanding is LOCAL and which carry an active grant for THIS vendor.
   */
  readonly remoteVendor?: string | undefined;
```

and replace the version predicate (currently `wheres[0]`, near line 119) with:

```ts
  // No understanding row, OR one at an older version, OR one that is LOCAL while an active grant
  // names the configured remote vendor (spec § 19.1).
  //
  // Derived rather than STORED, deliberately: the rejected alternative wrote
  // `understandingVersion = 0` at grant time, which re-offers the item on every pass until
  // something understands it — so the moment the remote arm cannot run (vendor disabled, key
  // rotated out of the Vault, org policy flipped), the item is re-offered, refused, and
  // re-offered again forever. That is the livelock PR 3 hit with the pass cursor. A predicate
  // self-corrects the instant `remote_vlm` changes.
  //
  // json_valid on both json_extract calls. NOT COALESCE — that was wrong in an earlier draft of
  // this plan and is worth stating so nobody re-introduces it: `json_extract` RAISES on malformed
  // JSON, and it raises BEFORE COALESCE can supply a default, so COALESCE guards nothing here. `OR`
  // does not short-circuit around a raised error either. Only `CASE WHEN json_valid(...)` guards
  // it. One derived row whose metadata does not round-trip would otherwise break discovery for the
  // entire library.
  const versionArm = `(u.id IS NULL OR COALESCE(json_extract(u.metadata, '$.understandingVersion'), -1) < ?)`;
  const wheres: string[] = [];
  const params: (string | number)[] = [];

  if (opts.remoteVendor === undefined) {
    wheres.push(versionArm);
    params.push(UNDERSTANDING_VERSION);
  } else {
    wheres.push(
      `(${versionArm} OR (
          COALESCE(json_extract(u.metadata, '$.isLocal'), 0) IN (1, 'true')
          AND EXISTS (
            SELECT 1 FROM media_grant AS g
             WHERE g.item_id = src.id
               AND g.revoked_at IS NULL
               AND g.modality = 'image'
               AND g.model_vendor = ?
          )
        ))`,
    );
    params.push(UNDERSTANDING_VERSION, opts.remoteVendor);
  }
  wheres.push(predicate.clause);
  params.push(...predicate.params);
```

Delete the old `const wheres` / `const params` initialisers that this replaces; the rest of the
function (service, sinceMs, afterItemId, limit) is unchanged and continues to push onto both arrays.

`IN (1, 'true')` rather than `= 1`: `upsertIndexedItem` serialises metadata as JSON, and
`json_extract` returns SQLite integer `1` for a JSON `true` — but a row written by an older path,
or by a test that stored the string, must not silently fall through to "not local" and suppress a
legitimate re-offer.

- [ ] **Step 4: Thread the option from the pass**

In `packages/gateway/src/multimodal/media-pass.ts`, where `findCandidates` is called, forward the
configured vendor:

```ts
      ...(deps.remoteVendor === undefined ? {} : { remoteVendor: deps.remoteVendor }),
```

and add `readonly remoteVendor?: string | undefined;` to `MediaPassDeps` with a one-line comment
pointing at § 19.1. Task 9 populates it from config; until then it is always absent and the new
clause never fires.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/media-discovery.ts packages/gateway/src/multimodal/media-discovery.test.ts packages/gateway/src/multimodal/media-pass.ts
git commit -m "feat(multimodal): re-offer a locally-understood item once a remote grant names the configured vendor"
```

---

### Task 5: `[multimodal] remote_vlm` config validation

**Files:**

- Modify: `packages/gateway/src/multimodal/multimodal-config.ts`
- Modify: `packages/gateway/src/multimodal/multimodal-config.test.ts`

**Interfaces:**

- Consumes: `isRemoteVlmVendor` from `media-types.ts` (Task 2).
- Produces: `MultimodalConfig` gains `readonly remoteVlm: RemoteVlmVendor | null` (default `null`).

- [ ] **Step 1: Write the failing tests**

Append to `packages/gateway/src/multimodal/multimodal-config.test.ts`:

```ts
describe("remote_vlm", () => {
  test("defaults to null — the remote arm is off unless named", () => {
    expect(loadFrom("[multimodal]\nenabled = true\n").remoteVlm).toBeNull();
  });

  test("accepts a vendor with a shipped VLM adapter", () => {
    expect(
      loadFrom('[multimodal]\nenabled = true\nremote_vlm = "openai"\n').remoteVlm,
    ).toBe("openai");
  });

  /**
   * LOUD, not fail-off. Silently disabling the section because the user misspelled `anthropic`
   * would be indistinguishable from the feature not existing — the same reasoning that makes a
   * non-loopback `vlm_base_url` throw rather than turn the section off.
   */
  test("REFUSES an unknown vendor loudly, naming the value", () => {
    expect(() => loadFrom('[multimodal]\nenabled = true\nremote_vlm = "gpt"\n')).toThrow(
      /remote_vlm/,
    );
  });

  /**
   * § 19.8: the vision vendor set is NARROWER than the text vendor set. `xai` has a text adapter
   * and no VLM adapter, so it must be refused at config load naming the reason, never accepted
   * and failed per-artifact at describe time.
   */
  test("REFUSES a text-only vendor that has no vision adapter", () => {
    expect(() => loadFrom('[multimodal]\nenabled = true\nremote_vlm = "xai"\n')).toThrow(/xai/);
  });
});
```

`loadFrom` is the existing test helper in that file that writes a temp config dir and calls
`loadMultimodalConfig`; reuse it rather than introducing a second one.

- [ ] **Step 2: Run and watch them fail**

Run: `bun test packages/gateway/src/multimodal/multimodal-config.test.ts`
Expected: FAIL — `remoteVlm` is not a field on `MultimodalConfig`.

- [ ] **Step 3: Implement**

In `packages/gateway/src/multimodal/multimodal-config.ts`:

Add to `MultimodalConfig`:

```ts
  /**
   * The frontier vision vendor, or null. Its API key is the EXISTING `[llm.remote.<vendor>]` Vault
   * entry — reusing that credential is deliberate (§ 18.2), because minting a second secret
   * surface for the same vendor and account gives a future bug a second place to leak from.
   * The CAPABILITY is not inherited, which is why this key exists at all: "I gave you my OpenAI
   * key so `nimbus ask` works" is not "you may send my photos to OpenAI".
   */
  readonly remoteVlm: RemoteVlmVendor | null;
```

Add `remoteVlm: null` to `defaults()`.

Add the key to `parseSection`'s chain, beside `vlm_model`:

```ts
    } else if (key === "remote_vlm") {
      const v = unquote(value);
      if (v === undefined) return defaults();
      // Deliberately NOT the fail-off direction, and the second exception in this file after
      // `vlm_base_url`. A misspelled vendor that silently disabled the section would be
      // indistinguishable from the feature not existing; the user needs to be told.
      out = { ...out, remoteVlmRaw: v };
```

Because `parseSection` must stay total and fail-off for malformed TOML, carry the raw string on an
internal field and validate it AFTER parsing, in `loadMultimodalConfig`, next to the existing
`vlm_base_url` loopback refusal (which is already outside the try/catch for exactly this reason):

```ts
function assertRemoteVlmSupported(cfg: MultimodalConfigDraft): RemoteVlmVendor | null {
  if (cfg.remoteVlmRaw === undefined || cfg.remoteVlmRaw === "") return null;
  if (!isRemoteVlmVendor(cfg.remoteVlmRaw)) {
    throw new MultimodalConfigError(
      `[multimodal] remote_vlm = "${cfg.remoteVlmRaw}" is not a vendor with a vision adapter. ` +
        `Supported: ${REMOTE_VLM_VENDORS.join(", ")}. Note this set is deliberately narrower ` +
        "than the text-model vendors in [llm.remote.*] — a vendor can have a text adapter and no " +
        "vision adapter. Fix the value or remove the key to keep image understanding local.",
    );
  }
  return cfg.remoteVlmRaw;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal/multimodal-config.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/multimodal/multimodal-config.ts packages/gateway/src/multimodal/multimodal-config.test.ts
git commit -m "feat(multimodal): [multimodal] remote_vlm, validated against vendors with a vision adapter"
```

---

### Task 6: MIME sniffing on the VLM seam

**Files:**

- Create: `packages/gateway/src/multimodal/vlm/image-mime.ts`
- Create: `packages/gateway/src/multimodal/vlm/image-mime.test.ts`
- Modify: `packages/gateway/src/multimodal/vlm/vlm-types.ts`
- Modify: `packages/gateway/src/multimodal/vlm/image-understander.ts`
- Modify: `packages/gateway/src/multimodal/frames/av-understander.ts`
- Modify: `packages/gateway/src/multimodal/media-types.ts`

**Interfaces:**

- Consumes: nothing.
- Produces:
  - `type WireImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif"`
  - `sniffImageMime(bytes: Uint8Array): WireImageMime | null`
  - `resolveWireMime(bytes: Uint8Array, declared: string | null): WireImageMime | null`
  - `VlmDescribeInput` gains `readonly mimeType?: string`
  - `SkipReason` gains `"unsupported_image_format"`

- [ ] **Step 1: Write the failing sniffer test**

Create `packages/gateway/src/multimodal/vlm/image-mime.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { resolveWireMime, sniffImageMime } from "./image-mime.ts";

const jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0, 0, 0]);
const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const gif = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 0, 0, 0, 0, 0, 0]);
const webp = new Uint8Array([
  0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x45, 0x42, 0x50,
]);
// HEIC: a real ftyp box, and deliberately NOT one of the four wire types.
const heic = new Uint8Array([
  0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63,
]);

describe("sniffImageMime", () => {
  test.each([
    ["jpeg", jpeg, "image/jpeg"],
    ["png", png, "image/png"],
    ["gif", gif, "image/gif"],
    ["webp", webp, "image/webp"],
  ])("recognises %s", (_n, bytes, expected) => {
    expect(sniffImageMime(bytes)).toBe(expected);
  });

  test("returns null for a format no vendor accepts on the wire", () => {
    expect(sniffImageMime(heic)).toBeNull();
  });

  test("returns null rather than throwing on a truncated buffer", () => {
    expect(sniffImageMime(new Uint8Array([0xff]))).toBeNull();
    expect(sniffImageMime(new Uint8Array())).toBeNull();
  });

  /** RIFF alone is not WebP — it is also WAV and AVI. */
  test("does not accept a RIFF container that is not WebP", () => {
    const wav = new Uint8Array([
      0x52, 0x49, 0x46, 0x46, 0x24, 0, 0, 0, 0x57, 0x41, 0x56, 0x45,
    ]);
    expect(sniffImageMime(wav)).toBeNull();
  });
});

describe("resolveWireMime", () => {
  /**
   * § 19.2, and the inversion of what the reviewer proposed. The sniff is AUTHORITATIVE and the
   * declared value is the fallback: on the cloud arm the declared value is a remote provider's
   * Content-Type header, which `media-types.ts` already says not to trust, and a wrong media_type
   * is not a soft failure — Anthropic rejects image/png over JPEG bytes outright.
   */
  test("the SNIFF wins over a contradicting declared type", () => {
    expect(resolveWireMime(jpeg, "image/png")).toBe("image/jpeg");
  });

  test("falls back to the declared type only when the sniff is inconclusive", () => {
    expect(resolveWireMime(heic, "image/png")).toBe("image/png");
  });

  test("ignores a declared type that is not a wire type", () => {
    expect(resolveWireMime(heic, "application/octet-stream")).toBeNull();
    expect(resolveWireMime(heic, "image/heic")).toBeNull();
  });

  test("tolerates parameters and casing on the declared type", () => {
    expect(resolveWireMime(heic, "IMAGE/PNG; charset=binary")).toBe("image/png");
  });

  test("returns null when neither resolves — the caller must refuse, not guess", () => {
    expect(resolveWireMime(heic, null)).toBeNull();
  });
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test packages/gateway/src/multimodal/vlm/image-mime.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write the sniffer**

Create `packages/gateway/src/multimodal/vlm/image-mime.ts`:

```ts
/**
 * The image type that goes ON THE WIRE to a vision model (spec § 19.2).
 *
 * WHY THE SNIFF IS AUTHORITATIVE AND THE DECLARED TYPE IS THE FALLBACK. On the cloud arm the
 * "declared" type is a remote provider's `Content-Type` header — `media-types.ts` says in as many
 * words that it is "not something an understander should trust further than that" — and a wrong
 * `media_type` is not a soft failure: Anthropic rejects `image/png` over JPEG bytes with an
 * HTTP 400, so trusting the header converts a provider quirk into a per-artifact failure the user
 * cannot diagnose. Magic bytes are the artifact itself.
 *
 * Four types, because these are what every target vendor accepts. A format outside the set (HEIC
 * straight off an iPhone is the common one) resolves to null and the caller REFUSES the artifact
 * rather than sending bytes of unknown type on the theory that the vendor might cope.
 *
 * Pure: no I/O, no allocation beyond the comparisons. Nothing here decodes an image — see
 * `ollama-vlm.ts`'s note on why `sharp` must not come back.
 */
export type WireImageMime = "image/jpeg" | "image/png" | "image/webp" | "image/gif";

const WIRE_MIMES: readonly WireImageMime[] = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

function startsWith(bytes: Uint8Array, sig: readonly number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

export function sniffImageMime(bytes: Uint8Array): WireImageMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith(bytes, [0x47, 0x49, 0x46, 0x38])) return "image/gif";
  // RIFF alone is ambiguous — WAV and AVI share it — so the WEBP fourcc at offset 8 is required.
  if (
    startsWith(bytes, [0x52, 0x49, 0x46, 0x46]) &&
    bytes.length >= 12 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

/**
 * Sniff first; fall back to a declared type ONLY when it names one of the four wire types.
 * Returns null when neither resolves — the caller refuses that artifact
 * (`unsupported_image_format`) rather than guessing.
 */
export function resolveWireMime(bytes: Uint8Array, declared: string | null): WireImageMime | null {
  const sniffed = sniffImageMime(bytes);
  if (sniffed !== null) return sniffed;
  if (declared === null) return null;
  // `image/png; charset=binary` and `IMAGE/PNG` are both real headers in the wild.
  const bare = declared.split(";")[0]?.trim().toLowerCase() ?? "";
  return (WIRE_MIMES as readonly string[]).includes(bare) ? (bare as WireImageMime) : null;
}
```

- [ ] **Step 4: Widen the VLM seam**

In `packages/gateway/src/multimodal/vlm/vlm-types.ts`, add to `VlmDescribeInput`:

```ts
  /**
   * The wire `media_type` for {@link bytes}, resolved by `image-mime.ts` (sniff first, declared
   * `Content-Type` only as a fallback).
   *
   * OPTIONAL on the interface and REQUIRED in practice by the remote adapters: Ollama accepts a
   * bare base64 array and needs none, while Anthropic returns HTTP 400 without one and Gemini and
   * OpenAI both put it on the wire. Keeping it optional here means the local path and every
   * existing caller are unchanged; each remote adapter refuses on its own when it is absent,
   * rather than this type forcing a value the local provider has no use for.
   */
  readonly mimeType?: string;
```

- [ ] **Step 5: Add the skip reason and pass the mime**

In `packages/gateway/src/multimodal/media-types.ts` add `| "unsupported_image_format"` to
`SkipReason`.

In `packages/gateway/src/multimodal/vlm/image-understander.ts`, resolve and forward it. The
understander receives a `MediaSource`; for the `bytes` arm the declared mime is `source.mime`, and
for the `path` arm it is null (the bytes are read from disk and sniffing is the only signal):

```ts
  const wire = resolveWireMime(bytes, source.kind === "bytes" ? source.mime : null);
  if (wire === null) {
    throw new UnsupportedImageFormatError(
      "image bytes are not JPEG, PNG, WebP or GIF — refusing rather than sending an unknown type",
    );
  }
  const { text } = await deps.vlm.describe({
    bytes,
    prompt: IMAGE_CAPTION_PROMPT,
    mimeType: wire,
    egressMethod: "multimodal.vlm.image",
  });
```

In `packages/gateway/src/multimodal/frames/av-understander.ts`, the frame bytes come from ffmpeg
and are always JPEG, so pass it as a literal at the existing `deps.vlm.describe({...})` call
(around line 105):

```ts
        mimeType: "image/jpeg",
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/gateway/src/multimodal/vlm/ packages/gateway/src/multimodal/frames/av-understander.ts packages/gateway/src/multimodal/media-types.ts
git commit -m "feat(multimodal): resolve a wire media_type by magic bytes, refusing an unknown format"
```

---

### Task 7: `describe_failed` — stop calling an image failure a transcription failure

**Files:**

- Modify: `packages/gateway/src/multimodal/media-types.ts`
- Modify: `packages/gateway/src/multimodal/media-gate.ts`
- Modify: `packages/gateway/src/multimodal/media-gate.test.ts`
- Modify: `packages/cli/src/commands/media-cmd.ts:21`
- Modify: `packages/cli/src/commands/media-cmd.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `SkipReason` gains `"describe_failed"`; the CLI's hand-mirrored `SkipReasonKey` gains
  `"describe_failed"` and `"unsupported_image_format"` in the SAME commit.

The CLI mirror is hand-maintained and has crashed the summary once already (§ 17). Both new reasons
must land in both places together.

- [ ] **Step 1: Write the failing tests**

In `packages/gateway/src/multimodal/media-gate.test.ts`:

```ts
test("an image understander that throws records describe_failed, not transcribe_failed", async () => {
  const res = await understandArtifact(
    imageCandidate(),
    { kind: "bytes", bytes: new Uint8Array([1]), mime: "image/png" },
    gateDeps({
      understanderFor: () => ({
        isLocal: true,
        model: "m",
        isAvailable: async () => true,
        understand: async () => {
          throw new Error("model exploded");
        },
      }),
    }),
  );
  expect(res).toEqual({ ok: false, reason: "describe_failed" });
});

test("an AV understander that throws still records transcribe_failed", async () => {
  const res = await understandArtifact(
    avCandidate(),
    { kind: "path", path: "/tmp/a.mp4" },
    gateDeps({
      understanderFor: () => ({
        isLocal: true,
        model: "m",
        isAvailable: async () => true,
        understand: async () => {
          throw new Error("whisper exploded");
        },
      }),
    }),
  );
  expect(res).toEqual({ ok: false, reason: "transcribe_failed" });
});
```

In `packages/cli/src/commands/media-cmd.test.ts`, add a case proving the mirror is total — the
guard against the § 17 crash recurring:

```ts
test("every gateway SkipReason has a CLI label — a missing one printed nothing and crashed", () => {
  // GATEWAY_SKIP_REASONS is imported from the gateway types via the shared test fixture; the CLI
  // may not import gateway source, so this list is asserted against the rendered output instead.
  for (const reason of [
    "over_byte_cap",
    "no_local_model",
    "no_remote_grant",
    "unresolvable_modality",
    "fetch_miss",
    "path_outside_roots",
    "transcode_failed",
    "transcribe_failed",
    "describe_failed",
    "unsupported_image_format",
    "not_configured",
    "rate_limited",
  ] as const) {
    const rendered = renderSummary({
      understood: 0,
      considered: 1,
      skipped: 1,
      skippedByReason: { [reason]: 1 } as never,
      cloudBytesFetched: 0,
      stopReason: "completed",
    });
    expect(rendered).toContain(reason);
  }
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test packages/gateway/src/multimodal/media-gate.test.ts packages/cli/src/commands/media-cmd.test.ts`
Expected: FAIL — the gate returns `transcribe_failed` for the image case, and the CLI type has no
`describe_failed` member.

- [ ] **Step 3: Branch the catch arm by modality**

In `packages/gateway/src/multimodal/media-gate.ts`, replace the bare catch:

```ts
  } catch {
    // The reason a user READS. "transcribe failed" printed against a photograph is a lie in the
    // one line the summary gives them, and the two failures have different remedies: a bad
    // transcode versus a model that could not describe an image.
    return {
      ok: false,
      reason: candidate.modality === "image" ? "describe_failed" : "transcribe_failed",
    };
  } finally {
```

- [ ] **Step 4: Extend both `SkipReason` and the CLI mirror**

`packages/gateway/src/multimodal/media-types.ts` — add `| "describe_failed"`.

`packages/cli/src/commands/media-cmd.ts:21` — add both new members to `SkipReasonKey`, with the
comment naming why this file is hand-mirrored:

```ts
  // Hand-mirrored from the gateway's `SkipReason` (packages/cli may not import gateway source).
  // A missing member here does not fail typecheck at the boundary — the summary arrives as JSON —
  // it prints nothing and once crashed the renderer outright. Both trees change together.
  | "describe_failed"
  | "unsupported_image_format"
```

Add human labels for both in whatever map `renderSummary` uses for its reason lines:

```ts
  describe_failed: "the vision model failed to describe it",
  unsupported_image_format: "not a JPEG, PNG, WebP or GIF — refused rather than sent as an unknown type",
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun test packages/gateway/src/multimodal packages/cli/src/commands/media-cmd.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/ packages/cli/src/commands/media-cmd.ts packages/cli/src/commands/media-cmd.test.ts
git commit -m "feat(multimodal): describe_failed, so an image failure stops printing as a transcription failure"
```

---

### Task 8: Per-candidate understander resolution

This is § 19.A — my own finding, and the structural change the rest of the remote arm needs. The
gate's seam is `understanderFor(modality)`, resolved before the candidate is consulted; every PR 4
decision is per artifact.

**Files:**

- Modify: `packages/gateway/src/multimodal/media-gate.ts`
- Modify: `packages/gateway/src/multimodal/media-gate.test.ts`
- Modify: `packages/gateway/src/multimodal/build-media-pass-deps.ts`
- Modify: `packages/gateway/src/multimodal/frames/av-understander.ts` (type import only)
- Modify: `packages/gateway/src/multimodal/vlm/image-understander.ts` (type import only)

**Interfaces:**

- Consumes: nothing new.
- Produces:
  - `LocalUnderstander` is RENAMED to `Understander` — same shape. Every implementer and importer
    moves in this commit.
  - `MediaGateDeps.understanderFor` becomes
    `(modality: MediaModality, candidate: MediaCandidate) => Understander | undefined`.

- [ ] **Step 1: Write the failing test**

In `packages/gateway/src/multimodal/media-gate.test.ts`:

```ts
test("resolves the understander PER CANDIDATE, not once per modality", async () => {
  const seen: string[] = [];
  const deps = gateDeps({
    understanderFor: (_m, candidate) => {
      seen.push(candidate.itemId);
      return {
        isLocal: true,
        model: "m",
        isAvailable: async () => true,
        understand: async () => ({ text: "ok" }),
      };
    },
  });
  await understandArtifact(imageCandidate({ itemId: "a" }), imageSource(), deps);
  await understandArtifact(imageCandidate({ itemId: "b" }), imageSource(), deps);
  // Two different artifacts of the SAME modality must each get their own resolution — that is what
  // lets one be granted remote and the other not.
  expect(seen).toEqual(["a", "b"]);
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test packages/gateway/src/multimodal/media-gate.test.ts`
Expected: FAIL — typecheck: `understanderFor` takes one parameter.

- [ ] **Step 3: Rename and widen**

In `packages/gateway/src/multimodal/media-gate.ts`:

```ts
/**
 * Renamed from `LocalUnderstander` in PR 4 (§ 19.A). The old name asserted a security property
 * this type no longer carries — a remote provider is returned through it now — and a type whose
 * name claims a guarantee it does not enforce is worse than the churn of renaming it. Locality is
 * read from `isLocal` (I34), which is the only thing that ever decided it.
 */
export interface Understander {
  /** DERIVED by the provider (I34). The gate READS it; it never accepts it from a caller. */
  readonly isLocal: boolean;
  readonly model: string;
  isAvailable(): Promise<boolean>;
  understand(source: MediaSource): Promise<UnderstandDetail>;
}
```

and on `MediaGateDeps`:

```ts
  /**
   * Resolves the understander for THIS artifact.
   *
   * Keyed on the candidate as well as the modality since PR 4: remote eligibility is per-artifact
   * (this image has a grant, that one does not), and a modality-keyed seam cannot express it. The
   * candidate is already the gate's first argument, so nothing new is threaded through the pass.
   */
  readonly understanderFor: (
    modality: MediaModality,
    candidate: MediaCandidate,
  ) => Understander | undefined;
```

Update the single call site inside `understandArtifact`:

```ts
  const provider = deps.understanderFor(candidate.modality, candidate);
```

- [ ] **Step 4: Move every importer**

Rename the type at each import site — `build-media-pass-deps.ts`, `frames/av-understander.ts`,
`vlm/image-understander.ts`, and their tests. Run this to find them all, and do not rely on the
list above being complete:

```bash
grep -rn "LocalUnderstander" packages/gateway/src/ scripts/
```

Expected after the edit: zero matches.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run typecheck && bun test packages/gateway/src/multimodal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/
git commit -m "refactor(multimodal): resolve the understander per candidate, and rename LocalUnderstander"
```

---

### Task 9: The gate's remote arm and its truth table

**Files:**

- Modify: `packages/gateway/src/multimodal/media-gate.ts`
- Modify: `packages/gateway/src/multimodal/media-gate.test.ts`
- Modify: `packages/gateway/src/multimodal/build-media-pass-deps.ts`

**Interfaces:**

- Consumes: `hasActiveGrant` (Task 2), `Understander` (Task 8), `MultimodalConfig.remoteVlm` (Task 5).
- Produces: `MediaGateDeps` gains
  `readonly remoteFor?: (candidate: MediaCandidate) => Understander | undefined` — absent means no
  remote arm exists at all, which is production's state until Task 10.

- [ ] **Step 1: Write the truth table as tests**

In `packages/gateway/src/multimodal/media-gate.test.ts`, one test per row of § 19.3's table:

```ts
describe("provider selection (§ 19.3 truth table)", () => {
  const remote = (): Understander => ({
    isLocal: false,
    model: "gpt-5",
    isAvailable: async () => true,
    understand: async () => ({ text: "remote caption" }),
  });
  const local = (available = true): Understander => ({
    isLocal: true,
    model: "qwen2.5vl:7b",
    isAvailable: async () => available,
    understand: async () => ({ text: "local caption" }),
  });

  test("no grant + local available -> LOCAL", async () => {
    const res = await understandArtifact(
      imageCandidate(),
      imageSource(),
      gateDeps({ understanderFor: () => local(), remoteFor: () => undefined }),
    );
    expect(res).toMatchObject({ ok: true, outcome: { isLocal: true } });
  });

  test("no grant + local unavailable -> REFUSE no_local_model, never remote", async () => {
    let remoteTouched = false;
    const res = await understandArtifact(
      imageCandidate(),
      imageSource(),
      gateDeps({
        understanderFor: () => local(false),
        remoteFor: () => {
          remoteTouched = true;
          return remote();
        },
      }),
    );
    expect(res).toEqual({ ok: false, reason: "no_local_model" });
    expect(remoteTouched).toBe(false);
  });

  /**
   * § 19.3, and the row I REJECTED from the review. A grant is a PERMISSION, not a mandate:
   * granting remote and then disabling the vendor must not cost the user local captioning too.
   * Consent that can only widen behaviour must never remove it.
   */
  test("grant + NO remote arm configured -> LOCAL, exactly as if no grant existed", async () => {
    const res = await understandArtifact(
      imageCandidate(),
      imageSource(),
      gateDeps({ understanderFor: () => local(), remoteFor: () => undefined }),
    );
    expect(res).toMatchObject({ ok: true, outcome: { isLocal: true } });
  });

  test("grant + remote configured -> REMOTE", async () => {
    const res = await understandArtifact(
      imageCandidate(),
      imageSource(),
      gateDeps({ understanderFor: () => remote(), remoteFor: () => remote() }),
    );
    expect(res).toMatchObject({ ok: true, outcome: { isLocal: false, model: "gpt-5" } });
  });

  /**
   * The key rule. A silent fall-back to local on a rate limit means the same command produces a
   * frontier caption on Tuesday and a 7B caption on Wednesday with nothing saying which — and
   * § 12.3's "a caption is still a guess" only holds as a bound if the reader can tell which
   * guesser made it.
   */
  test("remote failure is TERMINAL — it never degrades to local", async () => {
    let localTouched = false;
    const res = await understandArtifact(
      imageCandidate(),
      imageSource(),
      gateDeps({
        understanderFor: () => ({
          isLocal: false,
          model: "gpt-5",
          isAvailable: async () => true,
          understand: async () => {
            throw new Error("429");
          },
        }),
        remoteFor: () => {
          localTouched = true;
          return undefined;
        },
      }),
    );
    expect(res).toEqual({ ok: false, reason: "describe_failed" });
    expect(localTouched).toBe(false);
  });

  /** The PR 1 structural backstop stays reachable: a non-local provider with no grant refuses. */
  test("a non-local provider reached without a grant still refuses no_remote_grant", async () => {
    const res = await understandArtifact(
      imageCandidate(),
      imageSource(),
      gateDeps({ understanderFor: () => remote(), remoteFor: () => undefined }),
    );
    expect(res).toEqual({ ok: false, reason: "no_remote_grant" });
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test packages/gateway/src/multimodal/media-gate.test.ts`
Expected: FAIL — `remoteFor` is not a `MediaGateDeps` field.

- [ ] **Step 3: Implement the arm**

In `packages/gateway/src/multimodal/media-gate.ts`, add to `MediaGateDeps`:

```ts
  /**
   * The REMOTE understander for this artifact, when one is both configured and granted. Absent
   * (or returning undefined) means no remote arm exists — which is production's state whenever
   * `[multimodal] remote_vlm` is unset, and was every install's state before PR 4.
   *
   * The grant lookup lives BEHIND this closure, in `build-media-pass-deps.ts`, so the gate never
   * touches a `Database` and D27(b)'s confinement of the grant store holds without the gate
   * needing an exemption.
   */
  readonly remoteFor?: ((candidate: MediaCandidate) => Understander | undefined) | undefined;
```

and replace step 2/3 of `understandArtifact` (the locality check) with:

```ts
  // 2. Prefer the REMOTE arm when this artifact has one — meaning a vendor is configured AND an
  //    active grant names it for this exact artifact. `remoteFor` returns undefined otherwise, and
  //    the local provider resolved above stands.
  //
  //    A grant with no configured remote arm therefore resolves as if no grant existed (§ 19.3):
  //    consent widens what may happen, and must never take away the local capability the user
  //    already had.
  const remote = deps.remoteFor?.(candidate);
  const chosen = remote ?? provider;

  // 3. Locality is DERIVED (I34). A non-local provider that arrived any other way than through
  //    `remoteFor` has no grant behind it and is refused outright — the structural backstop this
  //    gate has carried since PR 1, still reachable and still tested.
  if (!chosen.isLocal && remote === undefined) {
    return { ok: false, reason: "no_remote_grant" };
  }

  // 4. A LOCAL provider that is unavailable refuses; it does not degrade to remote. A REMOTE
  //    provider is not availability-probed — there is no second arm to fall back to, so a probe
  //    would only add a round-trip before the same refusal, and its failure is reported by the
  //    describe itself.
  if (chosen.isLocal && !(await chosen.isAvailable())) {
    return { ok: false, reason: "no_local_model" };
  }
```

then use `chosen` in place of `provider` for the rest of the function (the GPU lease, the
`understand` call, and both `model`/`isLocal` fields of the outcome).

- [ ] **Step 4: Wire the closure**

In `packages/gateway/src/multimodal/build-media-pass-deps.ts`, build `remoteFor` from the grant
store and the configured vendor. Until Task 10 lands there is no remote provider to return, so this
step wires the GRANT half only and returns `undefined` unconditionally, with the provider slotted
in next task:

```ts
/**
 * The grant half of the remote arm. Returns a provider only when a vendor is configured AND an
 * active grant names it for this artifact — the two independent conditions of § 18.1 steps 3 and 4.
 *
 * The `Database` read lives here rather than in the gate so `media-gate.ts` never touches SQL and
 * D27(b) holds without an exemption for it.
 */
function buildRemoteFor(
  input: BuildMediaPassDepsInput,
  vendor: RemoteVlmVendor | null,
): ((candidate: MediaCandidate) => Understander | undefined) | undefined {
  if (vendor === null) return undefined;
  return (candidate: MediaCandidate): Understander | undefined => {
    if (candidate.modality !== "image") return undefined; // § 19.4: AV is local-only, always.
    if (
      !hasActiveGrant(input.db, {
        itemId: candidate.itemId,
        modality: "image",
        modelVendor: vendor,
      })
    ) {
      return undefined;
    }
    return undefined; // Task 10 returns the wrapped remote understander here.
  };
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run typecheck && bun test packages/gateway/src/multimodal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/
git commit -m "feat(multimodal): the gate's remote arm — grant-gated, fail-closed in both directions"
```

---

### Task 10: The remote VLM adapters

**Files:**

- Create: `packages/gateway/src/multimodal/vlm/remote/remote-vlm-shared.ts`
- Create: `packages/gateway/src/multimodal/vlm/remote/remote-vlm.test.ts`
- Modify: `packages/gateway/src/multimodal/build-media-pass-deps.ts`

**Interfaces:**

- Consumes: `VlmProvider`, `VlmDescribeInput` (Task 6); `FetchLike` from `../ollama-vlm.ts`;
  `RemoteVlmVendor` (Task 2); `vendorApiKeyName` from `llm/vendor-vault-keys.ts`.
- Produces: `createRemoteVlm(opts: RemoteVlmOptions): VlmProvider` — ONE factory, dispatching on
  vendor internally. A single factory name is what D27(a) confines in Task 11; three separately
  named factories would need three allow-list entries and one of them would eventually be forgotten.

```ts
export interface RemoteVlmOptions {
  readonly vendor: RemoteVlmVendor;
  readonly apiKey: () => Promise<string | null>;
  readonly model?: string;
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}
```

**Two leak rules carried over from `llm/cloud-provider-base.ts`, both load-bearing:**

1. **Never echo a vendor's error body.** It can quote the submitted key back, and this text reaches
   the user through the pass summary.
2. **Never carry a thrown fetch's `message`, only its `name`.** Gemini puts the API key in the URL
   query string, and a fetch failure message embeds the URL.

`postJson` from `cloud-provider-base.ts` is deliberately NOT reused: it calls the global `fetch`
with no injection seam, and `mock.module` is process-global — DI is the house rule for anything a
test must stand in for. The error taxonomy (`LlmProviderError`, `classifyHttpStatus`) IS reused, so
a vision failure classifies the same way a text failure does.

- [ ] **Step 1: Write the failing adapter tests**

Create `packages/gateway/src/multimodal/vlm/remote/remote-vlm.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { createRemoteVlm } from "./remote-vlm-shared.ts";

const BYTES = new Uint8Array([0xff, 0xd8, 0xff, 0x01]);
const b64 = Buffer.from(BYTES).toString("base64");

function capture(): {
  calls: Array<{ url: string; init: RequestInit }>;
  fetchImpl: (u: string | URL | Request, i?: RequestInit) => Promise<Response>;
  reply: (body: unknown, status?: number) => void;
} {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let next: { body: unknown; status: number } = { body: {}, status: 200 };
  return {
    calls,
    reply: (body, status = 200) => {
      next = { body, status };
    },
    fetchImpl: async (u, i) => {
      calls.push({ url: String(u), init: i ?? {} });
      return new Response(JSON.stringify(next.body), {
        status: next.status,
        headers: { "content-type": "application/json" },
      });
    },
  };
}

describe("anthropic", () => {
  test("sends media_type and base64 data, and reads the caption back", async () => {
    const c = capture();
    c.reply({ content: [{ type: "text", text: "a knife diagram" }] });
    const p = createRemoteVlm({
      vendor: "anthropic",
      apiKey: async () => "sk-ant-SECRET",
      fetchImpl: c.fetchImpl,
    });
    const out = await p.describe({ bytes: BYTES, prompt: "describe", mimeType: "image/jpeg" });
    expect(out.text).toBe("a knife diagram");

    const body = JSON.parse(String(c.calls[0]?.init.body));
    const image = body.messages[0].content.find((x: { type: string }) => x.type === "image");
    expect(image.source).toMatchObject({ type: "base64", media_type: "image/jpeg", data: b64 });
    expect(c.calls[0]?.init.headers).toMatchObject({ "x-api-key": "sk-ant-SECRET" });
  });

  /** Anthropic returns HTTP 400 without a media_type — refuse before spending the request. */
  test("REFUSES to send when mimeType is absent", async () => {
    const c = capture();
    const p = createRemoteVlm({
      vendor: "anthropic",
      apiKey: async () => "k",
      fetchImpl: c.fetchImpl,
    });
    await expect(p.describe({ bytes: BYTES, prompt: "d" })).rejects.toThrow(/mimeType/);
    expect(c.calls).toHaveLength(0);
  });
});

describe("openai", () => {
  test("sends a data: URL carrying the mime, and reads the caption back", async () => {
    const c = capture();
    c.reply({ choices: [{ message: { content: "a chart" } }] });
    const p = createRemoteVlm({
      vendor: "openai",
      apiKey: async () => "sk-SECRET",
      fetchImpl: c.fetchImpl,
    });
    expect(
      (await p.describe({ bytes: BYTES, prompt: "d", mimeType: "image/png" })).text,
    ).toBe("a chart");
    const body = JSON.parse(String(c.calls[0]?.init.body));
    const img = body.messages[0].content.find((x: { type: string }) => x.type === "image_url");
    expect(img.image_url.url).toBe(`data:image/png;base64,${b64}`);
  });
});

describe("gemini", () => {
  test("sends inline_data with mime_type, and reads the caption back", async () => {
    const c = capture();
    c.reply({ candidates: [{ content: { parts: [{ text: "a photo" }] } }] });
    const p = createRemoteVlm({
      vendor: "gemini",
      apiKey: async () => "g-SECRET",
      fetchImpl: c.fetchImpl,
    });
    expect(
      (await p.describe({ bytes: BYTES, prompt: "d", mimeType: "image/jpeg" })).text,
    ).toBe("a photo");
    const body = JSON.parse(String(c.calls[0]?.init.body));
    expect(body.contents[0].parts[1].inline_data).toMatchObject({ mime_type: "image/jpeg" });
  });
});

describe("every vendor", () => {
  test.each(["anthropic", "openai", "gemini"] as const)(
    "%s declares isLocal false — hardcoded, never derived from a URL (I34)",
    (vendor) => {
      expect(createRemoteVlm({ vendor, apiKey: async () => "k" }).isLocal).toBe(false);
    },
  );

  test.each(["anthropic", "openai", "gemini"] as const)(
    "%s refuses with no key BEFORE making a request",
    async (vendor) => {
      const c = capture();
      const p = createRemoteVlm({ vendor, apiKey: async () => null, fetchImpl: c.fetchImpl });
      await expect(
        p.describe({ bytes: BYTES, prompt: "d", mimeType: "image/jpeg" }),
      ).rejects.toThrow();
      expect(c.calls).toHaveLength(0);
    },
  );

  /**
   * A vendor error body can quote the submitted key back, and this text reaches the user through
   * the pass summary. Only the STATUS may be surfaced.
   */
  test.each(["anthropic", "openai", "gemini"] as const)(
    "%s never echoes the vendor's error body",
    async (vendor) => {
      const c = capture();
      c.reply({ error: { message: "invalid key sk-ant-SECRET-LEAKED" } }, 401);
      const p = createRemoteVlm({ vendor, apiKey: async () => "k", fetchImpl: c.fetchImpl });
      await expect(
        p.describe({ bytes: BYTES, prompt: "d", mimeType: "image/jpeg" }),
      ).rejects.toThrow(/^(?!.*SECRET-LEAKED).*$/s);
    },
  );

  /** No round-trip: a probe would be an unledgered outbound request, and there is no fallback. */
  test.each(["anthropic", "openai", "gemini"] as const)(
    "%s isAvailable is key-presence only, making no request",
    async (vendor) => {
      const c = capture();
      const p = createRemoteVlm({ vendor, apiKey: async () => "k", fetchImpl: c.fetchImpl });
      expect(await p.isAvailable()).toBe(true);
      expect(c.calls).toHaveLength(0);
    },
  );
});
```

- [ ] **Step 2: Run and watch it fail**

Run: `bun test packages/gateway/src/multimodal/vlm/remote/remote-vlm.test.ts`
Expected: FAIL — `Cannot find module './remote-vlm-shared.ts'`.

- [ ] **Step 3: Write the shared factory**

Create `packages/gateway/src/multimodal/vlm/remote/remote-vlm-shared.ts`:

```ts
/**
 * The remote `VlmProvider` — ONE factory for all three vendors (spec § 18.7, § 19.5).
 *
 * ONE name rather than three (`createAnthropicVlm`, ...) because static rule D27(a) confines the
 * remote constructor to a single wiring site: three names means three allow-list entries, and the
 * fourth vendor's would eventually be added without one.
 *
 * NOT built on `llm/cloud-provider-base.ts`'s `postJson`: that helper calls the global `fetch`
 * with no injection seam, and `mock.module` is process-global -- DI is the house rule for anything
 * a test must stand in for. The error taxonomy IS reused so a vision failure classifies the same
 * way a text failure does.
 *
 * TWO leak rules carried over verbatim from that module, both real:
 *   - the vendor's error BODY is never echoed -- it can quote the submitted key back, and this text
 *     reaches the user through the pass summary;
 *   - a thrown fetch contributes only its `name`, never its `message` -- Gemini puts the API key in
 *     the URL query string and a fetch failure message embeds the URL.
 */
import { classifyHttpStatus, LlmProviderError } from "../../../llm/provider-error.ts";
import type { RemoteVlmVendor } from "../../media-types.ts";
import type { FetchLike } from "../ollama-vlm.ts";
import type { VlmDescribeInput, VlmDescribeResult, VlmProvider } from "../vlm-types.ts";

export interface RemoteVlmOptions {
  readonly vendor: RemoteVlmVendor;
  /** Vault-backed. Returns null when unset -- never read from the environment (Non-Negotiable #3). */
  readonly apiKey: () => Promise<string | null>;
  readonly model?: string;
  /** Injected so tests never need a network. `mock.module` is process-global; DI is the house rule. */
  readonly fetchImpl?: FetchLike;
  readonly timeoutMs?: number;
}

/** A caption on a large image can be slow; this bounds a HANG, not slowness. */
const DEFAULT_REMOTE_VLM_TIMEOUT_MS = 2 * 60 * 1000;

export const DEFAULT_REMOTE_VLM_MODELS: Readonly<Record<RemoteVlmVendor, string>> = {
  anthropic: "claude-sonnet-5",
  openai: "gpt-5",
  gemini: "gemini-3.5-flash",
};

const ANTHROPIC_VERSION = "2023-06-01";
const MAX_TOKENS = 1024;

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/** Walks a response shape with runtime guards at every hop -- external data is `unknown` (NN #7). */
function firstString(value: unknown, path: readonly (string | number)[]): string | null {
  let cur: unknown = value;
  for (const key of path) {
    if (typeof key === "number") {
      if (!Array.isArray(cur)) return null;
      cur = cur[key];
      continue;
    }
    const rec = asRecord(cur);
    if (rec === undefined) return null;
    cur = rec[key];
  }
  return typeof cur === "string" ? cur : null;
}

type VendorRequest = { url: string; headers: Record<string, string>; body: unknown };

function buildRequest(
  vendor: RemoteVlmVendor,
  model: string,
  key: string,
  input: VlmDescribeInput,
  mime: string,
): VendorRequest {
  const data = Buffer.from(input.bytes).toString("base64");
  switch (vendor) {
    case "anthropic":
      return {
        url: "https://api.anthropic.com/v1/messages",
        headers: { "x-api-key": key, "anthropic-version": ANTHROPIC_VERSION },
        body: {
          model,
          max_tokens: MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                { type: "image", source: { type: "base64", media_type: mime, data } },
                { type: "text", text: input.prompt },
              ],
            },
          ],
        },
      };
    case "openai":
      return {
        url: "https://api.openai.com/v1/chat/completions",
        headers: { authorization: `Bearer ${key}` },
        body: {
          model,
          max_completion_tokens: MAX_TOKENS,
          messages: [
            {
              role: "user",
              content: [
                { type: "text", text: input.prompt },
                { type: "image_url", image_url: { url: `data:${mime};base64,${data}` } },
              ],
            },
          ],
        },
      };
    case "gemini":
      // The key rides the URL for this vendor -- which is exactly why a thrown fetch's message must
      // never be carried into an error below.
      return {
        url: `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        headers: {},
        body: {
          contents: [
            { parts: [{ text: input.prompt }, { inline_data: { mime_type: mime, data } }] },
          ],
        },
      };
  }
}

function readCaption(vendor: RemoteVlmVendor, payload: unknown): string {
  const text =
    vendor === "anthropic"
      ? firstString(payload, ["content", 0, "text"])
      : vendor === "openai"
        ? firstString(payload, ["choices", 0, "message", "content"])
        : firstString(payload, ["candidates", 0, "content", "parts", 0, "text"]);
  if (text === null) {
    // Returning an empty caption instead would write a row claiming an understanding that never
    // happened -- the same rule `ollama-vlm.ts` states for its own response parsing.
    throw new LlmProviderError(`${vendor} vlm: response carried no caption text`, "protocol");
  }
  return text;
}

export function createRemoteVlm(opts: RemoteVlmOptions): VlmProvider {
  const model = opts.model ?? DEFAULT_REMOTE_VLM_MODELS[opts.vendor];
  const doFetch = opts.fetchImpl ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_REMOTE_VLM_TIMEOUT_MS;

  return {
    providerId: opts.vendor,
    // HARDCODED false (I34). A cloud adapter never derives locality from a base URL -- that is the
    // local runtime's job -- and a wrong `true` would silently defeat both the egress appender and
    // any air-gap refusal at once.
    isLocal: false,
    model,

    async isAvailable(): Promise<boolean> {
      // Key presence only, deliberately: a reachability probe would be a real outbound request
      // that no ledger row covers, and there is no second arm to fall back to if it failed.
      const key = await opts.apiKey();
      return key !== null && key.trim() !== "";
    },

    async describe(input: VlmDescribeInput): Promise<VlmDescribeResult> {
      const mime = input.mimeType;
      if (mime === undefined || mime === "") {
        // Refuse BEFORE the request. Anthropic returns HTTP 400 without a media_type, and spending
        // a request to be told so costs the user money and a ledger row for nothing.
        throw new LlmProviderError(
          `${opts.vendor} vlm: refusing to send an image with no mimeType`,
          "protocol",
        );
      }
      const key = await opts.apiKey();
      if (key === null || key.trim() === "") {
        throw new LlmProviderError(`${opts.vendor} vlm: no API key configured`, "auth");
      }
      const req = buildRequest(opts.vendor, model, key, input, mime);

      let resp: Response;
      try {
        resp = await doFetch(req.url, {
          method: "POST",
          headers: { "content-type": "application/json", ...req.headers },
          body: JSON.stringify(req.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (err) {
        // NAME only. A fetch failure message embeds the request URL, and Gemini's URL carries the
        // API key.
        throw new LlmProviderError(
          `${opts.vendor} vlm: request failed: ${err instanceof Error ? err.name : "unknown"}`,
          "transport",
        );
      }
      if (!resp.ok) {
        // STATUS only -- the vendor's error text can quote the submitted key back.
        throw new LlmProviderError(
          `${opts.vendor} vlm: HTTP ${String(resp.status)}`,
          classifyHttpStatus(resp.status),
          resp.status,
        );
      }
      return { text: readCaption(opts.vendor, await resp.json()) };
    },
  };
}
```

- [ ] **Step 4: Construct and wrap it at the ONE wiring site**

In `packages/gateway/src/multimodal/build-media-pass-deps.ts`, replace Task 9's
`return undefined; // Task 10 ...` line with a wrapped construction, built ONCE per pass so one
provider serves every granted artifact:

```ts
  // THE ONLY production site that may name `createRemoteVlm` (static rule D27(a)) -- the same file
  // that already holds `createOllamaVlm` under D22(g), so one wiring site carries both and the two
  // rules cannot point at different files for the same class of object.
  const remoteProvider = wrapLedgeredVlm(
    input.db,
    createRemoteVlm({ vendor, apiKey: () => vendorApiKey(input.vault, vendor) }),
  );
```

Add a `vendorApiKey` helper beside the existing `cloudBearerFor`, reading `vendorApiKeyName(vendor)`
from the Vault and returning null when the vault is absent — fail-closed, mirroring how
`cloudBearerFor` treats a missing vault.

Then adapt it to the gate's shape — the VLM speaks `describe`, the gate speaks `understand`:

```ts
  const remoteUnderstander: Understander = {
    // DERIVED from the provider, never restated (I34).
    isLocal: remoteProvider.isLocal,
    model: `${vendor}/${remoteProvider.model}`,
    isAvailable: () => remoteProvider.isAvailable(),
    understand: async (source) => {
      const bytes = await bytesForSource(source);
      const mime = resolveWireMime(bytes, source.kind === "bytes" ? source.mime : null);
      if (mime === null) {
        throw new UnsupportedImageFormatError("not a JPEG, PNG, WebP or GIF");
      }
      const { text } = await remoteProvider.describe({
        bytes,
        prompt: IMAGE_CAPTION_PROMPT,
        mimeType: mime,
        egressMethod: "multimodal.vlm.image",
      });
      return { text };
    },
  };
```

and return `remoteUnderstander` from `buildRemoteFor`'s inner closure in place of the placeholder.

- [ ] **Step 5: Run tests to verify they pass**

Run: `bun run typecheck && bun test packages/gateway/src/multimodal`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/gateway/src/multimodal/
git commit -m "feat(multimodal): remote VLM adapters for Anthropic, OpenAI and Gemini"
```

---

### Task 11: Static rule D27

**Files:**

- Modify: `scripts/structure-audit/check-nimbus-invariants.ts`
- Modify: `scripts/structure-audit/check-nimbus-invariants.test.ts`

**Interfaces:**

- Consumes: nothing.
- Produces: `checkRemoteVlmConfinement(files): Violation[]` and
  `checkMediaGrantStoreConfinement(files): Violation[]`, both registered in the runner's rule list
  and both emitting a `::error file=...,line=...::D27(a|b) ...` line.

Mirror `checkVlmAppenderConfinement` (near line 1429) structurally rather than extending it: the two
rules guard different properties — D22(g) is egress completeness, D27(a) is gating — and one shared
function would mean a future change to either silently moving the other.

- [ ] **Step 1: Write the failing rule tests**

In `scripts/structure-audit/check-nimbus-invariants.test.ts`:

```ts
describe("D27(a) remote VLM constructor confinement", () => {
  const wiring = "packages/gateway/src/multimodal/build-media-pass-deps.ts";
  const definition = "packages/gateway/src/multimodal/vlm/remote/remote-vlm-shared.ts";

  test("passes at the wiring site when the call is inside a wrapLedgeredVlm argument list", () => {
    expect(
      checkRemoteVlmConfinement([
        file(wiring, "const p = wrapLedgeredVlm(db, createRemoteVlm({ vendor, apiKey }));"),
      ]),
    ).toEqual([]);
  });

  /** Ledgered is not gated, and unwrapped is not ledgered -- this catches the second failure. */
  test("FAILS at the wiring site when the construction is not wrapped", () => {
    expect(
      checkRemoteVlmConfinement([file(wiring, "const p = createRemoteVlm({ vendor, apiKey });")]),
    ).toHaveLength(1);
  });

  /**
   * Paren-matched per occurrence, not file-level: a second unwrapped construction planted beside a
   * legitimate wrapped one in an already-approved file was invisible to the file-level form of
   * this check, which is the exact hole D22(g) was widened to close.
   */
  test("FAILS on an unwrapped call sitting beside a wrapped one in the SAME file", () => {
    expect(
      checkRemoteVlmConfinement([
        file(
          wiring,
          "const a = wrapLedgeredVlm(db, createRemoteVlm({ vendor }));\nconst b = createRemoteVlm({ vendor });",
        ),
      ]),
    ).toHaveLength(1);
  });

  test("FAILS anywhere else, wrapped or not -- a new site demands a deliberate allow-list edit", () => {
    expect(
      checkRemoteVlmConfinement([
        file(
          "packages/gateway/src/engine/agent.ts",
          "const p = wrapLedgeredVlm(db, createRemoteVlm({ vendor }));",
        ),
      ]),
    ).toHaveLength(1);
  });

  test("exempts the factory's own definition -- there is nothing to wrap there", () => {
    expect(
      checkRemoteVlmConfinement([file(definition, "export function createRemoteVlm(opts) {}")]),
    ).toEqual([]);
  });

  test("a mention inside a comment or a string literal does not trip it", () => {
    expect(
      checkRemoteVlmConfinement([
        file(
          "packages/gateway/src/engine/agent.ts",
          '// createRemoteVlm( is discussed here\nconst s = "createRemoteVlm(";',
        ),
      ]),
    ).toEqual([]);
  });
});

describe("D27(b) media_grant table confinement", () => {
  const store = "packages/gateway/src/multimodal/media-grant-store.ts";
  const sql = "packages/gateway/src/index/media-grant-v59-sql.ts";

  test("allows the store and the V59 SQL module", () => {
    expect(
      checkMediaGrantStoreConfinement([
        file(store, "SELECT id FROM media_grant WHERE revoked_at IS NULL"),
        file(sql, "CREATE TABLE IF NOT EXISTS media_grant ("),
      ]),
    ).toEqual([]);
  });

  test.each([
    ["a read", "SELECT 1 FROM media_grant"],
    ["a write", "INSERT INTO media_grant (id) VALUES (?)"],
    ["an update", "UPDATE media_grant SET revoked_at = ?"],
  ])("FAILS on %s from anywhere else", (_n, sqlText) => {
    expect(
      checkMediaGrantStoreConfinement([
        file("packages/gateway/src/ipc/server/dispatchers.ts", sqlText),
      ]),
    ).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement both rules**

Add beside `checkVlmAppenderConfinement`:

```ts
// D27 (a): the remote VLM CONSTRUCTOR. `wrapLedgeredVlm` (D22(g)) guarantees a remote describe is
// LEDGERED; it does not guarantee it was GATED. A ledgered-but-ungated describe satisfies I29 and
// still violates I37 -- the bytes go, the row is written, no grant was ever checked. This rule
// closes exactly that, by making a non-local provider unconstructible outside the one wiring site
// that consults the grant store.
//
// Confining the CONSTRUCTOR rather than the `.describe(` call follows D26(c): the capability
// travels as a function VALUE, and a method-name regex cannot follow a provider held in a variable
// and invoked through an alias.
const D27_REMOTE_CTOR_CALL_RE = /\bcreateRemoteVlm\s*\(/;
const D27_REMOTE_CTOR_DEFINITION =
  "packages/gateway/src/multimodal/vlm/remote/remote-vlm-shared.ts";
const D27_REMOTE_CTOR_ALLOWED: readonly string[] = [
  "packages/gateway/src/multimodal/build-media-pass-deps.ts",
];

export function checkRemoteVlmConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D27_REMOTE_CTOR_DEFINITION) continue;

    // Comments AND string/template literals blanked length-preservingly, so neither can fake a
    // match nor desync the paren-depth count below.
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    const ctorMatches = [...code.matchAll(new RegExp(D27_REMOTE_CTOR_CALL_RE.source, "g"))];
    if (ctorMatches.length === 0) continue;

    const snippetAt = (index: number): Violation => {
      const line = code.slice(0, index).split("\n").length;
      return {
        rule: "remote-vlm-constructor-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      };
    };

    if (!D27_REMOTE_CTOR_ALLOWED.includes(f.relPath)) {
      for (const m of ctorMatches) out.push(snippetAt(m.index ?? 0));
      continue;
    }

    // Approved site: every `createRemoteVlm(` must sit inside a `wrapLedgeredVlm(...)` argument
    // list -- association, not co-occurrence, checked per occurrence.
    const wrapSpans: Array<[number, number]> = [];
    for (const m of code.matchAll(new RegExp(D22_VLM_WRAP_CALL_RE.source, "g"))) {
      const openIdx = (m.index ?? 0) + m[0].length - 1;
      const closeIdx = findMatchingParenClose(code, openIdx);
      if (closeIdx !== -1) wrapSpans.push([openIdx, closeIdx]);
    }
    for (const m of ctorMatches) {
      const idx = m.index ?? 0;
      if (!wrapSpans.some(([open, close]) => idx > open && idx < close)) out.push(snippetAt(idx));
    }
  }
  return out;
}

// D27 (b): the `media_grant` TABLE. Keyed on the table name in SQL text rather than on a symbol,
// because the leak this prevents is a hand-written query somewhere else reading around the store's
// `revoked_at IS NULL` filter. WEAKER than a symbol rule by construction -- a dynamically assembled
// identifier evades it, as it evades every source scanner here -- and that residual is closed the
// way the others are, by capability: only the store is handed a `Database` for this table.
const D27_GRANT_TABLE_RE = /\b(?:FROM|INTO|UPDATE|TABLE|JOIN)\s+media_grant\b/i;
const D27_GRANT_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/multimodal/media-grant-store.ts",
  "packages/gateway/src/index/media-grant-v59-sql.ts",
];

export function checkMediaGrantStoreConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D27_GRANT_TABLE_ALLOWED.includes(f.relPath)) continue;
    // Comments blanked ONLY: the table name legitimately lives inside string literals here, which
    // is the whole point -- so literals must NOT be stripped for this rule.
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D27_GRANT_TABLE_RE.source, "gi"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "media-grant-table-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}
```

Register both in the runner's rule list, and add their `::error` lines beside D22(g)'s (near
line 2003):

```ts
        `::error file=${e.file},line=${e.line}::D27(a) a non-local VlmProvider constructed outside build-media-pass-deps.ts, or not wrapped by wrapLedgeredVlm — an ungated remote describe; I37 regression: ${e.snippet}`,
        `::error file=${e.file},line=${e.line}::D27(b) media_grant reached outside media-grant-store.ts — a caller can synthesise a grant or read around the active-row filter; I37 regression: ${e.snippet}`,
```

- [ ] **Step 4: Run the tests and the real audit**

Run: `bun test scripts/structure-audit/check-nimbus-invariants.test.ts && bun run audit:invariants`
Expected: PASS, and the audit reports no violations against the real tree.

- [ ] **Step 5: Red-prove against the real tree**

Temporarily add this line to `packages/gateway/src/engine/agent.ts`:

```ts
const rogue = createRemoteVlm({ vendor: "openai", apiKey: async () => null });
```

Run `bun run audit:invariants`, confirm it FAILS naming D27(a), then revert the line. A
structure-audit rule that has never been shown to fail is a rule nobody has tested.

- [ ] **Step 6: Commit**

```bash
git add scripts/structure-audit/
git commit -m "feat(security): static rule D27 — confine the remote VLM constructor and the grant table"
```

---

### Task 12: Invariant I37 — wiring, docs and enforcement test in one commit

The triple rule: wiring (landed across Tasks 9–11), docs, and the enforcement test move together.

**Files:**

- Modify: `packages/gateway/src/security-invariants.test.ts`
- Modify: `docs/SECURITY-INVARIANTS.md`
- Modify: `CLAUDE.md`, `GEMINI.md`

**Interfaces:**

- Consumes: everything from Tasks 1–11.
- Produces: no new symbols — the invariant row and its enforcement test.

- [ ] **Step 1: Write the enforcement test**

In `packages/gateway/src/security-invariants.test.ts`:

```ts
describe("I37 — a media body reaches a non-local model only under a grant", () => {
  /** Negative control FIRST: without it, "zero rows" would pass for any reason at all. */
  test("no grant: the gate refuses, contacts nothing, and appends NO egress row", async () => {
    const db = freshDb();
    let contacted = false;
    const res = await understandArtifact(imageCandidate(), imageSource(), {
      enabled: true,
      capabilityDisabled: false,
      understanderFor: () => ({
        isLocal: false,
        model: "gpt-5",
        isAvailable: async () => true,
        understand: async () => {
          contacted = true;
          return { text: "leaked" };
        },
      }),
      remoteFor: () => undefined, // no grant
      gpu: { acquire: async () => () => undefined, touch: () => undefined },
    });
    expect(res).toEqual({ ok: false, reason: "no_remote_grant" });
    expect(contacted).toBe(false);
    expect(countEgress(db, "model")).toBe(0);
  });

  test("with a grant: the describe happens and appends exactly one model row BEFORE it", async () => {
    const db = freshDb();
    const order: string[] = [];
    const provider = wrapLedgeredVlm(db, {
      providerId: "openai",
      isLocal: false,
      model: "gpt-5",
      isAvailable: async () => true,
      describe: async () => {
        // The row must already exist by the time the request runs: a window with zero rows must
        // mean nothing left, never that something left unrecorded.
        expect(countEgress(db, "model")).toBe(1);
        order.push("request");
        return { text: "a caption" };
      },
    });
    await provider.describe({ bytes: new Uint8Array([1]), prompt: "p", mimeType: "image/png" });
    expect(order).toEqual(["request"]);
    expect(countEgress(db, "model")).toBe(1);
  });

  test("payload_summary carries the model and a byte COUNT, never the bytes or the prompt", async () => {
    const db = freshDb();
    const provider = wrapLedgeredVlm(db, fakeRemoteVlm());
    await provider.describe({
      bytes: new Uint8Array([1, 2, 3, 4]),
      prompt: "SECRET PROMPT",
      mimeType: "image/png",
    });
    const summary = egressRows(db)[0]?.payloadSummary ?? "";
    expect(summary).toContain("4");
    expect(summary).not.toContain("SECRET PROMPT");
  });

  test("a local provider is returned UNCHANGED and appends nothing (I34-derived)", () => {
    const db = freshDb();
    const local = { ...fakeRemoteVlm(), isLocal: true };
    expect(wrapLedgeredVlm(db, local)).toBe(local);
  });

  test("the grant store REFUSES an av grant, so no av artifact can reach a remote model", () => {
    const db = freshDb();
    expect(() =>
      createGrant(db, { itemId: "i", modality: "av", modelVendor: "openai", nowMs: 1 }),
    ).toThrow(MediaGrantRefusedError);
  });
});
```

- [ ] **Step 2: Run and confirm it passes against the shipped wiring**

Run: `bun test packages/gateway/src/security-invariants.test.ts`
Expected: PASS.

- [ ] **Step 3: Write the docs entry**

Add the I37 section to `docs/SECURITY-INVARIANTS.md` using § 18.6's wording verbatim, plus D27's two
rules and the § 19 amendments: the confinement site is `build-media-pass-deps.ts` (not
`media-gate.ts`, which constructs nothing); a grant is a permission and not a mandate; AV is refused
at write time.

Add the I37 row to `CLAUDE.md`'s Security Invariants list and the identical row to `GEMINI.md`. Add
`I37 (D27)` to the "Static complement" paragraph's enumeration in both.

- [ ] **Step 4: Verify the docs gates**

Run: `bun run audit:doc-refs && bun run audit:status-drift && bun run lint:markdown`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/security-invariants.test.ts docs/SECURITY-INVARIANTS.md CLAUDE.md GEMINI.md
git commit -m "feat(security): invariant I37 — a media body reaches a non-local model only under a grant"
```

---

### Task 13: `nimbus media allow-remote`

**Files:**

- Create: `packages/cli/src/commands/media-grants-cmd.ts`
- Create: `packages/cli/src/commands/media-grants-cmd.test.ts`
- Modify: `packages/cli/src/commands/media-cmd.ts` (subcommand dispatch only)

**Interfaces:**

- Consumes: IPC `media.allowRemote` (Task 15).
- Produces:

```ts
export interface AllowRemoteArgs {
  readonly itemIds: readonly string[];  // explicit form
  readonly service?: string;            // selector form
  readonly sinceDays?: number;
  readonly limit?: number;              // MANDATORY in the selector form
}
export interface GrantPreviewItem {
  readonly itemId: string;
  readonly title: string;
  readonly sizeBytes: number | null;
  readonly modifiedAt: number;
  readonly service: string;
  readonly alreadyGranted: boolean;
}
export function parseAllowRemoteArgs(argv: readonly string[]): AllowRemoteArgs;
export function renderGrantPreview(p: {
  readonly items: readonly GrantPreviewItem[];
  readonly vendor: string;
}): string;
export const MAX_GRANT_LIMIT = 500;
```

- [ ] **Step 1: Write the failing tests**

Create `packages/cli/src/commands/media-grants-cmd.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { GrantPreviewItem } from "./media-grants-cmd.ts";
import { parseAllowRemoteArgs, renderGrantPreview } from "./media-grants-cmd.ts";

describe("parseAllowRemoteArgs", () => {
  test("accepts explicit item ids", () => {
    expect(parseAllowRemoteArgs(["item_42", "item_43"]).itemIds).toEqual(["item_42", "item_43"]);
  });

  /**
   * § 18.5: an unbounded "grant everything" must not be EXPRESSIBLE. A selector with no --limit is
   * a refusal, not a default -- a default would be a number the user never chose.
   */
  test("REFUSES a selector form with no --limit", () => {
    expect(() => parseAllowRemoteArgs(["--service", "google_photos"])).toThrow(/--limit/);
  });

  test("REFUSES a --limit above the cap", () => {
    expect(() => parseAllowRemoteArgs(["--service", "google_photos", "--limit", "5000"])).toThrow(
      /limit/,
    );
  });

  test("REFUSES mixing explicit ids with a selector", () => {
    expect(() => parseAllowRemoteArgs(["item_1", "--service", "google_photos"])).toThrow();
  });
});

describe("renderGrantPreview", () => {
  const items: GrantPreviewItem[] = [
    {
      itemId: "i1",
      title: "chart.png",
      sizeBytes: 390_842,
      modifiedAt: 1_700_000_000_000,
      service: "google_photos",
      alreadyGranted: false,
    },
    {
      itemId: "i2",
      title: "diagram.png",
      sizeBytes: null,
      modifiedAt: 1_700_000_000_000,
      service: "google_photos",
      alreadyGranted: true,
    },
  ];

  /** § 18.5: "20 items" is a count, not consent. The preview ENUMERATES. */
  test("enumerates every artifact by title, never just a count", () => {
    const out = renderGrantPreview({ items, vendor: "openai" });
    expect(out).toContain("chart.png");
    expect(out).toContain("diagram.png");
  });

  /**
   * § 18.5, new in PR 4: since the cloud arm shipped, approving a grant authorises a CROSS-VENDOR
   * transfer -- bytes stored with one provider sent to a different one. The preview names both ends.
   */
  test("names BOTH ends of the transfer", () => {
    const out = renderGrantPreview({ items, vendor: "openai" });
    expect(out).toContain("source google_photos");
    expect(out).toContain("destination openai");
  });

  test("a local artifact reads 'source local'", () => {
    const first = items[0];
    if (first === undefined) throw new Error("fixture");
    const out = renderGrantPreview({
      items: [{ ...first, service: "filesystem" }],
      vendor: "openai",
    });
    expect(out).toContain("source local");
  });

  /** § 19.6: a count that silently includes rows the run did not write is a dishonest preview. */
  test("separates newly matched from already-granted", () => {
    const out = renderGrantPreview({ items, vendor: "openai" });
    expect(out).toMatch(/1 new/);
    expect(out).toMatch(/1 already granted/);
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test packages/cli/src/commands/media-grants-cmd.test.ts`
Expected: FAIL — `Cannot find module './media-grants-cmd.ts'`.

- [ ] **Step 3: Implement**

Create `packages/cli/src/commands/media-grants-cmd.ts` with `MAX_GRANT_LIMIT = 500`; a parser that
refuses a selector with no `--limit`, refuses a limit above the cap, and refuses mixed forms; and
`renderGrantPreview` printing one line per artifact (title, formatted size via `formatBytes` from
`media-cmd.ts`, date), then the dual-ended summary line, then the new/already-granted split.

The confirmation prompt must name the destination vendor on the SAME line as the question, so a
user who scrolled past a 20-line enumeration still sees where the bytes go before typing `y`:

```text
Send 16 artifacts to openai? This cannot be undone for bytes already sent. [y/N]
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/cli/src/commands/`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/commands/
git commit -m "feat(cli): nimbus media allow-remote, with an enumerated dual-ended preview"
```

---

### Task 14: `nimbus media grants list` and `grants revoke`

**Files:**

- Modify: `packages/cli/src/commands/media-grants-cmd.ts`
- Modify: `packages/cli/src/commands/media-grants-cmd.test.ts`

**Interfaces:**

- Consumes: IPC `media.grants.list`, `media.grants.revoke` (Task 15).
- Produces: `renderGrantList(grants): string`, `parseGrantsRevokeArgs(argv): { itemId: string; modelVendor?: string }`.

- [ ] **Step 1: Write the failing tests**

```ts
describe("renderGrantList", () => {
  test("names the vendor per grant — the whole point is which third party may see what", () => {
    const out = renderGrantList([
      { itemId: "i1", title: "chart.png", modelVendor: "openai", grantedAt: 1_700_000_000_000 },
    ]);
    expect(out).toContain("openai");
    expect(out).toContain("chart.png");
  });

  test("an empty list says so plainly rather than printing a bare header", () => {
    expect(renderGrantList([])).toMatch(/no active grants/i);
  });
});

describe("parseGrantsRevokeArgs", () => {
  test("--vendor narrows the revocation; without it every vendor's grant on the item goes", () => {
    expect(parseGrantsRevokeArgs(["i1", "--vendor", "openai"]).modelVendor).toBe("openai");
    expect(parseGrantsRevokeArgs(["i1"]).modelVendor).toBeUndefined();
  });

  test("REFUSES with no item id rather than revoking everything", () => {
    expect(() => parseGrantsRevokeArgs([])).toThrow();
  });
});
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test packages/cli/src/commands/media-grants-cmd.test.ts`
Expected: FAIL — neither function is exported.

- [ ] **Step 3: Implement, then verify**

Run: `bun test packages/cli/src/commands/`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add packages/cli/src/commands/
git commit -m "feat(cli): nimbus media grants list and grants revoke"
```

---

### Task 15: The three IPC methods

**Files:**

- Modify: `packages/gateway/src/ipc/server/dispatchers.ts`
- Modify: `packages/gateway/src/ipc/server/dispatchers.test.ts`
- Modify: `packages/gateway/src/ipc/lan-rpc.ts`
- Modify: `packages/gateway/src/ipc/lan-rpc.test.ts`

**Interfaces:**

- Consumes: the grant store (Task 2), `MultimodalConfig.remoteVlm` (Task 5).
- Produces: `media.allowRemote`, `media.grants.list`, `media.grants.revoke`, dispatched from
  `tryDispatchMediaRpc` beside the existing `media.understand`.

- [ ] **Step 1: Write the failing tests**

```ts
test("media.allowRemote writes a grant and reports new-vs-already-granted", async () => {
  const res = await dispatch("media.allowRemote", { itemIds: ["i1", "i1"], vendor: "openai" });
  expect(res).toMatchObject({ granted: 1, alreadyGranted: 1 });
});

/**
 * A grant for a vendor the install cannot use is the ships-inert pattern; silently rewriting the
 * caller's vendor to the configured one would be worse, since the user asked for a specific
 * third party.
 */
test("media.allowRemote REFUSES a vendor that is not the configured one", async () => {
  await expect(
    dispatch("media.allowRemote", { itemIds: ["i1"], vendor: "anthropic" }),
  ).rejects.toThrow();
});

/**
 * LAN-forbidden for the same reason `media.understand` is: consent to send a user's photos to a
 * third party is the local owner's to give, and a peer must never be able to grant it -- nor to
 * ENUMERATE which artifacts the owner has already exposed.
 */
test.each(["media.allowRemote", "media.grants.list", "media.grants.revoke"])(
  "%s is LAN-forbidden",
  (method) => {
    expect(checkLanMethodAllowed(method).allowed).toBe(false);
  },
);
```

- [ ] **Step 2: Run and watch them fail**

Run: `bun test packages/gateway/src/ipc/`
Expected: FAIL — unknown methods.

- [ ] **Step 3: Implement**

Widen `tryDispatchMediaRpc`'s method guard from an equality check on `"media.understand"` to a
membership check over the four media methods, dispatching each. `media.allowRemote` validates the
requested vendor against the CONFIGURED `remote_vlm` and refuses a mismatch.

Add all three to the LAN-forbidden list beside `media.understand`.

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test packages/gateway/src/ipc/ && bun run audit:status-drift`
Expected: PASS. `audit:status-drift` derives IPC surface claims from code and fails if a doc ledger
disagrees — fix the doc in Task 16, never by weakening the audit.

- [ ] **Step 5: Commit**

```bash
git add packages/gateway/src/ipc/
git commit -m "feat(ipc): media.allowRemote, media.grants.list and media.grants.revoke, all LAN-forbidden"
```

---

### Task 16: Documentation

**Files:**

- Modify: `docs/architecture.md`, `docs/cli-reference.md`, `docs/roadmap.md`, `docs/CHANGELOG.md`,
  `CLAUDE.md`, `GEMINI.md`.

- [ ] **Step 1: Update every surface**

- `docs/architecture.md` — schema V59 and the `media_grant` table.
- `docs/cli-reference.md` — `allow-remote`, `grants list`, `grants revoke`, `[multimodal] remote_vlm`,
  and the images-only bound stated where a user will actually read it.
- `docs/roadmap.md` — the S2 multimodal row closes as 4 of 4, carrying §§ 12.1, 12.2, 12.7 and the
  Photos-acceptance gap recorded in § 20.2.
- `docs/CHANGELOG.md` — a dated entry.
- `CLAUDE.md` + `GEMINI.md` — the status paragraph gains PR 4; schema 58 → 59; the invariant ceiling
  becomes I37.

**Re-read the `model`-class "no named exclusions" sentence against PR 4 rather than assuming it
survives** — § 14 says so explicitly. It does survive, because `wrapLedgeredVlm` already covers a
remote describe and PR 4 adds no appender. But it must be CHECKED, not assumed: that sentence is
the strongest claim either file makes about egress.

- [ ] **Step 2: Correct every restatement, not just the first**

```bash
grep -rn "I1–I36\|I1-I36\|through I36\|I28 reserved) and\|V58\b" CLAUDE.md GEMINI.md docs/ .claude/
```

A total that is still right can hide an enumeration that is wrong — when a count changes, re-derive
the list rather than only the number.

- [ ] **Step 3: Run the doc gates**

Run: `bun run audit:doc-refs && bun run audit:status-drift && bun run lint:markdown && bun run audit:readme-cli`
Expected: PASS.

- [ ] **Step 4: Full preflight**

Run: `bun run preflight`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/ CLAUDE.md GEMINI.md
git commit -m "docs(multimodal): PR 4 remote arm — I37, V59, allow-remote and the grants surface"
```

---

## Self-Review

**1. Spec coverage.** Every § 18 subsection maps to a task: 18.1 → Tasks 5, 9; 18.2 → Tasks 5, 10;
18.3 → Tasks 1, 2; 18.4 → Task 13 (CLI-only granting; no consent broker is built, per § 3.1's
amended placement map); 18.5 → Task 13; 18.6 → Task 12; 18.7 → Task 11; 18.8 → Task 12 (asserts no
coverage-class change); 18.9 → Task 16; 18.10 → Task 16. Every § 19 disposition maps too:
19.1 → Task 4; 19.2 → Task 6; 19.3 → Tasks 7 and 9; 19.4 → Tasks 2 and 9 (refused at write AND at
resolution — two independent refusals, deliberately); 19.5 → Task 11; 19.6 → Tasks 2 and 13;
19.7 → Tasks 2 and 3; 19.8 → Task 5; 19.A → Task 8.

**2. A known gap, stated rather than hidden.** § 20.3's finding 2 — the byte fetch runs before the
gate, so a refusal still spends the byte budget — is NOT fixed here. It predates PR 4 and its fix
(an availability pre-check before `fetchCloudBytes`) is independent of the remote arm. PR 4 does not
worsen it for ungranted artifacts, which download and caption locally exactly as today, but a
REMOTE-granted artifact whose vendor is unreachable now downloads and then refuses. Worth a
follow-up issue; adding it here would widen this plan past its spec.

**3. Type consistency.** `Understander` (Task 8) is the name used in Tasks 9 and 10.
`understanderFor(modality, candidate)` carries that arity in Tasks 8, 9 and 10. `RemoteVlmVendor`
(Task 2) is consumed by Tasks 5, 9, 10 and 15. `createGrant`'s `{ id, alreadyActive }` return is
what Tasks 13 and 15 render. `resolveWireMime(bytes, declared)` (Task 6) is called with that exact
signature in Tasks 6 and 10. `WireImageMime` is the value passed as `mimeType` in Tasks 6 and 10.
`MediaGrantRefusedError` (Task 2) is asserted in Tasks 2 and 12.

**4. One structural decision worth re-reading before Task 10.** The three vendors ship as ONE
factory in `remote-vlm-shared.ts`, not three per-vendor files. Three files would each hold one
`case` of a switch with identical leak-rule handling — verbatim duplication jscpd would flag — and
three factory NAMES would need three D27(a) allow-list entries, one of which would eventually be
added without one. The File Structure section says so too; the two agree.

**5. The plan's own riskiest assumption.** Task 10's request bodies are written from each vendor's
documented image API, and none of them has been exercised against a live endpoint here. The PR 3
acceptance run (§ 20) is the precedent: a fetch path can be green against fakes on every leg and
still be untested where it matters. The tests in Task 10 prove the SHAPE this code sends, not that
any vendor accepts it — so PR 4's own acceptance run, against at least one real vendor key, is the
thing that closes it, and it should be treated as part of the work rather than a follow-up.
