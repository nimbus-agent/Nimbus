// Static invariant rules: run grants, extension role, trust tables and eval confinement.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { posix } from "node:path";
import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import { escapeRegex } from "./spawn-vault-db-identity.ts";
import { checkTableConfinement, sqlTableReferenceRe } from "./vlm-media-capture-door.ts";

// ---- D33 (extension runtime) ---------------------------------------------------------------------
// (b) `extension_run_grant` is named only by its store and its DDL — a grant is the record of an
//     owner's `extension.run` approval, so no other code may write one or read around it. Same
//     shape and same stated bound as D32(a): a dynamically composed identifier evades a text scan,
//     and capability confinement (only the store holds queries against the table) is the real
//     defense.
const D33_RUN_GRANT_TABLE_RE = sqlTableReferenceRe("extension_run_grant");
const D33_RUN_GRANT_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/run-grant-store.ts",
  "packages/gateway/src/index/extension-run-grant-v70-sql.ts",
  // V72 adds `credentials_json` to the same table; DDL only.
  "packages/gateway/src/index/extension-run-grant-credentials-v72-sql.ts",
];

export function checkRunGrantTableConfinement(files: readonly FileEntry[]): Violation[] {
  return checkTableConfinement(
    files,
    D33_RUN_GRANT_TABLE_RE,
    D33_RUN_GRANT_TABLE_ALLOWED,
    "run-grant-table-confined",
  );
}

// (a) The `__nimbus-extension` self-role sentinel is named only by `platform/runtime-layout.ts` (which
//     defines it); `selfSpawn("extension", …)` is called only from `extensions/extension-launch-command.ts`
//     (`extensionEntryCommand`, the UNWRAPPED launch command, in a dependency-free module). That
//     module spawns nothing itself: D38(b) confines its callers to the two builders that wrap it
//     through the sandbox — the run builder in `extension-runtime.ts`, which runs the entry from a
//     verified, re-digested per-spawn stage (`<sandboxDir>/ext-stage/<serviceId>/<uuid>`, also the
//     child's working directory), and the eval builder `eval/eval-spawn-spec.ts` (I49).
//     `index.ts` dispatches via `ROLE_SENTINELS.extension`, never the literal. Scans
//     comment-stripped source but NOT string-stripped (the sentinel IS a string literal, as with
//     D29(a)); test files and anything outside packages/gateway/src/ are not scanned. Stated bound: a
//     dynamically composed role string or `selfSpawn(role)` with a variable evades a text scan. That
//     gap is covered by tests rather than by this rule: I43's pin names the run's spec builders only
//     in `extension-runtime.ts` and builds the spec once, inside `prepareSpawn`, after the verifier
//     and the stage digest check; D38(a) names the eval builder only in its module and the eval runtime.
const D33_EXT_SENTINEL_RE = /__nimbus-extension/g;
const D33_EXT_SENTINEL_ALLOWED: readonly string[] = [
  "packages/gateway/src/platform/runtime-layout.ts",
];
const D33_EXT_SELFSPAWN_RE = /\bselfSpawn\s*\(\s*["'`]extension["'`]/g;
// The unwrapped launch command lives in a dependency-free module (so the eval role, which imports
// it through its spec builder, reaches no db/ module, I49); D38(b) confines ITS callers to the two
// builders that wrap it through the sandbox: `extension-runtime.ts` and `eval/eval-spawn-spec.ts`.
const D33_EXT_SELFSPAWN_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/extension-launch-command.ts",
];

export function checkExtensionRoleConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    const scans: Array<[RegExp, readonly string[]]> = [
      [D33_EXT_SENTINEL_RE, D33_EXT_SENTINEL_ALLOWED],
      [D33_EXT_SELFSPAWN_RE, D33_EXT_SELFSPAWN_ALLOWED],
    ];
    for (const [re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "extension-role-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// (c) D33(b) confines the TABLE; this confines who may CREATE or DELETE a grant through the store.
//     `upsertRunGrant` is named only by its definition and `extensions/approve-run.ts` (which calls
//     it after the owner's `extension.run` approval); `deleteRunGrant` additionally by
//     `automation/extension-store.ts` (uninstall drops the grant with the row, and `setExtensionKind`
//     drops it when an update turns the row into a starter pack). Any other mention — a
//     call or an import, aliased or not — is a violation, so a second door cannot be opened by
//     importing the function under another name. Comments and string literals are stripped first;
//     test files and anything outside packages/gateway/src/ are not scanned. Stated bound: a
//     dynamically composed call (`store["upsert" + "RunGrant"]`, a namespace import called through a
//     computed key) evades a text scan, and a second call INSIDE an allow-listed file is exempt
//     whole-file; capability confinement is the real defense, as with D32(d).
const D33_UPSERT_RE = /\bupsertRunGrant\b/g;
const D33_UPSERT_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/run-grant-store.ts",
  "packages/gateway/src/extensions/approve-run.ts",
];
const D33_DELETE_RE = /\bdeleteRunGrant\b/g;
const D33_DELETE_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/run-grant-store.ts",
  "packages/gateway/src/extensions/approve-run.ts",
  "packages/gateway/src/automation/extension-store.ts",
];

export function checkRunGrantWriters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    const scans: Array<[RegExp, readonly string[]]> = [
      [D33_UPSERT_RE, D33_UPSERT_ALLOWED],
      [D33_DELETE_RE, D33_DELETE_ALLOWED],
    ];
    for (const [re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "run-grant-writers",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// ---- D37 (the trust store) -----------------------------------------------------------------------
// `trust_statement`, `trust_feed_state` and `trust_statement_source` (V77) are named only by the trust
// store and their DDL: what may enter the store (authority, admission, the per-registry cap), the
// sources a statement counts for, and the feed's anti-rollback floor are decided there, so no other
// code may write a statement or move the floor around them.
// Same shape and same stated bound as D33(b): a dynamically composed identifier evades a text scan,
// and capability confinement (only the store holds queries against the tables) is the real defense.
// Tied to no invariant in trust layer PR 2a; PR 2b's enforcement invariant binds it.
const D37_TRUST_TABLES_RE = new RegExp(
  `${sqlTableReferenceRe("trust_statement").source}|${sqlTableReferenceRe("trust_feed_state").source}|${sqlTableReferenceRe("trust_statement_source").source}`,
  "g",
);
const D37_TRUST_TABLES_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/trust/trust-store.ts",
  "packages/gateway/src/index/trust-layer-v76-sql.ts",
  "packages/gateway/src/index/trust-statement-source-v77-sql.ts",
];

export function checkTrustTableConfinement(files: readonly FileEntry[]): Violation[] {
  return checkTableConfinement(
    files,
    D37_TRUST_TABLES_RE,
    D37_TRUST_TABLES_ALLOWED,
    "trust-tables-confined",
  );
}

// ---- D38 (the eval runtime, I49) -----------------------------------------------------------------
// Extension code runs for evaluation only through `extensions/eval/eval-runtime.ts` under the spec
// `buildExtensionEvalSpawnSpec` builds: no network, baseline env only. Five clauses:
// (a) `buildExtensionEvalSpawnSpec` is named only by its module and the runtime that calls it;
// (b) `extensionEntryCommand` (the UNWRAPPED launch command of an extension entry) only by
//     `extensions/extension-launch-command.ts`, which defines it, `extensions/extension-runtime.ts`,
//     which wraps it for a run, and the eval spec module, which wraps it for an eval — a third holder could launch an entry outside both specs;
// (c) a file under `extensions/eval/` imports nothing — statically, as a type, or dynamically —
//     whose specifier has a `vault`, `egress`, `ipc` or `db` segment (a file under it, or the bare
//     directory) or names `engine/executor`;
// (d) `readCredentialEnv` is never named under `extensions/eval/`;
// (e) no file under `extensions/eval/` value-imports `@mastra/mcp` statically: the role imports it
//     only inside its run, after console output is routed to stderr (the one-document contract).
// Identifiers are matched as words after comments and string literals are stripped, so an aliased
// import is caught; the import clauses read comment-stripped source (a specifier IS a string).
// Test files and anything outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c): a
// dynamically composed name or specifier evades a text scan, and (c) reads direct imports only —
// the TRANSITIVE graph the role loads is pinned by I49's graph test in i49-extension-eval.test.ts.
const D38_EVAL_DIR = "packages/gateway/src/extensions/eval/";
const D38_SPEC_BUILDER_RE = /\bbuildExtensionEvalSpawnSpec\b/g;
const D38_SPEC_BUILDER_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/eval/eval-spawn-spec.ts",
  "packages/gateway/src/extensions/eval/eval-runtime.ts",
];
const D38_ENTRY_COMMAND_RE = /\bextensionEntryCommand\b/g;
const D38_ENTRY_COMMAND_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/extension-launch-command.ts",
  "packages/gateway/src/extensions/extension-runtime.ts",
  "packages/gateway/src/extensions/eval/eval-spawn-spec.ts",
];
const D38_CREDENTIAL_RE = /\breadCredentialEnv\b/g;
/** Every module specifier: `from "x"`, bare `import "x"`, `import("x")`, `require("x")`. */
const D38_SPECIFIER_RE =
  /(?:\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)["'`]([^"'`]+)["'`]/gm;
// A segment, ending in `/` or at the end of the specifier: `../../db` (a directory import) is caught.
const D38_FORBIDDEN_SPECIFIER_RE = /(?:^|\/)(?:vault|egress|ipc|db)(?:\/|$)|engine\/executor/;
const D38_STATIC_MASTRA_RE =
  /^\s*(?:import|export)\s+(?!type\b)(?:[^;]*?\bfrom\s*)?["']@mastra\/mcp(?:\/[^"']*)?["']/gm;

export function checkEvalConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    const original = f.contents.split("\n");
    const push = (rule: string, src: string, index: number | undefined): void => {
      const line = src.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    const scans: Array<[string, RegExp, readonly string[]]> = [
      ["eval-spec-builder-confined", D38_SPEC_BUILDER_RE, D38_SPEC_BUILDER_ALLOWED],
      ["eval-entry-command-confined", D38_ENTRY_COMMAND_RE, D38_ENTRY_COMMAND_ALLOWED],
    ];
    for (const [rule, re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) push(rule, code, m.index);
    }
    if (!f.relPath.startsWith(D38_EVAL_DIR)) continue;
    for (const m of commentFree.matchAll(D38_SPECIFIER_RE)) {
      if (D38_FORBIDDEN_SPECIFIER_RE.test(m[1] ?? "")) {
        push("eval-imports-confined", commentFree, m.index);
      }
    }
    for (const m of code.matchAll(D38_CREDENTIAL_RE)) push("eval-no-credentials", code, m.index);
    for (const m of commentFree.matchAll(D38_STATIC_MASTRA_RE)) {
      push("eval-mcp-client-dynamic-only", commentFree, m.index);
    }
  }
  return out;
}

// ---- D39 (the model's connector-write door, I53) ------------------------------------------------
// A first-party connector write reaches the model only through `engine/connector-write-agent-tools.ts`,
// on an executor built without delegation, with every action carrying `origin: "model"`. Four clauses:
// (a) a non-test gateway file that VALUE-imports the write table (anything under
//     `connectors/connector-writes/`, or `connector-write-registry`) and also calls `createTool`
//     — including an aliased import (`createTool as ct`) or a namespace import's member — is the
//     door itself; no other file builds model tools from the write table. A type-only import is
//     ignored, so a file may name a row's TYPE. The importer of the door MODULE (`engine/agent.ts`)
//     is not a trigger: it imports the builder, never the rows;
// (b) `getAgentRequestConnectorWriteExecutor`, the read of the owner-turn executor, is named only by
//     `engine/agent-request-context.ts` (its definition), `engine/run-ask.ts`, `engine/agent.ts` and
//     the door;
//     The request-context FIELD `connectorWriteExecutor` (a read or a write of it) is named only by
//     `agent-request-context.ts` and `run-ask.ts`;
// (c) the door file names no transport: `invokeConnectorWrite`, `withConnectorSession`,
//     `createConnectorDispatcher`, `createConnectorWriteDispatcher` or a `dispatch(` call (a
//     destructured one included) — it runs an action through the turn's executor and nothing else;
// (e) `buildConnectorWriteAgentTools` is named only by `engine/agent.ts` and the door, and
//     `buildModelWriteExecutor` only by `engine/run-ask.ts`, and `buildWorkflowWriteExecutor` (SA2)
//     only by `engine/run-ask.ts` and `gateway-main.ts`, and `buildAgentWriteExecutor` (Phase 28
//     AD1, the MCP act door's executor, built by the same door maker as the model door's) only by
//     `engine/run-ask.ts` (its definition) and `ipc/capture-rpc.ts` (`buildActDeps`, the one
//     place that has the ACCEPTING session's client and consent coordinator);
// (d) the door file contains `origin: "model"`, the marker `tryDelegatedApproval` refuses to delegate.
// Comments and string literals are stripped before identifiers are matched (the import clauses read
// comment-stripped source, a specifier IS a string). Test files and anything outside
// packages/gateway/src/ are not scanned. STATED BOUND, as D33(c): a dynamically composed name or
// specifier evades a text scan; the executor's own construction (no delegation) and the door's
// per-call checks are pinned behaviourally by I53's tests.
export const D39_DOOR = "packages/gateway/src/engine/connector-write-agent-tools.ts";
export const D39_EXECUTOR_READ_RE = /\bgetAgentRequestConnectorWriteExecutor\b/g;
export const D39_EXECUTOR_READ_ALLOWED: readonly string[] = [
  "packages/gateway/src/engine/agent-request-context.ts",
  "packages/gateway/src/engine/run-ask.ts",
  "packages/gateway/src/engine/agent.ts",
  D39_DOOR,
];
export const D39_TRANSPORT_RE =
  /\b(?:invokeConnectorWrite|withConnectorSession|createConnectorDispatcher|createConnectorWriteDispatcher)\b|\bdispatch\s*\(/g;
export const D39_CONTEXT_FIELD_RE = /\bconnectorWriteExecutor\b/g;
export const D39_CONTEXT_FIELD_ALLOWED: readonly string[] = [
  "packages/gateway/src/engine/agent-request-context.ts",
  "packages/gateway/src/engine/run-ask.ts",
];
export const D39_BUILDERS: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [
    /\bbuildConnectorWriteAgentTools\b/g,
    [
      "packages/gateway/src/engine/agent.ts",
      "packages/gateway/src/engine/connector-write-agent-tools.ts",
    ],
  ],
  [/\bbuildModelWriteExecutor\b/g, ["packages/gateway/src/engine/run-ask.ts"]],
  // Phase 10 IC7a / IC9b: the owner's push executor (no delegation, no before-state runner, no standing rule),
  // built per call around the asking connection's consent channel by the post-mortem push and the incident
  // update send.
  [
    /\bbuildOwnerPushExecutor\b/g,
    [
      "packages/gateway/src/engine/run-ask.ts",
      "packages/gateway/src/ipc/postmortem-rpc.ts",
      "packages/gateway/src/ipc/incident-update-rpc.ts",
    ],
  ],
  // Phase 28 AD1: the MCP act door's door executor. The wiring site is `buildActDeps`, which holds
  // the accepting client and the consent coordinator; `platform/assemble.ts` builds only the
  // static wiring around it.
  [
    /\bbuildAgentWriteExecutor\b/g,
    ["packages/gateway/src/engine/run-ask.ts", "packages/gateway/src/ipc/capture-rpc.ts"],
  ],
  // SA4: the scheduler's unattended executor is built by run-ask.ts and handed to the scheduler as a
  // factory by the boot file; the scheduler module never names it.
  [
    /\bbuildUnattendedWorkflowWriteExecutor\b/g,
    ["packages/gateway/src/engine/run-ask.ts", "packages/gateway/src/gateway-main.ts"],
  ],
  // SA2: the workflow write executor is built by run-ask.ts and handed to the runner by the boot file.
  [
    /\bbuildWorkflowWriteExecutor\b/g,
    ["packages/gateway/src/engine/run-ask.ts", "packages/gateway/src/gateway-main.ts"],
  ],
];
export const D39_ORIGIN_RE = /\borigin\s*:\s*["']model["']/;
const D39_ROWS_SPECIFIER_RE = /connectors\/connector-writes\/|connector-write-registry/;
const D39_ROWS_DIR = "packages/gateway/src/connectors/connector-writes";

/**
 * Whether `spec`, imported from `importerRel`, names the write table or the registry. A relative
 * specifier is resolved against the importer's directory first, so `./connector-writes/index.ts`
 * from `connectors/` and `./index.ts` from inside `connector-writes/` both land in the table.
 */
function specifierNamesWriteTable(importerRel: string, spec: string): boolean {
  if (spec.startsWith(".")) {
    const resolved = posix.normalize(posix.join(posix.dirname(importerRel), spec));
    return (
      resolved === D39_ROWS_DIR ||
      resolved.startsWith(`${D39_ROWS_DIR}/`) ||
      /(?:^|\/)connector-write-registry(?:\.ts)?$/.test(resolved)
    );
  }
  return D39_ROWS_SPECIFIER_RE.test(spec);
}
// `import <clause> from "x"` (static, comment-stripped); `export … from` re-exports count as values.
// Anchored at a line start OR after a `;`, so a second import on the same line is read too.
const D39_STATIC_IMPORT_RE =
  /(?:^|;)[ \t]*(?:import|export)\s+(type\s+)?([^;"']*?)\s*from\s*["']([^"']+)["']/gm;
const D39_DYNAMIC_IMPORT_RE = /\bimport\s*\(\s*["']([^"']+)["']\s*\)/g;

/** True when an import clause names at least one value (not `type X` / `import type`). */
function clauseHasValue(typeOnly: boolean, clause: string): boolean {
  if (typeOnly) return false;
  const withoutTypes = clause.replace(/\btype\s+\w+(?:\s+as\s+\w+)?/g, "");
  return /[A-Za-z_$*]/.test(withoutTypes);
}

export function importsWriteTableAsValue(importerRel: string, commentFree: string): boolean {
  for (const m of commentFree.matchAll(D39_STATIC_IMPORT_RE)) {
    if (!specifierNamesWriteTable(importerRel, m[3] ?? "")) continue;
    if (clauseHasValue(m[1] !== undefined, m[2] ?? "")) return true;
  }
  for (const m of commentFree.matchAll(D39_DYNAMIC_IMPORT_RE)) {
    if (specifierNamesWriteTable(importerRel, m[1] ?? "")) return true;
  }
  return false;
}

/** Every local name `createTool` is bound to, plus a namespace import's `t.createTool`. */
export function createToolCallRe(commentFree: string): RegExp {
  const names = new Set<string>(["createTool"]);
  const namespaces = new Set<string>();
  for (const m of commentFree.matchAll(D39_STATIC_IMPORT_RE)) {
    if (!/@mastra\/core\/tools/.test(m[3] ?? "") || m[1] !== undefined) continue;
    const clause = m[2] ?? "";
    for (const a of clause.matchAll(/\bcreateTool\s+as\s+([A-Za-z_$][\w$]*)/g)) {
      if (a[1] !== undefined) names.add(a[1]);
    }
    const ns = /\*\s*as\s+([A-Za-z_$][\w$]*)/.exec(clause);
    if (ns?.[1] !== undefined) namespaces.add(ns[1]);
  }
  const alt = [
    ...[...names].map(escapeRegex),
    ...[...namespaces].map((n) => `${escapeRegex(n)}\\s*\\.\\s*createTool`),
  ].join("|");
  return new RegExp(`(?<![.\\w$])(?:${alt})\\s*(?:<[^()]*>)?\\s*\\(|\\.\\s*createTool\\s*\\(`, "g");
}

// ---- D45 (the morning briefing delivers locally only, OR-10-11) ------------------------------------
// Rule ids `briefing-forbidden-import` and `briefing-no-network`. The briefing is read from the local index
// and delivered through two local sinks (the `briefing.ready` gateway event and the OS toast), both injected.
// Scope: every non-test file under `packages/gateway/src/briefing/` and every
// `packages/gateway/src/agents/_lib/briefing*.ts`. In scope:
//   - no import (static, side-effect `import "x"`, dynamic, `require`, or a re-export) of `chatops/`, `egress/`, `federation/` or
//     `share/`, even type-only; and none of `connectors/` unless it is a TYPE-only import;
//   - no network primitive: ANY reference to the global `fetch` (a call, an alias such as
//     `const f = fetch`, `fetch.bind`; only a `.fetch` property of another object is allowed), any use of
//     `globalThis`, `window` or `self`, `Bun.fetch`, `new WebSocket`, `XMLHttpRequest`, and no import of `node:http`, `node:https`, `node:http2`, `node:net`, `node:tls`,
//     `node:dgram` or `undici`.
// Stated bounds: a text scan of DIRECT imports. An indirect path through an allowed module (`llm/`,
// `index/`) is not followed; `synthesize.ts`, which the briefing imports, is no network path because no
// runner is ever passed (a source pin in i31-disclosure-integrity.test.ts). Tied to no invariant: it makes
// OR-10-11 structural rather than conventional.
const D45_DIR = "packages/gateway/src/briefing/";
const D45_LIB_RE = /^packages\/gateway\/src\/agents\/_lib\/briefing[\w.-]*\.ts$/;
export const D45_FORBIDDEN_SEGMENT_RE = /(?:^|\/)(?:chatops|egress|federation|share)(?:\/|$)/;
const D45_CONNECTORS_SEGMENT_RE = /(?:^|\/)connectors(?:\/|$)/;
const D45_REQUIRE_RE = /\brequire\s*\(\s*["'`]([^"'`]+)["'`]\s*\)/g;
const D45_NETWORK_MODULE_RE = /^(?:node:)?(?:http|https|http2|net|tls|dgram)$|^undici(?:\/|$)/;
const D45_NETWORK_CALL_RE = /\bBun\s*\.\s*fetch\b|\bnew\s+WebSocket\b|\bXMLHttpRequest\b/g;
// Any mention of the global `fetch` at all, not only a call: `const f = fetch`, `(fetch)`, `fetch.bind(...)`
// and a parameter default all alias it. A `.fetch` PROPERTY of some other object stays allowed (`db.fetch`).
const D45_FETCH_REF_RE = /(?<![.\w$])fetch(?![\w$])/g;
// The global objects a `fetch` can be reached through, by any spelling (`globalThis["fetch"]` has its name
// in a string, which is blanked): the briefing needs none of them.
const D45_GLOBAL_OBJECT_RE = /(?<![.\w$])(?:globalThis|window|self)(?![\w$])/g;
// `import "x";` (no `from`): runs the module for its effects, so it is an import like any other.
const D45_SIDE_EFFECT_IMPORT_RE = /(?:^|[;{}])[ \t]*import\s*["']([^"']+)["']/gm;

// `import(`...`)` with a template literal that has no `${}`: a literal specifier like any other.
const CONFINEMENT_TEMPLATE_IMPORT_RE = /\bimport\s*\(\s*`((?:[^`$]|\$(?!\{))*)`\s*\)/g;

/** What one confinement rule (D45, D48) scans and which rule ids it reports. */
interface ConfinementSpec {
  readonly inScope: (relPath: string) => boolean;
  readonly forbiddenSegmentRe: RegExp;
  readonly forbiddenImportRule: string;
  readonly noNetworkRule: string;
  /** An import target the rule permits although its path segment would be forbidden (D50(e) only). */
  readonly allowTarget?: (target: string) => boolean;
}

export function inBriefingScope(relPath: string): boolean {
  if (relPath.endsWith(".test.ts")) return false;
  return relPath.startsWith(D45_DIR) || D45_LIB_RE.test(relPath);
}

/**
 * The shared scan of D45 and D48: in every in-scope file, no import (static, side-effect, dynamic,
 * `require`, re-export) of a forbidden path segment, none of `connectors/` unless type-only, and no
 * network primitive. Comments and string literals are blanked first.
 */
export function checkConfinement(files: readonly FileEntry[], spec: ConfinementSpec): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!spec.inScope(f.relPath)) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    const original = f.contents.split("\n");
    // An import-shaped match counts only when its keyword survives string blanking: a
    // `"require('node:http')"` in a message is text, not an import.
    const live = (m: RegExpMatchArray): boolean => {
      const at = (m.index ?? 0) + Math.max(0, m[0].search(/import|export|require/));
      return code.charAt(at) === commentFree.charAt(at);
    };
    const push = (rule: string, src: string, index: number | undefined): void => {
      const line = src.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    const specifier = (target: string, valueImport: boolean, index: number | undefined): void => {
      if (spec.allowTarget?.(target) === true) {
        // A named exception: still no network module.
        if (D45_NETWORK_MODULE_RE.test(target)) push(spec.noNetworkRule, commentFree, index);
        return;
      }
      if (spec.forbiddenSegmentRe.test(target)) {
        push(spec.forbiddenImportRule, commentFree, index);
      } else if (D45_CONNECTORS_SEGMENT_RE.test(target) && valueImport) {
        push(spec.forbiddenImportRule, commentFree, index);
      }
      if (D45_NETWORK_MODULE_RE.test(target)) push(spec.noNetworkRule, commentFree, index);
    };
    for (const m of commentFree.matchAll(D39_STATIC_IMPORT_RE)) {
      if (live(m)) specifier(m[3] ?? "", clauseHasValue(m[1] !== undefined, m[2] ?? ""), m.index);
    }
    for (const m of commentFree.matchAll(D39_DYNAMIC_IMPORT_RE)) {
      if (live(m)) specifier(m[1] ?? "", true, m.index);
    }
    for (const m of commentFree.matchAll(CONFINEMENT_TEMPLATE_IMPORT_RE)) {
      // `code` has string bodies blanked, so an `import(` that is only text inside a string is not there.
      if (code.startsWith("import", m.index)) specifier(m[1] ?? "", true, m.index);
    }
    for (const m of commentFree.matchAll(D45_SIDE_EFFECT_IMPORT_RE)) {
      if (live(m)) specifier(m[1] ?? "", true, m.index);
    }
    for (const m of commentFree.matchAll(D45_REQUIRE_RE)) {
      if (live(m)) specifier(m[1] ?? "", true, m.index);
    }
    for (const re of [D45_NETWORK_CALL_RE, D45_FETCH_REF_RE, D45_GLOBAL_OBJECT_RE]) {
      for (const m of code.matchAll(re)) push(spec.noNetworkRule, code, m.index);
    }
  }
  return out;
}
