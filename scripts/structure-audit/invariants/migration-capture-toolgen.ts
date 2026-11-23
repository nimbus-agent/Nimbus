// Static invariant rules: migration and config reader confinement, capture gate, act door and toolgen confinement.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import { checkTableConfinement, sqlTableReferenceRe } from "./vlm-media-capture-door.ts";

// ---- D34 (connector migration) -------------------------------------------------------------------
// A connector migration (Readwise unbundling spec § 7.2) installs signed code, grants it a run and
// points it at the owner's existing Vault credential behind ONE `extension.migrate` approval. Three
// confinements keep that one approval the only way in, mirroring D33(b)/(c):
// (a) the `connector_migration` table is named only by its store and its V73 DDL — a row in
//     `awaiting_approval` is what `approveMigratedExtensionRun` requires, so writing one elsewhere
//     would forge the precondition for a prompt-less grant;
// (b) `approveMigratedExtensionRun` — the migration grant entry point, which takes no consent of
//     its own — is named only by its definition (`approve-run.ts`) and the migration engine, which
//     calls it only after the owner's `extension.migrate` answer;
// (c) the `extension.migrate` consent is raised only by the engine and the RPC path:
//     `migrationConsentViaGate` and `EXTENSION_MIGRATE_ACTION_TYPE` are named only by the engine and
//     `ipc/migration-rpc.ts`; the `"extension.migrate"` literal only by the engine, the I2 frozen set
//     (`engine/executor.ts`, which is what gates it); `createMigrationEngine` only by the
//     engine and `platform/migration-boot.ts`, the one production constructor; and the
//     `migrationEngine` option that carries the built instance only by `platform/assemble.ts` (which
//     sets it), `ipc/server/options.ts` (which types it) and `ipc/server/dispatchers/migration-rpcs.ts` (which hands
//     it to `ipc/migration-rpc.ts`).
// Comments are stripped first; identifiers are matched as words after string literals are stripped
// too (so an aliased import is caught), the literal on comment-stripped source. Test files and
// anything outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c): a dynamically
// composed name (`options["migration" + "Engine"]`) evades a text scan, and a second use inside an
// allow-listed file is exempt whole-file. That matters for `dispatchers/migration-rpcs.ts`: every dispatcher there
// receives the `ServerCtx` that carries the engine, and a caller holding it could pass `accept` a
// consent callback of its own (`async () => true`). The rule cannot see which function in that file
// reads the option; an I44-block test in `i43-extension-spawn.test.ts` pins that exactly one place in
// `dispatchers/migration-rpcs.ts` does — `tryDispatchMigrationRpc` — and that `accept` is called only by
// `ipc/migration-rpc.ts`.
const D34_TABLE_RE = sqlTableReferenceRe("connector_migration");
const D34_TABLE_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/migration/migration-store.ts",
  "packages/gateway/src/index/connector-migration-v73-sql.ts",
];
const D34_ENGINE = "packages/gateway/src/extensions/migration/migration-engine.ts";
const D34_IDENTIFIER_SCANS: ReadonlyArray<
  readonly [rule: string, re: RegExp, allowed: readonly string[]]
> = [
  [
    "migration-grant-callers",
    /\bapproveMigratedExtensionRun\b/g,
    ["packages/gateway/src/extensions/approve-run.ts", D34_ENGINE],
  ],
  [
    "migration-consent-raisers",
    /\b(?:migrationConsentViaGate|EXTENSION_MIGRATE_ACTION_TYPE)\b/g,
    [D34_ENGINE, "packages/gateway/src/ipc/migration-rpc.ts"],
  ],
  [
    "migration-consent-raisers",
    /\bcreateMigrationEngine\b/g,
    [D34_ENGINE, "packages/gateway/src/platform/migration-boot.ts"],
  ],
  [
    "migration-consent-raisers",
    /\bmigrationEngine\b/g,
    [
      "packages/gateway/src/platform/assemble.ts",
      "packages/gateway/src/ipc/server/options.ts",
      "packages/gateway/src/ipc/server/dispatchers/migration-rpcs.ts",
    ],
  ],
];
const D34_LITERAL_RE = /["'`]extension\.migrate["'`]/g;
const D34_LITERAL_ALLOWED: readonly string[] = [
  D34_ENGINE,
  "packages/gateway/src/engine/executor.ts",
];

export function checkMigrationConfinement(files: readonly FileEntry[]): Violation[] {
  const out = checkTableConfinement(
    files,
    D34_TABLE_RE,
    D34_TABLE_ALLOWED,
    "migration-table-confined",
  );
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
    for (const [rule, re, allowed] of D34_IDENTIFIER_SCANS) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) push(rule, code, m.index);
    }
    if (!D34_LITERAL_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D34_LITERAL_RE)) {
        push("migration-consent-raisers", commentFree, m.index);
      }
    }
  }
  return out;
}

// ---- D35 (layered config reader) -----------------------------------------------------------------
// Tied to no invariant. Config is read through the layered reader (`config/layered-config.ts`) so
// every setting follows the active profile. Stated bound: a dynamically composed path or file name
// evades a text scan, as does a nested call such as join(getDir(), "nimbus.toml") (the [^()]* match
// cannot cross the inner parentheses).
const D35_PATH_RE = /\b(?:join|resolve)\s*\([^()]*["'`]nimbus\.toml["'`]/g;
const D35_PROFILE_RE = /\bresolveNimbusTomlForProfile\b/g;
const D35_FROM_PATH_RE = /(?<!function\s)\bload\w+FromPath\s*\(/g;
const D35_PATH_ALLOWED: readonly string[] = [
  "packages/gateway/src/config/layered-config.ts",
  "packages/gateway/src/config/active-profile.ts",
  "packages/gateway/src/demo/seed.ts",
];

export function checkConfigReaderConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    const push = (index: number | undefined): void => {
      const line = code.slice(0, index).split("\n").length;
      out.push({
        rule: "config-reader-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    };
    if (!D35_PATH_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D35_PATH_RE)) push(m.index);
      for (const m of code.matchAll(D35_PROFILE_RE)) push(m.index);
    }
    if (!f.relPath.startsWith("packages/gateway/src/config/")) {
      for (const m of code.matchAll(D35_FROM_PATH_RE)) push(m.index);
    }
  }
  return out;
}

// (b) The five gate entry points are CALLED only from the two RPC modules, ipc/capture-rpc.ts and
//     (agent door AD2) ipc/approvals-rpc.ts, and DEFINED only in capture-gate.ts. Any other mention
//     — a call or an import (aliased or not) — is a violation, so a second door cannot be opened by
//     importing the function under another name. Entries are FULL repo-relative paths: the check
//     is `includes(f.relPath)`, so a bare `ipc/approvals-rpc.ts` would exempt nothing. A second
//     caller INSIDE an allow-listed module is exempt whole-file; the behavioural test that
//     `approvals.approve` calls `acceptCapture` after `getCapture` is authoritative.
const D32_GATE_FN_RE =
  /\b(?:submitCapture|acceptCapture|rejectCapture|revokeCapture|purgeCapture)\b/g;
const D32_GATE_ALLOWED: readonly string[] = [
  "packages/gateway/src/ipc/capture-rpc.ts",
  "packages/gateway/src/ipc/approvals-rpc.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];
const D32_GATE_IMPORTERS_ALLOWED: readonly string[] = [
  "packages/gateway/src/ipc/capture-rpc.ts",
  "packages/gateway/src/ipc/approvals-rpc.ts",
];

export function checkCaptureGateCallers(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D32_GATE_ALLOWED.includes(f.relPath)) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    for (const m of code.matchAll(D32_GATE_FN_RE)) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "capture-gate-callers",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// (c) No module outside the two RPC modules (ipc/capture-rpc.ts, ipc/approvals-rpc.ts) may VALUE-import (or re-export, or dynamically import)
//     capture-gate.ts. (b) is an identifier scan, which a barrel `export * from ".../capture-gate.ts"`
//     or a namespace import called through a computed key evades; this closes it at the module edge.
//     `import type` / `export type` carry no runtime reference and are allowed anywhere. The span
//     between the keyword and `from` may not cross another `import`/`export` keyword or a completed
//     `from "…"` clause, so in semicolon-free code a match cannot start at an earlier `import type`
//     and carry that statement's exemption onto the value import after it. The last alternative
//     takes both a dynamic `import("…")` and a side-effect `import "…"`, which has no `from` clause.
const D32_GATE_MODULE_RE =
  /\b(?:import|export)\b(?:(?!\bfrom\s*["']|\b(?:import|export)\b)[^;])*?\bfrom\s*["'][^"']*capture-gate(?:\.ts)?["']|\bimport\s*\(?\s*["'][^"']*capture-gate(?:\.ts)?["']/g;

export function checkCaptureGateImporters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D32_GATE_IMPORTERS_ALLOWED.includes(f.relPath)) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(D32_GATE_MODULE_RE)) {
      if (/^(?:import|export)\s+type\b/.test(m[0])) continue;
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "capture-gate-importers",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// (d) Rows with 'agent' provenance arise ONLY from an owner-accepted capture. The four agent-row
//     writers are named only by their definitions and `mcp-sink/capture-native.ts`, and
//     capture-native's write/inverse entry points only by itself and `capture-gate.ts`, so the one
//     path to an 'agent' row is acceptCapture → writeCaptureNative. Stated bound: a hand-written
//     `INSERT … 'agent'` elsewhere, string-keyed access (`gs["upsertAgentTerm"](…)` — the literal is
//     stripped), a caller in a non-test file outside packages/gateway/src/ (scripts/, test helpers),
//     and a second caller INSIDE an allow-listed file (exempt whole-file) are all invisible to this
//     identifier scan; capability confinement (only the stores are handed those tables' writers) is
//     the real defense, as with D27(b).
const D32_AGENT_WRITER_RE =
  /\b(?:insertAgentDecision|deleteAgentDecision|upsertAgentTerm|deleteAgentTerm)\b/g;
const D32_AGENT_WRITER_ALLOWED: readonly string[] = [
  "packages/gateway/src/decisions/decision-store.ts",
  "packages/gateway/src/glossary/glossary-store.ts",
  "packages/gateway/src/mcp-sink/capture-native.ts",
];
const D32_CAPTURE_NATIVE_RE = /\b(?:writeCaptureNative|revokeCaptureNative)\b/g;
const D32_CAPTURE_NATIVE_ALLOWED: readonly string[] = [
  "packages/gateway/src/mcp-sink/capture-native.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];

export function checkAgentProvenanceWriters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    const scans: Array<[RegExp, readonly string[]]> = [
      [D32_AGENT_WRITER_RE, D32_AGENT_WRITER_ALLOWED],
      [D32_CAPTURE_NATIVE_RE, D32_CAPTURE_NATIVE_ALLOWED],
    ];
    for (const [re, allowed] of scans) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "agent-provenance-writers",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// (e)(f)(g) The act door (spec 2026-10-15 § 12.2). (e) `acceptAction` is named only by its definition
//     (mcp-sink/capture-act.ts) and its one caller (mcp-sink/capture-gate.ts's acceptCapture); other
//     exports of capture-act.ts (e.g. `outcomeRefOf`) are not
//     covered. (f) No non-test `mcp-sink/` file imports, re-exports or dynamically imports
//     `engine/executor.ts` or anything under `connectors/` — TYPE imports included: execution,
//     classification and configured-ness reach the sink only as injected functions, built in
//     ipc/capture-rpc.ts and platform/assemble.ts. `engine/service-of.ts` is a pure string helper and
//     stays allowed. The import shape is D32(c)'s: the span between the keyword and `from` may not
//     cross another `import`/`export` keyword or a completed `from "…"` clause, so in semicolon-free
//     code an allowed import cannot swallow a forbidden one after it; the last alternative takes both
//     a dynamic `import("…")` and a side-effect `import "…"`. Separate passes catch `require("…")`
//     (incl. `import X = require("…")`) and a backtick `import(`…`)`, and the executor specifier
//     matches with any `.[cm]?[jt]s` extension or none (`../engine/executor.js` included). (g) The `mcpToolId` literal appears under
//     mcp-sink/ only in capture-validate.ts, where a key of that name is REFUSED — the gateway, never
//     the agent, chooses the tool (I42 pairing). Comments are stripped; strings are NOT (a key lives
//     there). Stated bound, as D32(a): a dynamically composed specifier or key evades a text scan, and
//     (e) exempts whole files, so a second caller inside capture-gate.ts is invisible; capability
//     confinement (the sink is never handed a dispatcher) is the real defence.
const D32E_ACCEPT_ACTION_RE = /\bacceptAction\b/g;
const D32E_ALLOWED: readonly string[] = [
  "packages/gateway/src/mcp-sink/capture-act.ts",
  "packages/gateway/src/mcp-sink/capture-gate.ts",
];
const D32F_MODULE_RE =
  /\b(?:import|export)\b(?:(?!\bfrom\s*["']|\b(?:import|export)\b)[^;])*?\bfrom\s*["']([^"']+)["']|\bimport\s*\(?\s*["']([^"']+)["']/g;
// A separate pass, so an `import … from` span can never swallow one: CommonJS `require("…")`,
// which also covers TypeScript's `import X = require("…")`.
const D32F_REQUIRE_RE = /\brequire\s*\(\s*["'`]([^"'`]+)["'`]/g;
// A separate pass for a backtick dynamic `import(`…`)`, whose specifier may be a template.
const D32F_TEMPLATE_IMPORT_RE = /\bimport\s*\(\s*`([^`]+)`/g;
// Any emitted/source extension (`.ts`, `.js`, `.mjs`, `.cts`, …) or none.
const D32F_FORBIDDEN_SPEC_RE = /(?:^|\/)engine\/executor(?:\.[cm]?[jt]s)?$|(?:^|\/)connectors\//;
const D32G_LITERAL_RE = /mcpToolId/g;
const D32G_ALLOWED = "packages/gateway/src/mcp-sink/capture-validate.ts";
const MCP_SINK_PREFIX = "packages/gateway/src/mcp-sink/";

export function checkActDoorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    // stripComments and stripStringLiterals both preserve length, so a match offset in either maps
    // to the same line of the original source.
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    const push = (rule: string, index: number): void => {
      const line = code.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    if (!D32E_ALLOWED.includes(f.relPath)) {
      for (const m of stripStringLiterals(code).matchAll(D32E_ACCEPT_ACTION_RE)) {
        push("act-door-accept-action", m.index);
      }
    }
    if (!f.relPath.startsWith(MCP_SINK_PREFIX)) continue;
    for (const re of [D32F_MODULE_RE, D32F_REQUIRE_RE, D32F_TEMPLATE_IMPORT_RE]) {
      for (const m of code.matchAll(re)) {
        const spec = m[1] ?? m[2] ?? "";
        if (D32F_FORBIDDEN_SPEC_RE.test(spec)) push("mcp-sink-no-executor-or-connectors", m.index);
      }
    }
    if (f.relPath !== D32G_ALLOWED) {
      for (const m of code.matchAll(D32G_LITERAL_RE)) push("mcp-sink-mcptoolid-literal", m.index);
    }
  }
  return out;
}

// D29 (a) (I39): the `nimbus/fetch` brokered-fetch METHOD LITERAL — the string a generated tool's
// stdio message and the broker's dispatch must agree on — is defined ONCE, in
// `toolgen/toolgen-types.ts`'s `BROKERED_FETCH_METHOD`, and confined there. A producer and a
// consumer that separately hardcode the same string are two copies that can drift invisibly, the
// exact failure the `SANDBOX_POLICY_ENV` comment warns about for its own wire; confining the single
// definition site is a stronger rule than allow-listing every file that would otherwise carry a
// copy.
//
// Comments are stripped before scanning, and that cuts BOTH ways: without stripping, a doc comment
// that merely MENTIONS the method (as this very comment does, in the paragraph above) would red the
// build; with stripping, the rule cannot see a literal hidden inside a comment -- accepted, because
// a comment does not execute and every real code path still goes through the exported constant.
//
// Only the QUOTED literal is matched (`"nimbus/fetch"` / `'nimbus/fetch'` / `` `nimbus/fetch` ``),
// with the same quote character on both sides, so the rule fires on the string's actual text
// rather than on any substring that happens to contain it.
const D29_FETCH_LITERAL_DEFINITION_FILE = "packages/gateway/src/toolgen/toolgen-types.ts";
const D29_FETCH_LITERAL_RE = /(["'`])nimbus\/fetch\1/;

export function checkBrokeredFetchLiteralConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (f.relPath === D29_FETCH_LITERAL_DEFINITION_FILE) continue;
    // Comments blanked; string literals left intact -- the literal we are hunting FOR lives inside
    // a string, so stripping strings too would blind the rule to the exact thing it exists to see.
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(D29_FETCH_LITERAL_RE.source, "g"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D29(a)-brokered-fetch-literal-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D29 (b) (I39): the GENERATED-MANIFEST CONSTRUCTOR — `buildGeneratedManifest`, the ONLY function
// that produces the `ExtensionManifest` a generated tool spawns under — is defined only in
// `toolgen/toolgen-stub.ts`, and that file may never assign `permissions.network` a non-empty
// array LITERAL. Two checks, one rule, because they guard the same property from two directions:
// a second definition elsewhere could return whatever `network:` it likes with nobody the wiser,
// and the ONE approved definition drifting to a non-empty literal would silently open the exact
// hole `permissions.network = []` exists to close (mirrors I33's `buildExecPolicy` rule, where a
// requested grant is REJECTED rather than dropped).
//
// The definition check matches on the `function` KEYWORD directly preceding the name, so an
// ordinary call (`buildGeneratedManifest(toolId)`), an import, or a `typeof buildGeneratedManifest`
// type query -- all of which appear legitimately elsewhere in this tree -- does not trip it; only a
// second DECLARATION would.
//
// The network-literal check is scoped to the one allowed file only: a non-empty ARRAY LITERAL after
// `network:` (`network: ["x"]`), never a bare `network: []` and never a non-literal expression such
// as `network: opts.network` (checked at runtime by `buildGeneratedManifest`'s own throw, not by
// this static rule).
//
// STATED BOUND, in D29(c)'s own style: keying on the `function` KEYWORD means a definition written
// as `const buildGeneratedManifest = (...) => {...}` or as a class method would evade this rule --
// this repo's one production definition is a `function` declaration today, but the regex is a text
// scan over ONE shape, not a symbol-confinement guarantee. Capability confinement (only this file
// is ever wired as the manifest constructor at every call site the toolgen chokepoint reaches) is
// the real defense; this rule is the backstop for the copy-paste/second-definition case, not the
// boundary, exactly as D29(c) says of the `toolgen.` Vault-key prefix.
const D29_MANIFEST_DEFINITION_FILE = "packages/gateway/src/toolgen/toolgen-stub.ts";
const D29_MANIFEST_DEFINITION_RE = /\bfunction\s+buildGeneratedManifest\s*\(/;
const D29_MANIFEST_NETWORK_RE = /\bnetwork\s*:\s*\[\s*(?!\])/;

export function checkGeneratedManifestConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");

    if (f.relPath !== D29_MANIFEST_DEFINITION_FILE) {
      const m = D29_MANIFEST_DEFINITION_RE.exec(code);
      if (m !== null) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "D29(b)-generated-manifest-definition-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
      continue;
    }

    for (const m of code.matchAll(new RegExp(D29_MANIFEST_NETWORK_RE.source, "g"))) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D29(b)-generated-manifest-network-nonempty",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}
