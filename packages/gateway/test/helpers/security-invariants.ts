/**
 * Shared helpers for the invariant enforcement tests (`src/security-invariants/`).
 *
 * They live under `test/`, not `src/`, on purpose: `readDirFiles` and `grepRepo` scan
 * `packages/gateway/src` for production TypeScript and skip only `*.test.ts`, so a helper file
 * kept in `src/` would be scanned as production code. This file is outside every scanned root.
 *
 * `REPO_ROOT` and `SRC_ROOT` resolve from this file's own location (`packages/gateway/test/helpers`), never from the process cwd.
 */
import { Database } from "bun:sqlite";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  INVARIANTS_ENTRY_REL,
  readInvariantsSource,
} from "../../../../scripts/structure-audit/invariants-source.ts";
import {
  confirmTemplateKeys,
  parseConfirmTemplate,
} from "../../src/connectors/connector-writes/confirm-template.ts";
import { CONNECTOR_WRITE_ROWS } from "../../src/connectors/connector-writes/index.ts";
import type { ConnectorWriteRow } from "../../src/connectors/connector-writes/types.ts";
import type { PlannedAction } from "../../src/engine/types.ts";
import type { ReachRunner } from "../../src/extensions/extension-reach.ts";
import { CURRENT_SCHEMA_VERSION } from "../../src/index/local-index.ts";
import { runIndexedSchemaMigrations } from "../../src/index/migrations/runner.ts";
import { HttpWriteRateLimiter } from "../../src/ipc/http-rate-limit.ts";
import type { NimbusVault } from "../../src/vault/nimbus-vault.ts";

/** A runner with a live posture: healthy per-host on Linux unless told otherwise. */
export function reachRunner(
  confine: () => string | null,
  opts: {
    platform?: "linux" | "darwin" | "win32";
    fullyActive?: boolean;
    reason?: string | null;
  } = {},
): ReachRunner {
  const platform = opts.platform ?? "linux";
  const scopes = { win32: "all_or_nothing", darwin: "per_port" } as const;
  const scope = platform === "linux" ? undefined : scopes[platform];
  return {
    platform,
    isFullyActive: () => opts.fullyActive ?? true,
    degradedReason: () => opts.reason ?? null,
    ...(scope === undefined ? {} : { networkScope: () => scope }),
    canConfine: confine,
  };
}

export function baseInvariantWriteCtx() {
  return {
    writeDb: new Database(":memory:"),
    expectedToken: "",
    rateLimiter: new HttpWriteRateLimiter({ maxRequests: 60, windowMs: 60_000 }),
    nowMs: () => 1000,
    knownServices: () => [] as readonly string[],
  };
}

/** Minimal in-memory vault fake (get/set/delete/listKeys) — mirrors clip-token-store.test.ts. */
export function fakeVault(seed: Record<string, string> = {}): NimbusVault {
  const store = new Map(Object.entries(seed));
  return {
    get: async (k) => store.get(k) ?? null,
    set: async (k, v) => void store.set(k, v),
    delete: async (k) => void store.delete(k),
    listKeys: async (prefix) =>
      [...store.keys()].filter((k) => prefix === undefined || k.startsWith(prefix)),
  };
}
export const REPO_ROOT = resolve(import.meta.dir, "../../../..");
export const SRC_ROOT = resolve(REPO_ROOT, "packages/gateway/src");

export async function read(relPathFromRepoRoot: string): Promise<string> {
  // The static auditor is one entry point plus the modules under invariants/; a pin on what it
  // names reads all of them.
  if (relPathFromRepoRoot === INVARIANTS_ENTRY_REL) return readInvariantsSource(REPO_ROOT);
  return readFile(resolve(REPO_ROOT, relPathFromRepoRoot), "utf8");
}

/**
 * Concatenate the PRODUCTION TypeScript under a directory, recursively.
 *
 * Both qualifiers are load-bearing and both were missing. `readdir` without `recursive` cannot
 * see a subdirectory, so nesting a spawn file one level down removed it from every check built on
 * this helper; and including `*.test.ts` let test files count toward a production floor, so the
 * floor could be met by fixtures asserting that the production code is wrong.
 */
export async function readDirConcat(relDirFromRepoRoot: string): Promise<string> {
  return (await readDirFiles(relDirFromRepoRoot)).map((f) => f.contents).join("\n");
}

/**
 * The same walk, but keeping each file separate.
 *
 * A concatenated blob forces any per-file exemption to be expressed as a per-SHAPE exemption, and
 * a shape exemption applies to every file in the scan. That is not hypothetical: exempting
 * `wrap-server-spec.ts`'s own env literal by its `{` shape also exempted every multi-line `env: {`
 * anywhere under lazy-mesh, including one spreading `process.env`.
 */
export async function readDirFiles(
  relDirFromRepoRoot: string,
): Promise<{ rel: string; contents: string }[]> {
  const dir = resolve(REPO_ROOT, relDirFromRepoRoot);
  const entries = await readdir(dir, { recursive: true });
  const tsFiles = entries
    .map((f) => f.replaceAll("\\", "/"))
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts"));
  return Promise.all(
    tsFiles.map(async (rel) => ({ rel, contents: await readFile(resolve(dir, rel), "utf8") })),
  );
}

/**
 * Every PRODUCTION file (test files excluded, per `readDirFiles`) under `packages/gateway/src`
 * whose content matches `pattern`, as repo-root-relative paths sorted for a stable comparison. I39's
 * "recordToolEgress is the ONLY tool-class appender in the tree" test needs a repo-wide search
 * primitive, not a single-file read — a second appender planted anywhere else in the tree must be
 * visible to it.
 */
export async function grepRepo(pattern: RegExp): Promise<string[]> {
  const files = await readDirFiles("packages/gateway/src");
  return files
    .filter((f) => pattern.test(f.contents))
    .map((f) => `packages/gateway/src/${f.rel}`)
    .sort();
}

// ---- Per-write coverage helpers (ruling E1: they live in test code, never in a production .ts; here, outside `src/`).
export interface WriteUnderTest {
  readonly label: string;
  readonly action: PlannedAction;
}

/**
 * A wave 4 row needs an input its confirm text can be rendered from (Phase 9.7 D0a), so the tests
 * that drive every row through the executor give each placeholder a plain value. Other rows: `{}`.
 */
export function confirmableInput(row: ConnectorWriteRow): Record<string, unknown> {
  if (row.confirm === undefined) return {};
  const parsed = parseConfirmTemplate(row.confirm.template);
  if (!parsed.ok) throw new Error(parsed.reason);
  const input: Record<string, unknown> = {};
  for (const name of confirmTemplateKeys(parsed.segments)) {
    input[name] = name === "instanceIds" ? ["i-1"] : "x1";
  }
  // A multi-file commit (D1c) must also pass its row's input check: one small new file.
  if (row.bound?.prepare.inputRefusal !== undefined && row.bound.prepare.settle === undefined) {
    input["message"] = "m";
    input["files"] = [{ path: "a.txt", content: "x" }];
  }
  // A plan-bound IaC row (D2) passes its own input check too: an absolute directory, a template.
  if (row.bound?.prepare.settle === "iac-terraform") input["workingDirectory"] = "/srv/x1";
  if (row.bound?.prepare.settle === "iac-cfn") input["templateBody"] = "Resources: {}";
  // The Kubernetes apply (D3a) derives its typed target from a manifest the gateway parses: its
  // input is three real keys, never a `target`.
  if (row.bound?.prepare.settle === "k8s-manifest") {
    return {
      context: "x1",
      namespace: "x1",
      manifest: ["apiVersion: v1", "kind: ConfigMap", "metadata:", "  name: x1", ""].join("\n"),
    };
  }
  return input;
}

/**
 * What a fake connector answers to a BOUND row's prepare read (D1c): a head and every file as new.
 * `undefined` for a row that is not bound.
 */
export function censusPrepareReply(
  row: ConnectorWriteRow | undefined,
  input: Record<string, unknown>,
): unknown {
  if (row?.bound === undefined) return undefined;
  // A settled row (D2) takes its values from the settler, not from this reply.
  if (row.bound.prepare.settle !== undefined) return {};
  const files = (input["files"] as Array<{ path: string }>).map((f) => ({
    path: f.path,
    exists: false,
    mode: "100644",
  }));
  return { headSha: "a".repeat(40), files };
}

/**
 * The capabilities a settled bound row (D2) needs on its dispatcher: a preflight that accepts and a
 * settler that binds a placeholder for each of the row's bound fields (the production settlers are
 * tested on their own). `undefined` for every other row, so they run on a dispatcher without them.
 */
export function censusCapabilities(row: ConnectorWriteRow | undefined):
  | {
      boundWriteCapabilities: {
        preflight: () => Promise<{ ok: true; release: () => void }>;
        settle: () => Promise<{
          values: Record<string, string>;
          fields: Array<{ label: string; value: string }>;
          cleanup: () => Promise<void>;
        }>;
      };
    }
  | Record<string, never> {
  if (row?.bound?.prepare.settle === undefined) return {};
  const fields = row.bound.binds.map((b) => b.field);
  return {
    boundWriteCapabilities: {
      preflight: async () => ({ ok: true, release: () => undefined }),
      settle: async () => ({
        values: Object.fromEntries(fields.map((f) => [f, `settled-${f}`])),
        fields: [{ label: "Plan", value: "settled" }],
        cleanup: async () => undefined,
      }),
    },
  };
}

/** Every row (built the way its door builds it, ruling E2) plus the four gate-confined writes. */
export function writesUnderTest(): readonly WriteUnderTest[] {
  const rows: WriteUnderTest[] = CONNECTOR_WRITE_ROWS.map((row) => {
    const input = confirmableInput(row);
    return {
      label: row.toolId,
      action:
        row.transport === "mesh"
          ? { type: row.actionType, payload: { mcpToolId: row.toolId, input } }
          : { type: row.actionType, payload: input },
    };
  });
  const confined = [
    "slack.chat.post",
    "teams.chat.post",
    "notion.knowledge.write",
    "confluence.knowledge.write",
  ].map((t) => ({ label: t, action: { type: t, payload: {} } }));
  return [...rows, ...confined];
}

let migratedTemplate: Uint8Array | undefined;

/** A fully migrated in-memory database; migrated once, then cloned (a migration run per row is slow). */
export function freshEgressDb(): Database {
  if (migratedTemplate === undefined) {
    const seed = new Database(":memory:");
    runIndexedSchemaMigrations(seed, CURRENT_SCHEMA_VERSION);
    migratedTemplate = seed.serialize();
    seed.close();
  }
  return Database.deserialize(migratedTemplate);
}

export function egressRows(
  db: Database,
): Array<{ resultStatus: string; destination: string; hitlStatus: string }> {
  return db
    .query(
      "SELECT result_status AS resultStatus, destination, hitl_status AS hitlStatus FROM egress_ledger ORDER BY id",
    )
    .all() as Array<{ resultStatus: string; destination: string; hitlStatus: string }>;
}
