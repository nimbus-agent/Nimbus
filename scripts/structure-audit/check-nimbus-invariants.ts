#!/usr/bin/env bun
// D10/D11/D12 — Nimbus-specific structural invariant checks.
//
// Subcommands:
//   --rule spawn          D10: connectors/ spawn must use extensionProcessEnv() (binary, exits non-zero on hits)
//   --rule wrap-spec      D10 (I15): every lazy-mesh ServerSpec construction must call wrapServerSpec()
//   --rule vault-key      D11: vault-key construction must be in the allow-list (binary, exits non-zero on hits)
//   --rule db-run         D12: census of db.run() outside db/write.ts (always exit 0; writes JSON)
//   --rule db-run-exec    D12: binary gate — db.run/db.exec outside allow-list (exits non-zero on hits)
//   --binary-only         runs spawn + wrap-spec + vault-key + db-run-exec (CI mode)
//   (no flag)             runs everything; binary-violation exit code on D10/D11/D12

import { CONNECTOR_VAULT_SECRET_KEYS } from "../../packages/gateway/src/connectors/connector-secrets-manifest.ts";
import { auditOutputPath, iterateSourceFiles, stripComments } from "./lib.ts";

export type FileEntry = { relPath: string; contents: string };
export type Violation = { rule: string; file: string; line: number; snippet: string };

export const VAULT_KEY_ALLOW_LIST = [
  "packages/gateway/src/connectors/connector-vault.ts",
  "packages/gateway/src/auth/google-access-token.ts",
  "packages/gateway/src/auth/pkce.ts",
  // Provider-shared OAuth canonical reader (Microsoft); mirrors google-access-token.ts.
  "packages/gateway/src/auth/oauth-vault-tokens.ts",
  // OpenAI embedding provider — not a Nimbus connector; no ConnectorServiceId.
  "packages/gateway/src/embedding/create-embedding-runtime.ts",
  // Canonical declaration of per-connector vault keys; structurally equivalent
  // to connector-vault.ts (declaration site, not runtime construction).
  "packages/gateway/src/connectors/connector-secrets-manifest.ts",
];

// Match a Bun.spawn or child_process spawn call.
const SPAWN_RE = /\b(?:Bun\.spawn|Bun\.spawnSync|child_process\.spawn|spawn)\s*\(/;

export function checkSpawnInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith("packages/gateway/src/connectors/")) continue;
    const lines = f.contents.split("\n");
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (!SPAWN_RE.test(line)) continue;
      // Look for extensionProcessEnv on the same line OR within the next 5 lines.
      const window = lines.slice(i, Math.min(i + 6, lines.length)).join("\n");
      if (window.includes("extensionProcessEnv")) continue;
      out.push({
        rule: "D10-spawn",
        file: f.relPath,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
  return out;
}

// I15 — every lazy-mesh file that constructs a `ServerSpec` (either by
// instantiating `new MCPClient({ servers: { ... } })` or by populating a
// `Record<string, ServerSpec>`) must also call `wrapServerSpec(...)` so
// MCPClient's internal spawn lands in `sandbox-wrapper.ts` (T2 PR 1).
//
// The plan amendment (Option A wrapper-command shim) means there are zero
// direct `spawn(` calls under lazy-mesh — the I1 D10 rule has nothing to
// catch there. I15 is the equivalent static rule for the wrapper-spec
// rewrite that replaces the (now-impossible) direct spawn interception.
//
// Exemptions:
//   - `wrap-server-spec.ts`     — defines `wrapServerSpec`; cannot call itself.
//   - `slot.ts`                 — declares the `ServerSpec` type only; no construction.
//   - `tool-map.ts`             — type-only `MCPClient` import; no construction.
//   - `first-party-manifests.ts` — manifest data only; references in comments.
export const LAZY_MESH_DIR = "packages/gateway/src/connectors/lazy-mesh";
export const I15_EXEMPT: readonly string[] = [
  `${LAZY_MESH_DIR}/wrap-server-spec.ts`,
  `${LAZY_MESH_DIR}/slot.ts`,
  `${LAZY_MESH_DIR}/tool-map.ts`,
  `${LAZY_MESH_DIR}/first-party-manifests.ts`,
];

// `new MCPClient(` catches `mesh.ts` + `user-mcp.ts` + `connector-spawns.ts`.
// `Record<string, ServerSpec>` catches `phase3-config.ts` which builds the
// records and hands them to a parent `MCPClient` constructor elsewhere.
const I15_CONSTRUCTS_RE = /\bnew\s+MCPClient\s*\(|Record\s*<\s*string\s*,\s*ServerSpec\s*>/;
const I15_WRAP_RE = /\bwrapServerSpec\s*\(/;

export function checkWrapServerSpecInvariant(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith(`${LAZY_MESH_DIR}/`)) continue;
    if (I15_EXEMPT.includes(f.relPath)) continue;
    // Strip comments so doc-block mentions of `new MCPClient(` (e.g. the
    // rationale in `wrap-server-spec.ts`) and `Record<string, ServerSpec>`
    // descriptions in JSDoc do not trigger the heuristic.
    const stripped = stripComments(f.contents);
    if (!I15_CONSTRUCTS_RE.test(stripped)) continue;
    if (I15_WRAP_RE.test(stripped)) continue;
    // First line that hits the construct pattern, for the GH annotation.
    const lines = stripped.split("\n");
    let hitLine = 1;
    for (let i = 0; i < lines.length; i++) {
      if (I15_CONSTRUCTS_RE.test(lines[i] as string)) {
        hitLine = i + 1;
        break;
      }
    }
    out.push({
      rule: "D10-wrap-spec",
      file: f.relPath,
      line: hitLine,
      snippet: (lines[hitLine - 1] as string).trim(),
    });
  }
  return out;
}

// Heuristic: vault-key construction is a string-literal containing a manifest
// key (e.g. `"slack.oauth"`) or any template literal mixing service/provider
// with a known suffix (e.g. `\`${s}.oauth\``).
// Files in the allow-list are exempt. Test files are exempt (handled by iterateSourceFiles).
function escapeRegex(s: string): string {
  return s.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
}

function buildVaultKeyRegex(): RegExp {
  const keys = Object.values(CONNECTOR_VAULT_SECRET_KEYS).flat();
  const suffixes = Array.from(new Set(keys.map((k) => k.split(".")[1] ?? "")));
  const literalAlt = keys.map(escapeRegex).join("|");
  const suffixAlt = suffixes.map(escapeRegex).join("|");
  return new RegExp(`['"\`](${literalAlt})['"\`]|\\$\\{[^}]+\\}\\.(${suffixAlt})`);
}

const VAULT_KEY_RE = buildVaultKeyRegex();

export function checkVaultKeyAllowList(
  files: readonly FileEntry[],
  allowList: readonly string[] = VAULT_KEY_ALLOW_LIST,
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (allowList.includes(f.relPath)) continue;
    // Strip comments so JSDoc references (e.g. `* when \`X.Y\` is present`) do
    // not trigger the heuristic. Newlines are preserved so line numbers stay
    // correct. The opt-out sentinel check uses the ORIGINAL lines because
    // stripComments removes the `//` line that carries the marker.
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] as string;
      const prevLine = originalLines[i - 1] ?? "";
      if (prevLine.includes("audit-ignore-next-line D11-vault-key")) continue;
      if (!VAULT_KEY_RE.test(line)) continue;
      out.push({
        rule: "D11-vault-key",
        file: f.relPath,
        line: i + 1,
        snippet: line.trim(),
      });
    }
  }
  return out;
}

export type DbRunHit = {
  file: string;
  line: number;
  function: string;
  snippet: string;
};

export const DB_RUN_EXEC_ALLOW_LIST: readonly string[] = ["packages/gateway/src/db/write.ts"];

const DB_RUN_EXEC_RE = /\b(?:this\.|ctx\.)?db\.(?:run|exec)\s*\(/;
// Best-effort enclosing-function detection: nearest preceding `function name(`
// or `name(...) {` / `name(...) =`. Split into two simpler patterns so each
// alternation has bounded complexity (closes ReDoS warning vs. the previous
// single combined regex).
// Bounded quantifiers on the identifier and parameter list make ReDoS
// structurally impossible — a pathological minified line cannot cause
// super-linear backtracking.
const FN_DECL_RE = /(?:function|async\s+function)\s+([A-Za-z_$][\w$]{0,127})/;
const FN_CALL_RE = /([A-Za-z_$][\w$]{0,127})\s{0,8}\([^)]{0,500}\)\s{0,8}[:{=]/;

function findEnclosingFunction(lines: readonly string[], from: number): string {
  for (let j = from; j >= Math.max(0, from - 30); j--) {
    const candidate = lines[j] as string;
    const decl = FN_DECL_RE.exec(candidate);
    if (decl) return decl[1] ?? "<unknown>";
    const call = FN_CALL_RE.exec(candidate);
    if (call) return call[1] ?? "<unknown>";
  }
  return "<top-level>";
}

export function findDirectDbRunExec(
  files: readonly FileEntry[],
  allowList: readonly string[] = DB_RUN_EXEC_ALLOW_LIST,
): DbRunHit[] {
  const out: DbRunHit[] = [];
  for (const f of files) {
    if (allowList.includes(f.relPath)) continue;
    // Strip comments so inline references (e.g. `// empty \`db.exec("")\``) do
    // not trigger the heuristic. Newlines are preserved so line numbers stay
    // correct. The original lines are kept for the enclosing-function scan.
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] as string;
      if (!DB_RUN_EXEC_RE.test(line)) continue;
      out.push({
        file: f.relPath,
        line: i + 1,
        function: findEnclosingFunction(originalLines, i),
        snippet: (originalLines[i] as string).trim(),
      });
    }
  }
  return out;
}

/** @deprecated kept for backwards compatibility — diagnostic census mode. */
export function collectDbRunCensus(files: readonly FileEntry[]): DbRunHit[] {
  return findDirectDbRunExec(files, []);
}

type Mode = "spawn" | "wrap-spec" | "vault-key" | "db-run" | "db-run-exec" | "binary-only" | "all";

function parseArgs(argv: readonly string[]): Mode {
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rule") {
      const r = argv[++i];
      if (
        r === "spawn" ||
        r === "wrap-spec" ||
        r === "vault-key" ||
        r === "db-run" ||
        r === "db-run-exec"
      ) {
        return r;
      }
      console.error(`unknown rule: ${r}`);
      process.exit(2);
    }
    if (a === "--binary-only") return "binary-only";
  }
  return "all";
}

async function loadFiles(): Promise<FileEntry[]> {
  const out: FileEntry[] = [];
  for await (const f of iterateSourceFiles()) {
    out.push({ relPath: f.relPath, contents: f.contents });
  }
  return out;
}

async function run(): Promise<void> {
  const mode = parseArgs(Bun.argv);
  const files = await loadFiles();

  let exit = 0;

  if (mode === "spawn" || mode === "binary-only" || mode === "all") {
    const v = checkSpawnInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D10 spawn not via extensionProcessEnv: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "wrap-spec" || mode === "binary-only" || mode === "all") {
    const v = checkWrapServerSpecInvariant(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::I15 lazy-mesh file constructs ServerSpec without wrapServerSpec — I15 regression: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "vault-key" || mode === "binary-only" || mode === "all") {
    const v = checkVaultKeyAllowList(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D11 vault-key constructed outside allow-list: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "db-run-exec" || mode === "binary-only" || mode === "all") {
    const v = findDirectDbRunExec(files);
    for (const e of v) {
      console.error(
        `::error file=${e.file},line=${e.line}::D12 direct db.run/db.exec outside allow-list: ${e.snippet}`,
      );
    }
    if (v.length > 0) exit = 1;
  }
  if (mode === "db-run" || mode === "all") {
    const census = collectDbRunCensus(files);
    const outPath = auditOutputPath("db-run-census.json");
    await Bun.write(outPath, `${JSON.stringify(census, null, 2)}\n`);
    console.log(`db-run census: ${census.length} hits → ${outPath}`);
    // db-run always exits 0 — it's a census, not a gate.
  }

  process.exit(exit);
}

if (import.meta.main) await run();
