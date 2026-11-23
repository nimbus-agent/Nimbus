// Static invariant rules: briefing, finops, incident, workflow import, computer-use binding, toolgen model door and LAN box path.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import {
  checkConfinement,
  D45_FORBIDDEN_SEGMENT_RE,
  inBriefingScope,
} from "./extension-grants-eval.ts";
import { sqlTableReferenceRe } from "./vlm-media-capture-door.ts";

export function checkBriefingConfinement(files: readonly FileEntry[]): Violation[] {
  return checkConfinement(files, {
    inScope: inBriefingScope,
    forbiddenSegmentRe: D45_FORBIDDEN_SEGMENT_RE,
    forbiddenImportRule: "briefing-forbidden-import",
    noNetworkRule: "briefing-no-network",
  });
}

// ---- D48 (FinOps cost data is read and pruned by code that cannot leave the machine, spec § 6, OR-10-8) ------
// Rule ids `finops-forbidden-import` and `finops-no-network`. `packages/gateway/src/finops/` holds the
// pure side of the cost connectors (the row contract, the series rollup, the `readCostSeries` reader and
// the retention pass): it runs unattended, so it must be incapable of an outbound request, a connector
// call or a model call. Scope: every non-test file under `packages/gateway/src/finops/`. In scope:
//   - no import (static, side-effect, dynamic, `require`, re-export) of `chatops/`, `egress/`,
//     `federation/`, `share/`, `llm/`, `engine/` or `agents/`, even type-only; none of `connectors/`
//     unless it is a TYPE-only import;
//   - no network primitive: ANY reference to the global `fetch`, any use of `globalThis`, `window` or
//     `self`, `Bun.fetch`, `new WebSocket`, `XMLHttpRequest`, and no import of `node:http`,
//     `node:https`, `node:http2`, `node:net`, `node:tls`, `node:dgram` or `undici`.
// Stated bounds: a text scan of DIRECT imports; an indirect path through an allowed module (`index/`,
// `db/`) is not followed. The mapper and the syncable live in `connectors/` and are out of scope: they
// reach the vendor only through the sandboxed connector session. Tied to no invariant (spec D-FO-11): it
// makes "unattended means inert" structural rather than conventional.
const D48_DIR = "packages/gateway/src/finops/";
const D48_FORBIDDEN_SEGMENT_RE =
  /(?:^|\/)(?:chatops|egress|federation|share|llm|engine|agents)(?:\/|$)/;

export function checkFinopsConfinement(files: readonly FileEntry[]): Violation[] {
  return checkConfinement(files, {
    inScope: (relPath) => !relPath.endsWith(".test.ts") && relPath.startsWith(D48_DIR),
    forbiddenSegmentRe: D48_FORBIDDEN_SEGMENT_RE,
    forbiddenImportRule: "finops-forbidden-import",
    noNetworkRule: "finops-no-network",
  });
}

// ---- D46(a) (incident assembly is inert, I57 (a)) ------------------------------------------------
// Rule ids `incident-forbidden-import` and `incident-no-network`: the D45/D48 shape. `packages/gateway/src/incident/`
// holds the incident engine (the assembler, its lanes, its store, its retention and erasure) and
// `agents/_lib/incident*.ts` its render. Every pass runs after a sync with nobody present, so it must be
// incapable of an outbound request, a post, a connector call or a model call. Scope: every non-test file under
// `packages/gateway/src/incident/` and every `packages/gateway/src/agents/_lib/incident*.ts`. In scope:
//   - no import (static, side-effect, dynamic, `require`, re-export) of `chatops/`, `egress/`, `federation/` or
//     `share/`, even type-only; none of `connectors/` unless it is a TYPE-only import;
//   - no network primitive: ANY reference to the global `fetch`, any use of `globalThis`, `window` or `self`,
//     `Bun.fetch`, `new WebSocket`, `XMLHttpRequest`, and no import of `node:http`, `node:https`, `node:http2`,
//     `node:net`, `node:tls`, `node:dgram` or `undici`.
// Scope is the whole directory at IC3 because it holds only inert code; the slice that adds an action-building
// file carves it out in the same commit as its own rule (D46(c)). Stated bounds: a text scan of DIRECT imports;
// an indirect path through an allowed module (`index/`, `agents/_lib/synthesize.ts`, `oncall-push/push-store.ts`)
// is not followed, which is why the zero-egress and OR-10-8 pins in i31-disclosure-integrity.test.ts are the other half.
const D46A_DIR = "packages/gateway/src/incident/";
const D46A_LIB_RE = /^packages\/gateway\/src\/agents\/_lib\/incident[\w.-]*\.ts$/;

// Phase 10 IC5a carves out ONE file: `incident/remediation.ts` builds and runs the owner remediation actions, so it
// imports the connector write table as a value and the executor types. It is governed instead by D46(c) below.
// Everything else under `incident/` (including the pure derivation `proposals.ts` and the store) stays in scope.
const D46A_ACTION_BUILDER = "packages/gateway/src/incident/remediation.ts";

function inIncidentScope(relPath: string): boolean {
  if (relPath.endsWith(".test.ts")) return false;
  if (relPath === D46A_ACTION_BUILDER) return false;
  return relPath.startsWith(D46A_DIR) || D46A_LIB_RE.test(relPath);
}

export function checkIncidentConfinement(files: readonly FileEntry[]): Violation[] {
  return checkConfinement(files, {
    inScope: inIncidentScope,
    forbiddenSegmentRe: D45_FORBIDDEN_SEGMENT_RE,
    forbiddenImportRule: "incident-forbidden-import",
    noNetworkRule: "incident-no-network",
  });
}

// ---- D50 (signed workflow import, I59) ------------------------------------------------------------
// (a) Rule `workflow-import-table-confined`: the table `workflow_import` (V101) is named only by its store
//     (`automation/workflow-import-store.ts`) and its DDL; the writer `recordImport` and the floor reads
//     `floorFor` / `signerHistory` only there and in `automation/workflow-import.ts`.
// (b) Rule `workflow-import-entry-confined`: `importWorkflowBundle` is named only by
//     `automation/workflow-import.ts` and `ipc/workflow-import-rpc.ts`; the literals "workflow.import" and
//     "workflow.export" only by the executor, the import module, the RPC module,
//     `connectors/proposable-actions.ts`, `ipc/lan-rpc.ts` and `ipc/server/demo-gate.ts`.
// (c) Rule `workflow-import-upsert-confined`: `upsertWorkflowByName` is called only by its definition
//     (`automation/workflow-store.ts`), the `workflow.save` handler (`ipc/automation-rpc/workflow.ts`) and
//     `automation/workflow-import.ts`, so nothing else (an agent door, a template path) becomes a second way
//     to write a workflow.
// (d) Rule `workflow-import-rule-isolation`: the rule and learning path (`engine/standing-rule-step.ts`,
//     `standing/standing-rule-derive.ts`, `standing/approval-learning.ts`, `standing/standing-rule-store.ts`)
//     names neither `workflow_import` nor the import store nor any of its reads; the display reads are named
//     only where the plan allows (`readImportSource`: the store, `ipc/standing-rpc.ts`,
//     `automation/workflow-import.ts`; `listSources`: the store, `ipc/automation-rpc/workflow.ts`,
//     `ipc/workflow-import-rpc.ts`; `signersForName`: the store and `automation/workflow-import.ts`); and
//     the import modules name none of `standing_rule`, `standing_rule_fire`, `standing_streak`,
//     `standing_suggestion`, `insertRule`, `claimFire`, `standingRuleStep`. So an import can never satisfy a
//     rule and a rule never relaxes for an import.
// (e) Rules `workflow-import-forbidden-import` and `workflow-import-no-network`: the import modules
//     (`automation/workflow-bundle.ts`, `workflow-import.ts`, `workflow-import-prompt.ts`,
//     `workflow-import-store.ts`, `ipc/workflow-import-rpc.ts`) import no ChatOps, egress, federation or
//     share module (from `share/` only `share-keypair.ts`, which holds the key behind
//     `signBytesWithShareKey`), no `connectors/` value (the ONE permitted exception is
//     `connectors/connector-writes/sanitise.ts`, the text escaper, which has no imports of its own) and no
//     network primitive.
// (f) Rule `workflow-import-schedule-isolation`: `setWorkflowSchedule`, `resolveSaveSchedule` and
//     `upsertWorkflowByName` are named among the import modules only by `automation/workflow-import.ts`
//     (the bundle layer, the prompt, the store and the RPC module name none), so the bundle layer cannot
//     carry a schedule.
// Stated bounds: a text scan, so a dynamically composed name evades it (as D33(c), D41 and D42 say); the
// behavioural tests in `i59-workflow-import.test.ts` (I59) are authoritative. Tied to I59.
const D50_SRC = "packages/gateway/src/";
const D50_STORE = `${D50_SRC}automation/workflow-import-store.ts`;
const D50_DDL = `${D50_SRC}index/workflow-import-v101-sql.ts`;
const D50_IMPORT = `${D50_SRC}automation/workflow-import.ts`;
const D50_RPC = `${D50_SRC}ipc/workflow-import-rpc.ts`;
const D50_BUNDLE = `${D50_SRC}automation/workflow-bundle.ts`;
const D50_PROMPT = `${D50_SRC}automation/workflow-import-prompt.ts`;
const D50_MODULES: readonly string[] = [D50_BUNDLE, D50_IMPORT, D50_PROMPT, D50_STORE, D50_RPC];
const D50_RULE_PATH: readonly string[] = [
  `${D50_SRC}engine/standing-rule-step.ts`,
  `${D50_SRC}standing/standing-rule-derive.ts`,
  `${D50_SRC}standing/approval-learning.ts`,
  `${D50_SRC}standing/standing-rule-store.ts`,
];
const D50_TABLE_RE = sqlTableReferenceRe("workflow_import");
const D50_IDENTIFIERS: readonly {
  readonly re: RegExp;
  readonly allowed: readonly string[];
  readonly rule: string;
}[] = [
  {
    re: /\b(?:recordImport|floorFor|signerHistory)\b/g,
    allowed: [D50_STORE, D50_IMPORT],
    rule: "workflow-import-table-confined",
  },
  {
    re: /\bimportWorkflowBundle\b/g,
    allowed: [D50_IMPORT, D50_RPC],
    rule: "workflow-import-entry-confined",
  },
  {
    re: /\bupsertWorkflowByName\b/g,
    allowed: [
      `${D50_SRC}automation/workflow-store.ts`,
      `${D50_SRC}ipc/automation-rpc/workflow.ts`,
      D50_IMPORT,
    ],
    rule: "workflow-import-upsert-confined",
  },
  {
    re: /\breadImportSource\b/g,
    allowed: [D50_STORE, `${D50_SRC}ipc/standing-rpc.ts`, D50_IMPORT],
    rule: "workflow-import-rule-isolation",
  },
  {
    re: /\blistSources\b/g,
    allowed: [D50_STORE, `${D50_SRC}ipc/automation-rpc/workflow.ts`, D50_RPC],
    rule: "workflow-import-rule-isolation",
  },
  {
    re: /\bsignersForName\b/g,
    allowed: [D50_STORE, D50_IMPORT],
    rule: "workflow-import-rule-isolation",
  },
];
const D50_LITERAL_RE = /(["'`])workflow\.(?:import|export)\1/g;
const D50_EXPORT_LITERAL_RE = /(["'`])workflow\.export\1/g;
// Files allowed the `workflow.import` literal ONLY (a `workflow.export` there is still flagged):
// `usesPromptText`, split out of the executor, names the types whose prompt is a prompt text.
const D50_IMPORT_ONLY_ALLOWED: readonly string[] = [`${D50_SRC}engine/executor/action-types.ts`];
const D50_LITERAL_ALLOWED: readonly string[] = [
  `${D50_SRC}engine/executor.ts`,
  D50_IMPORT,
  D50_RPC,
  `${D50_SRC}connectors/proposable-actions.ts`,
  `${D50_SRC}ipc/lan-rpc.ts`,
  `${D50_SRC}ipc/server/demo-gate.ts`,
];
const D50_RULE_NAMES_RE =
  /\b(?:standing_rule(?:_fire)?|standing_streak|standing_suggestion|insertRule|claimFire|standingRuleStep)\b/g;
const D50_STORE_NAMES_RE =
  /\bworkflow_import\b|workflow-import-store|\b(?:readImportSource|listSources|signersForName|floorFor|signerHistory|recordImport)\b/g;
const D50_SCHEDULE_NAMES_RE =
  /\b(?:setWorkflowSchedule|resolveSaveSchedule|upsertWorkflowByName)\b/g;
const D50_ALLOWED_TARGET_RE =
  /(?:^|\/)share\/share-keypair(?:\.ts)?$|(?:^|\/)connectors\/connector-writes\/sanitise(?:\.ts)?$/;

export function checkWorkflowImportConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith(D50_SRC)) continue;
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    const code = stripComments(f.contents);
    const original = f.contents.split("\n");
    const push = (rule: string, index: number | undefined): void => {
      const line = code.slice(0, index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    };
    // (a) the table
    if (f.relPath !== D50_STORE && f.relPath !== D50_DDL) {
      for (const m of code.matchAll(new RegExp(D50_TABLE_RE.source, "gi"))) {
        push("workflow-import-table-confined", m.index);
      }
    }
    // (a)-(d) identifiers
    for (const id of D50_IDENTIFIERS) {
      if (id.allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(id.re)) push(id.rule, m.index);
    }
    // (b) the method literals
    if (!D50_LITERAL_ALLOWED.includes(f.relPath)) {
      const literalRe = D50_IMPORT_ONLY_ALLOWED.includes(f.relPath)
        ? D50_EXPORT_LITERAL_RE
        : D50_LITERAL_RE;
      for (const m of code.matchAll(literalRe)) push("workflow-import-entry-confined", m.index);
    }
    // (d) the rule and learning path never reads provenance
    if (D50_RULE_PATH.includes(f.relPath)) {
      for (const m of code.matchAll(D50_STORE_NAMES_RE)) {
        push("workflow-import-rule-isolation", m.index);
      }
    }
    // (d) the import modules never touch a rule or a learning table
    if (D50_MODULES.includes(f.relPath)) {
      for (const m of code.matchAll(D50_RULE_NAMES_RE)) {
        push("workflow-import-rule-isolation", m.index);
      }
    }
    // (f) schedules: only the import core names the schedule writers
    if (D50_MODULES.includes(f.relPath) && f.relPath !== D50_IMPORT) {
      for (const m of code.matchAll(D50_SCHEDULE_NAMES_RE)) {
        push("workflow-import-schedule-isolation", m.index);
      }
    }
  }
  // (e) the import modules' imports and network primitives
  out.push(
    ...checkConfinement(files, {
      inScope: (relPath) => D50_MODULES.includes(relPath),
      forbiddenSegmentRe: D45_FORBIDDEN_SEGMENT_RE,
      forbiddenImportRule: "workflow-import-forbidden-import",
      noNetworkRule: "workflow-import-no-network",
      allowTarget: (target) => D50_ALLOWED_TARGET_RE.test(target),
    }),
  );
  return out;
}

// ---- D26(d) (the model's computer-use binding, I35, owner rulings OR-MCU-1/2) ----------------------
// Rule `computer-use-binding-confined`, each identifier matched as a word after comments and string
// literals are stripped:
// (a) `buildComputerUseTools` only by `computer-use/cu-tools.ts` (its definition) and `engine/agent.ts`
//     (the one caller, per request, from the turn's binding);
// (b) the request slot `computerUse` only by `engine/agent-request-context.ts` (its declaration) and
//     `engine/run-ask.ts` (the one setter, on the owner's non-demo `cli` turn), and its reader
//     `getAgentRequestComputerUse` only by the context module and `engine/agent.ts`;
// (c) `liveSessionLane` only by `computer-use/cu-gate.ts` and `platform/assemble.ts` (the resolver);
// (d) `COMPUTER_USE_OFFER_BY_KIND` only by `ipc/server/inline-handlers.ts`, so no other entry decides
//     which callers may bind a session;
// (e) `requestFor` (the unicast prompt) only by `computer-use/cu-unicast-broker.ts` and
//     `platform/assemble.ts`, so no other module raises a computer-use prompt to a connection.
// Test files are not scanned. Stated bounds: a text scan, so a dynamically composed name evades it, and
// a second use inside an allow-listed file is exempt whole-file; the behavioural tests (I35) are
// authoritative. Tied to I35.
const D26D_SRC = "packages/gateway/src/";
const D26D_RULES: readonly { readonly re: RegExp; readonly allowed: readonly string[] }[] = [
  {
    re: /\bbuildComputerUseTools\b/g,
    allowed: [`${D26D_SRC}computer-use/cu-tools.ts`, `${D26D_SRC}engine/agent.ts`],
  },
  {
    re: /\bcomputerUse\b/g,
    allowed: [`${D26D_SRC}engine/agent-request-context.ts`, `${D26D_SRC}engine/run-ask.ts`],
  },
  {
    re: /\bgetAgentRequestComputerUse\b/g,
    allowed: [`${D26D_SRC}engine/agent-request-context.ts`, `${D26D_SRC}engine/agent.ts`],
  },
  {
    re: /\bliveSessionLane\b/g,
    allowed: [`${D26D_SRC}computer-use/cu-gate.ts`, `${D26D_SRC}platform/assemble.ts`],
  },
  {
    re: /\bCOMPUTER_USE_OFFER_BY_KIND\b/g,
    allowed: [`${D26D_SRC}ipc/server/inline-handlers.ts`],
  },
  {
    re: /\brequestFor\b/g,
    allowed: [`${D26D_SRC}computer-use/cu-unicast-broker.ts`, `${D26D_SRC}platform/assemble.ts`],
  },
];

export function checkComputerUseBindingConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith(D26D_SRC)) continue;
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    for (const r of D26D_RULES) {
      if (r.allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(r.re)) {
        const line = code.slice(0, m.index).split("\n").length;
        out.push({
          rule: "computer-use-binding-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// ---- D51 (model access to saved generated tools, I60) --------------------------------------------
// Rule `toolgen-model-door-confined`, each identifier matched as a word after comments and string
// literals are stripped (so an aliased import is caught):
// (a) `buildModelGeneratedTools` is named only by `toolgen/toolgen-model-door.ts` (its definition) and
//     `engine/agent.ts` (the one caller), so no other surface offers the model a generated tool;
// (b) `buildGeneratedTools` only by `toolgen/toolgen-agent-tools.ts` and the door, so a tool built
//     from an unfiltered list cannot reach the model past the door's offer and call checks;
// (c) `invokeSavedTool` only by `toolgen/toolgen-invoke-gate.ts`, `ipc/toolgen-rpc.ts` (the owner's
//     `nimbus tool run`) and `platform/assemble.ts` (the door's pinned binding);
// (d) `pinReadVerified` only by the door and `platform/assemble.ts`;
// (e) the request slot `toolgenModelAsk` only by `engine/agent-request-context.ts` (its declaration)
//     and `engine/run-ask.ts` (the one setter, on the owner's non-demo `cli`/`ui` turn), and its
//     reader `getAgentRequestToolgenModelAsk` only by the context module, `engine/agent.ts` and the door;
// (f) the literal "tool.model.invoke" only by the door and `engine/executor.ts` (the I2 frozen set) and
//     `engine/executor/action-types.ts` (the `usesPromptText` predicate).
// Test files are not scanned. Stated bounds: a text scan, so a dynamically composed name evades it, and
// a second use inside an allow-listed file is exempt whole-file; the behavioural tests in
// `i60-saved-tool-owner-turn.test.ts` (I60) are authoritative. Tied to I60.
const D51_SRC = "packages/gateway/src/";
const D51_DOOR = `${D51_SRC}toolgen/toolgen-model-door.ts`;
const D51_ASSEMBLE = `${D51_SRC}platform/assemble.ts`;
const D51_CONTEXT = `${D51_SRC}engine/agent-request-context.ts`;
const D51_RULES: readonly { readonly re: RegExp; readonly allowed: readonly string[] }[] = [
  { re: /\bbuildModelGeneratedTools\b/g, allowed: [D51_DOOR, `${D51_SRC}engine/agent.ts`] },
  {
    re: /\bbuildGeneratedTools\b/g,
    allowed: [`${D51_SRC}toolgen/toolgen-agent-tools.ts`, D51_DOOR],
  },
  {
    re: /\binvokeSavedTool\b/g,
    allowed: [
      `${D51_SRC}toolgen/toolgen-invoke-gate.ts`,
      `${D51_SRC}ipc/toolgen-rpc.ts`,
      D51_ASSEMBLE,
    ],
  },
  { re: /\bpinReadVerified\b/g, allowed: [D51_DOOR, D51_ASSEMBLE] },
  { re: /\btoolgenModelAsk\b/g, allowed: [D51_CONTEXT, `${D51_SRC}engine/run-ask.ts`] },
  {
    re: /\bgetAgentRequestToolgenModelAsk\b/g,
    allowed: [D51_CONTEXT, `${D51_SRC}engine/agent.ts`, D51_DOOR],
  },
];
const D51_STRING_LITERAL_RE = /(["'`])((?:\\[\s\S]|(?!\1)[^\\\n])*)\1/g;
const D51_TYPE_VALUE = "tool.model.invoke";
const D51_LITERAL_ALLOWED: readonly string[] = [
  D51_DOOR,
  `${D51_SRC}engine/executor.ts`,
  // `usesPromptText`, split out of the executor (the type's prompt is a prompt text).
  `${D51_SRC}engine/executor/action-types.ts`,
];

export function checkToolgenModelDoorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (!f.relPath.startsWith(D51_SRC)) continue;
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    const withStrings = stripComments(f.contents);
    const code = stripStringLiterals(withStrings);
    const original = f.contents.split("\n");
    const push = (text: string, index: number | undefined): void => {
      const line = text.slice(0, index).split("\n").length;
      out.push({
        rule: "toolgen-model-door-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    };
    for (const r of D51_RULES) {
      if (r.allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(r.re)) push(code, m.index);
    }
    if (!D51_LITERAL_ALLOWED.includes(f.relPath)) {
      // Every string literal, scanned left to right, so a quoted word inside a longer string is part
      // of that string's value and never matches on its own.
      for (const m of withStrings.matchAll(D51_STRING_LITERAL_RE)) {
        if (m[2] === D51_TYPE_VALUE) push(withStrings, m.index);
      }
    }
  }
  return out;
}

// ---- D47 (the v1 static-box LAN path, I56) -------------------------------------------------------
// Rule id `lan-box-path-confined`. The LAN's v1 wire seals every frame under the STATIC `nacl.box`
// secret of the two identity keys, which has no forward secrecy. Since LAN FS1 that path is reachable
// only through `ipc/lan-legacy.ts` (which refuses a peer already at protocol 2 and everything under
// `[lan] min_protocol = 2`); the primitives live in `ipc/lan-crypto.ts`. In every other non-test file of
// `packages/gateway/src/`, the identifiers `sealBoxFrame` and `openBoxFrame` (a call, an import,
// aliased or not) and a `nacl.box(` / `nacl.box.open(` call are violations, so a new federation module
// cannot seal a record under the static key and skip the Noise session. `nacl.box.keyPair` is not a
// seal and stays free (identity key creation). Comments and string literals are stripped first;
// `*.test.ts` and `*.test-helpers.ts` are not scanned.
// STATED BOUNDS (as D33(c)): a dynamically composed call evades a text scan, a second use INSIDE
// `lan-legacy.ts` or `lan-crypto.ts` is exempt whole-file, and a `box` imported by name from the
// library and called bare is not matched. After slice FS3 the legacy file is deleted and the
// allowance with it.
const D47_IDENT_RE = /\b(?:sealBoxFrame|openBoxFrame)\b/g;
const D47_NACL_BOX_RE = /\b(?:nacl|tweetnacl)\s*\.\s*box\s*(?:\.\s*open\s*)?\(/g;
const D47_ALLOWED: readonly string[] = [
  "packages/gateway/src/ipc/lan-crypto.ts",
  "packages/gateway/src/ipc/lan-legacy.ts",
];

export function checkLanBoxPathConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (/\.test(?:-helpers)?\.ts$/.test(f.relPath)) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D47_ALLOWED.includes(f.relPath)) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    for (const re of [D47_IDENT_RE, D47_NACL_BOX_RE]) {
      for (const hit of code.matchAll(re)) {
        const line = code.slice(0, hit.index).split("\n").length;
        out.push({
          rule: "lan-box-path-confined",
          file: f.relPath,
          line,
          snippet: (original[line - 1] ?? "").trim(),
        });
      }
    }
  }
  return out;
}
