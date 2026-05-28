# Monorepo Cleanup Pass Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Execute a whole-monorepo cleanup pass: strip all comments and migrate load-bearing rationale to markdown docs, extract real duplication into composable helpers, and apply SOLID refactors where violations exist — all while keeping security invariants I1–I16, the HITL gate, vault key names, license fields, audit-chain format, cross-platform parity, and the existing test suite intact.

**Architecture:** Six sequential passes on a single branch (`cleanup/monorepo-pass`) inside `.worktrees/cleanup-pass`. Pass 1 produces a punch list that drives passes 2–5. Pass 3 is a single mechanical script-driven commit. Passes 4 and 5 are themed/per-subsystem commits citing punch-list rows. Pass 6 is verification before opening the PR. Discovery-dependent passes use templated iteration tasks; helper modules and the strip script are written in full upfront.

**Tech Stack:** Bun v1.2+, TypeScript 6.x strict, Biome (lint+format), Bun's built-in test runner, jscpd for duplication audit, TypeScript Compiler API for the strip script.

**Spec:** `docs/superpowers/specs/2026-05-28-monorepo-cleanup-design.md` (commit `5cde7c1a` on `cleanup/monorepo-pass`).

---

## Pass 0 — Workspace prep

### Task 0.1: Verify worktree builds

**Files:** none (smoke test)

- [ ] **Step 1: Install workspace dependencies in the worktree**

Run from worktree:

```bash
cd .worktrees/cleanup-pass && bun install
```

Expected: completes without errors. `node_modules/` populates in the worktree root.

- [ ] **Step 2: Run preflight:fast as the baseline**

Run from worktree:

```bash
cd .worktrees/cleanup-pass && bun run preflight:fast
```

Expected: all cheap gates pass. This is the green baseline we measure regressions against.

- [ ] **Step 3: Capture the baseline state**

Record the commit SHA the worktree is at (`git -C .worktrees/cleanup-pass rev-parse HEAD`) in a scratchpad — you'll cite it in the final PR description.

---

## Pass 1 — Survey (read-only)

The output of Pass 1 IS the input to Passes 2–5. Every commit in those passes cites a punch-list row.

### Task 1.1: Create survey script directory and shared helpers

**Files:**

- Create: `.worktrees/cleanup-pass/scripts/cleanup/lib.ts`

- [ ] **Step 1: Write the shared helper module**

```typescript
// scripts/cleanup/lib.ts
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

export const REPO_ROOT = process.cwd();

const SKIP_DIRS = new Set([
  "node_modules", "dist", ".next", "build", "coverage",
  ".git", ".worktrees", ".turbo", "target", "out",
]);

const SOURCE_EXTS = new Set([".ts", ".tsx", ".js", ".rs"]);

export async function* iterateSourceFiles(root: string): AsyncGenerator<string> {
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      yield* iterateSourceFiles(full);
    } else if (entry.isFile()) {
      const dotIdx = entry.name.lastIndexOf(".");
      if (dotIdx > 0 && SOURCE_EXTS.has(entry.name.slice(dotIdx))) {
        yield full;
      }
    }
  }
}

export function relPath(p: string): string {
  return relative(REPO_ROOT, p).replaceAll("\\", "/");
}

export interface CommentHit {
  file: string;
  line: number;
  text: string;
  marker: string;
}
```

- [ ] **Step 2: Commit**

```bash
git -C .worktrees/cleanup-pass add scripts/cleanup/lib.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
chore(cleanup): add survey helper module

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.2: Write the load-bearing-comments survey

**Files:**

- Create: `.worktrees/cleanup-pass/scripts/cleanup/survey-comments.ts`

- [ ] **Step 1: Write the script**

```typescript
// scripts/cleanup/survey-comments.ts
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { iterateSourceFiles, REPO_ROOT, relPath, type CommentHit } from "./lib.ts";

const MARKERS = [
  { name: "I-numbered", pattern: /\bI[1-9][0-9]?\b/ },
  { name: "HITL", pattern: /\bHITL\b/ },
  { name: "WHY", pattern: /\bWHY:/ },
  { name: "NOTE", pattern: /\bNOTE:/ },
  { name: "WORKAROUND", pattern: /\bWORKAROUND\b/i },
  { name: "BUG-ref", pattern: /\bBUG-[A-Z0-9-]+\b/ },
  { name: "ticket-ref", pattern: /#\d{2,}/ },
  { name: "TODO", pattern: /\bTODO\b/ },
  { name: "FIXME", pattern: /\bFIXME\b/ },
  { name: "HACK", pattern: /\bHACK\b/ },
  { name: "XXX", pattern: /\bXXX\b/ },
  { name: "security/timing", pattern: /\b(constant-?time|side-?channel|leak)\b/i },
];

function findCommentLines(source: string): Array<{ line: number; text: string }> {
  const lines = source.split(/\r?\n/);
  const hits: Array<{ line: number; text: string }> = [];
  let inBlock = false;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    if (inBlock) {
      hits.push({ line: i + 1, text: raw.trim() });
      if (raw.includes("*/")) inBlock = false;
      continue;
    }
    const slashIdx = raw.indexOf("//");
    const blockIdx = raw.indexOf("/*");
    if (blockIdx >= 0 && (slashIdx < 0 || blockIdx < slashIdx)) {
      hits.push({ line: i + 1, text: raw.slice(blockIdx).trim() });
      if (!raw.slice(blockIdx).includes("*/")) inBlock = true;
    } else if (slashIdx >= 0) {
      hits.push({ line: i + 1, text: raw.slice(slashIdx).trim() });
    }
  }
  return hits;
}

async function main() {
  const allHits: CommentHit[] = [];
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    if (relPath(file).startsWith("scripts/cleanup/")) continue;
    const source = await readFile(file, "utf8");
    const lines = findCommentLines(source);
    for (const { line, text } of lines) {
      for (const { name, pattern } of MARKERS) {
        if (pattern.test(text)) {
          allHits.push({ file: relPath(file), line, text, marker: name });
          break;
        }
      }
    }
  }
  const byMarker = new Map<string, CommentHit[]>();
  for (const hit of allHits) {
    const list = byMarker.get(hit.marker) ?? [];
    list.push(hit);
    byMarker.set(hit.marker, list);
  }
  const out: string[] = ["# Punch list — section 1: Load-bearing comments", ""];
  out.push(`Total hits: ${allHits.length}`, "");
  for (const [marker, hits] of [...byMarker.entries()].sort()) {
    out.push(`## ${marker} (${hits.length})`, "");
    for (const h of hits) {
      out.push(`- \`${h.file}:${h.line}\` — \`${h.text.replaceAll("|", "\\|").slice(0, 200)}\``);
    }
    out.push("");
  }
  const target = `${REPO_ROOT}/docs/superpowers/specs/punchlist/01-load-bearing-comments.md`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out.join("\n"), "utf8");
  console.log(`Wrote ${allHits.length} hits to ${relPath(target)}`);
}

await main();
```

- [ ] **Step 2: Run it**

```bash
cd .worktrees/cleanup-pass && bun run scripts/cleanup/survey-comments.ts
```

Expected: prints `Wrote N hits to docs/superpowers/specs/punchlist/01-load-bearing-comments.md`. N will be in the hundreds.

- [ ] **Step 3: Commit (script + output)**

```bash
git -C .worktrees/cleanup-pass add scripts/cleanup/survey-comments.ts docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
chore(cleanup): survey load-bearing comments

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.3: Capture jscpd duplication output

**Files:**

- Create: `.worktrees/cleanup-pass/docs/superpowers/specs/punchlist/02-duplication-clusters.md`

- [ ] **Step 1: Run jscpd and capture output**

```bash
cd .worktrees/cleanup-pass && bun run audit:duplication > /tmp/jscpd.out 2>&1; cat /tmp/jscpd.out
```

Expected: jscpd report listing duplicated token sequences with file:line ranges. Note the report file path it writes (usually `.jscpd/jscpd-report.md` or similar).

- [ ] **Step 2: Compose the section**

Write `docs/superpowers/specs/punchlist/02-duplication-clusters.md` with this template:

```markdown
# Punch list — section 2: Duplication clusters

## jscpd output

(verbatim copy of relevant jscpd findings; or reference path to .jscpd/jscpd-report.* if generated as a file)

## Proposed extractions

For each cluster, fill in:

- Cluster `<id>`: files `<list>` — propose extracted symbol `<name>` in `<file path>`. Status: [PROPOSED|EXTRACTED|N/A].

(populate after reviewing the jscpd report; one row per cluster worth extracting)
```

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add docs/superpowers/specs/punchlist/02-duplication-clusters.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
chore(cleanup): capture jscpd duplication clusters

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.4: Write the shape-duplication survey (connector / RPC / mapping)

**Files:**

- Create: `.worktrees/cleanup-pass/scripts/cleanup/survey-shape-dupes.ts`

- [ ] **Step 1: Write the script**

```typescript
// scripts/cleanup/survey-shape-dupes.ts
// Finds files matching known repeated-shape patterns: connector sync handlers,
// RPC dispatchers, and connector mapping files. Token-based jscpd misses these
// because they share STRUCTURE but not enough literal tokens.
import { readdir, stat } from "node:fs/promises";
import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { REPO_ROOT, relPath } from "./lib.ts";

interface ShapeGroup {
  name: string;
  glob: string;
  matches: string[];
}

async function lsOne(dir: string, suffix: string): Promise<string[]> {
  try {
    const entries = await readdir(dir);
    return entries.filter(e => e.endsWith(suffix)).map(e => join(dir, e));
  } catch {
    return [];
  }
}

async function main() {
  const connectorsDir = `${REPO_ROOT}/packages/gateway/src/connectors`;
  const ipcDir = `${REPO_ROOT}/packages/gateway/src/ipc`;
  const mcpDir = `${REPO_ROOT}/packages/mcp-connectors`;

  const groups: ShapeGroup[] = [
    { name: "connector sync handlers", glob: `${connectorsDir}/*-sync.ts`, matches: await lsOne(connectorsDir, "-sync.ts") },
    { name: "connector mappings", glob: `${connectorsDir}/*-mapping.ts`, matches: await lsOne(connectorsDir, "-mapping.ts") },
    { name: "IPC RPC dispatchers", glob: `${ipcDir}/*-rpc.ts`, matches: await lsOne(ipcDir, "-rpc.ts") },
  ];

  // first-party MCP connector servers — one src/server.ts per package
  const mcpServers: string[] = [];
  try {
    for (const dir of await readdir(mcpDir)) {
      const srv = join(mcpDir, dir, "src", "server.ts");
      try { await stat(srv); mcpServers.push(srv); } catch { /* missing */ }
    }
  } catch { /* missing mcp dir */ }
  groups.push({ name: "MCP connector servers", glob: `${mcpDir}/*/src/server.ts`, matches: mcpServers });

  const out: string[] = ["# Punch list — section 2b: Shape duplication", ""];
  for (const g of groups) {
    out.push(`## ${g.name} (${g.matches.length})`, "", `Glob: \`${relPath(g.glob)}\``, "");
    for (const m of g.matches) {
      out.push(`- \`${relPath(m)}\``);
    }
    out.push("");
  }
  out.push("## Proposed extractions", "");
  out.push("- `runConnectorSync` template + `Pagination`/`AuthHeaderProvider`/`RateLimitObserver` strategies — `packages/gateway/src/connectors/_lib/`");
  out.push("- `createRpcDispatcher` — `packages/gateway/src/ipc/_lib/dispatcher.ts`");
  out.push("- `buildIndexedItem` — `packages/gateway/src/connectors/_lib/item-builder.ts`");
  out.push("- `registerReadOnlyConnectorTools` — `@nimbus-dev/sdk`");

  const target = `${REPO_ROOT}/docs/superpowers/specs/punchlist/02b-shape-dupes.md`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out.join("\n"), "utf8");
  console.log(`Wrote shape-dupe survey to ${relPath(target)}`);
}

await main();
```

- [ ] **Step 2: Run it**

```bash
cd .worktrees/cleanup-pass && bun run scripts/cleanup/survey-shape-dupes.ts
```

Expected: prints `Wrote shape-dupe survey to docs/superpowers/specs/punchlist/02b-shape-dupes.md`.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add scripts/cleanup/survey-shape-dupes.ts docs/superpowers/specs/punchlist/02b-shape-dupes.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
chore(cleanup): survey shape-duplication clusters

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.5: Write the SRP-offender survey

**Files:**

- Create: `.worktrees/cleanup-pass/scripts/cleanup/survey-srp.ts`

- [ ] **Step 1: Write the script**

```typescript
// scripts/cleanup/survey-srp.ts
// Lists every source file >500 LOC with a count of top-level exports.
// Heuristic: many exports in a large file is an SRP smell.
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";

const EXPORT_RE = /^export\s+(?:async\s+)?(?:function|class|const|let|interface|type|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gm;

async function main() {
  interface Row { file: string; loc: number; exports: number; names: string[] }
  const rows: Row[] = [];
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    if (relPath(file).startsWith("scripts/cleanup/")) continue;
    if (file.endsWith(".rs")) continue;
    const source = await readFile(file, "utf8");
    const loc = source.split(/\r?\n/).length;
    if (loc <= 500) continue;
    const names: string[] = [];
    for (const m of source.matchAll(EXPORT_RE)) names.push(m[1]);
    rows.push({ file: relPath(file), loc, exports: names.length, names });
  }
  rows.sort((a, b) => b.loc - a.loc);
  const out: string[] = ["# Punch list — section 3: SRP offenders (>500 LOC)", ""];
  out.push(`Total files: ${rows.length}`, "");
  out.push("| File | LOC | Exports | Names (first 8) |");
  out.push("|---|---|---|---|");
  for (const r of rows) {
    out.push(`| \`${r.file}\` | ${r.loc} | ${r.exports} | ${r.names.slice(0, 8).join(", ")}${r.names.length > 8 ? "…" : ""} |`);
  }
  out.push("", "## Triage rule", "");
  out.push("- LOC>500 + exports>=3 unrelated symbols → split candidate.");
  out.push("- LOC>500 + one cohesive exported class/function → keep but audit for internal SRP.");
  out.push("- LOC>500 in a test file → ignore for pass 5 (tests are frozen).");
  const target = `${REPO_ROOT}/docs/superpowers/specs/punchlist/03-srp-offenders.md`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out.join("\n"), "utf8");
  console.log(`Wrote ${rows.length} SRP candidates to ${relPath(target)}`);
}

await main();
```

- [ ] **Step 2: Run it**

```bash
cd .worktrees/cleanup-pass && bun run scripts/cleanup/survey-srp.ts
```

Expected: prints `Wrote N SRP candidates to docs/superpowers/specs/punchlist/03-srp-offenders.md`.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add scripts/cleanup/survey-srp.ts docs/superpowers/specs/punchlist/03-srp-offenders.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
chore(cleanup): survey SRP offenders (>500 LOC)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.6: Write the open/closed-violation survey

**Files:**

- Create: `.worktrees/cleanup-pass/scripts/cleanup/survey-oc.ts`

- [ ] **Step 1: Write the script**

```typescript
// scripts/cleanup/survey-oc.ts
// AST-based finder: 3+ if/else-if branches comparing the same discriminator
// to string literals, or switch statements with 3+ string-literal case clauses.
// Uses the TypeScript compiler API for accurate parsing — regex parsing of
// source code trips on strings, commented-out code, and multi-line statements.
// .rs files are excluded (Rust OC surface is small enough to audit by hand).
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import ts from "typescript";
import { iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";

interface Cluster { file: string; startLine: number; discriminator: string; literals: string[]; kind: "if" | "switch"; }

function discriminatorText(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const base = discriminatorText(expr.expression);
    return base ? `${base}.${expr.name.text}` : null;
  }
  return null;
}

function extractIfLiteralBranch(node: ts.IfStatement): { discriminator: string; literal: string } | null {
  const cond = node.expression;
  if (!ts.isBinaryExpression(cond)) return null;
  if (cond.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
  let identSide: ts.Expression;
  let litSide: ts.Expression;
  if (ts.isStringLiteral(cond.right)) { identSide = cond.left; litSide = cond.right; }
  else if (ts.isStringLiteral(cond.left)) { identSide = cond.right; litSide = cond.left; }
  else return null;
  const disc = discriminatorText(identSide);
  if (!disc) return null;
  return { discriminator: disc, literal: (litSide as ts.StringLiteral).text };
}

function walkIfChain(node: ts.IfStatement, source: ts.SourceFile): Cluster | null {
  const first = extractIfLiteralBranch(node);
  if (!first) return null;
  const literals: string[] = [first.literal];
  const startLine = source.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  let cur: ts.IfStatement | undefined = node;
  while (cur?.elseStatement && ts.isIfStatement(cur.elseStatement)) {
    const next = extractIfLiteralBranch(cur.elseStatement);
    if (!next || next.discriminator !== first.discriminator) break;
    literals.push(next.literal);
    cur = cur.elseStatement;
  }
  if (literals.length < 3) return null;
  return { file: source.fileName, startLine, discriminator: first.discriminator, literals, kind: "if" };
}

function walkSwitch(node: ts.SwitchStatement, source: ts.SourceFile): Cluster | null {
  const disc = discriminatorText(node.expression);
  if (!disc) return null;
  const literals: string[] = [];
  for (const clause of node.caseBlock.clauses) {
    if (ts.isCaseClause(clause) && ts.isStringLiteral(clause.expression)) {
      literals.push(clause.expression.text);
    }
  }
  if (literals.length < 3) return null;
  return {
    file: source.fileName,
    startLine: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
    discriminator: disc,
    literals,
    kind: "switch",
  };
}

function scanFile(rel: string, sourceText: string): Cluster[] {
  const sf = ts.createSourceFile(rel, sourceText, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Cluster[] = [];
  const visitedIf = new Set<number>();
  function walk(node: ts.Node): void {
    if (ts.isIfStatement(node) && !visitedIf.has(node.getStart())) {
      const cluster = walkIfChain(node, sf);
      if (cluster) {
        out.push(cluster);
        // Mark every if in the chain as visited so we don't re-emit sub-chains.
        let c: ts.IfStatement | undefined = node;
        while (c) {
          visitedIf.add(c.getStart());
          c = c.elseStatement && ts.isIfStatement(c.elseStatement) ? c.elseStatement : undefined;
        }
      }
    } else if (ts.isSwitchStatement(node)) {
      const cluster = walkSwitch(node, sf);
      if (cluster) out.push(cluster);
    }
    node.forEachChild(walk);
  }
  walk(sf);
  return out;
}

async function main() {
  const all: Cluster[] = [];
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    const rel = relPath(file);
    if (rel.startsWith("scripts/cleanup/")) continue;
    if (file.endsWith(".rs")) continue;
    const source = await readFile(file, "utf8");
    for (const c of scanFile(rel, source)) {
      all.push({ ...c, file: rel });
    }
  }
  all.sort((a, b) => b.literals.length - a.literals.length);
  const out: string[] = ["# Punch list — section 4: Open/closed violations (3+ literals)", ""];
  out.push(`Total clusters: ${all.length}`, "");
  out.push("| File | Line | Kind | Discriminator | Literals |");
  out.push("|---|---|---|---|---|");
  for (const c of all) {
    out.push(`| \`${c.file}\` | ${c.startLine} | ${c.kind} | \`${c.discriminator}\` | ${c.literals.length} (${c.literals.slice(0, 6).join(", ")}${c.literals.length > 6 ? "…" : ""}) |`);
  }
  out.push("", "## Triage rule", "");
  out.push("- Discriminator is `service` / `provider` / `connector` / `type` / `kind` → strong registry candidate.");
  out.push("- Discriminator is a tagged-union state field (`status`, `state`) → leave as switch; that's idiomatic.");
  out.push("- Discriminator is a config flag (`mode`, `level`) → registry only if open to extension; otherwise keep.");
  const target = `${REPO_ROOT}/docs/superpowers/specs/punchlist/04-oc-violations.md`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, out.join("\n"), "utf8");
  console.log(`Wrote ${all.length} OC candidates to ${relPath(target)}`);
}

await main();
```

- [ ] **Step 2: Run it**

```bash
cd .worktrees/cleanup-pass && bun run scripts/cleanup/survey-oc.ts
```

Expected: prints `Wrote N OC candidates to docs/superpowers/specs/punchlist/04-oc-violations.md`.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add scripts/cleanup/survey-oc.ts docs/superpowers/specs/punchlist/04-oc-violations.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
chore(cleanup): survey open/closed violations

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 1.7: Compose master punch list

**Files:**

- Create: `.worktrees/cleanup-pass/docs/superpowers/specs/2026-05-28-monorepo-cleanup-punchlist.md`

- [ ] **Step 1: Write the index document**

```markdown
# Monorepo Cleanup Pass — Punch List

**Date:** 2026-05-28
**Drives:** Passes 2–5 of the cleanup branch.

Every commit in passes 2–5 cites the row(s) it resolves by section + line range.

## Sections

1. [Load-bearing comments](punchlist/01-load-bearing-comments.md) — jscpd-blind grep across the tree
2. [Duplication clusters (jscpd)](punchlist/02-duplication-clusters.md)
2b. [Shape duplication (manual)](punchlist/02b-shape-dupes.md)
3. [SRP offenders (>500 LOC)](punchlist/03-srp-offenders.md)
4. [Open/closed violations](punchlist/04-oc-violations.md)

## Status convention per row

`[OPEN]` — not yet addressed
`[DOCS]` — migrated to a markdown doc in pass 2
`[DELETE-ONLY]` — captured here; will be stripped in pass 3 with no migration
`[EXTRACTED]` — extracted to a helper in pass 4
`[REFACTORED]` — split/refactored in pass 5
`[N/A]` — false positive; survey heuristic flagged something not worth touching
```

- [ ] **Step 2: Commit**

```bash
git -C .worktrees/cleanup-pass add docs/superpowers/specs/2026-05-28-monorepo-cleanup-punchlist.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): master punch list index

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### CHECKPOINT — End of Pass 1

Before continuing to Pass 2, the operator (or reviewing subagent) reads each of the four punch-list sections and:

1. Marks false positives `[N/A]`.
2. For section 1 (load-bearing comments): annotates each row with the target doc from the Pass 2 mapping table (see spec §"Pass 2 — Docs migration").
3. For section 2 (duplication): confirms the proposed extractions or proposes alternatives.
4. For section 3 (SRP): marks each row with a proposed split or `[keep]` if cohesive.
5. For section 4 (OC): confirms registry-candidate rows or marks `[keep]` for tagged-union state.

The annotated punch list is committed before Pass 2 starts.

---

## Pass 2 — Docs migration

One commit per docs-target file. Each commit cites the punch-list section 1 rows it consumes.

### Task 2.1: Create internals docs skeleton

**Files:**

- Create: `.worktrees/cleanup-pass/docs/internals/performance-tuning.md`
- Create: `.worktrees/cleanup-pass/docs/internals/upstream-workarounds.md`
- Create: `.worktrees/cleanup-pass/docs/internals/platform-quirks.md`
- Create: `.worktrees/cleanup-pass/docs/internals/migration-history.md`
- Create: `.worktrees/cleanup-pass/docs/internals/test-fixtures.md`
- Create: `.worktrees/cleanup-pass/docs/internals/types-reference.md`
- Create: `.worktrees/cleanup-pass/docs/internals/known-todos.md`
- Create: `.worktrees/cleanup-pass/docs/connectors/.gitkeep`

- [ ] **Step 1: Write each skeleton**

Each new file in `docs/internals/` uses the same shape. Example for `performance-tuning.md`:

```markdown
# Performance tuning constants

This file is the home for the *why* behind numeric constants in the codebase.
Each entry is dated and cites the source file:line where the constant lives.

## Entries

(populated by Pass 2 from punch-list section 1)
```

Repeat with topic-appropriate intro for each new file. `known-todos.md` adds:

```markdown
# Known TODOs

Migrated from inline `TODO`/`FIXME` comments. Each entry cites the original
source file:line and the date it was captured.

## Entries

(populated by Pass 2)
```

`types-reference.md`:

```markdown
# Internal type-field narrative

This file preserves the *why* of complex internal type fields that loses its
inline JSDoc home in pass 3. Type *shapes* still come from the TypeScript
type system; this file holds the *narrative*.

## Entries

(populated by Pass 2)
```

- [ ] **Step 2: Commit**

```bash
git -C .worktrees/cleanup-pass add docs/internals/ docs/connectors/.gitkeep
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): internals docs skeleton (pass 2 prep)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 2.2 — 2.11: Migrate per-target (templated iteration)

Each task below has the same shape. The executing worker iterates the corresponding section of the punch list, applies the migration template, and commits.

**Migration template (use for every entry):**

```markdown
### <short title>

**Source:** `<file>:<line>` — added 2026-05-28
**Original comment:** `<comment text>`

<rewritten narrative — 1–3 sentences explaining the why>
```

- [ ] **Task 2.2 — `docs/SECURITY-INVARIANTS.md` (I-numbered rows)**

For each section-1 punch-list row tagged `I-numbered` or `HITL` or `security/timing`:

1. Open `docs/SECURITY-INVARIANTS.md`, locate the matching `I<N>` row.
2. Append the migrated entry under that row using the template above.
3. Mark the punch-list row `[DOCS]`.

After all such rows are processed, commit:

```bash
git -C .worktrees/cleanup-pass add docs/SECURITY-INVARIANTS.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate security/invariant comments to SECURITY-INVARIANTS.md

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.3 — `docs/architecture.md` (subsystem WHY rows)**

For each section-1 row tagged `WHY` or `NOTE` whose comment is about subsystem design: append under the matching architecture section. Same template, same status-mark, then commit:

```bash
git -C .worktrees/cleanup-pass add docs/architecture.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate architecture WHY comments

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.4 — `docs/internals/performance-tuning.md` (perf constants)**

Rows whose comment explains a numeric constant (`4096`, `5_000`, batch sizes, timeouts). Migrate using the template. Commit:

```bash
git -C .worktrees/cleanup-pass add docs/internals/performance-tuning.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate performance-constant rationale

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.5 — `docs/internals/upstream-workarounds.md`**

Rows tagged `WORKAROUND` or that reference an upstream bug. Migrate; commit:

```bash
git -C .worktrees/cleanup-pass add docs/internals/upstream-workarounds.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate upstream-library workarounds

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.6 — `docs/internals/platform-quirks.md` and `docs/sandbox.md`**

Rows in `vault/win32.ts`, `platform/*`, `platform/sandbox/*` that explain platform-specific behavior. Append to `docs/sandbox.md` if sandbox-related; otherwise to `docs/internals/platform-quirks.md`. Commit:

```bash
git -C .worktrees/cleanup-pass add docs/internals/platform-quirks.md docs/sandbox.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate platform quirk rationale

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.7 — `docs/connectors/<name>.md` (per-connector)**

For each connector that has at least one rationale row: create `docs/connectors/<name>.md` with intro:

```markdown
# <Name> connector — quirks

Migrated from inline comments in `packages/gateway/src/connectors/<name>-*.ts`
and `packages/mcp-connectors/<name>/`.

## Entries
```

Then append per-row entries. Commit:

```bash
git -C .worktrees/cleanup-pass add docs/connectors/ docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): per-connector quirk docs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.8 — `docs/internals/migration-history.md`**

Rows in `packages/gateway/src/index/*-v<N>-sql.ts` and `migrations/runner.ts`. Commit:

```bash
git -C .worktrees/cleanup-pass add docs/internals/migration-history.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate DB-migration rationale

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.9 — `docs/internals/test-fixtures.md`**

Rows in `test/` directories explaining fixture choices. Commit:

```bash
git -C .worktrees/cleanup-pass add docs/internals/test-fixtures.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate test-fixture rationale

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.10 — `docs/internals/types-reference.md`**

JSDoc on internal types that carries genuine narrative ("must be non-empty because…"). Commit:

```bash
git -C .worktrees/cleanup-pass add docs/internals/types-reference.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate type-field narrative

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

- [ ] **Task 2.11 — `docs/internals/known-todos.md`**

Rows tagged `TODO`/`FIXME`/`HACK`/`XXX` that name a concrete future task (cites a ticket, a date, a named follow-up). Stale ones with no concrete task → mark `[DELETE-ONLY]` in the punch list, no migration. Commit:

```bash
git -C .worktrees/cleanup-pass add docs/internals/known-todos.md docs/superpowers/specs/punchlist/01-load-bearing-comments.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
docs(cleanup): migrate concrete TODOs / FIXMEs

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### CHECKPOINT — End of Pass 2

Every row in punch-list section 1 is tagged `[DOCS]` or `[DELETE-ONLY]`. If any rows are still `[OPEN]`, go back and decide — do not advance to pass 3 with un-triaged rows.

---

## Pass 3 — Comment strip (mechanical)

### Task 3.1: Write the strip-comments script

**Files:**

- Create: `.worktrees/cleanup-pass/scripts/cleanup/strip-comments.ts`
- Create: `.worktrees/cleanup-pass/scripts/cleanup/strip-comments.test.ts`

- [ ] **Step 1: Write the implementation**

```typescript
// scripts/cleanup/strip-comments.ts
// AST-aware comment removal for .ts/.tsx/.js. Preserves:
//   - shebang lines
//   - tooling pragmas (@ts-expect-error, @ts-ignore, biome-ignore,
//     eslint-disable-*, dprint-ignore, prettier-ignore)
//   - cross-platform-ok markers
//   - JSDoc on packages/sdk/src/ and packages/client/src/ (published surfaces)
// Deletes everything else.
//
// .rs files use a simpler line-based pass with string-literal awareness.
import ts from "typescript";
import { readFile, writeFile, stat } from "node:fs/promises";
import { iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";

const PRESERVE_PRAGMAS = [
  "@ts-expect-error", "@ts-ignore", "@ts-nocheck",
  "biome-ignore", "eslint-disable", "dprint-ignore", "prettier-ignore",
  "cross-platform-ok",
];

const PUBLISHED_JSDOC_PREFIXES = [
  "packages/sdk/src/",
  "packages/client/src/",
];

export function shouldPreserveComment(text: string): boolean {
  return PRESERVE_PRAGMAS.some(p => text.includes(p));
}

export function isPublishedJsdocFile(relativePath: string): boolean {
  return PUBLISHED_JSDOC_PREFIXES.some(p => relativePath.startsWith(p));
}

export function stripTsSource(source: string, opts: { keepJsdoc: boolean }): string {
  const sf = ts.createSourceFile("f.ts", source, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
  const removals: Array<{ start: number; end: number }> = [];
  const visited = new Set<number>();

  function isJsdoc(text: string): boolean {
    return text.startsWith("/**");
  }

  function scanCommentsAtPosition(pos: number, isLeading: boolean): void {
    if (visited.has(pos)) return;
    visited.add(pos);
    const ranges = isLeading
      ? ts.getLeadingCommentRanges(source, pos)
      : ts.getTrailingCommentRanges(source, pos);
    if (!ranges) return;
    for (const r of ranges) {
      const text = source.slice(r.pos, r.end);
      if (shouldPreserveComment(text)) continue;
      if (opts.keepJsdoc && isJsdoc(text)) continue;
      let start = r.pos;
      let end = r.end;
      if (r.hasTrailingNewLine) end = Math.min(source.length, end + 1);
      removals.push({ start, end });
    }
  }

  function walk(node: ts.Node): void {
    scanCommentsAtPosition(node.getFullStart(), true);
    scanCommentsAtPosition(node.getEnd(), false);
    node.forEachChild(walk);
  }
  walk(sf);

  // Sort descending so slice indices stay valid as we remove.
  removals.sort((a, b) => b.start - a.start);
  let out = source;
  for (const { start, end } of removals) {
    out = out.slice(0, start) + out.slice(end);
  }
  // Preserve shebang if it existed.
  if (source.startsWith("#!") && !out.startsWith("#!")) {
    const nl = source.indexOf("\n");
    if (nl > 0) out = source.slice(0, nl + 1) + out;
  }
  // Collapse 3+ consecutive blank lines to a single blank line.
  return out.replace(/\n{3,}/g, "\n\n");
}

// Returns { stripped, abstained } — abstained === true means the file
// contained a raw-string-like pattern (r"...", r#"..."#, r##"..."##, …) that
// our parser could not bound safely. In that case the caller leaves the file
// untouched and prints a warning so a human can audit + strip manually.
export function stripRustSource(source: string): { stripped: string; abstained: boolean } {
  // Char-level scan, single pass. Tracks four mutually exclusive states:
  //   - normal code
  //   - inside "..." string (escape-aware)
  //   - inside r"...", r#"..."#, etc. raw string (no escape interpretation;
  //     terminator is a quote followed by exactly N hashes matching the opener)
  //   - inside /* ... */ block comment
  const out: string[] = [];
  let i = 0;
  let abstained = false;
  while (i < source.length) {
    const c = source[i];
    const c2 = source[i + 1];

    // Raw string opener: r" or r#"… or r##"… etc.
    if (c === "r" && (c2 === '"' || c2 === "#")) {
      // Count hashes between 'r' and '"'.
      let j = i + 1;
      let hashes = 0;
      while (j < source.length && source[j] === "#") { hashes++; j++; }
      if (j < source.length && source[j] === '"') {
        // Find matching terminator: " followed by `hashes` '#' chars.
        const terminator = '"' + "#".repeat(hashes);
        const end = source.indexOf(terminator, j + 1);
        if (end < 0) { abstained = true; break; }
        out.push(source.slice(i, end + terminator.length));
        i = end + terminator.length;
        continue;
      }
      // 'r' followed by hashes but no quote — fall through to normal scan.
    }

    if (c === '"') {
      // Regular string — copy until unescaped closing quote.
      const start = i;
      i++;
      while (i < source.length) {
        if (source[i] === "\\") { i += 2; continue; }
        if (source[i] === '"') { i++; break; }
        i++;
      }
      out.push(source.slice(start, i));
      continue;
    }

    if (c === "'") {
      // Could be a char literal ('x', '\n', '\u{1F4A9}') or a lifetime ('a).
      // Either way, no `//` inside — copy up to the next ' or to end-of-token.
      const start = i;
      i++;
      while (i < source.length && source[i] !== "'" && source[i] !== "\n") {
        if (source[i] === "\\") { i += 2; continue; }
        i++;
      }
      if (source[i] === "'") i++;
      out.push(source.slice(start, i));
      continue;
    }

    if (c === "/" && c2 === "/") {
      // Line comment — skip to end of line, leaving the newline.
      while (i < source.length && source[i] !== "\n") i++;
      continue;
    }

    if (c === "/" && c2 === "*") {
      // Block comment — skip to */.
      const end = source.indexOf("*/", i + 2);
      if (end < 0) { abstained = true; break; }
      i = end + 2;
      continue;
    }

    out.push(c);
    i++;
  }
  if (abstained) return { stripped: source, abstained: true };
  return { stripped: out.join("").replace(/\n{3,}/g, "\n\n"), abstained: false };
}

export async function stripFile(file: string): Promise<{ before: number; after: number; abstained?: boolean }> {
  const rel = relPath(file);
  if (rel.startsWith("scripts/cleanup/")) return { before: 0, after: 0 };
  const source = await readFile(file, "utf8");
  let next: string;
  let abstained = false;
  if (file.endsWith(".rs")) {
    const result = stripRustSource(source);
    next = result.stripped;
    abstained = result.abstained;
    if (abstained) {
      console.warn(`[abstain] ${rel} — raw-string parsing was inconclusive, file left untouched`);
    }
  } else {
    next = stripTsSource(source, { keepJsdoc: isPublishedJsdocFile(rel) });
  }
  if (next !== source) {
    await writeFile(file, next, "utf8");
  }
  return { before: source.length, after: next.length, abstained };
}

async function main() {
  const dryRun = process.argv.includes("--dry-run");
  let totalBefore = 0, totalAfter = 0, fileCount = 0, changed = 0, abstained = 0;
  for await (const file of iterateSourceFiles(REPO_ROOT)) {
    fileCount++;
    if (dryRun) {
      const source = await readFile(file, "utf8");
      let nextText: string;
      if (file.endsWith(".rs")) {
        const r = stripRustSource(source);
        if (r.abstained) { abstained++; console.warn(`[abstain] ${relPath(file)}`); }
        nextText = r.stripped;
      } else {
        nextText = stripTsSource(source, { keepJsdoc: isPublishedJsdocFile(relPath(file)) });
      }
      totalBefore += source.length;
      totalAfter += nextText.length;
      if (nextText !== source) changed++;
    } else {
      const result = await stripFile(file);
      totalBefore += result.before;
      totalAfter += result.after;
      if (result.before !== result.after) changed++;
      if (result.abstained) abstained++;
    }
  }
  console.log(`${dryRun ? "[dry-run] " : ""}Files: ${fileCount}, changed: ${changed}, abstained: ${abstained}, bytes: ${totalBefore} -> ${totalAfter}`);
  if (abstained > 0) {
    console.warn(`[!] ${abstained} .rs files were left untouched due to raw-string ambiguity. Audit them manually.`);
  }
}

if (import.meta.main) await main();
```

- [ ] **Step 2: Write the test**

```typescript
// scripts/cleanup/strip-comments.test.ts
import { describe, expect, test } from "bun:test";
import { stripTsSource, stripRustSource, shouldPreserveComment, isPublishedJsdocFile } from "./strip-comments.ts";

describe("shouldPreserveComment", () => {
  test("preserves @ts-expect-error", () => {
    expect(shouldPreserveComment("// @ts-expect-error reason")).toBe(true);
  });
  test("preserves biome-ignore", () => {
    expect(shouldPreserveComment("// biome-ignore lint/style/useTemplate: legacy")).toBe(true);
  });
  test("preserves cross-platform-ok", () => {
    expect(shouldPreserveComment("// cross-platform-ok")).toBe(true);
  });
  test("does not preserve regular comments", () => {
    expect(shouldPreserveComment("// just a comment")).toBe(false);
    expect(shouldPreserveComment("/* block */")).toBe(false);
  });
});

describe("isPublishedJsdocFile", () => {
  test("matches sdk and client src", () => {
    expect(isPublishedJsdocFile("packages/sdk/src/index.ts")).toBe(true);
    expect(isPublishedJsdocFile("packages/client/src/index.ts")).toBe(true);
  });
  test("does not match other packages", () => {
    expect(isPublishedJsdocFile("packages/gateway/src/engine/executor.ts")).toBe(false);
    expect(isPublishedJsdocFile("packages/cli/src/index.ts")).toBe(false);
  });
});

describe("stripTsSource", () => {
  test("removes line comments", () => {
    const src = `const x = 1; // this is removed\nconst y = 2;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("this is removed");
    expect(out).toContain("const x = 1;");
    expect(out).toContain("const y = 2;");
  });

  test("removes block comments", () => {
    const src = `/* block */\nconst x = 1;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("/* block */");
    expect(out).toContain("const x = 1;");
  });

  test("removes JSDoc when keepJsdoc is false", () => {
    const src = `/**\n * Doc comment\n */\nexport function f() {}\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toContain("Doc comment");
    expect(out).toContain("export function f() {}");
  });

  test("preserves JSDoc when keepJsdoc is true", () => {
    const src = `/**\n * Doc comment\n */\nexport function f() {}\n`;
    const out = stripTsSource(src, { keepJsdoc: true });
    expect(out).toContain("Doc comment");
  });

  test("preserves @ts-expect-error", () => {
    const src = `// @ts-expect-error this is wrong\nconst x: number = "foo";\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("@ts-expect-error");
  });

  test("preserves biome-ignore", () => {
    const src = `// biome-ignore lint/style/useTemplate: legacy code\nconst s = "a" + "b";\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("biome-ignore");
  });

  test("preserves shebang", () => {
    const src = `#!/usr/bin/env bun\n// removed\nconsole.log("hi");\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out.startsWith("#!/usr/bin/env bun")).toBe(true);
    expect(out).not.toContain("removed");
  });

  test("does not touch string literals that look like comments", () => {
    const src = `const s = "// not a comment";\nconst t = "/* still not */";\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("// not a comment");
    expect(out).toContain("/* still not */");
  });

  test("does not touch template literals containing /*", () => {
    const src = "const s = `/* literal */ value`;\n";
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).toContain("/* literal */");
  });

  test("collapses 3+ blank lines after stripping", () => {
    const src = `const x = 1;\n// removed\n\n\n\nconst y = 2;\n`;
    const out = stripTsSource(src, { keepJsdoc: false });
    expect(out).not.toMatch(/\n{3,}/);
  });
});

describe("stripRustSource", () => {
  test("removes line comments", () => {
    const src = `let x = 1; // removed\nlet y = 2;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).not.toContain("removed");
    expect(stripped).toContain("let x = 1");
    expect(stripped).toContain("let y = 2");
  });

  test("removes block comments", () => {
    const src = `/* block */\nlet x = 1;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).not.toContain("/* block */");
  });

  test("does not touch string literals", () => {
    const src = `let s = "// not a comment";\n`;
    const { stripped } = stripRustSource(src);
    expect(stripped).toContain("// not a comment");
  });

  test("does not touch raw strings r\"...\"", () => {
    const src = `let s = r"// raw, not a comment";\nlet y = 1; // gone\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).toContain('r"// raw, not a comment"');
    expect(stripped).not.toContain("gone");
  });

  test("does not touch raw strings with hashes r#\"...\"#", () => {
    const src = `let s = r#"// also raw, with quote " inside"#;\nlet y = 1;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).toContain('r#"// also raw, with quote " inside"#');
  });

  test("preserves /* */ inside raw strings", () => {
    const src = `let s = r##"/* fake block */ /* still */"##;\nlet y = 1;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).toContain('r##"/* fake block */ /* still */"##');
  });

  test("abstains on unterminated raw string", () => {
    const src = `let s = r#"never closed\nlet y = 1;\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(true);
    expect(stripped).toBe(src);
  });

  test("preserves char literal 'x' and lifetime 'a", () => {
    const src = `let c = '/'; struct F<'a> { x: &'a str }\nlet y = 1; // gone\n`;
    const { stripped, abstained } = stripRustSource(src);
    expect(abstained).toBe(false);
    expect(stripped).toContain("let c = '/';");
    expect(stripped).toContain("'a");
    expect(stripped).not.toContain("gone");
  });
});
```

- [ ] **Step 3: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test scripts/cleanup/strip-comments.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit script + tests (no strip applied yet)**

```bash
git -C .worktrees/cleanup-pass add scripts/cleanup/strip-comments.ts scripts/cleanup/strip-comments.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
chore(cleanup): comment-strip script + tests (not applied)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.2: Dry-run inspection

- [ ] **Step 1: Dry-run**

```bash
cd .worktrees/cleanup-pass && bun run scripts/cleanup/strip-comments.ts --dry-run
```

Expected: `[dry-run] Files: <N>, changed: <M>, bytes: <before> -> <after>`. The byte ratio should be 70–90% (we are removing comments, not code).

- [ ] **Step 2: Spot-check a sample file**

Pick five files at random from `packages/gateway/src/` and run the strip on a copy:

```bash
for F in packages/gateway/src/engine/executor.ts packages/gateway/src/ipc/http-server.ts packages/gateway/src/db/write.ts packages/gateway/src/vault/win32.ts packages/gateway/src/llm/router.ts; do
  echo "=== $F ==="
  bun -e "import { stripTsSource, isPublishedJsdocFile } from './scripts/cleanup/strip-comments.ts'; import { readFile } from 'node:fs/promises'; const src = await readFile('$F', 'utf8'); console.log(stripTsSource(src, { keepJsdoc: isPublishedJsdocFile('$F') }))" | head -60
done
```

Visually verify: shebangs preserved, type pragmas preserved, code intact.

### Task 3.3: Apply the strip across the tree

- [ ] **Step 1: Apply**

```bash
cd .worktrees/cleanup-pass && bun run scripts/cleanup/strip-comments.ts
```

Expected: `Files: <N>, changed: <M>, bytes: <before> -> <after>` (no `[dry-run]` prefix).

- [ ] **Step 2: Run lint + typecheck sanity check**

```bash
cd .worktrees/cleanup-pass && bun run lint:fix && bun run typecheck
```

Expected: both pass. Lint applies any Biome formatting changes that follow naturally from removed comments (e.g. trailing whitespace cleanup). Typecheck must be green — if it fails, a preserved pragma was missed or a comment was carrying a `//@ts-...` directive that was deleted; investigate.

- [ ] **Step 3: Commit the strip**

```bash
git -C .worktrees/cleanup-pass add -A
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(cleanup): strip all comments across packages/ and scripts/

Mechanical commit. Run by scripts/cleanup/strip-comments.ts.

Preserved: shebangs, tooling pragmas (@ts-*, biome-ignore, eslint-disable-*,
prettier/dprint-ignore), cross-platform-ok markers, JSDoc on @nimbus-dev/sdk
and @nimbus-dev/client published surfaces.

All other comments deleted. Load-bearing context migrated to docs/ in pass 2.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 3.4: Post-strip sanity

- [ ] **Step 1: Run the existing test suite**

```bash
cd .worktrees/cleanup-pass && bun run test:ci
```

Expected: every package's tests pass. Tests must not have been affected (they have no comments removed if they're under `test/` — yes they are, the script walks the whole tree; but assertions are unchanged, so they still pass).

If any test fails: the failure indicates a pragma was missed, a `// biome-ignore` is missing, or a test was *parsing* the comment in some indirect way (unlikely but possible). Fix root cause; do not skip.

- [ ] **Step 2: Run audit:invariants**

```bash
cd .worktrees/cleanup-pass && bun run audit:invariants
```

Expected: green. The static D-rules don't care about comments.

---

## Pass 4 — Dedupe (themed commits)

### Task 4.1: Create connector strategy library (Pagination)

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/pagination.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/pagination.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/connectors/_lib/pagination.test.ts
import { describe, expect, test } from "bun:test";
import {
  CursorPagination,
  OffsetPagination,
  PageNumberPagination,
  LinkHeaderPagination,
  type PageResponse,
} from "./pagination.ts";

describe("CursorPagination", () => {
  test("starts at undefined cursor", () => {
    const p = new CursorPagination<{ next?: string }>(r => r.next);
    expect(p.initialState()).toBeUndefined();
  });
  test("advances state from response cursor", () => {
    const p = new CursorPagination<{ next?: string }>(r => r.next);
    expect(p.nextState(undefined, { next: "C2" } as any)).toBe("C2");
    expect(p.nextState("C2", { next: undefined } as any)).toBeUndefined();
  });
});

describe("OffsetPagination", () => {
  test("starts at 0", () => {
    const p = new OffsetPagination(100);
    expect(p.initialState()).toBe(0);
  });
  test("advances by pageSize", () => {
    const p = new OffsetPagination(100);
    expect(p.nextState(0, { hasMore: true } as any)).toBe(100);
    expect(p.nextState(0, { hasMore: false } as any)).toBeUndefined();
  });
});

describe("PageNumberPagination", () => {
  test("starts at 1", () => {
    const p = new PageNumberPagination();
    expect(p.initialState()).toBe(1);
  });
  test("advances by 1 until response signals done", () => {
    const p = new PageNumberPagination();
    expect(p.nextState(1, { hasMore: true } as any)).toBe(2);
    expect(p.nextState(2, { hasMore: false } as any)).toBeUndefined();
  });
});

describe("LinkHeaderPagination", () => {
  test("parses next URL from Link header", () => {
    const p = new LinkHeaderPagination();
    const headers = new Headers();
    headers.set("Link", '<https://api/items?page=2>; rel="next", <https://api/items?page=10>; rel="last"');
    const resp: PageResponse = { headers, body: {} };
    expect(p.nextState("https://api/items?page=1", resp)).toBe("https://api/items?page=2");
  });
  test("returns undefined when no next link", () => {
    const p = new LinkHeaderPagination();
    const headers = new Headers();
    headers.set("Link", '<https://api/items?page=1>; rel="prev"');
    const resp: PageResponse = { headers, body: {} };
    expect(p.nextState("https://api/items?page=2", resp)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test (should fail — module missing)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/pagination.test.ts
```

Expected: FAIL with `Cannot find module './pagination.ts'`.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/connectors/_lib/pagination.ts
export interface PageResponse {
  readonly headers: Headers;
  readonly body: unknown;
}

export interface Pagination<S> {
  initialState(): S | undefined;
  nextState(current: S | undefined, response: PageResponse): S | undefined;
}

export class CursorPagination<B> implements Pagination<string> {
  constructor(private readonly extract: (body: B) => string | undefined) {}
  initialState(): string | undefined { return undefined; }
  nextState(_current: string | undefined, response: PageResponse): string | undefined {
    return this.extract(response.body as B);
  }
}

export class OffsetPagination implements Pagination<number> {
  constructor(private readonly pageSize: number) {}
  initialState(): number { return 0; }
  nextState(current: number | undefined, response: PageResponse): number | undefined {
    const more = (response.body as { hasMore?: boolean }).hasMore === true;
    if (!more) return undefined;
    return (current ?? 0) + this.pageSize;
  }
}

export class PageNumberPagination implements Pagination<number> {
  initialState(): number { return 1; }
  nextState(current: number | undefined, response: PageResponse): number | undefined {
    const more = (response.body as { hasMore?: boolean }).hasMore === true;
    if (!more) return undefined;
    return (current ?? 1) + 1;
  }
}

export class LinkHeaderPagination implements Pagination<string> {
  initialState(): string | undefined { return undefined; }
  nextState(_current: string | undefined, response: PageResponse): string | undefined {
    const link = response.headers.get("Link") ?? response.headers.get("link");
    if (!link) return undefined;
    for (const part of link.split(",")) {
      const m = /<([^>]+)>;\s*rel="next"/.exec(part.trim());
      if (m) return m[1];
    }
    return undefined;
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/pagination.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/connectors/_lib/pagination.ts packages/gateway/src/connectors/_lib/pagination.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(connectors): add Pagination strategy library

Four implementations: Cursor, Offset, PageNumber, LinkHeader.

Drives pass-4 dedupe of <connector>-sync.ts pagination boilerplate.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.2: Create AuthHeaderProvider library

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/auth.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/auth.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/connectors/_lib/auth.test.ts
import { describe, expect, test } from "bun:test";
import {
  BearerPat, OAuthWithRefresh, QueryStringToken, Anonymous,
  type AuthHeaderProvider,
} from "./auth.ts";

describe("BearerPat", () => {
  test("emits Authorization: Bearer <token>", async () => {
    const p: AuthHeaderProvider = new BearerPat(async () => "ghp_abc");
    const h = await p.apply(new Headers());
    expect(h.get("Authorization")).toBe("Bearer ghp_abc");
  });
});

describe("QueryStringToken", () => {
  test("appends token to URL as query param", async () => {
    const p = new QueryStringToken("api_token", async () => "secret");
    const u = await p.applyToUrl(new URL("https://api/items"));
    expect(u.searchParams.get("api_token")).toBe("secret");
  });
});

describe("Anonymous", () => {
  test("does nothing", async () => {
    const p = new Anonymous();
    const h = new Headers({ Existing: "v" });
    const out = await p.apply(h);
    expect(out.get("Authorization")).toBeNull();
    expect(out.get("Existing")).toBe("v");
  });
});

describe("OAuthWithRefresh", () => {
  test("delegates to provider for access token", async () => {
    const p = new OAuthWithRefresh(async () => "oauth_token");
    const h = await p.apply(new Headers());
    expect(h.get("Authorization")).toBe("Bearer oauth_token");
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/auth.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/connectors/_lib/auth.ts
export interface AuthHeaderProvider {
  apply(headers: Headers): Promise<Headers>;
  applyToUrl?(url: URL): Promise<URL>;
}

export class BearerPat implements AuthHeaderProvider {
  constructor(private readonly getToken: () => Promise<string>) {}
  async apply(headers: Headers): Promise<Headers> {
    const out = new Headers(headers);
    out.set("Authorization", `Bearer ${await this.getToken()}`);
    return out;
  }
}

export class OAuthWithRefresh implements AuthHeaderProvider {
  constructor(private readonly getAccessToken: () => Promise<string>) {}
  async apply(headers: Headers): Promise<Headers> {
    const out = new Headers(headers);
    out.set("Authorization", `Bearer ${await this.getAccessToken()}`);
    return out;
  }
}

export class QueryStringToken implements AuthHeaderProvider {
  constructor(
    private readonly param: string,
    private readonly getToken: () => Promise<string>,
  ) {}
  async apply(headers: Headers): Promise<Headers> {
    return headers;
  }
  async applyToUrl(url: URL): Promise<URL> {
    const out = new URL(url.toString());
    out.searchParams.set(this.param, await this.getToken());
    return out;
  }
}

export class Anonymous implements AuthHeaderProvider {
  async apply(headers: Headers): Promise<Headers> {
    return headers;
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/auth.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/connectors/_lib/auth.ts packages/gateway/src/connectors/_lib/auth.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(connectors): add AuthHeaderProvider strategy library

Four implementations: BearerPat, OAuthWithRefresh, QueryStringToken, Anonymous.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.3: Create RateLimitObserver library

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/rate-limit-observer.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/rate-limit-observer.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/connectors/_lib/rate-limit-observer.test.ts
import { describe, expect, test } from "bun:test";
import {
  GithubStyleHeaders,
  RetryAfterHeader,
  NoopObserver,
} from "./rate-limit-observer.ts";

describe("GithubStyleHeaders", () => {
  test("reads X-RateLimit-Remaining and Reset", () => {
    const obs = new GithubStyleHeaders();
    const h = new Headers();
    h.set("X-RateLimit-Remaining", "3");
    h.set("X-RateLimit-Reset", String(Math.floor(Date.now() / 1000) + 30));
    const snap = obs.observe(h);
    expect(snap.remaining).toBe(3);
    expect(snap.resetAtMs).toBeGreaterThan(Date.now());
  });
  test("returns null snapshot if headers absent", () => {
    expect(new GithubStyleHeaders().observe(new Headers())).toBeNull();
  });
});

describe("RetryAfterHeader", () => {
  test("reads Retry-After seconds", () => {
    const h = new Headers();
    h.set("Retry-After", "60");
    const snap = new RetryAfterHeader().observe(h);
    expect(snap?.remaining).toBe(0);
    expect(snap?.resetAtMs).toBeGreaterThan(Date.now() + 50_000);
  });
});

describe("NoopObserver", () => {
  test("always returns null", () => {
    expect(new NoopObserver().observe(new Headers())).toBeNull();
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/rate-limit-observer.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/connectors/_lib/rate-limit-observer.ts
export interface RateLimitSnapshot {
  readonly remaining: number;
  readonly resetAtMs: number;
}

export interface RateLimitObserver {
  observe(headers: Headers): RateLimitSnapshot | null;
}

export class GithubStyleHeaders implements RateLimitObserver {
  observe(headers: Headers): RateLimitSnapshot | null {
    const rem = headers.get("X-RateLimit-Remaining") ?? headers.get("x-ratelimit-remaining");
    const reset = headers.get("X-RateLimit-Reset") ?? headers.get("x-ratelimit-reset");
    if (rem === null || reset === null) return null;
    const r = Number.parseInt(rem, 10);
    const resetSec = Number.parseInt(reset, 10);
    if (Number.isNaN(r) || Number.isNaN(resetSec)) return null;
    return { remaining: r, resetAtMs: resetSec * 1000 };
  }
}

export class RetryAfterHeader implements RateLimitObserver {
  observe(headers: Headers): RateLimitSnapshot | null {
    const v = headers.get("Retry-After") ?? headers.get("retry-after");
    if (v === null) return null;
    const sec = Number.parseInt(v, 10);
    if (Number.isNaN(sec)) return null;
    return { remaining: 0, resetAtMs: Date.now() + sec * 1000 };
  }
}

export class NoopObserver implements RateLimitObserver {
  observe(_headers: Headers): RateLimitSnapshot | null {
    return null;
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/rate-limit-observer.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/connectors/_lib/rate-limit-observer.ts packages/gateway/src/connectors/_lib/rate-limit-observer.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(connectors): add RateLimitObserver strategy library

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.4: Create the HTTP client wrapper

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/http.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/http.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/connectors/_lib/http.test.ts
import { describe, expect, test } from "bun:test";
import { ConnectorHttpClient } from "./http.ts";
import { BearerPat, Anonymous } from "./auth.ts";
import { GithubStyleHeaders, NoopObserver } from "./rate-limit-observer.ts";

describe("ConnectorHttpClient", () => {
  test("applies BearerPat auth", async () => {
    let captured: Headers | undefined;
    const client = new ConnectorHttpClient({
      auth: new BearerPat(async () => "tok"),
      observer: new NoopObserver(),
      fetch: async (url, init) => {
        captured = new Headers(init?.headers);
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.get("https://api/x");
    expect(captured?.get("Authorization")).toBe("Bearer tok");
  });

  test("applies QueryStringToken to URL", async () => {
    let capturedUrl: string | undefined;
    const { QueryStringToken } = await import("./auth.ts");
    const client = new ConnectorHttpClient({
      auth: new QueryStringToken("api_token", async () => "secret"),
      observer: new NoopObserver(),
      fetch: async (url) => {
        capturedUrl = url.toString();
        return new Response("{}", { status: 200, headers: { "content-type": "application/json" } });
      },
    });
    await client.get("https://api/x");
    expect(capturedUrl).toContain("api_token=secret");
  });

  test("returns parsed JSON body and headers", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => new Response(JSON.stringify({ items: [1, 2] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    });
    const resp = await client.get("https://api/x");
    expect(resp.body).toEqual({ items: [1, 2] });
    expect(resp.status).toBe(200);
  });

  test("invokes rate-limit observer", async () => {
    const obs = new GithubStyleHeaders();
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: obs,
      fetch: async () => new Response("{}", {
        status: 200,
        headers: {
          "content-type": "application/json",
          "x-ratelimit-remaining": "5",
          "x-ratelimit-reset": String(Math.floor(Date.now() / 1000) + 10),
        },
      }),
    });
    const resp = await client.get("https://api/x");
    expect(resp.rateLimit?.remaining).toBe(5);
  });

  test("throws on non-2xx with response body in error", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => new Response("not found", { status: 404 }),
    });
    await expect(client.get("https://api/x")).rejects.toThrow(/404/);
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/http.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/connectors/_lib/http.ts
import type { AuthHeaderProvider } from "./auth.ts";
import type { RateLimitObserver, RateLimitSnapshot } from "./rate-limit-observer.ts";

export interface HttpResponse<B = unknown> {
  readonly status: number;
  readonly headers: Headers;
  readonly body: B;
  readonly rateLimit: RateLimitSnapshot | null;
}

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

export interface ConnectorHttpClientOptions {
  readonly auth: AuthHeaderProvider;
  readonly observer: RateLimitObserver;
  readonly fetch?: FetchFn;
}

export class ConnectorHttpError extends Error {
  constructor(public readonly status: number, public readonly url: string, public readonly bodyText: string) {
    super(`HTTP ${status} from ${url}: ${bodyText.slice(0, 200)}`);
  }
}

export class ConnectorHttpClient {
  private readonly fetchFn: FetchFn;
  constructor(private readonly opts: ConnectorHttpClientOptions) {
    this.fetchFn = opts.fetch ?? (globalThis.fetch as FetchFn);
  }

  async get<B = unknown>(url: string, init: RequestInit = {}): Promise<HttpResponse<B>> {
    const u = new URL(url);
    const finalUrl = this.opts.auth.applyToUrl ? await this.opts.auth.applyToUrl(u) : u;
    const headers = await this.opts.auth.apply(new Headers(init.headers));
    const resp = await this.fetchFn(finalUrl, { ...init, method: init.method ?? "GET", headers });
    if (!resp.ok) {
      const text = await resp.text();
      throw new ConnectorHttpError(resp.status, finalUrl.toString(), text);
    }
    const contentType = resp.headers.get("content-type") ?? "";
    const body = contentType.includes("application/json") ? await resp.json() : (await resp.text());
    return {
      status: resp.status,
      headers: resp.headers,
      body: body as B,
      rateLimit: this.opts.observer.observe(resp.headers),
    };
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/http.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/connectors/_lib/http.ts packages/gateway/src/connectors/_lib/http.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(connectors): add ConnectorHttpClient (auth + observer)

Composes AuthHeaderProvider + RateLimitObserver; returns typed HttpResponse
with optional rateLimit snapshot. Throws ConnectorHttpError on non-2xx.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.5: Create the item-builder helper

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/item-builder.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/item-builder.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/connectors/_lib/item-builder.test.ts
import { describe, expect, test } from "bun:test";
import { buildIndexedItem } from "./item-builder.ts";

describe("buildIndexedItem", () => {
  test("composes service:native-id id format", () => {
    const item = buildIndexedItem({
      service: "github",
      type: "pr",
      externalId: "12345",
      title: "Add foo",
      createdAt: 1700000000000,
      metadata: { state: "open" },
    });
    expect(item.id).toBe("github:12345");
    expect(item.service).toBe("github");
    expect(item.type).toBe("pr");
    expect(item.title).toBe("Add foo");
    expect(item.metadata).toEqual({ state: "open" });
  });

  test("preserves updatedAt and url when provided", () => {
    const item = buildIndexedItem({
      service: "linear",
      type: "issue",
      externalId: "NIM-1",
      title: "x",
      createdAt: 1,
      updatedAt: 2,
      url: "https://linear.app/x",
    });
    expect(item.updatedAt).toBe(2);
    expect(item.url).toBe("https://linear.app/x");
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/item-builder.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

Read the existing `IndexedItem` type first to keep field shape compatible:

```bash
cd .worktrees/cleanup-pass && grep -n "export type IndexedItem\|export interface IndexedItem" packages/gateway/src/**/*.ts
```

Then write `item-builder.ts` matching the existing `IndexedItem` shape:

```typescript
// packages/gateway/src/connectors/_lib/item-builder.ts
// Pure factory for IndexedItem. Enforces the "<service>:<native_id>" id format
// (see docs/architecture.md §"Connector / MCP Pattern").
import type { IndexedItem } from "<actual path to IndexedItem from grep>";

export interface BuildIndexedItemInput {
  readonly service: string;
  readonly type: string;
  readonly externalId: string;
  readonly title: string;
  readonly createdAt: number;
  readonly updatedAt?: number;
  readonly url?: string;
  readonly metadata?: Record<string, unknown>;
  readonly content?: string;
}

export function buildIndexedItem(input: BuildIndexedItemInput): IndexedItem {
  if (input.externalId.length === 0) {
    throw new Error("externalId must be non-empty");
  }
  return {
    id: `${input.service}:${input.externalId}`,
    service: input.service,
    type: input.type,
    title: input.title,
    createdAt: input.createdAt,
    updatedAt: input.updatedAt,
    url: input.url,
    metadata: input.metadata ?? {},
    content: input.content,
  } as IndexedItem;
}
```

(The exact `IndexedItem` field list must match the type — adjust based on the grep output. If the type has additional required fields like `embedAt`, they go in the input or default to a sentinel.)

- [ ] **Step 4: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/item-builder.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/connectors/_lib/item-builder.ts packages/gateway/src/connectors/_lib/item-builder.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(connectors): add buildIndexedItem factory

Pure. Enforces "<service>:<native_id>" id format. Drives pass-4 dedupe of
<connector>-mapping.ts files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.6: Create the runConnectorSync template

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/sync-runner.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/connectors/_lib/sync-runner.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/connectors/_lib/sync-runner.test.ts
import { describe, expect, test } from "bun:test";
import { runConnectorSync } from "./sync-runner.ts";
import { OffsetPagination, LinkHeaderPagination } from "./pagination.ts";
import { Anonymous } from "./auth.ts";
import { NoopObserver } from "./rate-limit-observer.ts";
import { ConnectorHttpClient } from "./http.ts";

interface PageBody { items: { id: string }[]; hasMore: boolean }

describe("runConnectorSync", () => {
  test("iterates pages until pagination exhausts", async () => {
    let pageIndex = 0;
    const pages = [
      { items: [{ id: "1" }, { id: "2" }], hasMore: true },
      { items: [{ id: "3" }], hasMore: false },
    ];
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => new Response(JSON.stringify(pages[pageIndex++]), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    const seen: string[] = [];
    const result = await runConnectorSync<number, PageBody, { id: string }>({
      pagination: new OffsetPagination(2),
      fetchPage: (offset) => client.get<PageBody>(`https://api/items?offset=${offset ?? 0}`),
      mapBody: (body) => body.items,
      onItem: async (item) => { seen.push(item.id); },
    });
    expect(seen).toEqual(["1", "2", "3"]);
    expect(result.pageCount).toBe(2);
    expect(result.itemCount).toBe(3);
  });

  test("respects pageLimit", async () => {
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => new Response(JSON.stringify({ items: [{ id: "x" }], hasMore: true }), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    const result = await runConnectorSync<number, PageBody, { id: string }>({
      pagination: new OffsetPagination(1),
      fetchPage: () => client.get<PageBody>("https://api/x"),
      mapBody: (body) => body.items,
      onItem: async () => { /* noop */ },
      pageLimit: 3,
    });
    expect(result.pageCount).toBe(3);
  });

  test("supports Link-header pagination from real response headers", async () => {
    let n = 0;
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => {
        n++;
        const headers: Record<string, string> = { "content-type": "application/json" };
        if (n === 1) headers["Link"] = '<https://api/p2>; rel="next"';
        return new Response(JSON.stringify({ items: [{ id: String(n) }] }), { status: 200, headers });
      },
    });
    const seen: string[] = [];
    await runConnectorSync<string, { items: { id: string }[] }, { id: string }>({
      pagination: new LinkHeaderPagination(),
      fetchPage: (url) => client.get(url ?? "https://api/p1"),
      mapBody: (body) => body.items,
      onItem: async (item) => { seen.push(item.id); },
    });
    expect(seen).toEqual(["1", "2"]);
  });

  test("array-bodied API works when paired with a single-page pagination", async () => {
    // Some APIs return a bare array. The template doesn't synthesise envelopes;
    // pagination strategies that ignore `body` (e.g. an off-the-shelf single-page
    // strategy) just work. CursorPagination expecting an object body would not —
    // by design.
    const client = new ConnectorHttpClient({
      auth: new Anonymous(),
      observer: new NoopObserver(),
      fetch: async () => new Response(JSON.stringify([{ id: "a" }, { id: "b" }]), {
        status: 200, headers: { "content-type": "application/json" },
      }),
    });
    const { OffsetPagination: Op } = await import("./pagination.ts");
    const seen: string[] = [];
    const result = await runConnectorSync<number, { id: string }[], { id: string }>({
      pagination: new Op(100), // hasMore is undefined on a raw array → strategy returns undefined → loop ends
      fetchPage: () => client.get<{ id: string }[]>("https://api/x"),
      mapBody: (body) => body,
      onItem: async (i) => { seen.push(i.id); },
    });
    expect(seen).toEqual(["a", "b"]);
    expect(result.pageCount).toBe(1);
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/sync-runner.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/connectors/_lib/sync-runner.ts
// Composes a fetch-page-and-extract-cursor loop. Contract:
//   - fetchPage returns an HttpResponse<B> (the shape ConnectorHttpClient.get
//     produces). The template passes this directly to the Pagination strategy,
//     never synthesises a fake envelope.
//   - mapBody receives the parsed body B and returns the items to upsert.
//   - onItem is the per-item side-effect (typically an index upsert).
import type { HttpResponse } from "./http.ts";
import type { Pagination } from "./pagination.ts";

export interface RunConnectorSyncOptions<S, B, Item> {
  readonly pagination: Pagination<S>;
  readonly fetchPage: (state: S | undefined) => Promise<HttpResponse<B>>;
  readonly mapBody: (body: B) => Item[];
  readonly onItem: (item: Item) => Promise<void>;
  readonly pageLimit?: number;
}

export interface SyncResult {
  readonly pageCount: number;
  readonly itemCount: number;
}

export async function runConnectorSync<S, B, Item>(
  opts: RunConnectorSyncOptions<S, B, Item>,
): Promise<SyncResult> {
  let state: S | undefined = opts.pagination.initialState();
  let pageCount = 0;
  let itemCount = 0;
  const limit = opts.pageLimit ?? Number.POSITIVE_INFINITY;

  while (pageCount < limit) {
    const response = await opts.fetchPage(state);
    pageCount += 1;
    for (const item of opts.mapBody(response.body)) {
      await opts.onItem(item);
      itemCount += 1;
    }
    // HttpResponse<B> is structurally compatible with PageResponse —
    // both expose { headers, body }. No envelope synthesis.
    const next = opts.pagination.nextState(state, response);
    if (next === undefined) break;
    state = next;
  }
  return { pageCount, itemCount };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/connectors/_lib/sync-runner.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/connectors/_lib/sync-runner.ts packages/gateway/src/connectors/_lib/sync-runner.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(connectors): add runConnectorSync template

Composes Pagination + fetchPage + mapPage + onItem. Outliers opt out by
using their bespoke loop; success criterion is median, not universal.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.7: Per-connector migration (one task per connector)

**Plan revision 2026-05-28 (session 2):** the original Task 4.7 template assumed a `ConnectorSyncHandler` shape with `runConnectorSync` + flat pagination. The actual codebase uses a `Syncable` envelope with `FetchOutcome` + `syncPassCursor*` helpers, and most connectors do tree-walks (orgs→projects→issues, apps→builds) rather than a single paginated loop. `runConnectorSync` was deleted and replaced with `connectorFetch`, which models the duplication that actually exists (~26 connectors copy the same rate-limit + fetch + bytes + parse + outcome-tagging block). The flat-pagination helpers (`auth.ts`, `http.ts`, `pagination.ts`, `item-builder.ts`) remain in `_lib/` for future connectors but do not drive existing migrations.

This step iterates the 30+ connectors. Each task: replace the bespoke `xGet` inner helper with `connectorFetch(ctx, SERVICE_ID, url, { headers })`, keep the `syncPassCursor*` envelope at the call site, keep tree-walks + the connector-specific mapping + vault-key resolution + HITL tool declarations untouched.

**Time budget.** ~30 connectors × ~5 minutes each (smaller per-connector change than originally planned). Each migration is a self-contained 1-file diff with -15 to -25 lines net.

**Template per connector:**

For each `<connector>` in:

- snyk, bitrise, sonarqube, semgrep, wiz, launchdarkly, flagsmith, argocd ✅ (PoC), flux, dbt, metabase, superset, databricks, mlflow, vercel, netlify, stripe, mercury, readwise, raindrop, intercom, zendesk, lever, greenhouse, pipedrive, stackoverflow, zoom, obsidian, openapi-indexer, (and any others surfaced by Task 1.4 shape-dupe survey)

Apply this checklist (one task per connector, one commit per connector):

- [ ] **Step 1: Read the current `<connector>-sync.ts`** and find:
  - The inner `<x>Get` / `<x>Post` function that does `ctx.rateLimiter.acquire + fetch + text + ok/throw + JSON.parse → FetchOutcome`
  - The auth shape (Bearer / Token / token / Basic / raw) — caller-built, will pass through unchanged
  - The local `FetchOutcome` type alias (delete it; use the one re-exported from `_lib/fetch-outcome.ts`)

- [ ] **Step 2: Decide opt-in vs opt-out.** Some connectors are genuinely shaped differently:
  - `openapi-indexer-sync.ts` indexes spec *files*, not HTTP APIs — opt out, mark `[N/A — filesystem]`.
  - Anything using `fetch` more than once with bespoke parameters (e.g. a discriminated `xPost`) — replace each call site separately; same helper.
  - Anything that doesn't actually call `ctx.rateLimiter.acquire` (filesystem, kubernetes via library calls) — opt out.

  For an opt-out, leave the source unchanged and add a brief leading comment:

  ```typescript
  // connectorFetch opt-out: indexes filesystem specs, not paginated HTTP.
  ```

- [ ] **Step 3: Replace each `<x>Get` / `<x>Post` callsite.** The pattern:

  Before:
  ```typescript
  async function agGet(ctx, creds, path): Promise<FetchOutcome> {
    await ctx.rateLimiter.acquire(SERVICE_ID);
    const res = await fetch(`${creds.url}/api/v1${path}`, {
      headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
    });
    const text = await res.text();
    if (!res.ok) { ctx.logger.warn(...); return { kind: "http_error", bytes: text.length }; }
    try { return { kind: "ok", parsed: JSON.parse(text), bytes: text.length }; }
    catch { return { kind: "parse_error", bytes: text.length }; }
  }
  // ... outcome = await agGet(ctx, creds, "/applications");
  ```

  After:
  ```typescript
  import { connectorFetch } from "./_lib/fetch-outcome.ts";
  // ... agGet deleted entirely
  // ... outcome = await connectorFetch(ctx, SERVICE_ID, `${creds.url}/api/v1/applications`, {
  //       headers: { Authorization: `Bearer ${creds.token}`, Accept: "application/json" },
  //     });
  ```

  The connector keeps everything else — `SERVICE_ID`, cursor encoding, `syncPassCursor*` calls, tree-walk loops, `upsertIndexedItemForSync`, mapping functions.

- [ ] **Step 4: Delete the local `FetchOutcome` type alias** (now imported from `_lib/fetch-outcome.ts` via `connectorFetch`'s return type). If anything in the file still names `FetchOutcome` directly, `import type { FetchOutcome } from "./_lib/fetch-outcome.ts";`.

- [ ] **Step 5: Run the connector's existing tests**

  ```bash
  bun test packages/gateway/test/integration/connectors/<connector>-sync-fake-server.test.ts packages/gateway/test/unit/connectors/<connector>-*-mapping.test.ts
  ```

  (Test layout: integration in `test/integration/connectors/`, mapping unit in `test/unit/connectors/`. Test paths differ from the src-side `_lib` tests — the existing tests use fake `Bun.serve` HTTP servers driven via `createXSyncable(...)`.)

  Expected: all existing tests still pass. The external behaviour (endpoint, headers, status handling) is unchanged.

- [ ] **Step 6: Workspace typecheck** (`bun run typecheck`) — must stay green. The `Provider` literal union enforces `SERVICE_ID` matches a known provider; bad casts here surface as typecheck failures, not test failures.

- [ ] **Step 7: Commit the migration**

  ```bash
  git -C .worktrees/cleanup-pass add packages/gateway/src/connectors/<connector>-sync.ts
  git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
  refactor(connectors/<connector>): adopt connectorFetch helper

  Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
  EOF
  )"
  ```

Repeat for every connector from the list above. Mark the punch-list row `[EXTRACTED]` or `[N/A — opted out]` as appropriate.

**PoC commit (2026-05-28):** `argocd` migrated as 5a8f8bbf — 4 insertions, 23 deletions, 22 existing tests green. Validates the template.

### Task 4.8: Extract registerReadOnlyConnectorTools to SDK

**Files:**

- Create: `.worktrees/cleanup-pass/packages/sdk/src/server-helpers.ts`
- Create: `.worktrees/cleanup-pass/packages/sdk/src/server-helpers.test.ts`
- Modify: `.worktrees/cleanup-pass/packages/sdk/src/index.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/sdk/src/server-helpers.test.ts
import { describe, expect, test } from "bun:test";
import { registerReadOnlyConnectorTools } from "./server-helpers.ts";

describe("registerReadOnlyConnectorTools", () => {
  test("registers <name>_list, <name>_get, <name>_search", () => {
    const registered: string[] = [];
    const fakeServer = {
      registerTool: (name: string, _def: unknown) => { registered.push(name); },
    };
    registerReadOnlyConnectorTools(fakeServer as any, {
      name: "acme",
      list: async () => ({ items: [] }),
      get: async () => ({ item: null }),
      search: async () => ({ matches: [] }),
    });
    expect(registered).toEqual(["acme_list", "acme_get", "acme_search"]);
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/sdk/src/server-helpers.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/sdk/src/server-helpers.ts
import type { McpServer } from "./index.ts";

export interface ReadOnlyConnectorTools<L, G, S> {
  readonly name: string;
  readonly list: (input: unknown) => Promise<L>;
  readonly get: (input: unknown) => Promise<G>;
  readonly search: (input: unknown) => Promise<S>;
}

export function registerReadOnlyConnectorTools<L, G, S>(
  server: McpServer,
  tools: ReadOnlyConnectorTools<L, G, S>,
): void {
  server.registerTool(`${tools.name}_list`, { handler: tools.list });
  server.registerTool(`${tools.name}_get`, { handler: tools.get });
  server.registerTool(`${tools.name}_search`, { handler: tools.search });
}
```

(Adjust `McpServer` import path + `registerTool` signature to match the actual SDK type. Run `grep -n "registerTool\|McpServer" packages/sdk/src/` to confirm.)

- [ ] **Step 4: Export from SDK index**

Edit `packages/sdk/src/index.ts` to re-export:

```typescript
export { registerReadOnlyConnectorTools } from "./server-helpers.ts";
export type { ReadOnlyConnectorTools } from "./server-helpers.ts";
```

- [ ] **Step 5: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/sdk/src/server-helpers.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/sdk/src/server-helpers.ts packages/sdk/src/server-helpers.test.ts packages/sdk/src/index.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(sdk): export registerReadOnlyConnectorTools helper

Drives the per-MCP-connector dedupe in packages/mcp-connectors/*/src/server.ts.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.9: Per-MCP-connector migration to registerReadOnlyConnectorTools

For each `<connector>` in `packages/mcp-connectors/*/`:

- [ ] **Step 1: Replace bespoke tool registrations**

Open `packages/mcp-connectors/<connector>/src/server.ts`. Replace the three `server.registerTool("<connector>_list", ...)` / `_get` / `_search` blocks with:

```typescript
import { registerReadOnlyConnectorTools } from "@nimbus-dev/sdk";

registerReadOnlyConnectorTools(server, {
  name: "<connector>",
  list: handleList,
  get: handleGet,
  search: handleSearch,
});
```

- [ ] **Step 2: Run the connector's contract tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/mcp-connectors/<connector>/
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/mcp-connectors/<connector>/src/server.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(mcp-connectors/<connector>): adopt registerReadOnlyConnectorTools

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.10: Create createRpcDispatcher

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/ipc/_lib/dispatcher.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/ipc/_lib/dispatcher.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/ipc/_lib/dispatcher.test.ts
import { describe, expect, test } from "bun:test";
import { createRpcDispatcher, RpcMethodNotFound, RpcInvalidParams } from "./dispatcher.ts";

describe("createRpcDispatcher", () => {
  test("routes by method name", async () => {
    const dispatcher = createRpcDispatcher({
      "foo.bar": async (params: { x: number }) => ({ y: params.x * 2 }),
    });
    expect(await dispatcher("foo.bar", { x: 3 })).toEqual({ y: 6 });
  });

  test("throws RpcMethodNotFound for unknown method", async () => {
    const dispatcher = createRpcDispatcher({});
    await expect(dispatcher("nope", {})).rejects.toThrow(RpcMethodNotFound);
  });

  test("propagates handler errors", async () => {
    const dispatcher = createRpcDispatcher({
      "fail": async () => { throw new RpcInvalidParams("bad input"); },
    });
    await expect(dispatcher("fail", {})).rejects.toThrow(RpcInvalidParams);
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/ipc/_lib/dispatcher.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/ipc/_lib/dispatcher.ts
export class RpcMethodNotFound extends Error {
  constructor(method: string) { super(`Method not found: ${method}`); }
}

export class RpcInvalidParams extends Error {
  constructor(message: string) { super(message); }
}

export type RpcHandler<P = unknown, R = unknown> = (params: P) => Promise<R>;

export type RpcMethodMap = Record<string, RpcHandler<any, any>>;

export type RpcDispatcher = (method: string, params: unknown) => Promise<unknown>;

export function createRpcDispatcher(methods: RpcMethodMap): RpcDispatcher {
  return async function dispatch(method: string, params: unknown): Promise<unknown> {
    const handler = methods[method];
    if (!handler) throw new RpcMethodNotFound(method);
    return await handler(params);
  };
}
```

- [ ] **Step 4: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/ipc/_lib/dispatcher.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/ipc/_lib/dispatcher.ts packages/gateway/src/ipc/_lib/dispatcher.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(ipc): add createRpcDispatcher helper

Drives the per-namespace RPC dedupe in <namespace>-rpc.ts files.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.11: Per-RPC-namespace migration to createRpcDispatcher

For each `<namespace>` in `packages/gateway/src/ipc/*-rpc.ts`:

- [ ] **Step 1: Refactor**

Replace the existing `dispatch<Namespace>Rpc(method, params, ctx)` `if/else if` chain with a `createRpcDispatcher(...)` call constructed at module init:

```typescript
const dispatcher = createRpcDispatcher({
  "namespace.method1": async (params) => handler1(params, ctx),
  "namespace.method2": async (params) => handler2(params, ctx),
});

export async function dispatchNamespaceRpc(method: string, params: unknown): Promise<unknown> {
  return dispatcher(method, params);
}
```

- [ ] **Step 2: Run existing tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/test/unit/ipc/<namespace>*.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/ipc/<namespace>-rpc.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(ipc/<namespace>): adopt createRpcDispatcher

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

Repeat for: agents-rpc, llm-rpc, voice-rpc, updater-rpc, metrics-rpc, preflight-rpc, deployment-rpc, security-rpc, audit-rpc, index-reembed-rpc, and any other `*-rpc.ts` file surfaced by Task 1.4.

### Task 4.12: Create long-running IPC helper

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/ipc/_lib/long-running.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/ipc/_lib/long-running.test.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/ipc/_lib/long-running.test.ts
import { describe, expect, test } from "bun:test";
import { LongRunningJobRegistry } from "./long-running.ts";

describe("LongRunningJobRegistry", () => {
  test("starts a job, emits progress + done", async () => {
    const events: Array<{ kind: string; payload: unknown }> = [];
    const reg = new LongRunningJobRegistry({
      emit: (kind, payload) => { events.push({ kind, payload }); },
    });
    const { jobId } = reg.start({
      methodPrefix: "test",
      run: async (notifyProgress) => {
        notifyProgress({ done: 1, total: 2 });
        notifyProgress({ done: 2, total: 2 });
        return { result: "ok" };
      },
    });
    expect(jobId).toMatch(/^job_/);
    await reg.awaitJob(jobId);
    const kinds = events.map(e => e.kind);
    expect(kinds).toContain("test.progress");
    expect(kinds).toContain("test.done");
  });

  test("cancel triggers cancellation token", async () => {
    const reg = new LongRunningJobRegistry({ emit: () => {} });
    let cancelled = false;
    const { jobId } = reg.start({
      methodPrefix: "test",
      run: async (_progress, signal) => {
        await new Promise<void>(resolve => {
          signal.addEventListener("abort", () => { cancelled = true; resolve(); });
        });
        return { result: "cancelled" };
      },
    });
    expect(reg.cancel(jobId)).toBe(true);
    await reg.awaitJob(jobId);
    expect(cancelled).toBe(true);
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/ipc/_lib/long-running.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/ipc/_lib/long-running.ts
export interface ProgressUpdate {
  readonly done: number;
  readonly total: number;
  readonly skipped?: number;
}

export interface LongRunningJobSpec<R> {
  readonly methodPrefix: string;
  run(progress: (u: ProgressUpdate) => void, signal: AbortSignal): Promise<R>;
}

export interface LongRunningEmitter {
  emit(method: string, payload: unknown): void;
}

export interface LongRunningHandle {
  readonly jobId: string;
}

export class LongRunningJobRegistry {
  private nextId = 1;
  private readonly jobs = new Map<string, { controller: AbortController; done: Promise<void> }>();

  constructor(private readonly emitter: LongRunningEmitter) {}

  start<R>(spec: LongRunningJobSpec<R>): LongRunningHandle {
    const jobId = `job_${this.nextId++}`;
    const controller = new AbortController();
    const startedAt = Date.now();
    const done = (async () => {
      try {
        const result = await spec.run(
          (u) => this.emitter.emit(`${spec.methodPrefix}.progress`, { jobId, ...u }),
          controller.signal,
        );
        this.emitter.emit(`${spec.methodPrefix}.done`, { jobId, durationMs: Date.now() - startedAt, result });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        this.emitter.emit(`${spec.methodPrefix}.error`, { jobId, message });
      } finally {
        this.jobs.delete(jobId);
      }
    })();
    this.jobs.set(jobId, { controller, done });
    return { jobId };
  }

  cancel(jobId: string): boolean {
    const entry = this.jobs.get(jobId);
    if (!entry) return false;
    entry.controller.abort();
    return true;
  }

  awaitJob(jobId: string): Promise<void> {
    return this.jobs.get(jobId)?.done ?? Promise.resolve();
  }
}
```

- [ ] **Step 4: Run the tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/ipc/_lib/long-running.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/ipc/_lib/long-running.ts packages/gateway/src/ipc/_lib/long-running.test.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(ipc): add LongRunningJobRegistry helper

Drives dedupe of index.reembed-style { jobId } + progress/done/error pattern.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.13: Migrate index.reembed to LongRunningJobRegistry

- [ ] **Step 1: Refactor `packages/gateway/src/ipc/index-reembed-rpc.ts`**

Replace the bespoke job tracking with a `LongRunningJobRegistry({ emit: (m, p) => ipcServer.notify(m, p) })`.

- [ ] **Step 2: Run existing tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/test/unit/ipc/index-reembed*.test.ts packages/cli/test/e2e/scenarios/index-reembed*.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/ipc/index-reembed-rpc.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(ipc/index-reembed): adopt LongRunningJobRegistry

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.14: Extract applySchemaStep migration helper

**Files:**

- Modify: `.worktrees/cleanup-pass/packages/gateway/src/index/migrations/runner.ts`
- Modify: `.worktrees/cleanup-pass/packages/gateway/src/index/migrations/runner-v31.test.ts` (if needed)

- [ ] **Step 1: Refactor the runner**

In `runner.ts`, replace the per-step boilerplate functions (`migrateIndexedV28ToV29`, `migrateIndexedV29ToV30`, `migrateIndexedV30ToV31`) with declarative entries that consume a shared helper:

```typescript
function applySchemaStep(db: Database, step: { version: number; description: string; sql: string }, now: number): void {
  db.transaction(() => {
    dbExec(db, step.sql);
    dbExec(db, `PRAGMA user_version = ${step.version}`);
    recordMigration(db, step.version, step.description, now);
  })();
}

export const INDEXED_SCHEMA_STEPS: IndexedSchemaStep[] = [
  { version: 28, apply: (db, now) => applySchemaStep(db, { version: 28, description: "deployment_items shadow", sql: V28_SCHEMA_SQL }, now) },
  { version: 29, apply: (db, now) => applySchemaStep(db, { version: 29, description: "tool_call_log", sql: V29_SCHEMA_SQL }, now) },
  // … etc
];
```

- [ ] **Step 2: Run existing migration tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/index/migrations/
```

Expected: PASS — `runner-v31.test.ts` and any other migration tests exercise the same end-to-end behavior.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/index/migrations/runner.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(index/migrations): extract applySchemaStep helper

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.15: Extract runReadOnlyAgent + migrate expert.ts and impact.ts

**Files:**

- Create: `.worktrees/cleanup-pass/packages/gateway/src/agents/_lib/read-only-agent.ts`
- Create: `.worktrees/cleanup-pass/packages/gateway/src/agents/_lib/read-only-agent.test.ts`
- Modify: `.worktrees/cleanup-pass/packages/gateway/src/agents/expert.ts`
- Modify: `.worktrees/cleanup-pass/packages/gateway/src/agents/impact.ts`

- [ ] **Step 1: Write the test**

```typescript
// packages/gateway/src/agents/_lib/read-only-agent.test.ts
import { describe, expect, test } from "bun:test";
import { runReadOnlyAgent } from "./read-only-agent.ts";

describe("runReadOnlyAgent", () => {
  test("composes decompose + synthesize", async () => {
    const brief = await runReadOnlyAgent({
      decompose: async () => [{ id: "a", findings: ["fact-1"] }, { id: "b", findings: ["fact-2"] }],
      synthesize: async (results) => `Synth: ${results.flatMap(r => r.findings).join(", ")}`,
    });
    expect(brief).toBe("Synth: fact-1, fact-2");
  });
});
```

- [ ] **Step 2: Run test (should fail)**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/agents/_lib/read-only-agent.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Write the implementation**

```typescript
// packages/gateway/src/agents/_lib/read-only-agent.ts
export interface SubAgentResult {
  readonly id: string;
  readonly findings: readonly string[];
}

export interface ReadOnlyAgentSpec {
  decompose(): Promise<SubAgentResult[]>;
  synthesize(results: SubAgentResult[]): Promise<string>;
}

export async function runReadOnlyAgent(spec: ReadOnlyAgentSpec): Promise<string> {
  const results = await spec.decompose();
  return spec.synthesize(results);
}
```

- [ ] **Step 4: Migrate `expert.ts` to consume `runReadOnlyAgent`**

Refactor `runExpert` (or whatever it's called) so the parallel sub-agent decomposition + final synthesis goes through `runReadOnlyAgent`. The per-sub-agent logic (`AgentCoordinator.executeAll`) stays where it is; `runReadOnlyAgent` is the outer template.

- [ ] **Step 5: Migrate `impact.ts` the same way**

- [ ] **Step 6: Run existing agent tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/test/e2e/scenarios/expert.e2e.test.ts packages/gateway/test/e2e/scenarios/impact.e2e.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/agents/_lib/ packages/gateway/src/agents/expert.ts packages/gateway/src/agents/impact.ts
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(agents): extract runReadOnlyAgent template

expert and impact now share the decompose+synthesize template.

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 4.16: OAuth registry chain cleanup

- [ ] **Step 1: Identify remaining chains**

```bash
cd .worktrees/cleanup-pass && bun run scripts/cleanup/survey-oc.ts
```

Then open `docs/superpowers/specs/punchlist/04-oc-violations.md` and find every row whose discriminator is `service`/`provider` with literals matching OAuth providers (`google`, `microsoft`, `slack`, `notion`, `zoom`).

- [ ] **Step 2: Replace each chain with a registry lookup**

Pattern:

```typescript
// Before
if (provider === "google") { /* … */ }
else if (provider === "microsoft") { /* … */ }
// …

// After
const config = OAUTH_PROVIDERS[provider];
if (!config) throw new Error(`Unknown OAuth provider: ${provider}`);
// use config.<field>
```

- [ ] **Step 3: Run related tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/auth/
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/auth/ docs/superpowers/specs/punchlist/04-oc-violations.md
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(auth): replace remaining provider if/else chains with OAUTH_PROVIDERS

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Pass 5 — SOLID per subsystem

One commit per subsystem. Each cites the punch-list section 3 rows it resolves.

### Task 5.1: gateway/engine SOLID

- [ ] **Step 1: Audit `packages/gateway/src/engine/`**

For each file in the directory:

1. If `<file>` is in punch-list section 3 with proposed split, apply the split.
2. If a module imports a non-injectable dependency (`pino`, raw `Database`, `fs/promises`) directly and the module is tested by mocking that import (`mock.module`), refactor to constructor injection — see the auto-memory entry `bun-mock-module-model-ts-leak`.

**Constraints (do not violate):**

- `HITL_REQUIRED` set and `ToolExecutor.gate()` stay in `executor.ts` per I2.
- `wrapToolOutput` call sites at `engine/agent.ts:wrapToolForLlm` and `lazy-mesh/mesh.ts:397` are unchanged.

- [ ] **Step 2: Run engine tests**

```bash
cd .worktrees/cleanup-pass && bun run test:coverage:engine
```

Expected: PASS, coverage ≥85%.

- [ ] **Step 3: Run security-invariants test**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/security-invariants.test.ts
```

Expected: PASS — all sixteen invariant assertions still green.

- [ ] **Step 4: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/engine/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(engine): SOLID pass (SRP splits + DI)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.2: gateway/connectors final SOLID check

- [ ] **Step 1: Find connectors still >150 LOC**

```bash
cd .worktrees/cleanup-pass && find packages/gateway/src/connectors -maxdepth 1 -name '*-sync.ts' | while read f; do
  loc=$(wc -l < "$f")
  if [ "$loc" -gt 150 ]; then echo "$loc $f"; fi
done | sort -rn
```

- [ ] **Step 2: For each: confirm opt-out doc entry, or split**

If the file is the OpenAPI indexer or another genuine outlier with a leading opt-out comment, leave it. Otherwise: split the bespoke logic into a helper module under `_lib/` and reduce the connector file.

- [ ] **Step 3: Run connector tests**

```bash
cd .worktrees/cleanup-pass && bun run test:coverage:sync
```

Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/connectors/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(connectors): SOLID pass — enforce 150 LOC threshold or documented opt-out

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.3: gateway/ipc SOLID

- [ ] **Step 1: Interface segregation**

For each `<namespace>-rpc.ts`, check that the dispatched handler signatures are typed per-method (e.g. `engineAskParams`/`engineAskResult`) rather than a single huge union. Apply the split where missing.

- [ ] **Step 2: Run IPC tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/test/unit/ipc/
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/ipc/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(ipc): per-method typed signatures (interface segregation)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.4: gateway/db SOLID

- [ ] **Step 1: Audit `db/` files** for SRP violations using punch-list section 3 rows.

- [ ] **Step 2: Constraint check**: every write goes through `dbRun` / `dbExec` / `dbStmtRun` per I14. Run `bun run audit:invariants` after changes.

- [ ] **Step 3: Run db tests**

```bash
cd .worktrees/cleanup-pass && bun run test:coverage:db && bun run audit:invariants
```

Expected: both PASS.

- [ ] **Step 4: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/db/ packages/gateway/src/index/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(db): SOLID pass

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.5: gateway/vault Liskov check

- [ ] **Step 1: Confirm each platform impl genuinely implements `NimbusVault`**

For each of `vault/win32.ts`, `vault/darwin.ts`, `vault/linux.ts`: each declared method must do exactly what the `NimbusVault` interface promises, with no platform-specific signature widening or behavior leakage.

- [ ] **Step 2: Constraint check**: I12 (DPAPI entropy) wiring must stay. Run security-invariants test.

- [ ] **Step 3: Commit (if changes)**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/vault/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(vault): tighten platform impl conformance (Liskov)

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.6: gateway/llm + voice DI

- [ ] **Step 1: Refactor `LlmRouter` to accept providers as constructor args**

Today it likely imports `OllamaProvider` and `LlamaCppProvider` directly. Change to:

```typescript
class LlmRouter {
  constructor(private readonly providers: { ollama: LlmProvider; llamaCpp: LlmProvider }) {}
}
```

- [ ] **Step 2: Run llm tests**

```bash
cd .worktrees/cleanup-pass && bun test packages/gateway/src/llm/
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/gateway/src/llm/ packages/gateway/src/voice/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(llm+voice): provider DI

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.7: CLI command-file splits

- [ ] **Step 1: For each command file >300 LOC, split**

Reference punch-list section 3 for the file list. Typical split: `<command>.ts` becomes the thin CLI registration entry; `<command>-impl.ts` carries the actual implementation. The IPC plumbing stays in a third file if it's large.

- [ ] **Step 2: Run CLI tests**

```bash
cd .worktrees/cleanup-pass && cd packages/cli && bun test src/
```

Expected: PASS. Remember the auto-memory note: `bun test packages/cli/src` is the combined run where `mock.module` can leak. If a test breaks, prefer DI over `mock.module`.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/cli/src/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(cli): split command files >300 LOC

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.8: UI component splits

- [ ] **Step 1: For each React component file >250 LOC, extract sub-components**

Zustand store stays as is (slices are the split).

- [ ] **Step 2: Run UI tests**

```bash
cd .worktrees/cleanup-pass && cd packages/ui && bunx vitest run --coverage
```

Expected: PASS, ≥80% lines / ≥75% branches.

- [ ] **Step 3: Commit**

```bash
git -C .worktrees/cleanup-pass add packages/ui/src/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(ui): split components >250 LOC

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.9: SDK + client published-pkg conservative pass

- [ ] **Step 1: Audit `packages/sdk/src/` and `packages/client/src/`**

For each file: apply SOLID *only* where the change does not break the public API. Anything that breaks `index.ts` exports needs a version bump.

- [ ] **Step 2: Run SDK + client tests**

```bash
cd .worktrees/cleanup-pass && bun run test:coverage:sdk && bun run test:coverage:client
```

Expected: PASS, ≥80%.

- [ ] **Step 3: Commit (with any version bumps)**

If any export shape changed, bump the `version` in `packages/sdk/package.json` or `packages/client/package.json` (minor for additive, major for breaking).

```bash
git -C .worktrees/cleanup-pass add packages/sdk/ packages/client/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(sdk+client): conservative SOLID pass

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

### Task 5.10: vscode-extension minimal SOLID

- [ ] **Step 1: Apply comment strip + minor dedupe consistency**

The package is small. The pass is comment-strip verification + any obvious dedupe.

- [ ] **Step 2: Run extension typecheck**

```bash
cd .worktrees/cleanup-pass && cd packages/vscode-extension && bun run typecheck
```

Expected: PASS. (Recall auto-memory `vscode-extension-types-node-conflict`: `tsconfig.json` must keep `compilerOptions.types: ["node"]`.)

- [ ] **Step 3: Commit (if changes)**

```bash
git -C .worktrees/cleanup-pass add packages/vscode-extension/
git -C .worktrees/cleanup-pass commit -m "$(cat <<'EOF'
refactor(vscode-extension): minimal SOLID pass

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
EOF
)"
```

---

## Pass 6 — Verify

No code changes in Pass 6. Pure verification. If anything fails, fix in a new commit and re-run the failed gate.

### Task 6.1: Full preflight

- [ ] **Step 1: Run**

```bash
cd .worktrees/cleanup-pass && bun run preflight
```

Expected: every gate PASS.

If a gate fails: identify the gate, fix root cause, commit the fix with a clear message ("fix(<area>): <what>"), re-run.

### Task 6.2: Audit invariants

- [ ] **Step 1: Run**

```bash
cd .worktrees/cleanup-pass && bun run audit:invariants
```

Expected: PASS — D10 (I15), D12 (I14), vault-key allow-list all green.

### Task 6.3: Cross-platform audit

- [ ] **Step 1: Run**

```bash
cd .worktrees/cleanup-pass && bun run audit:cross-platform
```

Expected: PASS.

### Task 6.4: OpenAPI drift

- [ ] **Step 1: Run**

```bash
cd .worktrees/cleanup-pass && bun run audit:openapi-drift
```

Expected: PASS — OpenAPI schema and `READ_ONLY_HTTP_ROUTES` agree.

### Task 6.5: Linux docker coverage-floor reproduce

- [ ] **Step 1: Run the docker recipe from CLAUDE.md**

```bash
cd .worktrees/cleanup-pass && docker run --rm -v "$PWD":/src:ro oven/bun:latest bash -lc \
  'mkdir -p /app && (cd /src && tar --exclude=node_modules --exclude=.git -cf - .) | (cd /app && tar -xf -) \
   && cd /app && bun install && bun run audit:coverage-floor'
```

Expected: PASS. This is the CI-Linux-authoritative coverage check. If it fails on Linux while Windows passes, investigate `mock.module` contamination per the auto-memory entry.

### Task 6.6: Tauri allowlist cargo tests

- [ ] **Step 1: Run**

```bash
cd .worktrees/cleanup-pass && cd packages/ui/src-tauri && cargo test
```

Expected: PASS — `allowlist_exact_size`, `allowlist_is_alphabetized`, `allowlist_has_no_duplicates`, `allowlist_rejects_vault_and_raw_db_writes`, `no_timeout_methods_*` all green.

### Task 6.7: Compose PR description

- [ ] **Step 1: Generate the commit log**

```bash
cd .worktrees/cleanup-pass && git log main..HEAD --reverse --pretty=format:'- %h %s' > /tmp/cleanup-pr-body.md
```

- [ ] **Step 2: Write the PR description**

Use this template — save to `/tmp/cleanup-pr-body-final.md`:

```markdown
## Monorepo cleanup pass — comment strip, dedupe, SOLID

Implements the design at `docs/superpowers/specs/2026-05-28-monorepo-cleanup-design.md`.

### What changed

**Pass 1 — Survey (read-only).** Punch list at `docs/superpowers/specs/2026-05-28-monorepo-cleanup-punchlist.md` drives every subsequent commit.

**Pass 2 — Docs migration.** Load-bearing comments migrated to:
- `docs/SECURITY-INVARIANTS.md` (security/HITL rationale)
- `docs/architecture.md` (subsystem WHYs)
- `docs/internals/performance-tuning.md` (perf constants)
- `docs/internals/upstream-workarounds.md` (library bug refs)
- `docs/internals/platform-quirks.md` + `docs/sandbox.md` (platform notes)
- `docs/internals/migration-history.md` (DB migration WHYs)
- `docs/internals/test-fixtures.md` (fixture rationale)
- `docs/internals/types-reference.md` (type-field narrative)
- `docs/internals/known-todos.md` (concrete TODOs/FIXMEs)
- `docs/connectors/<name>.md` (per-connector quirks)

**Pass 3 — Comment strip.** One mechanical commit driven by `scripts/cleanup/strip-comments.ts`. **Reviewer tip:** read the script first (~200 LOC, fully tested), then trust the diff.

Preserved: shebangs, tooling pragmas (`@ts-*`, `biome-ignore`, `eslint-disable-*`, `dprint-ignore`, `prettier-ignore`), `cross-platform-ok` markers, JSDoc on `@nimbus-dev/sdk` and `@nimbus-dev/client` published surfaces.

Deleted: every other comment in `.ts`, `.tsx`, `.js`, `.rs` under `packages/` and `scripts/`. All TODO/FIXME/HACK/XXX markers.

**Pass 4 — Dedupe.** Themed commits:
- `connectors/_lib/` — Pagination, AuthHeaderProvider, RateLimitObserver, ConnectorHttpClient, buildIndexedItem, runConnectorSync template. ~N connectors migrated (others opt out with documented reason).
- `ipc/_lib/` — createRpcDispatcher, LongRunningJobRegistry. All `<namespace>-rpc.ts` files use the dispatcher.
- `index/migrations/` — applySchemaStep replaces per-step boilerplate.
- `agents/_lib/` — runReadOnlyAgent template. `expert.ts` and `impact.ts` consume it.
- `auth/` — remaining provider if/else chains replaced with `OAUTH_PROVIDERS` lookups.
- `@nimbus-dev/sdk` — `registerReadOnlyConnectorTools` helper. All MCP connector servers consume it.

**Pass 5 — SOLID per subsystem.** One commit each for engine, connectors, ipc, db, vault, llm/voice, cli, ui, sdk/client, vscode-extension. Splits files >threshold; converts module-import dependencies to constructor injection where mock.module was the workaround.

**Pass 6 — Verify.** `bun run preflight`, `audit:invariants`, `audit:cross-platform`, `audit:openapi-drift`, Linux docker `audit:coverage-floor`, and Tauri `cargo test` all green.

### What did NOT change

- Security invariants I1–I16. All wiring sites intact; `security-invariants.test.ts` green.
- HITL `HITL_REQUIRED` set and `ToolExecutor.gate()` module privacy.
- Vault key names (user data — renames would silently lose tokens after upgrade).
- License fields in every `package.json`.
- Audit chain BLAKE3 format.
- Cross-platform parity. `audit:cross-platform` clean.
- Existing test files. Touched only where a refactored module's import path or signature genuinely changed; assertions never edited.
- Tauri `ALLOWED_METHODS` array contents (renames updated allowlist + count assertion in lockstep where applicable).
- OpenAPI surface (`POST /v1/deployments`, read-only routes).

### Reviewer guide

1. Read `docs/superpowers/specs/2026-05-28-monorepo-cleanup-design.md` for context.
2. Skim the punch list at `docs/superpowers/specs/2026-05-28-monorepo-cleanup-punchlist.md`.
3. Read commits in order. Pass 3 (comment strip) is huge but mechanical — diff `scripts/cleanup/strip-comments.ts` first, then trust the bulk output.
4. Pass 4 commits cite punch-list rows by section + line range.
5. Pass 5 commits cite punch-list section 3 rows.

### Commits

(paste contents of /tmp/cleanup-pr-body.md here)
```

- [ ] **Step 3: Stop here. Do NOT push.**

The plan explicitly does not include `git push`. The user opens the PR manually with `gh pr create` after reviewing the local stack.

---

## Review-driven amendments (2026-05-28)

After plan review (`2026-05-28-monorepo-cleanup-pass-review.md`):

- **Task 1.6 (survey-oc.ts) switched from regex to TypeScript AST walker.** The regex parser could be fooled by literals in strings, commented-out code, and multi-line statements. The AST walk via `ts.createSourceFile` + `ts.forEachChild` is structurally accurate. `.rs` files remain out of scope for this survey (Rust OC surface is small enough to audit by hand).
- **Task 3.1 (stripRustSource) now handles raw strings.** The parser detects `r"..."`, `r#"..."#`, `r##"..."##`, etc. Char literals and lifetime markers (`'a`) are handled separately. Unterminated raw strings or block comments cause the function to *abstain* (return the source unchanged) rather than risk corruption; the strip script prints a warning and lists abstained files at the end for manual audit. Tests added for each preserved pattern.
- **Task 4.6 (runConnectorSync) contract clarified.** `fetchPage` now returns `HttpResponse<B>` directly (no `.body` extraction in the caller). The template passes `response` to `Pagination.nextState` without synthesising a `fakeResp` envelope. `mapPage` renamed to `mapBody` to match the new contract — the function receives the parsed body, not an envelope. A test covers the array-bodied API case explicitly so the behaviour is documented.
- **Task 4.7 duration acknowledged.** Per-connector migrations parallelise freely once the helper modules land — subagent-driven execution should fan out 4–6 at a time. Sequential time estimate added.
- **Internal JSDoc and mega-PR delivery: unchanged.** Both already-decided in the design review; reviewer's reiteration noted but no plan change.

## Self-review checklist (run after writing the plan)

- [x] Every spec section maps to at least one task (pass 0 prep, passes 1–6).
- [x] No "TBD" / "implement later" / "add appropriate error handling" placeholders.
- [x] Type signatures consistent across tasks (e.g. `Pagination<S>` used the same in 4.1, 4.4, 4.6).
- [x] Every code step has full code (not a description).
- [x] Every run step has the expected output described.
- [x] Discovery-dependent tasks (2.2–2.11, 4.7, 4.9, 4.11, 5.x) are templated with the same shape so the executing worker can pattern-match.
- [x] Security invariants are reaffirmed at every relevant subsystem task.
- [x] Final task is "Stop here. Do NOT push." — matches the spec's explicit constraint.
