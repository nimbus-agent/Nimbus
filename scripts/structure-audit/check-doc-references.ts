#!/usr/bin/env bun

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { Glob } from "bun";
import { REPO_ROOT } from "./lib.ts";

type Mode = "check" | "report";

type Reference = {
  source: string;
  sourceLine: number;
  raw: string;
  target: string;
  lineHint?: number;
};

type Issue = {
  ref: Reference;
  reason: string;
};

const KNOWN_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".json",
  ".jsonc",
  ".md",
  ".toml",
  ".yml",
  ".yaml",
  ".rs",
  ".sh",
  ".ps1",
  ".py",
  ".sql",
  ".css",
  ".html",
  ".lock",
  ".properties",
  ".env",
  ".cfg",
  ".ini",
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".svg",
  ".webp",
  ".pdf",
  ".txt",
]);

const REPO_ROOT_ENTRIES = new Set([
  "packages",
  "docs",
  "scripts",
  ".github",
  ".claude",
  "package.json",
  "bun.lock",
  "tsconfig.json",
  "biome.json",
  "sonar-project.properties",
  ".dependency-cruiser.cjs",
  ".gitleaksignore",
  "CLAUDE.md",
  "GEMINI.md",
  "LICENSE",
]);

const PATH_REJECT_CHARS = ["<", ">", "*", "?", "{", "}", "[", "]", "$", "(", ")", "|", " "];

const DOCS_FILES = [
  "CLAUDE.md",
  "GEMINI.md",
  "docs/architecture.md",
  "docs/SECURITY.md",
  "docs/SECURITY-INVARIANTS.md",
  "docs/security-hardening.md",
  "docs/sonar-local.md",
  "docs/cli-reference.md",
  "docs/CONTRIBUTING.md",
  "docs/CODE_OF_CONDUCT.md",
  "docs/README.md",
  "docs/install-macos-unsigned.md",
  "docs/install-windows-unsigned.md",
  "docs/verify-release-integrity.md",
  "docs/license-policy.md",
];

const DOCS_GLOBS = [".claude/commands/*.md"];

function hasRejectChar(s: string): boolean {
  for (const ch of PATH_REJECT_CHARS) if (s.includes(ch)) return true;
  return false;
}

function getExtension(s: string): string {
  const dot = s.lastIndexOf(".");
  if (dot < 0) return "";
  return s.slice(dot).toLowerCase();
}

function looksLikePathTarget(s: string): boolean {
  if (!s) return false;
  if (s.startsWith("http://") || s.startsWith("https://")) return false;
  if (s.startsWith("mailto:")) return false;
  if (s.startsWith("#")) return false;
  if (s.startsWith("@")) return false;
  if (s.startsWith("~")) return false;
  if (hasRejectChar(s)) return false;
  return true;
}

function splitTargetParts(raw: string): { path: string; lineHint?: number } {
  const anchorIx = raw.indexOf("#");
  const noAnchor = anchorIx >= 0 ? raw.slice(0, anchorIx) : raw;
  const m = /^(.*?):(\d+)$/.exec(noAnchor);
  if (m) return { path: m[1] ?? "", lineHint: Number(m[2]) };
  return { path: noAnchor };
}

function offsetToLine(text: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < text.length; i++) {
    if (text[i] === "\n") line += 1;
  }
  return line;
}

function* extractMarkdownLinks(text: string): Generator<{ raw: string; offset: number }> {
  const re = /\[[^\]]*\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
  for (const m of text.matchAll(re)) {
    if (m[1] !== undefined && m.index !== undefined) {
      yield { raw: m[1], offset: m.index };
    }
  }
}

function* extractBacktickPaths(text: string): Generator<{ raw: string; offset: number }> {
  const re = /`([^`\n]+)`/g;
  for (const m of text.matchAll(re)) {
    const inner = m[1];
    if (inner === undefined || m.index === undefined) continue;
    if (!looksLikePathTarget(inner)) continue;
    const { path } = splitTargetParts(inner);
    if (!path) continue;
    const firstSeg = path.split("/")[0] ?? "";
    if (!REPO_ROOT_ENTRIES.has(firstSeg)) continue;
    const ext = getExtension(path);
    const isKnownFile = KNOWN_EXTENSIONS.has(ext);
    const isDirPath = path.includes("/") && ext === "";
    if (!isKnownFile && !isDirPath) continue;
    yield { raw: inner, offset: m.index + 1 };
  }
}

function resolveMarkdownTarget(rawTarget: string, sourceDoc: string): string | null {
  const { path } = splitTargetParts(rawTarget);
  if (!path) return null;
  if (!looksLikePathTarget(path)) return null;
  if (isAbsolute(path)) return null;
  const docDir = dirname(sourceDoc);
  const resolved = resolve(REPO_ROOT, docDir, path);
  const rel = relative(REPO_ROOT, resolved).replaceAll("\\", "/");
  if (rel.startsWith("..") || rel.startsWith("/")) return null;
  return rel;
}

async function scanDoc(docRel: string): Promise<Reference[]> {
  const abs = join(REPO_ROOT, docRel);
  if (!existsSync(abs)) return [];
  const text = await Bun.file(abs).text();
  const refs: Reference[] = [];

  for (const { raw, offset } of extractMarkdownLinks(text)) {
    const target = resolveMarkdownTarget(raw, docRel);
    if (target === null) continue;
    const { lineHint } = splitTargetParts(raw);
    refs.push({
      source: docRel,
      sourceLine: offsetToLine(text, offset),
      raw,
      target,
      ...(lineHint !== undefined ? { lineHint } : {}),
    });
  }

  for (const { raw, offset } of extractBacktickPaths(text)) {
    const { path, lineHint } = splitTargetParts(raw);
    if (!path) continue;
    refs.push({
      source: docRel,
      sourceLine: offsetToLine(text, offset),
      raw,
      target: path,
      ...(lineHint !== undefined ? { lineHint } : {}),
    });
  }

  return refs;
}

async function lineCount(absPath: string): Promise<number> {
  const text = await Bun.file(absPath).text();
  return text.split("\n").length;
}

const RUNTIME_PATH_FRAGMENTS = ["/dist", "/build", "/node_modules", "/coverage", "/.astro"];

function isRuntimeArtifactPath(target: string): boolean {
  const slashed = `/${target}`;
  for (const frag of RUNTIME_PATH_FRAGMENTS) {
    if (slashed.includes(frag)) return true;
  }
  return false;
}

async function validate(refs: readonly Reference[]): Promise<Issue[]> {
  const issues: Issue[] = [];
  const lineCache = new Map<string, number>();
  for (const ref of refs) {
    if (isRuntimeArtifactPath(ref.target)) continue;
    const abs = join(REPO_ROOT, ref.target);
    if (!existsSync(abs)) {
      issues.push({ ref, reason: "file does not exist" });
      continue;
    }
    if (ref.lineHint === undefined) continue;
    let lc = lineCache.get(abs);
    if (lc === undefined) {
      lc = await lineCount(abs);
      lineCache.set(abs, lc);
    }
    if (ref.lineHint < 1 || ref.lineHint > lc) {
      issues.push({
        ref,
        reason: `line ${ref.lineHint} out of range (file has ${lc} lines)`,
      });
    }
  }
  return issues;
}

function parseArgs(argv: readonly string[]): { mode: Mode } {
  let mode: Mode = "check";
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") mode = "check";
    else if (a === "--report") mode = "report";
    else {
      console.error(`unknown arg: ${a}`);
      process.exit(2);
    }
  }
  return { mode };
}

async function gatherDocs(): Promise<string[]> {
  const docs: string[] = [];
  for (const d of DOCS_FILES) {
    if (existsSync(join(REPO_ROOT, d))) docs.push(d);
  }
  for (const pattern of DOCS_GLOBS) {
    for await (const rel of new Glob(pattern).scan({ cwd: REPO_ROOT })) {
      docs.push(rel.replaceAll("\\", "/"));
    }
  }
  return docs;
}

async function run(): Promise<void> {
  const { mode } = parseArgs(Bun.argv);
  const docs = await gatherDocs();
  const allRefs: Reference[] = [];
  for (const doc of docs) {
    const refs = await scanDoc(doc);
    allRefs.push(...refs);
  }
  const issues = await validate(allRefs);

  if (mode === "report") {
    console.log(`Scanned ${docs.length} docs, ${allRefs.length} refs`);
    for (const issue of issues) {
      console.log(
        `BROKEN  ${issue.ref.source}:${issue.ref.sourceLine}  → \`${issue.ref.raw}\`  (${issue.reason})`,
      );
    }
    console.log(`${issues.length} broken refs`);
    process.exit(issues.length === 0 ? 0 : 1);
  }

  if (issues.length === 0) {
    console.log(
      `Doc-reference check: ${allRefs.length} refs across ${docs.length} docs — all resolve.`,
    );
    return;
  }
  for (const issue of issues) {
    console.error(
      `::error file=${issue.ref.source},line=${issue.ref.sourceLine}::broken doc reference \`${issue.ref.raw}\`: ${issue.reason}`,
    );
  }
  console.error(`\n${issues.length} broken doc references across ${docs.length} docs.`);
  process.exit(1);
}

await run();
