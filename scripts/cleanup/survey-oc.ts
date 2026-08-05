// scripts/cleanup/survey-oc.ts
// AST-based finder: 3+ if/else-if branches comparing the same discriminator
// to string literals, or switch statements with 3+ string-literal case clauses.
// Uses the TypeScript compiler API for accurate parsing — regex parsing of
// source code trips on strings, commented-out code, and multi-line statements.
// .rs files are excluded (Rust OC surface is small enough to audit by hand).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
// TypeScript 7 is the native port: its `typescript` package exports only lib/version.cjs at
// the root, and the compiler API moved to the explicitly UNSTABLE `typescript/unstable/*`
// subpaths. This script drives the compiler API directly, so it resolves a pinned TypeScript 6
// through the `typescript-compiler-api` alias rather than build repo tooling on an API its own
// maintainers label unstable. Everything else in the repo typechecks with 7.
import ts from "typescript-compiler-api";
import { iterateSourceFiles, REPO_ROOT, relPath } from "./lib.ts";

interface Cluster {
  file: string;
  startLine: number;
  discriminator: string;
  literals: string[];
  kind: "if" | "switch";
}

function discriminatorText(expr: ts.Expression): string | null {
  if (ts.isIdentifier(expr)) return expr.text;
  if (ts.isPropertyAccessExpression(expr)) {
    const base = discriminatorText(expr.expression);
    return base ? `${base}.${expr.name.text}` : null;
  }
  return null;
}

function extractIfLiteralBranch(
  node: ts.IfStatement,
): { discriminator: string; literal: string } | null {
  const cond = node.expression;
  if (!ts.isBinaryExpression(cond)) return null;
  if (cond.operatorToken.kind !== ts.SyntaxKind.EqualsEqualsEqualsToken) return null;
  let identSide: ts.Expression;
  let litSide: ts.Expression;
  if (ts.isStringLiteral(cond.right)) {
    identSide = cond.left;
    litSide = cond.right;
  } else if (ts.isStringLiteral(cond.left)) {
    identSide = cond.right;
    litSide = cond.left;
  } else return null;
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
    if (next?.discriminator !== first.discriminator) break;
    literals.push(next.literal);
    cur = cur.elseStatement;
  }
  if (literals.length < 3) return null;
  return {
    file: source.fileName,
    startLine,
    discriminator: first.discriminator,
    literals,
    kind: "if",
  };
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
  out.push(
    `Total clusters: ${all.length}`,
    "",
    "| File | Line | Kind | Discriminator | Literals |",
    "|---|---|---|---|---|",
  );
  for (const c of all) {
    out.push(
      `| \`${c.file}\` | ${c.startLine} | ${c.kind} | \`${c.discriminator}\` | ${c.literals.length} (${c.literals.slice(0, 6).join(", ")}${c.literals.length > 6 ? "…" : ""}) |`,
    );
  }
  out.push(
    "",
    "## Triage rule",
    "",
    "- Discriminator is `service` / `provider` / `connector` / `type` / `kind` → strong registry candidate.",
    "- Discriminator is a tagged-union state field (`status`, `state`) → leave as switch; that's idiomatic.",
    "- Discriminator is a config flag (`mode`, `level`) → registry only if open to extension; otherwise keep.",
  );
  const target = `${REPO_ROOT}/docs/superpowers/specs/punchlist/04-oc-violations.md`;
  await mkdir(dirname(target), { recursive: true });
  await writeFile(target, `${out.join("\n")}\n`, "utf8");
  console.log(`Wrote ${all.length} OC candidates to ${relPath(target)}`);
}

await main();
