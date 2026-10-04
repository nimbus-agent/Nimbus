/**
 * Edge paths of the filesystem syncable that `filesystem-v2-sync.test.ts` does not reach: corrupt
 * code-index cursors, the depth and symlink bounds of the walks, directories the OS will not list
 * or search, git roots with nothing to blame, and the media indexer driven through `sync()` itself.
 *
 * Everything goes through `createFilesystemV2Syncable(...).sync()` — the walks, the cursor codec and
 * the blame bound are module-private, and the syncable is the seam production uses.
 */
import type { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import type { BlameRow } from "../security/blame-store.ts";
import type { SyncContext } from "../sync/types.ts";
import {
  createMemoryIndexDb,
  EMPTY_NIMBUS_VAULT,
  syncTestContext,
} from "./connector-sync-test-helpers.ts";
import { createFilesystemV2Syncable } from "./filesystem-v2-sync.ts";
import { decodeNimbusJsonCursorPayload } from "./nimbus-json-cursor.ts";

const CURSOR_PREFIX = "nimbus-fsv2:";

const tempDirs: string[] = [];

function tempRoot(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function rootCfg(
  path: string,
  flags: Partial<Omit<NimbusFilesystemRootToml, "path">>,
): NimbusFilesystemRootToml {
  return {
    path,
    gitAware: false,
    codeIndex: false,
    dependencyGraph: false,
    mediaIndex: false,
    exclude: [],
    ...flags,
  };
}

const ALL_LOCAL_INDEXERS = { codeIndex: true, dependencyGraph: true, mediaIndex: true } as const;

function titles(db: Database): string[] {
  return (
    db.query("SELECT title FROM item WHERE service = 'filesystem' ORDER BY title").all() as {
      title: string;
    }[]
  ).map((r) => r.title);
}

type CursorPayload = { tips?: Record<string, string>; codeMtimes?: Record<string, unknown> };

function payloadOf(cursor: string | null): CursorPayload {
  const decoded = decodeNimbusJsonCursorPayload(cursor ?? "", CURSOR_PREFIX);
  if (decoded === null || typeof decoded !== "object") {
    throw new Error(`not a filesystem cursor: ${String(cursor)}`);
  }
  return decoded as CursorPayload;
}

/** A cursor from raw JSON text — needed to carry values `JSON.stringify` cannot emit (`1e999`). */
function cursorFromJsonText(json: string): string {
  return CURSOR_PREFIX + Buffer.from(json, "utf8").toString("base64url");
}

async function git(dir: string, ...args: string[]): Promise<void> {
  const proc = Bun.spawn(["git", "-C", dir, ...args], {
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } as Record<string, string>,
    stdout: "pipe",
    stderr: "pipe",
    windowsHide: true,
  });
  const code = await proc.exited;
  if (code !== 0) {
    const err = await new Response(proc.stderr).text();
    throw new Error(`git ${args.join(" ")} exited ${String(code)}: ${err}`);
  }
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q", "-b", "main");
  await git(dir, "config", "user.email", "test@example.com");
  await git(dir, "config", "user.name", "Test");
}

/** A context whose blame writes are recorded (by file) as well as persisted. */
function blameRecordingContext(db: Database): { ctx: SyncContext; blamedFiles: string[] } {
  const base = syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem");
  const blamedFiles: string[] = [];
  const ctx: SyncContext = {
    ...base,
    upsertBlameLines: (root: string, file: string, rows: readonly BlameRow[]): void => {
      blamedFiles.push(file);
      base.upsertBlameLines(root, file, rows);
    },
  };
  return { ctx, blamedFiles };
}

/** True when this OS/user really refuses `probe` — false on Windows and when running as root. */
function throws(probe: () => unknown): boolean {
  try {
    probe();
    return false;
  } catch {
    return true;
  }
}

describe("a corrupt code-index cursor re-indexes rather than skipping or throwing", () => {
  function codeRoot(prefix: string): string {
    const dir = tempRoot(prefix);
    writeFileSync(join(dir, "a.ts"), "export function alpha() {}\nexport const A = 1;\n");
    writeFileSync(join(dir, "b.ts"), "export class Beta {}\n");
    return dir;
  }

  async function firstRun(dir: string): Promise<{ rk: string; mtimes: Record<string, number> }> {
    const sync = createFilesystemV2Syncable({ roots: [rootCfg(dir, { codeIndex: true })] });
    const db = createMemoryIndexDb();
    const first = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);
    db.close();
    const codeMtimes = payloadOf(first.cursor).codeMtimes ?? {};
    const keys = Object.keys(codeMtimes);
    expect(keys).toHaveLength(1);
    const rk = keys[0] ?? "";
    return { rk, mtimes: codeMtimes[rk] as Record<string, number> };
  }

  test.each([
    ["null", null],
    ["an array", [1700000000000]],
    ["a string", "stale"],
  ])(
    "a per-root entry that is %s is dropped, so every file of that root is re-indexed",
    async (_label, bad) => {
      const dir = codeRoot("nimbus-fsv2-cov-badroot-");
      const { rk } = await firstRun(dir);
      const sync = createFilesystemV2Syncable({ roots: [rootCfg(dir, { codeIndex: true })] });
      const db = createMemoryIndexDb();
      const corrupt = cursorFromJsonText(JSON.stringify({ tips: {}, codeMtimes: { [rk]: bad } }));

      const run = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), corrupt);
      db.close();

      // alpha + A from a.ts, Beta from b.ts: nothing was treated as already indexed.
      expect(run.itemsUpserted).toBe(3);
      // The rewritten cursor carries real, finite mtimes for both files again.
      const rewritten = payloadOf(run.cursor).codeMtimes?.[rk] as Record<string, number>;
      expect(Object.keys(rewritten).sort()).toEqual(["a.ts", "b.ts"]);
      expect(Object.values(rewritten).every((m) => Number.isFinite(m))).toBe(true);
    },
  );

  test.each([
    ["non-finite (1e999 decodes to Infinity)", "1e999"],
    ["a string", JSON.stringify("1700000000000")],
  ])("an mtime that is %s re-indexes that file only", async (_label, badJson) => {
    const dir = codeRoot("nimbus-fsv2-cov-badmtime-");
    const { rk, mtimes } = await firstRun(dir);
    const goodB = mtimes["b.ts"];
    expect(typeof goodB).toBe("number");
    const sync = createFilesystemV2Syncable({ roots: [rootCfg(dir, { codeIndex: true })] });
    const db = createMemoryIndexDb();
    // Hand-built JSON: `JSON.stringify(Infinity)` would write `null`, which is a different case.
    const corrupt = cursorFromJsonText(
      `{"tips":{},"codeMtimes":{${JSON.stringify(rk)}:{"a.ts":${badJson},"b.ts":${JSON.stringify(goodB)}}}}`,
    );

    const run = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), corrupt);
    db.close();

    // a.ts (alpha, A) is re-indexed; b.ts kept its valid entry and is skipped.
    expect(run.itemsUpserted).toBe(2);
    const rewritten = payloadOf(run.cursor).codeMtimes?.[rk] as Record<string, number>;
    expect(rewritten["b.ts"]).toBe(goodB as number);
    expect(Number.isFinite(rewritten["a.ts"])).toBe(true);
  });
});

describe("walk bounds", () => {
  test("the code and media walks index depth 10 and stop at depth 11", async () => {
    const dir = tempRoot("nimbus-fsv2-cov-depth-");
    let atTen = dir;
    for (let i = 1; i <= 10; i++) atTen = join(atTen, `d${String(i)}`);
    const atEleven = join(atTen, "d11");
    mkdirSync(atEleven, { recursive: true });
    writeFileSync(join(atTen, "edge.ts"), "export const edge = 1;\n");
    writeFileSync(join(atTen, "edge.png"), "x");
    writeFileSync(join(atEleven, "deep.ts"), "export const deep = 1;\n");
    writeFileSync(join(atEleven, "deep.png"), "x");
    const sync = createFilesystemV2Syncable({
      roots: [rootCfg(dir, { codeIndex: true, mediaIndex: true })],
    });
    const db = createMemoryIndexDb();

    await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);

    expect(titles(db)).toEqual(["edge (const)", "edge.png"]);
    db.close();
  });

  test("a symlinked directory is not followed: its target is indexed once, under its real path", async () => {
    const dir = tempRoot("nimbus-fsv2-cov-link-");
    const real = join(dir, "real");
    mkdirSync(real);
    writeFileSync(join(real, "a.ts"), "export const viaReal = 1;\n");
    writeFileSync(join(real, "pic.png"), "x");
    writeFileSync(
      join(real, "package.json"),
      JSON.stringify({ dependencies: { realdep: "1.0.0" } }),
    );
    // `junction` needs no privilege on Windows and is ignored elsewhere (a plain symlink). Either
    // way `readdir` reports the entry as a link — neither a directory nor a file.
    symlinkSync(real, join(dir, "link"), "junction");
    const sync = createFilesystemV2Syncable({ roots: [rootCfg(dir, ALL_LOCAL_INDEXERS)] });
    const db = createMemoryIndexDb();

    const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);

    expect(titles(db)).toEqual(["pic.png", "realdep@1.0.0", "viaReal (const)"]);
    expect(r.itemsUpserted).toBe(3);
    const sym = db
      .query("SELECT metadata FROM item WHERE service = 'filesystem' AND type = 'code_symbol'")
      .get() as { metadata: string };
    expect((JSON.parse(sym.metadata) as { file: string }).file).toBe("real/a.ts");
    db.close();
  });

  test("an excluded component inside a root-relative path is honoured by all three walks", async () => {
    /**
     * `isExcluded` folds `\` to `/` before splitting the root-relative path, so `vendor` is an
     * excluded component of `pkg\vendor` on EVERY platform. On Linux/macOS that is one directory
     * whose NAME contains a backslash — the bare-name check does not match it and only the
     * path-component check does. On Windows the same `mkdir` makes `pkg/vendor`, and the bare-name
     * check catches `vendor` one level down. The files inside are never indexed either way.
     */
    const dir = tempRoot("nimbus-fsv2-cov-pathexcl-");
    const vendored = join(dir, "pkg\\vendor");
    mkdirSync(vendored, { recursive: true });
    writeFileSync(join(vendored, "hidden.ts"), "export const hidden = 1;\n");
    writeFileSync(join(vendored, "hidden.png"), "x");
    writeFileSync(
      join(vendored, "package.json"),
      JSON.stringify({ dependencies: { hiddendep: "1.0.0" } }),
    );
    writeFileSync(join(dir, "shown.ts"), "export const shown = 1;\n");
    writeFileSync(join(dir, "shown.png"), "x");
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ dependencies: { showndep: "1.0.0" } }),
    );
    const sync = createFilesystemV2Syncable({
      roots: [rootCfg(dir, { ...ALL_LOCAL_INDEXERS, exclude: ["vendor"] })],
    });
    const db = createMemoryIndexDb();

    await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);

    expect(titles(db)).toEqual(["shown (const)", "shown.png", "showndep@1.0.0"]);
    db.close();
  });
});

describe("directories the OS refuses", () => {
  test("a subdirectory that cannot be listed is skipped by every walk, and the run still succeeds", async () => {
    const dir = tempRoot("nimbus-fsv2-cov-unlistable-");
    writeFileSync(join(dir, "top.ts"), "export const top = 1;\n");
    const locked = join(dir, "locked");
    mkdirSync(locked);
    writeFileSync(join(locked, "inner.ts"), "export const inner = 1;\n");
    writeFileSync(join(locked, "inner.png"), "x");
    writeFileSync(
      join(locked, "package.json"),
      JSON.stringify({ dependencies: { innerdep: "1.0.0" } }),
    );
    chmodSync(locked, 0o000);
    try {
      // SELF-VALIDATING: mode bits block a listing only on POSIX for a non-root user. Where they
      // do not (Windows, root), the directory is an ordinary one and is indexed in full.
      const listingRefused = throws(() => readdirSync(locked));
      const sync = createFilesystemV2Syncable({ roots: [rootCfg(dir, ALL_LOCAL_INDEXERS)] });
      const db = createMemoryIndexDb();

      const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);

      if (listingRefused) {
        expect(titles(db)).toEqual(["top (const)"]);
        expect(r.itemsUpserted).toBe(1);
      } else {
        expect(titles(db)).toEqual(["inner (const)", "inner.png", "innerdep@1.0.0", "top (const)"]);
        expect(r.itemsUpserted).toBe(4);
      }
      db.close();
    } finally {
      chmodSync(locked, 0o755);
    }
  });

  test("files that can be listed but not stat'd or read are skipped, recorded nowhere, and retried", async () => {
    const dir = tempRoot("nimbus-fsv2-cov-nosearch-");
    writeFileSync(join(dir, "top.ts"), "export const top = 1;\n");
    const shut = join(dir, "shut");
    mkdirSync(shut);
    writeFileSync(join(shut, "inner.ts"), "export const inner = 1;\n");
    writeFileSync(join(shut, "inner.png"), "x");
    writeFileSync(
      join(shut, "package.json"),
      JSON.stringify({ dependencies: { innerdep: "1.0.0" } }),
    );
    // r--r--r--: the directory can be LISTED (read) but not SEARCHED (execute), so its entries
    // are walked while `stat`/`open` on each of them fails.
    chmodSync(shut, 0o444);
    try {
      // SELF-VALIDATING, as above: on Windows or as root the mode does not bite.
      const listedButNotSearchable =
        !throws(() => readdirSync(shut)) && throws(() => statSync(join(shut, "inner.ts")));
      const sync = createFilesystemV2Syncable({ roots: [rootCfg(dir, ALL_LOCAL_INDEXERS)] });
      const db = createMemoryIndexDb();
      const ctx = syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem");

      const first = await sync.sync(ctx, null);
      const recorded = Object.values(payloadOf(first.cursor).codeMtimes ?? {}).flatMap((m) =>
        Object.keys(m as Record<string, number>),
      );

      if (listedButNotSearchable) {
        // The package.json read, the code file's stat + read and the media stat all failed.
        expect(titles(db)).toEqual(["top (const)"]);
        expect(recorded).toEqual(["top.ts"]);
        // Nothing about shut/inner.ts was recorded, so once it is reachable it is picked up.
        chmodSync(shut, 0o755);
        const second = await sync.sync(ctx, first.cursor);
        expect(second.itemsUpserted).toBe(3); // inner (const) + innerdep + inner.png
        expect(titles(db)).toEqual(["inner (const)", "inner.png", "innerdep@1.0.0", "top (const)"]);
      } else {
        expect(titles(db)).toEqual(["inner (const)", "inner.png", "innerdep@1.0.0", "top (const)"]);
        expect(recorded.sort()).toEqual(["shut/inner.ts", "top.ts"]);
      }
      db.close();
    } finally {
      chmodSync(shut, 0o755);
    }
  });
});

describe("git-aware roots", () => {
  test("a repository with no commits yet records no tip and blames nothing, but indexes its code", async () => {
    const dir = tempRoot("nimbus-fsv2-cov-nocommit-");
    await initRepo(dir);
    writeFileSync(join(dir, "a.ts"), "export function alpha() {}\n");
    const sync = createFilesystemV2Syncable({
      roots: [rootCfg(dir, { gitAware: true, codeIndex: true, exclude: [".git"] })],
    });
    const db = createMemoryIndexDb();
    const { ctx, blamedFiles } = blameRecordingContext(db);

    const r = await sync.sync(ctx, null);

    // `git log` and `git blame` both exit non-zero before the first commit: no git_commit rows,
    // no tip to compare against next time, and no (empty) blame write for a.ts.
    expect(r.itemsUpserted).toBe(1);
    expect(titles(db)).toEqual(["alpha (function)"]);
    expect(payloadOf(r.cursor).tips).toEqual({});
    expect(blamedFiles).toEqual([]);
    db.close();
  });

  test("a file whose indexed excerpts span more than 5000 lines is indexed but not blamed", async () => {
    const dir = tempRoot("nimbus-fsv2-cov-bigblame-");
    await initRepo(dir);
    writeFileSync(join(dir, "small.ts"), "export function small() {}\n");
    // One export every 16 lines: each export's ~16-line excerpt abuts the next, so the merged
    // blame ranges cover all 5120 lines — past MAX_BLAME_LINES (5000).
    const lines: string[] = [];
    for (let k = 0; k < 320 * 16; k++) {
      lines.push(
        k % 16 === 0 ? `export const big_${String(k)}_sym = ${String(k)};` : `// ${String(k)}`,
      );
    }
    writeFileSync(join(dir, "big.ts"), `${lines.join("\n")}\n`);
    await git(dir, "add", "small.ts", "big.ts");
    await git(dir, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "init");
    const sync = createFilesystemV2Syncable({
      roots: [rootCfg(dir, { gitAware: true, codeIndex: true, exclude: [".git"] })],
    });
    const db = createMemoryIndexDb();
    const { ctx, blamedFiles } = blameRecordingContext(db);

    await sync.sync(ctx, null);

    // The committed small file is blamed (positive control: blame really works here)...
    expect(blamedFiles).toEqual(["small.ts"]);
    // ...and big.ts was still indexed in full: the bound skips its blame, not the file.
    const bigSymbols = db
      .query(
        "SELECT COUNT(*) AS c FROM item WHERE type = 'code_symbol' AND json_extract(metadata, '$.file') = 'big.ts'",
      )
      .get() as { c: number };
    expect(bigSymbols.c).toBe(320);
    db.close();
  });
});

describe("code symbols and media through sync()", () => {
  test("an export split across lines falls back to a flat excerpt with no start line", async () => {
    const dir = tempRoot("nimbus-fsv2-cov-split-");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "split.ts"), "export\nconst splitName = 1;\n");
    const sync = createFilesystemV2Syncable({ roots: [rootCfg(dir, { codeIndex: true })] });
    const db = createMemoryIndexDb();

    await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);

    const row = db
      .query(
        "SELECT title, body_preview, metadata FROM item WHERE service = 'filesystem' AND type = 'code_symbol'",
      )
      .get() as { title: string; body_preview: string; metadata: string };
    db.close();
    expect(row.title).toBe("splitName (const)");
    // No single line holds both `export` and the name, so the whole file is flattened...
    expect(row.body_preview).toBe("src/split.ts\nexport const splitName = 1;");
    // ...and with no start line there is no excerpt anchor (and nothing to blame).
    const meta = JSON.parse(row.metadata) as Record<string, unknown>;
    expect(meta).toEqual({
      name: "splitName",
      kind: "const",
      file: "src/split.ts",
      repoRoot: dir,
    });
  });

  test("mediaIndex indexes media files as bodyless items and reports no bytes for them", async () => {
    const dir = tempRoot("nimbus-fsv2-cov-media-");
    writeFileSync(join(dir, "photo.png"), "png-bytes");
    writeFileSync(join(dir, "clip.MP4"), "mp4-bytes-longer");
    writeFileSync(join(dir, "README"), "no extension at all");
    writeFileSync(join(dir, "notes.txt"), "not a media extension");
    const sync = createFilesystemV2Syncable({ roots: [rootCfg(dir, { mediaIndex: true })] });
    const db = createMemoryIndexDb();

    const r = await sync.sync(syncTestContext(db, EMPTY_NIMBUS_VAULT, "filesystem"), null);

    expect(r.itemsUpserted).toBe(2);
    // Media is stat'd, never read, so it contributes nothing to the transfer total.
    expect(r.bytesTransferred).toBe(0);
    const rows = db
      .query(
        "SELECT type, title, body_preview, metadata FROM item WHERE service = 'filesystem' ORDER BY title",
      )
      .all() as { type: string; title: string; body_preview: string; metadata: string }[];
    db.close();
    expect(rows.map((x) => [x.type, x.title, x.body_preview])).toEqual([
      ["media_av", "clip.MP4", ""],
      ["media_image", "photo.png", ""],
    ]);
    const metas = rows.map((x) => JSON.parse(x.metadata) as Record<string, unknown>);
    expect(metas.map((m) => [m["mimeType"], m["sizeBytes"], m["mediaKind"]])).toEqual([
      ["video/mp4", 16, "av"],
      ["image/png", 9, "image"],
    ]);
  });
});
