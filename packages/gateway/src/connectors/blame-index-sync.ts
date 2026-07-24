import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import {
  type BlameRow,
  parseBlamePorcelain,
  pruneBlameForFile,
  upsertBlameLines,
} from "../security/blame-store.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

type SpawnFn = typeof Bun.spawn;
const GIT_TIMEOUT_MS = 30_000;

/** A single file's change relative to a prior HEAD, as parsed from
 * `git diff --name-status -M`. A rename is expanded by the caller to a
 * `D` (old path) + `A` (new path, carrying `oldPath`). */
export interface BlameChange {
  readonly path: string;
  readonly status: "A" | "M" | "D";
  readonly oldPath?: string;
}

async function runGit(
  root: string,
  args: readonly string[],
  spawn: SpawnFn,
): Promise<{ code: number; out: string }> {
  try {
    const proc = spawn(["git", "-C", root, ...args], {
      env: extensionProcessEnv({}),
      stdout: "pipe",
      stderr: "pipe",
      signal: AbortSignal.timeout(GIT_TIMEOUT_MS),
    });
    const code = await proc.exited;
    const out = await new Response(proc.stdout).text();
    return { code, out };
  } catch {
    // AbortError (timeout), ENOENT (git not on PATH), or spawn failure → treated
    // as a non-fatal empty result so the indexer degrades to zero blame.
    return { code: 1, out: "" };
  }
}

/** `git rev-parse HEAD`; null if not a resolvable 40-hex sha (empty repo, not a repo). */
export async function gitHeadSha(root: string, spawn: SpawnFn = Bun.spawn): Promise<string | null> {
  const { code, out } = await runGit(root, ["rev-parse", "HEAD"], spawn);
  const sha = out.trim();
  return code === 0 && /^[0-9a-f]{40}$/.test(sha) ? sha : null;
}

/** True iff `sha` is an ancestor of HEAD (`git merge-base --is-ancestor`). A
 * false result means history was rewritten (or the sha is unknown) → the caller
 * should fall back to a full re-blame rather than an incremental diff. */
export async function isAncestor(
  root: string,
  sha: string,
  spawn: SpawnFn = Bun.spawn,
): Promise<boolean> {
  const { code } = await runGit(root, ["merge-base", "--is-ancestor", sha, "HEAD"], spawn);
  return code === 0;
}

/** Tracked files with at least one commit in the last `windowDays`, repo-relative
 * and deduped. NUL-separated to survive any path characters. */
export async function gitBlameWindowFiles(
  root: string,
  windowDays: number,
  spawn: SpawnFn = Bun.spawn,
): Promise<string[]> {
  const { code, out } = await runGit(
    root,
    ["log", `--since=${String(windowDays)} days ago`, "--name-only", "--pretty=format:", "-z"],
    spawn,
  );
  if (code !== 0) return [];
  const seen = new Set<string>();
  for (const p of out.split("\0")) {
    const f = p.trim();
    if (f !== "") seen.add(f);
  }
  return [...seen];
}

/** Parsed `git diff --name-status -M <sinceSha> HEAD`. Renames (`R###`) expand
 * to a `D` of the old path plus an `A` of the new path (carrying `oldPath`). */
export async function gitChangedSince(
  root: string,
  sinceSha: string,
  spawn: SpawnFn = Bun.spawn,
): Promise<BlameChange[]> {
  const { code, out } = await runGit(
    root,
    ["diff", "--name-status", "-M", "-z", sinceSha, "HEAD"],
    spawn,
  );
  if (code !== 0) return [];
  const toks = out.split("\0").filter((s) => s !== "");
  const changes: BlameChange[] = [];
  for (let i = 0; i < toks.length; ) {
    const st = toks[i] ?? "";
    if (st.startsWith("R")) {
      // rename: <status>\0<oldPath>\0<newPath>
      changes.push({ status: "D", path: toks[i + 1] ?? "" });
      changes.push({ status: "A", path: toks[i + 2] ?? "", oldPath: toks[i + 1] ?? "" });
      i += 3;
    } else {
      const s = st.charAt(0);
      const status = s === "A" ? "A" : s === "D" ? "D" : "M";
      changes.push({ status, path: toks[i + 1] ?? "" });
      i += 2;
    }
  }
  return changes;
}

/** Whole-file `git blame --line-porcelain`; empty on any non-zero exit. */
export async function gitBlameWholeFile(
  root: string,
  relFile: string,
  spawn: SpawnFn = Bun.spawn,
): Promise<BlameRow[]> {
  const { code, out } = await runGit(root, ["blame", "--line-porcelain", "--", relFile], spawn);
  if (code !== 0) return [];
  return parseBlamePorcelain(out);
}

// --- The Syncable ---

const SERVICE_ID = "blame";
const CURSOR_PREFIX = "nimbus-blame1:";
const DEFAULT_WINDOW_DAYS = 90;
/** Per-root per-tick cap. Bounds a first-run full index on a large repo; the
 * remainder is picked up by later ticks' incremental path (or the next full run,
 * which re-evaluates the cap). Files are processed sequentially — one `git blame`
 * subprocess at a time — so there is no FD/CPU storm. */
const MAX_BLAME_FILES = 400;

interface BlameCursor {
  readonly heads: Record<string, string>;
}

function decodeCursor(raw: string | null): BlameCursor {
  if (raw === null) return { heads: {} };
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (parsed !== null && typeof parsed === "object" && "heads" in parsed) {
    const heads = (parsed as { heads: unknown }).heads;
    if (heads !== null && typeof heads === "object") {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(heads as Record<string, unknown>)) {
        if (typeof v === "string") out[k] = v;
      }
      return { heads: out };
    }
  }
  return { heads: {} };
}

export type BlameIndexSyncableOptions = {
  roots: readonly NimbusFilesystemRootToml[];
  windowDays?: number;
};

/** Re-blames one file whole, idempotently: prune first (also cleans a stale or
 * deleted file), then re-blame if it still exists on disk. Returns the blamed
 * line count (0 = file gone / no blame). */
async function blameOneFile(ctx: SyncContext, root: string, relFile: string): Promise<number> {
  pruneBlameForFile(ctx.db, root, relFile);
  if (!existsSync(join(root, relFile))) return 0; // deleted/renamed-away: skip the spawn
  const rows = await gitBlameWholeFile(root, relFile);
  if (rows.length > 0) upsertBlameLines(ctx.db, root, relFile, rows);
  return rows.length;
}

/**
 * A whole-file, `windowDays`-bounded blame indexer. Per configured filesystem
 * root that is a git repo, it blames every git-tracked file with a commit in the
 * window (all languages), storing one `git_blame_line` row per line. Incremental
 * via a per-repo last-blamed HEAD cursor; falls back to a full re-blame when the
 * recorded head is no longer an ancestor of HEAD (history rewrite). Reuses the
 * V32 `git_blame_line` table — no migration.
 */
export function createBlameIndexSyncable(options: BlameIndexSyncableOptions): Syncable {
  const windowDays = options.windowDays ?? DEFAULT_WINDOW_DAYS;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays: DEFAULT_WINDOW_DAYS,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      if (options.roots.length === 0) {
        return syncNoopResult(cursor, t0);
      }
      await ctx.rateLimiter.acquire(SERVICE_ID);

      const { heads } = decodeCursor(cursor);
      const nextHeads: Record<string, string> = { ...heads };
      let filesBlamed = 0; // itemsUpserted unit: files blamed this tick

      for (const rootCfg of options.roots) {
        const root = rootCfg.path;
        if (!existsSync(root) || !statSync(root).isDirectory()) continue;
        const head = await gitHeadSha(root);
        if (head === null) continue; // not a git repo / empty repo

        const last = heads[root];
        if (last === undefined || !(await isAncestor(root, last))) {
          // Full path (first run or rewritten history).
          const files = await gitBlameWindowFiles(root, windowDays);
          if (files.length > MAX_BLAME_FILES) {
            ctx.logger.info(
              { service: SERVICE_ID, root, total: files.length, cap: MAX_BLAME_FILES },
              "blame window exceeds per-tick cap; remainder picked up on later ticks",
            );
          }
          for (const f of files.slice(0, MAX_BLAME_FILES)) {
            if ((await blameOneFile(ctx, root, f)) > 0) filesBlamed += 1;
          }
        } else {
          // Incremental path.
          for (const ch of await gitChangedSince(root, last)) {
            if (ch.status === "D") {
              pruneBlameForFile(ctx.db, root, ch.path);
            } else if ((await blameOneFile(ctx, root, ch.path)) > 0) {
              filesBlamed += 1;
            }
          }
        }
        nextHeads[root] = head;
      }

      return {
        cursor: encodeNimbusJsonCursor(CURSOR_PREFIX, { heads: nextHeads }),
        itemsUpserted: filesBlamed,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
      };
    },
  };
}
