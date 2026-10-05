/**
 * Test support for the I26 code-execution sync guard (`../connector-code-execution-sync.test.ts`).
 *
 * Reads the INSTALLED `@nimbus-dev/connectors` source as TEXT (never importing it — the gateway's one
 * import from that package is `setConnectorMode`) and answers two questions: which connectors can
 * start a process or evaluate code on the machine that runs them, and which tool ids each of those
 * registers. A tool that runs caller-directed code (`iac_terraform_plan`, `iac_pulumi_preview`) can
 * only live in such a connector, so the guard requires every tool of every one of them to be
 * classified — refused at the federated door, or reviewed — and a connector that newly gains the
 * capability fails the guard until someone has looked at it.
 *
 * A file has the capability when its code (comments removed, string text blanked) names the `Bun`
 * global, `eval`, the `Function` constructor, a `Worker`, or `process.dlopen` / `process.binding`,
 * or when it imports a module that grants one (`node:child_process`, `node:vm`,
 * `node:worker_threads`, `node:module`, `bun`, `bun:ffi`, `bun:sqlite`, ...). The capability flows
 * back along RELATIVE imports, to a fixed point: a connector importing `shared/run-cli-json.ts`,
 * which imports `shared/nimbus-spawn.ts`, which spawns, can spawn.
 *
 * Tool ids are read from calls whose first argument is a tool-id-shaped string literal
 * (`reg("iac_terraform_plan", ...)`, `registerWriteTool("k8s_pod_delete", ...)`). When a connector
 * also exports upstream's own `<NAME>_TOOL_NAMES` list, the two must agree.
 *
 * Every shape it cannot follow is a VIOLATION, never a silent skip: a dynamic loader whose specifier
 * is not a plain string literal (it could load any module) — BOTH the bare form (`import(x)` /
 * `require(x)`) and the member form (`module.require(x)`, `import.meta.require(x)`,
 * `globalThis.require(x)`), which the bare pattern's lookbehind would otherwise skip — a relative
 * import of code that resolves to no source file, a connector with the capability but no derived tool
 * id, and a `<NAME>_TOOL_NAMES` export that disagrees with the derivation.
 *
 * STATED BOUND: the capability is recognised by NAME, so reflection (`globalThis["Bun"]`,
 * `globalThis["req"+"uire"](x)`) and a third-party package that spawns internally (a bare specifier
 * not listed below) are not seen; and a tool id not written as a literal is derived only when the
 * connector's `<NAME>_TOOL_NAMES` export names it. The wire test
 * (`test/integration/connectors/write-tool-namespacing.integration.test.ts`) checks the derivation
 * against what real `aws`, `kubernetes` and `iac` processes list.
 */
import { posix } from "node:path";
import { stripComments, stripStringLiterals } from "../../../../../scripts/structure-audit/lib.ts";
import type { PackageSource, ScanViolation } from "./connector-write-registrations.ts";

export interface SpawningConnector {
  /** Its directory under `connectors/` — `iac`, `cloud-logging`. */
  readonly id: string;
  /** Its files that can start a process or evaluate code, package-relative and sorted. */
  readonly capableFiles: readonly string[];
  /** Every tool id it registers by literal, sorted. */
  readonly toolIds: readonly string[];
}

export interface ProcessSpawnScan {
  /** Sorted by id. */
  readonly connectors: readonly SpawningConnector[];
  readonly violations: readonly ScanViolation[];
}

/** Modules whose import alone grants a process, code-evaluation or native-code capability. */
export const CAPABILITY_MODULES: ReadonlySet<string> = new Set([
  "child_process",
  "node:child_process",
  "worker_threads",
  "node:worker_threads",
  "vm",
  "node:vm",
  "module",
  "node:module",
  "bun",
  "bun:ffi",
  "bun:jsc",
  "bun:sqlite",
  "node:sqlite",
]);

/** Globals that grant the capability without an import. Matched on code with strings blanked. */
const CAPABILITY_GLOBAL_RE =
  /(?<![\w$])Bun\b|(?<![\w$.])(?:eval|Function|Worker)\s*\(|\bprocess\s*\.\s*(?:dlopen|binding|_linkedBinding)\b/;

const TOOL_ID_RE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;
const CONNECTOR_FILE_RE = /^connectors\/([^/]+)\//;
/** A relative specifier that names code (a script extension, or none) rather than data. */
const CODE_SPECIFIER_RE = /(?:\.[cm]?[jt]sx?|\/[^/.]*)$/;

interface Prepared {
  readonly rel: string;
  /** Comments removed, string contents kept. */
  readonly code: string;
  /** `code` with string and template text blanked to spaces — same length, so offsets agree. */
  readonly blank: string;
}

interface FileFacts {
  readonly capable: boolean;
  readonly relativeImports: readonly string[];
}

interface ConnectorAcc {
  readonly capableFiles: string[];
  readonly toolIds: Set<string>;
  declared: string[] | undefined;
}

function lineAt(code: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < code.length; i++) if (code.charAt(i) === "\n") line++;
  return line;
}

/** The text of the single-line string literal whose opening quote is at `quote`, if any. */
function literalAt(code: string, quote: number): string | undefined {
  const q = code.charAt(quote);
  if (q !== '"' && q !== "'") return undefined;
  const end = code.indexOf(q, quote + 1);
  if (end === -1) return undefined;
  const text = code.slice(quote + 1, end);
  return text.includes("\n") || text.includes("\\") ? undefined : text;
}

/** The literal starting at `at` when it is the WHOLE argument list, as in `import("x")`. */
function soleLiteralArgument(code: string, at: number): string | undefined {
  const spec = literalAt(code, at);
  if (spec === undefined) return undefined;
  return /^\s*\)/.test(code.slice(at + spec.length + 2)) ? spec : undefined;
}

/** Dynamic-loader call shapes: a literal specifier is followed, a non-literal one is a violation. */
const DYNAMIC_LOADER_RES: readonly RegExp[] = [
  // Bare: `import(...)` / `require(...)`.
  /(?<![\w$.])(?:import|require)\s*\(\s*/g,
  // Member: `module.require(...)`, `import.meta.require(...)`, `globalThis.require(...)`. The bare
  // pattern's `(?<![\w$.])` lookbehind EXCLUDES a `.`-prefixed call, so without this a
  // `module.require(name)` with a computed specifier is neither followed nor flagged — it loads any
  // module all the same. (There is no member-form dynamic `import()` in JS, so only `require` here.)
  /\.\s*require(?![\w$])\s*\(\s*/g,
];

/** Every module specifier a file names; a dynamic load it cannot read is a violation. */
function specifiersOf(p: Prepared, violations: ScanViolation[]): string[] {
  const out: string[] = [];
  // Static: `import ... from "x"`, `export ... from "x"`, `import "x"`.
  for (const m of p.blank.matchAll(/\b(?:from|import)\s*(?=["'])/g)) {
    const spec = literalAt(p.code, (m.index ?? 0) + m[0].length);
    if (spec !== undefined) out.push(spec);
  }
  // Dynamic: a loader call reaches ANY module unless its specifier is a plain string literal.
  for (const re of DYNAMIC_LOADER_RES) {
    for (const m of p.blank.matchAll(re)) {
      const spec = soleLiteralArgument(p.code, (m.index ?? 0) + m[0].length);
      if (spec !== undefined) out.push(spec);
      else {
        violations.push({
          file: p.rel,
          line: lineAt(p.code, m.index ?? 0),
          reason: "a dynamic import/require whose specifier is not a plain string literal",
        });
      }
    }
  }
  return out;
}

/** The package-relative file a relative specifier names, or undefined when there is none. */
function resolveRelative(
  from: string,
  spec: string,
  known: ReadonlySet<string>,
): string | undefined {
  const base = posix.normalize(posix.join(posix.dirname(from), spec));
  const candidates = [base, `${base}.ts`, base.replace(/\.js$/, ".ts"), `${base}/index.ts`];
  return candidates.find((c) => known.has(c));
}

function factsOf(p: Prepared, known: ReadonlySet<string>, violations: ScanViolation[]): FileFacts {
  let capable = CAPABILITY_GLOBAL_RE.test(p.blank);
  const relativeImports: string[] = [];
  for (const spec of specifiersOf(p, violations)) {
    if (!spec.startsWith(".")) {
      capable ||= CAPABILITY_MODULES.has(spec);
      continue;
    }
    const target = resolveRelative(p.rel, spec, known);
    if (target !== undefined) relativeImports.push(target);
    // A JSON import cannot run anything; a missing MODULE could be anything.
    else if (CODE_SPECIFIER_RE.test(spec)) {
      violations.push({ file: p.rel, line: 1, reason: `unresolved relative import "${spec}"` });
    }
  }
  return { capable, relativeImports };
}

/** Every file that can reach the capability, directly or along relative imports. */
function closeOverImports(facts: ReadonlyMap<string, FileFacts>): Set<string> {
  const capable = new Set([...facts].filter(([, f]) => f.capable).map(([rel]) => rel));
  let grew = true;
  while (grew) {
    grew = false;
    for (const [rel, f] of facts) {
      if (!capable.has(rel) && f.relativeImports.some((t) => capable.has(t))) {
        capable.add(rel);
        grew = true;
      }
    }
  }
  return capable;
}

/** Tool ids passed as the first, literal argument of a call that takes more arguments. */
function literalToolIds(p: Prepared): string[] {
  const out: string[] = [];
  for (const m of p.blank.matchAll(/(?<![\w$])[A-Za-z_$][\w$]*\s*\(\s*(?=["'])/g)) {
    const at = (m.index ?? 0) + m[0].length;
    const id = literalAt(p.code, at);
    if (id === undefined || !TOOL_ID_RE.test(id)) continue;
    if (/^\s*,/.test(p.code.slice(at + id.length + 2))) out.push(id);
  }
  return out;
}

/** Upstream's own `export const <NAME>_TOOL_NAMES = [...]` list, when the file has one. */
function declaredToolIds(p: Prepared): string[] | undefined {
  const m = /\bexport\s+const\s+[A-Z][A-Z0-9_]*_TOOL_NAMES\b[^=]*=\s*\[/.exec(p.blank);
  if (m === null) return undefined;
  const open = m.index + m[0].length;
  const close = p.blank.indexOf("]", open);
  if (close === -1) return undefined;
  return [...p.code.slice(open, close).matchAll(/["']([^"'\n]+)["']/g)].map((x) => x[1] ?? "");
}

function connectorOf(rel: string): string | undefined {
  return CONNECTOR_FILE_RE.exec(rel)?.[1];
}

/** The capable files, grouped by the connector they belong to (shared files belong to none). */
function groupByConnector(capable: ReadonlySet<string>): Map<string, ConnectorAcc> {
  const byConnector = new Map<string, ConnectorAcc>();
  for (const rel of [...capable].sort((a, b) => a.localeCompare(b))) {
    const id = connectorOf(rel);
    if (id === undefined) continue;
    const acc = byConnector.get(id) ?? {
      capableFiles: [],
      toolIds: new Set(),
      declared: undefined,
    };
    acc.capableFiles.push(rel);
    byConnector.set(id, acc);
  }
  return byConnector;
}

/** Every file of a capable connector contributes its tools: they all run in the same process. */
function collectToolIds(
  prepared: readonly Prepared[],
  byConnector: Map<string, ConnectorAcc>,
): void {
  for (const p of prepared) {
    const acc = byConnector.get(connectorOf(p.rel) ?? "");
    if (acc === undefined) continue;
    for (const id of literalToolIds(p)) acc.toolIds.add(id);
    acc.declared ??= declaredToolIds(p);
  }
}

function toConnector(
  id: string,
  acc: ConnectorAcc,
  violations: ScanViolation[],
): SpawningConnector {
  const file = acc.capableFiles[0] ?? `connectors/${id}`;
  if (acc.toolIds.size === 0) {
    violations.push({
      file,
      line: 1,
      reason: `${id} can start a process but registers no tool id the scan can read`,
    });
  }
  const declared = acc.declared;
  if (declared !== undefined) {
    const agrees =
      declared.length === acc.toolIds.size && declared.every((t) => acc.toolIds.has(t));
    if (!agrees) {
      violations.push({
        file,
        line: 1,
        reason: `${id}: its *_TOOL_NAMES export disagrees with the tool ids derived from its calls`,
      });
    }
  }
  return {
    id,
    capableFiles: acc.capableFiles,
    toolIds: [...acc.toolIds].sort((a, b) => a.localeCompare(b)),
  };
}

/**
 * Derive every connector that can start a process or evaluate code, with the tool ids it
 * registers. Fail-closed: see the module comment for what is reported as a violation.
 */
export function scanProcessSpawningConnectors(sources: readonly PackageSource[]): ProcessSpawnScan {
  const violations: ScanViolation[] = [];
  const known = new Set(sources.map((s) => s.rel));
  const prepared = sources.map((s): Prepared => {
    const code = stripComments(s.text);
    return { rel: s.rel, code, blank: stripStringLiterals(code) };
  });
  const facts = new Map(prepared.map((p) => [p.rel, factsOf(p, known, violations)] as const));
  const byConnector = groupByConnector(closeOverImports(facts));
  collectToolIds(prepared, byConnector);
  const connectors = [...byConnector]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([id, acc]) => toConnector(id, acc, violations));
  return { connectors, violations };
}
