// Agent visibility is PRESENTATION ONLY: it shapes what `nimbus catalog` and `config explain`
// show, and nothing else. No gate, dispatcher, HTTP route, MCP tool, fleet or ChatOps path may
// read it, so hiding an agent can never refuse a call. This guard pins that structurally, each
// rule written as what CANNOT pass rather than a list of places to look.
//
// No comment stripping anywhere: a regex stripper cannot tell `"/v1/*"` from a comment opener and
// silently deleted real code. Imports come from Bun's own parser; the other rules scan raw text,
// so a comment mention can only make them stricter, never blind.

import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { parseNimbusAgentsToml } from "../config/nimbus-toml.ts";

const SRC = join(import.meta.dir, "..");
const CATALOG_DIR = join(SRC, "catalog");

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listSourceFiles(full));
    else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) out.push(full);
  }
  return out;
}

const FILES = listSourceFiles(SRC).map((full) => ({
  full,
  rel: relative(SRC, full).split(sep).join("/"),
  code: readFileSync(full, "utf8"),
}));

const transpiler = new Bun.Transpiler({ loader: "ts" });

function isInsideCatalog(absPath: string): boolean {
  const r = relative(CATALOG_DIR, absPath);
  return r === "" || (!r.startsWith("..") && !r.startsWith(sep) && !/^[a-z]:/i.test(r));
}

/**
 * Whether `code` imports anything under `catalog/`: static, side-effect and dynamic imports with
 * a literal specifier, each resolved against the importing file. Bound: a type-only import is
 * erased by the parser (it carries no runtime read), and a dynamically composed specifier
 * evades it.
 */
function importsCatalog(full: string, code: string): boolean {
  // The scanner rejects a leading `#!` line (an entry-point shebang); drop that one line.
  const source = code.startsWith("#!") ? code.replace(/^#![^\n]*/, "") : code;
  return transpiler
    .scanImports(source)
    .some((imp) => imp.path.startsWith(".") && isInsideCatalog(resolve(dirname(full), imp.path)));
}

const RESOLVER_ALLOWED = new Set([
  "catalog/agent-visibility.ts",
  "catalog/catalog-list.ts",
  "ipc/diagnostics-rpc.ts",
]);

const CATALOG_IMPORTERS_ALLOWED = new Set(["ipc/catalog-rpc.ts", "ipc/diagnostics-rpc.ts"]);

const AGENTS_LITERAL = /["'`](?:agents|\[agents\])["'`]/;
const VISIBILITY_KEY_LITERAL = /["'`](?:show|hide|visible)["'`]/;

describe("agent visibility is presentation only", () => {
  test("the scan sees the gateway source", () => {
    expect(FILES.some((f) => f.rel === "catalog/agent-visibility.ts")).toBe(true);
    expect(FILES.some((f) => f.rel === "ipc/agents-rpc.ts")).toBe(true);
    // The import scan is real: the two allowed importers are seen importing catalog/.
    for (const rel of CATALOG_IMPORTERS_ALLOWED) {
      const f = FILES.find((x) => x.rel === rel);
      expect(f !== undefined && importsCatalog(f.full, f.code)).toBe(true);
    }
  });

  test("(a) resolveAgentVisibility is named only by the catalog and config explain", () => {
    const offenders = FILES.filter(
      (f) => /\bresolveAgentVisibility\b/.test(f.code) && !RESOLVER_ALLOWED.has(f.rel),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("(b) only the catalog RPC and config explain import from catalog/", () => {
    const offenders = FILES.filter(
      (f) =>
        !f.rel.startsWith("catalog/") &&
        !CATALOG_IMPORTERS_ALLOWED.has(f.rel) &&
        importsCatalog(f.full, f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });

  test("(c) the [agents] loader reads only synthesis settings", () => {
    const parsed = parseNimbusAgentsToml(
      '[agents]\nsynthesis = "off"\nshow = ["standup"]\nhide = ["oncall"]\nvisible = ["why"]\n',
    );
    expect(Object.keys(parsed).sort()).toEqual(["synthesis", "synthesisTimeoutMs"]);
  });

  // Bound: whole-file co-occurrence of two exact literals. A dynamically composed key (for
  // example `"agen" + "ts"`, or a key read through a variable) evades it; rules (a) and (b) and
  // the layered reader being the only TOML entry point (D35) are what cover that.
  test("(d) outside catalog/ and config/, no file names both [agents] and a visibility key", () => {
    const offenders = FILES.filter(
      (f) =>
        !f.rel.startsWith("catalog/") &&
        !f.rel.startsWith("config/") &&
        AGENTS_LITERAL.test(f.code) &&
        VISIBILITY_KEY_LITERAL.test(f.code),
    ).map((f) => f.rel);
    expect(offenders).toEqual([]);
  });
});
