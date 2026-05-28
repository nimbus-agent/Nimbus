import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { NimbusFilesystemRootToml } from "../config/filesystem-toml.ts";
import { extensionProcessEnv } from "../extensions/spawn-env.ts";
import { upsertIndexedItemForSync } from "../index/item-store.ts";
import { type Syncable, type SyncContext, type SyncResult, syncNoopResult } from "../sync/types.ts";
import { decodeNimbusJsonCursorPayload, encodeNimbusJsonCursor } from "./nimbus-json-cursor.ts";

const SERVICE_ID = "filesystem";
const CURSOR_PREFIX = "nimbus-fsv2:";

type FsCursorV1 = { tips: Record<string, string> };

function encodeCursor(c: FsCursorV1): string {
  return encodeNimbusJsonCursor(CURSOR_PREFIX, c);
}

function decodeCursor(raw: string | null): FsCursorV1 {
  if (raw === null || raw === "") {
    return { tips: {} };
  }
  const parsed = decodeNimbusJsonCursorPayload(raw, CURSOR_PREFIX);
  if (
    parsed === undefined ||
    parsed === null ||
    typeof parsed !== "object" ||
    Array.isArray(parsed)
  ) {
    return { tips: {} };
  }
  const rec = parsed as Record<string, unknown>;
  const tipsRaw = rec["tips"];
  const tips: Record<string, string> = {};
  if (tipsRaw !== null && typeof tipsRaw === "object" && !Array.isArray(tipsRaw)) {
    for (const [k, v] of Object.entries(tipsRaw as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "") {
        tips[k] = v;
      }
    }
  }
  return { tips };
}

function isExcluded(relPath: string, exclude: readonly string[]): boolean {
  const norm = relPath.replaceAll("\\", "/");
  const parts = norm.split("/");
  for (const p of parts) {
    if (exclude.includes(p)) {
      return true;
    }
  }
  return false;
}

function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git"));
}

function rootKey(root: string): string {
  return createHash("sha256").update(root).digest("hex").slice(0, 16);
}

async function gitLogRecords(
  root: string,
  maxCount: number,
): Promise<{ sha: string; ct: number; subject: string }[]> {
  const args = [
    "git",
    "-C",
    root,
    "log",
    `--max-count=${String(maxCount)}`,
    "-z",
    "--pretty=format:%H%x00%ct%x00%s",
  ];
  const proc = Bun.spawn(args, {
    env: extensionProcessEnv({}),
    stdout: "pipe",
    stderr: "pipe",
  });
  const code = await proc.exited;
  const out = await new Response(proc.stdout).text();
  if (code !== 0) {
    return [];
  }
  const chunks = out.split("\0").filter((s) => s !== "");
  const outList: { sha: string; ct: number; subject: string }[] = [];
  for (let i = 0; i + 2 < chunks.length; i += 3) {
    const sha = chunks[i] ?? "";
    const ctRaw = chunks[i + 1] ?? "0";
    const subject = chunks[i + 2] ?? "";
    if (sha.length !== 40) {
      continue;
    }
    const ct = Number.parseInt(ctRaw, 10);
    outList.push({ sha, ct: Number.isFinite(ct) ? ct * 1000 : Date.now(), subject });
  }
  return outList;
}

function listPackageJsonFiles(
  root: string,
  exclude: readonly string[],
  maxFiles: number,
): string[] {
  const found: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (found.length >= maxFiles || depth > 8) {
      return;
    }
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true }) as Dirent[];
    } catch {
      return;
    }
    for (const ent of entries) {
      if (found.length >= maxFiles) {
        return;
      }
      const name = String(ent.name);
      if (exclude.includes(name)) {
        continue;
      }
      const full = join(dir, name);
      const rel = relative(root, full);
      if (isExcluded(rel, exclude)) {
        continue;
      }
      if (ent.isDirectory()) {
        walk(full, depth + 1);
      } else if (ent.isFile() && name === "package.json") {
        found.push(full);
      }
    }
  };
  walk(root, 0);
  return found;
}

function parsePackageJsonDeps(path: string): { name: string; version: string; kind: string }[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    return [];
  }
  let j: unknown;
  try {
    j = JSON.parse(raw) as unknown;
  } catch {
    return [];
  }
  if (j === null || typeof j !== "object" || Array.isArray(j)) {
    return [];
  }
  const rec = j as Record<string, unknown>;
  const out: { name: string; version: string; kind: string }[] = [];
  const dep = rec["dependencies"];
  const devDep = rec["devDependencies"];
  const add = (o: unknown, kind: string): void => {
    if (o === null || typeof o !== "object" || Array.isArray(o)) {
      return;
    }
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      if (typeof v === "string" && k !== "") {
        out.push({ name: k, version: v, kind });
      }
    }
  };
  add(dep, "dependency");
  add(devDep, "devDependency");
  return out;
}

async function syncFilesystemGitCommits(
  ctx: SyncContext,
  root: string,
  rk: string,
  now: number,
  nextTips: Record<string, string>,
): Promise<{ upserted: number; bytes: number }> {
  if (!isGitRepo(root)) {
    return { upserted: 0, bytes: 0 };
  }
  const commits = await gitLogRecords(root, 40);
  let upserted = 0;
  const bytes = commits.length * 80;
  for (const c of commits) {
    const externalId = `${c.sha}_${rk}`;
    upsertIndexedItemForSync(ctx, {
      service: SERVICE_ID,
      type: "git_commit",
      externalId,
      title: c.subject.length > 200 ? c.subject.slice(0, 200) : c.subject,
      bodyPreview: c.sha,
      url: null,
      canonicalUrl: null,
      modifiedAt: c.ct,
      authorId: null,
      metadata: { repoRoot: root, sha: c.sha, subject: c.subject },
      pinned: false,
      syncedAt: now,
    });
    upserted += 1;
  }
  if (commits.length > 0 && commits[0] !== undefined) {
    nextTips[`git:${root}`] = commits[0].sha;
  }
  return { upserted, bytes };
}

function syncFilesystemPackageDeps(
  ctx: SyncContext,
  root: string,
  exclude: readonly string[],
  rk: string,
  now: number,
): { upserted: number; bytes: number } {
  let upserted = 0;
  let bytes = 0;
  const manifests = listPackageJsonFiles(root, exclude, 80);
  for (const manifestPath of manifests) {
    const deps = parsePackageJsonDeps(manifestPath);
    bytes += deps.length * 40;
    const rel = relative(root, manifestPath);
    for (const d of deps) {
      const extId = `dep:${rk}:${rel.replaceAll("\\", "/")}:${d.name}:${d.kind}`;
      upsertIndexedItemForSync(ctx, {
        service: SERVICE_ID,
        type: "dependency",
        externalId: extId,
        title: `${d.name}@${d.version}`,
        bodyPreview: d.kind,
        url: null,
        canonicalUrl: null,
        modifiedAt: now,
        authorId: null,
        metadata: {
          packageName: d.name,
          version: d.version,
          kind: d.kind,
          manifestPath: rel,
          repoRoot: root,
        },
        pinned: false,
        syncedAt: now,
      });
      upserted += 1;
    }
  }
  return { upserted, bytes };
}

function syncFilesystemCodeSymbolsForRoot(
  ctx: SyncContext,
  root: string,
  exclude: readonly string[],
  rk: string,
  now: number,
): { upserted: number; bytes: number } {
  let upserted = 0;
  let bytes = 0;
  const files = listCodeFiles(root, exclude, 120);
  for (const fp of files) {
    let src: string;
    try {
      src = readFileSync(fp, "utf8");
    } catch {
      continue;
    }
    bytes += src.length;
    const rel = relative(root, fp);
    const symbols = extractExportedSymbols(src, fp);
    let mtime = now;
    try {
      mtime = statSync(fp).mtimeMs;
    } catch {
      /* keep now */
    }
    for (const sym of symbols) {
      const extId = `sym:${rk}:${rel.replaceAll("\\", "/")}:${sym.name}:${sym.kind}`;
      const relNorm = rel.replaceAll("\\", "/");
      const excerpt = excerptAroundExportedSymbol(src, sym.name, 380);
      const bodyPreview = excerpt === "" ? relNorm : `${relNorm}\n${excerpt}`;
      upsertIndexedItemForSync(ctx, {
        service: SERVICE_ID,
        type: "code_symbol",
        externalId: extId,
        title: `${sym.name} (${sym.kind})`,
        bodyPreview,
        url: null,
        canonicalUrl: null,
        modifiedAt: mtime,
        authorId: null,
        metadata: {
          name: sym.name,
          kind: sym.kind,
          file: rel.replaceAll("\\", "/"),
          repoRoot: root,
        },
        pinned: false,
        syncedAt: now,
      });
      upserted += 1;
    }
  }
  return { upserted, bytes };
}

const CODE_EXT = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

function readDirectoryDirentsOrUndefined(dir: string): Dirent[] | undefined {
  try {
    return readdirSync(dir, { withFileTypes: true }) as Dirent[];
  } catch {
    return undefined;
  }
}

function pushIfCodeExtensionFile(name: string, full: string, found: string[]): void {
  const lower = name.toLowerCase();
  const dot = lower.lastIndexOf(".");
  const ext = dot >= 0 ? lower.slice(dot) : "";
  if (CODE_EXT.has(ext)) {
    found.push(full);
  }
}

function walkCodeFilesRecursive(
  root: string,
  exclude: readonly string[],
  maxFiles: number,
  found: string[],
  dir: string,
  depth: number,
): void {
  if (found.length >= maxFiles || depth > 10) {
    return;
  }
  const entries = readDirectoryDirentsOrUndefined(dir);
  if (entries === undefined) {
    return;
  }
  for (const ent of entries) {
    if (found.length >= maxFiles) {
      return;
    }
    const name = String(ent.name);
    if (exclude.includes(name)) {
      continue;
    }
    const full = join(dir, name);
    const rel = relative(root, full);
    if (isExcluded(rel, exclude)) {
      continue;
    }
    if (ent.isDirectory()) {
      walkCodeFilesRecursive(root, exclude, maxFiles, found, full, depth + 1);
    } else if (ent.isFile()) {
      pushIfCodeExtensionFile(name, full, found);
    }
  }
}

function listCodeFiles(root: string, exclude: readonly string[], maxFiles: number): string[] {
  const found: string[] = [];
  walkCodeFilesRecursive(root, exclude, maxFiles, found, root, 0);
  return found;
}

function excerptAroundExportedSymbol(source: string, symbolName: string, maxChars: number): string {
  const lines = source.split(/\r?\n/);
  let hit = -1;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (!line.includes(symbolName) || !/\bexport\b/.test(line)) {
      continue;
    }
    hit = i;
    break;
  }
  if (hit < 0) {
    const flat = source.replaceAll(/\s+/g, " ").trim();
    return flat.length <= maxChars ? flat : flat.slice(0, maxChars);
  }
  const from = Math.max(0, hit - 6);
  const to = Math.min(lines.length, hit + 10);
  const text = lines.slice(from, to).join("\n").trim();
  return text.length <= maxChars ? text : text.slice(0, maxChars);
}

function extractExportedSymbols(
  source: string,
  filePath: string,
): { name: string; kind: string }[] {
  const out: { name: string; kind: string }[] = [];
  const max = Math.min(source.length, 256_000);
  const slice = source.slice(0, max);
  const exportFn = /export\s+async\s+function\s+(\w+)/g;
  const exportFn2 = /export\s+function\s+(\w+)/g;
  const exportConst = /export\s+const\s+(\w+)/g;
  const exportClass = /export\s+class\s+(\w+)/g;
  const exportType = /export\s+type\s+(\w+)/g;
  const add = (re: RegExp, kind: string): void => {
    re.lastIndex = 0;
    for (;;) {
      const m = re.exec(slice);
      if (m === null) {
        break;
      }
      const n = m[1];
      if (n !== undefined && n !== "") {
        out.push({ name: n, kind });
      }
    }
  };
  add(exportFn, "function");
  add(exportFn2, "function");
  add(exportConst, "const");
  add(exportClass, "class");
  add(exportType, "type");
  if (out.length === 0 && filePath !== "") {
    return [];
  }
  return out;
}

export type FilesystemV2SyncableOptions = {
  roots: readonly NimbusFilesystemRootToml[];
};

export function createFilesystemV2Syncable(options: FilesystemV2SyncableOptions): Syncable {
  const initialSyncDepthDays = 30;
  return {
    serviceId: SERVICE_ID,
    defaultIntervalMs: 10 * 60 * 1000,
    initialSyncDepthDays,
    async sync(ctx: SyncContext, cursor: string | null): Promise<SyncResult> {
      const t0 = performance.now();
      if (options.roots.length === 0) {
        return syncNoopResult(cursor, t0);
      }
      await ctx.rateLimiter.acquire("filesystem");
      const tips = decodeCursor(cursor).tips;
      const nextTips: Record<string, string> = { ...tips };
      let upserted = 0;
      const now = Date.now();
      let bytes = 0;

      for (const rootCfg of options.roots) {
        const root = rootCfg.path;
        if (!existsSync(root) || !statSync(root).isDirectory()) {
          continue;
        }
        const rk = rootKey(root);

        if (rootCfg.gitAware) {
          const g = await syncFilesystemGitCommits(ctx, root, rk, now, nextTips);
          upserted += g.upserted;
          bytes += g.bytes;
        }

        if (rootCfg.dependencyGraph) {
          const d = syncFilesystemPackageDeps(ctx, root, rootCfg.exclude, rk, now);
          upserted += d.upserted;
          bytes += d.bytes;
        }

        if (rootCfg.codeIndex) {
          const c = syncFilesystemCodeSymbolsForRoot(ctx, root, rootCfg.exclude, rk, now);
          upserted += c.upserted;
          bytes += c.bytes;
        }
      }

      return {
        cursor: encodeCursor({ tips: nextTips }),
        itemsUpserted: upserted,
        itemsDeleted: 0,
        hasMore: false,
        durationMs: Math.round(performance.now() - t0),
        bytesTransferred: bytes,
      };
    },
  };
}
