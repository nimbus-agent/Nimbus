import { createHash } from "node:crypto";
import {
  closeSync,
  fstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import {
  createRegisterSimpleTool,
  createZodToolRegistrar,
  mcpJsonResult as jsonResult,
  requireProcessEnv,
} from "../../shared/mcp-tool-kit.ts";

const VAULT_MARKER = ".obsidian";
const DEFAULT_IGNORED_DIR_NAMES = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "target",
  ".next",
  "out",
  "vendor",
  ".cache",
]);

function vaultIdFromAbsolutePath(absolutePath: string): string {
  return createHash("sha256").update(absolutePath).digest("hex").slice(0, 12);
}

function stripTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && (s.charAt(end - 1) === "/" || s.charAt(end - 1) === "\\")) end--;
  return s.slice(0, end);
}

function assertWithinVault(vaultRoot: string, relPath: string): string {
  const resolvedRoot = resolve(vaultRoot);
  const candidate = resolve(resolvedRoot, relPath);
  if (candidate !== resolvedRoot && !candidate.startsWith(resolvedRoot + sep)) {
    throw new Error(`Path escapes vault: ${relPath}`);
  }
  return candidate;
}

function loadVaultPaths(): readonly string[] {
  const raw = requireProcessEnv("OBSIDIAN_VAULT_PATHS_JSON");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("OBSIDIAN_VAULT_PATHS_JSON is not valid JSON");
  }
  if (!Array.isArray(parsed) || parsed.some((p) => typeof p !== "string")) {
    throw new Error("OBSIDIAN_VAULT_PATHS_JSON must be a JSON array of strings");
  }
  return parsed as string[];
}

type VaultEntry = { id: string; root: string; name: string };

function discoverVaults(roots: readonly string[]): readonly VaultEntry[] {
  const out: VaultEntry[] = [];
  for (const r of roots) {
    walkForVaults(r, out);
  }
  return out;
}

function walkForVaults(dir: string, out: VaultEntry[]): void {
  let entries: readonly string[];
  try {
    if (!statSync(dir).isDirectory()) return;
    entries = readdirSync(dir);
  } catch {
    return;
  }
  if (entries.includes(VAULT_MARKER)) {
    out.push({
      id: vaultIdFromAbsolutePath(dir),
      root: dir,
      name: basename(stripTrailingSlashes(dir)),
    });
  }
  for (const e of entries) {
    if (e === VAULT_MARKER || DEFAULT_IGNORED_DIR_NAMES.has(e)) continue;
    const sub = join(dir, e);
    let isDir = false;
    try {
      const st = statSync(sub);
      isDir = st.isDirectory() && !st.isSymbolicLink();
    } catch {
      continue;
    }
    if (isDir) walkForVaults(sub, out);
  }
}

function listNotesInVault(vaultRoot: string): readonly string[] {
  const out: string[] = [];
  walkNotes(vaultRoot, vaultRoot, out);
  return out;
}

function walkNotes(currentDir: string, vaultRoot: string, out: string[]): void {
  let entries: readonly string[];
  try {
    if (!statSync(currentDir).isDirectory()) return;
    entries = readdirSync(currentDir);
  } catch {
    return;
  }
  if (currentDir !== vaultRoot && entries.includes(VAULT_MARKER)) return;
  for (const e of entries) {
    if (e === VAULT_MARKER || DEFAULT_IGNORED_DIR_NAMES.has(e)) continue;
    const full = join(currentDir, e);
    let isFile = false;
    let isDir = false;
    try {
      const st = statSync(full);
      if (st.isSymbolicLink()) continue;
      isFile = st.isFile();
      isDir = st.isDirectory();
    } catch {
      continue;
    }
    if (isFile && full.toLowerCase().endsWith(".md")) {
      out.push(relative(vaultRoot, full).replaceAll("\\", "/"));
    } else if (isDir) {
      walkNotes(full, vaultRoot, out);
    }
  }
}

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
const H1_RE = /^#\s+(\S.*)$/m;

function readNote(
  vaultRoot: string,
  relPath: string,
): { title: string; body: string; raw: string } {
  const abs = assertWithinVault(vaultRoot, relPath);
  const raw = readFileSync(abs, "utf8");
  const m = FRONTMATTER_RE.exec(raw);
  const body = m === null ? raw : raw.slice(m[0].length);
  const h1 = H1_RE.exec(body);
  const title =
    h1?.[1]?.trim() !== undefined && h1[1].trim() !== ""
      ? h1[1].trim()
      : basename(relPath).replace(/\.md$/i, "");
  return { title, body, raw };
}

function noteIdFor(vaultId: string, relPath: string): string {
  return `obsidian:${vaultId}#${relPath}`;
}

function findVaultByIdOrPathPrefix(
  vaults: readonly VaultEntry[],
  needle: string,
): VaultEntry | undefined {
  return vaults.find((v) => v.id === needle || v.root === needle);
}

const server = new McpServer({ name: "nimbus-obsidian", version: "0.1.0" });
const registerSimpleTool = createRegisterSimpleTool(server);

import { createWriteToolRegistrar } from "../../shared/consent-kit.ts";

const reg = createZodToolRegistrar(registerSimpleTool);

/**
 * Every MUTATING obsidian tool goes through here. Outside the gateway this adds the
 * consent gate, the write-scope allow-list, the mutation budget and the audit record; inside
 * the gateway it is a pass-through, because executor.ts (I2) is the gate there.
 */
const registerWriteTool = createWriteToolRegistrar(server, {
  connector: "obsidian",
  scopeEnv: "NIMBUS_MCP_OBSIDIAN_WRITE_SCOPE",
  scopeKinds: ["vault"],
});

const VAULTS = discoverVaults(loadVaultPaths());

const obsidianListSchema = z.object({
  vault: z.string().min(1).optional(),
  tag: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(500).optional(),
});

reg(
  "obsidian_list",
  "List Obsidian notes (optionally filtered by vault id, vault path, or frontmatter tag).",
  obsidianListSchema,
  async (parsed) => {
    const limit = parsed.limit ?? 200;
    const filterVault =
      parsed.vault === undefined ? undefined : findVaultByIdOrPathPrefix(VAULTS, parsed.vault);
    const targetVaults = filterVault === undefined ? VAULTS : [filterVault];
    const out: Array<{
      id: string;
      vault_id: string;
      vault_name: string;
      path: string;
      title: string;
    }> = [];
    for (const v of targetVaults) {
      for (const rel of listNotesInVault(v.root)) {
        if (out.length >= limit) break;
        const { title, raw } = readNote(v.root, rel);
        if (parsed.tag !== undefined) {
          const fm = FRONTMATTER_RE.exec(raw);
          if (!fm?.[1]?.includes(parsed.tag)) continue;
        }
        out.push({
          id: noteIdFor(v.id, rel),
          vault_id: v.id,
          vault_name: v.name,
          path: rel,
          title,
        });
      }
    }
    return jsonResult(out);
  },
);

const obsidianGetSchema = z.object({
  id: z.string().min(1).optional(),
  vault: z.string().min(1).optional(),
  path: z.string().min(1).optional(),
});

reg(
  "obsidian_get",
  "Read a single Obsidian note by id, or by (vault, path) pair.",
  obsidianGetSchema,
  async (parsed) => {
    let v: VaultEntry | undefined;
    let rel = "";
    if (parsed.id !== undefined) {
      const m = /^obsidian:([0-9a-f]{12})#(.+)$/.exec(parsed.id);
      if (m === null) {
        throw new Error(`Invalid obsidian id: ${parsed.id}`);
      }
      v = VAULTS.find((x) => x.id === m[1]);
      rel = m[2] ?? "";
    } else if (parsed.vault !== undefined && parsed.path !== undefined) {
      v = findVaultByIdOrPathPrefix(VAULTS, parsed.vault);
      rel = parsed.path;
    } else {
      throw new Error("obsidian_get requires either `id` or both `vault` and `path`");
    }
    if (v === undefined) {
      throw new Error("Vault not found in OBSIDIAN_VAULT_PATHS_JSON discovery");
    }
    const note = readNote(v.root, rel);
    return jsonResult({
      id: noteIdFor(v.id, rel),
      vault_id: v.id,
      vault_name: v.name,
      path: rel,
      title: note.title,
      body: note.body,
    });
  },
);

const obsidianSearchSchema = z.object({
  query: z.string().min(1),
  vault: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(200).optional(),
});

reg(
  "obsidian_search",
  "Substring-match against note title and body across all configured vaults.",
  obsidianSearchSchema,
  async (parsed) => {
    const limit = parsed.limit ?? 50;
    const needle = parsed.query.toLowerCase();
    const targets =
      parsed.vault === undefined
        ? VAULTS
        : [findVaultByIdOrPathPrefix(VAULTS, parsed.vault)].filter(
            (v): v is VaultEntry => v !== undefined,
          );
    const out: Array<{
      id: string;
      vault_id: string;
      path: string;
      title: string;
      snippet: string;
    }> = [];
    outer: for (const v of targets) {
      for (const rel of listNotesInVault(v.root)) {
        if (out.length >= limit) break outer;
        const note = readNote(v.root, rel);
        const titleHit = note.title.toLowerCase().includes(needle);
        const bodyHitIdx = note.body.toLowerCase().indexOf(needle);
        if (!titleHit && bodyHitIdx < 0) continue;
        const start = Math.max(0, bodyHitIdx - 60);
        const snippet = bodyHitIdx >= 0 ? note.body.slice(start, start + 240) : "";
        out.push({
          id: noteIdFor(v.id, rel),
          vault_id: v.id,
          path: rel,
          title: note.title,
          snippet,
        });
      }
    }
    return jsonResult(out);
  },
);

const appendDailyNoteSchema = z.object({
  vault_id: z.string().min(1),
  content: z.string().min(1),
  date_iso: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const SUPPORTED_TOKENS = ["YYYY", "YY", "MM", "DD", "HH", "mm"] as const;

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

function formatDailyNoteFilename(format: string, date: Date): string {
  const r: Record<string, string> = {
    YYYY: String(date.getUTCFullYear()),
    YY: String(date.getUTCFullYear() % 100).padStart(2, "0"),
    MM: pad2(date.getUTCMonth() + 1),
    DD: pad2(date.getUTCDate()),
    HH: pad2(date.getUTCHours()),
    mm: pad2(date.getUTCMinutes()),
  };
  let out = format;
  for (const tok of SUPPORTED_TOKENS) out = out.replaceAll(tok, r[tok] ?? "");
  return out;
}

function resolveDailyNoteRelativePath(vaultRoot: string, date: Date): string {
  const cfgPath = join(vaultRoot, ".obsidian", "daily-notes.json");
  let folder = "";
  let format = "YYYY-MM-DD";
  try {
    const parsed = JSON.parse(readFileSync(cfgPath, "utf8")) as unknown;
    if (parsed !== null && typeof parsed === "object") {
      const obj = parsed as Record<string, unknown>;
      if (typeof obj["folder"] === "string") folder = obj["folder"];
      if (typeof obj["format"] === "string" && obj["format"] !== "") {
        format = obj["format"];
      }
    }
  } catch {
    // fall through to defaults
  }
  const filename = `${formatDailyNoteFilename(format, date)}.md`;
  return folder === "" ? filename : `${stripTrailingSlashes(folder)}/${filename}`;
}

registerWriteTool(
  "obsidian_append_to_daily_note",
  {
    mutates: "obsidian.note.append",
    // Append-only by construction — it never overwrites — so the note is recoverable by editing.
    recoverable: true,
    scopeTargetOf: (p) => ({ kind: "vault", value: p.vault_id }),
  },
  "Append text to today's Obsidian daily note. Creates the file if it does not exist. Always appends — never overwrites. Adds a leading newline when the existing file does not end in one. Requires HITL `obsidian.note.append`.",
  appendDailyNoteSchema,
  async (parsed) => {
    const v = findVaultByIdOrPathPrefix(VAULTS, parsed.vault_id);
    if (v === undefined) {
      throw new Error("Unknown vault_id");
    }
    const date =
      parsed.date_iso === undefined ? new Date() : new Date(`${parsed.date_iso}T00:00:00Z`);
    const rel = resolveDailyNoteRelativePath(v.root, date);
    const abs = assertWithinVault(v.root, rel);
    mkdirSync(dirname(abs), { recursive: true });

    const fd = openSync(abs, "a+");
    let bytes = 0;
    try {
      let prefix = "";
      const size = fstatSync(fd).size;
      if (size > 0) {
        const tail = Buffer.alloc(1);
        readSync(fd, tail, 0, 1, size - 1);
        if (tail[0] !== 0x0a) {
          prefix = "\n";
        }
      }
      const final = `${prefix}${parsed.content}`;
      const buf = Buffer.from(final, "utf8");
      writeSync(fd, buf);
      bytes = buf.length;
    } finally {
      try {
        closeSync(fd);
      } catch {
        // ignore close errors
      }
    }

    return jsonResult({
      appended: true,
      vault_id: v.id,
      vault_name: v.name,
      path: rel,
      bytes,
    });
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
