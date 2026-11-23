// Static invariant rules: the model write door, before-state read, confirm comparison and bound writes.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import { D42_EXECUTOR, D42_REGISTRY, d41Span, d42ExecutorPins } from "./bound-write-pins.ts";
import {
  createToolCallRe,
  D39_BUILDERS,
  D39_CONTEXT_FIELD_ALLOWED,
  D39_CONTEXT_FIELD_RE,
  D39_DOOR,
  D39_EXECUTOR_READ_ALLOWED,
  D39_EXECUTOR_READ_RE,
  D39_ORIGIN_RE,
  D39_TRANSPORT_RE,
  importsWriteTableAsValue,
} from "./extension-grants-eval.ts";

export function checkModelWriteDoor(files: readonly FileEntry[]): Violation[] {
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
    const isDoor = f.relPath === D39_DOOR;
    if (!isDoor && importsWriteTableAsValue(f.relPath, commentFree)) {
      const m = createToolCallRe(commentFree).exec(code);
      if (m !== null) push("connector-write-tools-built-outside-door", code, m.index);
    }
    if (!D39_EXECUTOR_READ_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D39_EXECUTOR_READ_RE)) {
        push("connector-write-executor-read-confined", code, m.index);
      }
    }
    if (!D39_CONTEXT_FIELD_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D39_CONTEXT_FIELD_RE)) {
        push("connector-write-context-field-confined", code, m.index);
      }
    }
    for (const [re, allowed] of D39_BUILDERS) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) push("connector-write-builders-confined", code, m.index);
    }
    if (isDoor) {
      for (const m of code.matchAll(D39_TRANSPORT_RE)) {
        push("connector-write-door-names-transport", code, m.index);
      }
      if (!D39_ORIGIN_RE.test(commentFree)) {
        out.push({
          rule: "connector-write-door-origin-model",
          file: f.relPath,
          line: 1,
          snippet: 'no origin: "model" in the door',
        });
      }
    }
  }
  return out;
}

// ---- D40 (the door's before-state read, I53 / spec § 5.4) ---------------------------------------
// A before-state read runs with no approval of its own, so three confinements keep it a read of
// the write's own connector, on the model door's executor only:
// (a) the `.before.read` action-type literal appears (in code or in a string, comments stripped)
//     only in `engine/before-state.ts`, which builds the type, and `connectors/registry.ts`, the
//     dispatcher guard. This confines the SPELLING, not the capability: a dynamically composed
//     type evades it, and what stops such an action is the gate refusal and the dispatcher guard;
// (b) `createBeforeStateRunner` is named only by `engine/before-state.ts` (its definition) and
//     `engine/run-ask.ts`, and inside run-ask.ts only on an import line or within the body of
//     `newDoorExecutor` (Phase 28 AD1: the ONE door maker, which `buildModelWriteExecutor` and
//     `buildAgentWriteExecutor` both call, so the model door and the MCP act door cannot drift) or
//     `newWorkflowWriteExecutor` (SA2: the owner's own workflow
//     write step is the second carrier; it offers nothing to the model; SA4: the private function
//     both workflow builders call, so the attended and the unattended executor share it) or `newRemediationExecutor`
//     (Phase 10 IC5a: the incident engine remediation, the owner own action with a capture observer), and it is never imported
//     under an `as` alias (an alias would let
//     run-ask.ts call it outside that body unseen); a runner handed around as a value (an object
//     literal, a re-export under another name in another module) is outside a text scan;
// (c) `engine/executor.ts` (the structural refusal in `gate()`) and `connectors/registry.ts` (the
//     dispatch guard) each call `isBeforeReadActionType(`; a guard that disappears is a violation.
// Test files and anything outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c):
// a dynamically composed type (`".before" + ".read"`) evades a text scan; the guard and the gate
// refusal are pinned behaviourally (`connectors/registry.test.ts`, `engine/before-state.test.ts`).
const D40_LITERAL_RE = /\.before\.read\b/g;
const D40_LITERAL_ALLOWED: readonly string[] = [
  "packages/gateway/src/engine/before-state.ts",
  "packages/gateway/src/connectors/registry.ts",
];
const D40_RUNNER_RE = /\bcreateBeforeStateRunner\b/g;
const D40_RUNNER_ALIAS_RE = /\bcreateBeforeStateRunner\s+as\b/g;
const D40_RUNNER_DEF = "packages/gateway/src/engine/before-state.ts";
const D40_RUN_ASK = "packages/gateway/src/engine/run-ask.ts";
const D40_GUARD_RE = /\bisBeforeReadActionType\s*\(/;
const D40_GUARD_SITES: readonly string[] = [
  "packages/gateway/src/engine/executor.ts",
  "packages/gateway/src/connectors/registry.ts",
];

/** `[start, end)` of each permitted carrier's body (the door's and the workflow write step's). */
function d40CarrierSpans(code: string): readonly (readonly [number, number])[] {
  const spans: (readonly [number, number])[] = [];
  for (const name of ["newDoorExecutor", "newWorkflowWriteExecutor", "newRemediationExecutor"]) {
    const at = code.search(new RegExp(`\\bfunction\\s+${name}\\s*\\(`));
    if (at === -1) continue;
    const end = code.indexOf("\n}\n", at);
    spans.push([at, end === -1 ? code.length : end]);
  }
  return spans;
}

/** Whether `index` sits inside an `import … from` statement (single- or multi-line). */
function d40InImportStatement(code: string, index: number): boolean {
  const statementStart = code.lastIndexOf(";", index - 1) + 1;
  return /^\s*import\b[^;]*$/.test(code.slice(statementStart, index));
}

export function checkBeforeStateRead(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const guardsSeen = new Set<string>();
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
    if (!D40_LITERAL_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D40_LITERAL_RE)) {
        push("before-read-literal-confined", commentFree, m.index);
      }
    }
    if (f.relPath !== D40_RUNNER_DEF) {
      const spans = f.relPath === D40_RUN_ASK ? d40CarrierSpans(code) : [];
      for (const m of code.matchAll(D40_RUNNER_RE)) {
        const i = m.index;
        const inDoorBuilder = spans.some(([start, end]) => i >= start && i < end);
        const allowed =
          f.relPath === D40_RUN_ASK && (inDoorBuilder || d40InImportStatement(code, i));
        if (!allowed) push("before-state-runner-confined", code, i);
      }
      for (const m of code.matchAll(D40_RUNNER_ALIAS_RE)) {
        push("before-state-runner-confined", code, m.index);
      }
    }
    if (D40_GUARD_SITES.includes(f.relPath) && D40_GUARD_RE.test(code)) guardsSeen.add(f.relPath);
  }
  for (const site of D40_GUARD_SITES) {
    if (!guardsSeen.has(site)) {
      out.push({
        rule: "before-read-guard-present",
        file: site,
        line: 1,
        snippet: "isBeforeReadActionType is not called here",
      });
    }
  }
  return out;
}

// ---- D41 (type-to-confirm, I53 / I20, Phase 9.7 D0a) ---------------------------------------------
// A Wave 4 connector write is approved only by the owner typing its confirm text, and ONE place
// decides whether what was typed is right: `engine/executor.ts`. Four clauses:
// (a) `requestConfirmedApproval` (the consent channel's typed-answer method) is named only by
//     `engine/executor.ts` (the gate, which is the only caller, and `bindConsentChannel`, which
//     defines the IPC channel) and `engine/types.ts` (the interface). (The act door's wrapper,
//     `provenanceConsent`, was the one other site until Phase 28 AD1 deleted it: the executor's own
//     prompt now reaches the owner on that door too.) `requestConfirmedConsent` (the coordinator's half) is named
//     only by `engine/executor.ts` and `ipc/consent.ts`;
// (b) `renderConfirmText` is named only by `engine/executor.ts` (its one caller) and
//     `connectors/connector-writes/confirm.ts` (its definition);
// (c) the strict comparison of a typed answer with a confirm text — a `===` or `!==` with
//     `confirmText` or a `.typed` property on either side — occurs only in `engine/executor.ts`,
//     so `ConsentCoordinatorImpl`, the act-door wrapper and every other channel carry the text
//     and never judge it;
// (d) the order is pinned in `engine/executor.ts`: `resolveHitlApproval` calls
//     `captureBeforePhase`, then `renderConfirmPhase`, then `approvalPhase`; the plain
//     `this.consent.requestApproval(` call sits in `approvalPhase` after its `confirm.kind ===
//     "none"` guard and nowhere else, `requestConfirmedApproval(` is called only in
//     `confirmedOwnerPrompt`, and `renderConfirmPhase` reads the row's wave. A phase that is
//     reordered, or a Wave 4 write that reaches the plain prompt, is a violation.
// Comments and string literals are stripped before identifiers are matched; test files and anything
// outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c): a dynamically composed
// name evades a text scan, a second use inside an allow-listed file is exempt whole-file (the
// order pin narrows that for the file that matters), and an ALIAS of the
// channel method is not followed. The behaviour is pinned by `engine/executor-confirm.test.ts`.
const D41_EXECUTOR = "packages/gateway/src/engine/executor.ts";
const D41_CHANNEL_RE = /\brequestConfirmedApproval\b/g;
const D41_CHANNEL_ALLOWED: readonly string[] = [
  D41_EXECUTOR,
  "packages/gateway/src/engine/types.ts",
];
const D41_COORDINATOR_RE = /\brequestConfirmedConsent\b/g;
const D41_COORDINATOR_ALLOWED: readonly string[] = [
  D41_EXECUTOR,
  "packages/gateway/src/ipc/consent.ts",
];
const D41_RENDER_RE = /\brenderConfirmText\b/g;
const D41_RENDER_ALLOWED: readonly string[] = [
  D41_EXECUTOR,
  "packages/gateway/src/connectors/connector-writes/confirm.ts",
];
// A comparison with `undefined` or `null` ("is there a confirm text") is a presence check, not a
// judgement of what was typed.
const D41_COMPARE_RE =
  /(?:\bconfirmText|\.typed)\b\s*[!=]==(?!\s*(?:undefined|null)\b)|(?<!\b(?:undefined|null)\s*)[!=]==\s*[\w.]*(?:\bconfirmText\b|\.typed\b)/g;

export function checkConfirmComparison(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const push = (f: FileEntry, rule: string, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    if (!D41_CHANNEL_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D41_CHANNEL_RE))
        push(f, "confirm-channel-confined", code, m.index);
    }
    // A `*.test-helpers.ts` is test support (an inert coordinator stub), imported by tests only.
    if (!D41_COORDINATOR_ALLOWED.includes(f.relPath) && !f.relPath.endsWith(".test-helpers.ts")) {
      for (const m of code.matchAll(D41_COORDINATOR_RE)) {
        push(f, "confirm-coordinator-confined", code, m.index);
      }
    }
    if (!D41_RENDER_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D41_RENDER_RE))
        push(f, "confirm-render-confined", code, m.index);
    }
    if (f.relPath !== D41_EXECUTOR) {
      for (const m of code.matchAll(D41_COMPARE_RE)) {
        push(f, "confirm-comparison-confined", code, m.index);
      }
    }
    if (f.relPath === D41_EXECUTOR) {
      for (const v of d41OrderPin(f, code)) out.push(v);
    }
  }
  return out;
}

/** The index of the `}` that closes the block whose body starts at `from`, or -1. */
function d41BlockEnd(code: string, from: number): number {
  let depth = 1;
  for (let i = from; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i;
  }
  return -1;
}

/** Clause (d): the phase order and the two prompt call sites in `engine/executor.ts`. */
function d41OrderPin(f: FileEntry, code: string): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "confirm-order-pinned", file: f.relPath, line: 1, snippet: what });
  };
  const resolve = d41Span(code, /\bprivate\s+async\s+resolveHitlApproval\s*\(/, "\n  }\n");
  const body = resolve === undefined ? "" : code.slice(resolve[0], resolve[1]);
  const before = body.indexOf("this.captureBeforePhase(");
  const render = body.indexOf("this.renderConfirmPhase(");
  const approve = body.indexOf("this.approvalPhase(");
  if (before === -1 || render === -1 || approve === -1 || !(before < render && render < approve)) {
    fail(
      "resolveHitlApproval must call captureBeforePhase, renderConfirmPhase, approvalPhase in that order",
    );
  }
  const phase = d41Span(code, /\bprivate\s+async\s+approvalPhase\s*\(/, "\n  }\n");
  const owner = d41Span(code, /\bprivate\s+async\s+confirmedOwnerPrompt\s*\(/, "\n  }\n");
  // Any receiver (an alias of the channel, `this.consent`, an optional call): exactly one call.
  const plainCalls = [...code.matchAll(/\.\s*requestApproval\s*(?:\?\.)?\s*\(/g)];
  const plainAt = plainCalls[0]?.index;
  // The guard must be `if (confirm.kind === "none") {` and the plain call must sit INSIDE its block:
  // reading the literal needs the string contents, which `code` has blanked; `stripStringLiterals`
  // keeps every offset, so the match index carries over to `code`, whose braces are reliable.
  const guard =
    phase === undefined
      ? null
      : /\bif\s*\(\s*confirm\.kind\s*===\s*"none"\s*\)\s*\{/.exec(
          stripComments(f.contents).slice(phase[0], phase[1]),
        );
  const blockStart =
    guard === null || phase === undefined ? -1 : phase[0] + guard.index + guard[0].length;
  const blockEnd = blockStart === -1 ? -1 : d41BlockEnd(code, blockStart);
  const plainOk =
    plainCalls.length === 1 &&
    plainAt !== undefined &&
    phase !== undefined &&
    plainAt > phase[0] &&
    plainAt < phase[1] &&
    blockStart !== -1 &&
    blockEnd !== -1 &&
    plainAt >= blockStart &&
    plainAt < blockEnd;
  if (!plainOk)
    fail(
      'the plain requestApproval call must sit once in approvalPhase, inside the if (confirm.kind === "none") block',
    );
  const typedCalls = [...code.matchAll(/\.\s*requestConfirmedApproval\s*(?:\?\.)?\s*\(/g)];
  const typedAt = typedCalls[0]?.index;
  if (
    typedCalls.length !== 1 ||
    typedAt === undefined ||
    owner === undefined ||
    typedAt < owner[0] ||
    typedAt >= owner[1]
  ) {
    fail("requestConfirmedApproval must be called once, in confirmedOwnerPrompt");
  }
  const renderPhase = d41Span(code, /\bprivate\s+renderConfirmPhase\s*\(/, "\n  }\n");
  if (
    renderPhase === undefined ||
    !/\bwave\s*===\s*4\b/.test(code.slice(renderPhase[0], renderPhase[1]))
  ) {
    fail("renderConfirmPhase must decide Wave 4 from the row's wave");
  }
  return out;
}
const D42_STEP = "packages/gateway/src/engine/prepare-step.ts";
const D42_TOOLS = "packages/gateway/src/connectors/connector-writes/prepare-tools.ts";
const D42_TYPES = "packages/gateway/src/connectors/connector-writes/types.ts";
const D42_WRITE_REGISTRY = "packages/gateway/src/connectors/connector-write-registry.ts";
const D42_DIFF = "packages/gateway/src/connectors/connector-writes/diff.ts";
const D42_LITERAL_RE = /\.write\.prepare\b/g;
const D42_NAMES: ReadonlyArray<readonly [RegExp, readonly string[]]> = [
  [/\binjectBoundFields\b/g, [D42_STEP, D42_EXECUTOR]],
  [/\brunPrepareStep\b/g, [D42_STEP, D42_EXECUTOR]],
  [/\bisPrepareActionType\b/g, [D42_STEP, D42_EXECUTOR, D42_REGISTRY]],
  [/\bisPrepareToolId\b/g, [D42_TOOLS, D42_REGISTRY, D42_WRITE_REGISTRY]],
  [/\brenderUnifiedDiff\b/g, [D42_STEP, D42_DIFF]],
  [/\bPREPARE_TOOL_IDS\b/g, [D42_TOOLS, D42_TYPES, D42_EXECUTOR, D42_REGISTRY]],
  [/\b(?:writeTable|WriteTable)\b/g, [D42_EXECUTOR]],
  [/\bprepareToolIds\b/g, [D42_STEP, D42_TOOLS, D42_TYPES, D42_EXECUTOR, D42_REGISTRY]],
];
const D42_MUTATOR_RE = /\bPREPARE_TOOL_IDS\s*\.\s*(?:add|delete|clear)\s*\(/g;

/**
 * The index of the `>` that closes the type-argument list opened at `open` (a `<`), or -1 when the
 * text is not one: only identifiers, dots, commas, spaces, `[]`, `|`, `&`, string-literal types and nested `<>`
 * may appear (no `?`, `:`, `(` or operator: that is a comparison or a ternary).
 */
function d42TypeArgsEnd(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "<") depth++;
    else if (ch === ">" && code.charAt(i - 1) !== "=") {
      depth--;
      if (depth === 0) return i;
    } else if (!/[\w$.,\s[\]|&'"`]/.test(ch)) return -1;
  }
  return -1;
}

/** The top-level arguments of the call whose `(` is at `open` in `code` (strings already blanked). */
function d42CallArgs(code: string, open: number): string[] {
  const args: string[] = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < code.length; i++) {
    const ch = code.charAt(i);
    if (ch === "<" && /[\w$]/.test(code.charAt(i - 1))) {
      // `f<A, B>(x)`: a `<` glued to an identifier that closes as a type-argument list is not an
      // argument separator context. A comparison (`a < b`) has a space or never closes this way.
      const end = d42TypeArgsEnd(code, i);
      if (end > i) {
        i = end;
        continue;
      }
    }
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") {
      depth--;
      if (depth === 0) {
        const last = code.slice(start, i).trim();
        if (last !== "") args.push(last);
        return args;
      }
    } else if (ch === "," && depth === 1) {
      args.push(code.slice(start, i).trim());
      start = i + 1;
    }
  }
  return args;
}

/** The base names of the `*.test-helpers` modules a production file (not a test) imports. */
function d42ImportedHelpers(files: readonly FileEntry[]): ReadonlySet<string> {
  const names = new Set<string>();
  const re = /["'][^"']*?([\w.-]+\.test-helpers)(?:\.ts)?["']/g;
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    for (const m of stripComments(f.contents).matchAll(re)) names.add(m[1] ?? "");
  }
  return names;
}

export function checkBoundWrites(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const importedHelpers = d42ImportedHelpers(files);
  const push = (f: FileEntry, rule: string, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  const whole = (f: FileEntry, rule: string, what: string): void => {
    out.push({ rule, file: f.relPath, line: 1, snippet: what });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // A test-support helper is exempt only while no production file imports it.
    if (f.relPath.endsWith(".test-helpers.ts")) {
      const base = f.relPath.slice(f.relPath.lastIndexOf("/") + 1).replace(/\.ts$/, "");
      if (!importedHelpers.has(base)) continue;
    }
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (f.relPath !== D42_STEP) {
      for (const m of commentFree.matchAll(D42_LITERAL_RE)) {
        push(f, "bound-prepare-literal-confined", commentFree, m.index);
      }
    }
    for (const [re, allowed] of D42_NAMES) {
      if (allowed.includes(f.relPath)) continue;
      for (const m of code.matchAll(re)) push(f, "bound-name-confined", code, m.index);
    }
    for (const m of code.matchAll(/(?<!function\s+)\bnew\s+ToolExecutor\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      if (d42CallArgs(code, open).length > 8) push(f, "bound-seam-not-production", code, m.index);
    }
    for (const m of code.matchAll(/(?<!function\s+)\bcreateConnectorDispatcher\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      if (/\bprepareToolIds\b/.test(d42CallArgs(code, open)[1] ?? "")) {
        push(f, "bound-seam-not-production", code, m.index);
      }
    }
    for (const m of code.matchAll(/(?<!function\s+)\bwithBound\s*\(/g)) {
      const open = (m.index ?? 0) + m[0].length - 1;
      if (d42CallArgs(code, open).length > 2) push(f, "bound-seam-not-production", code, m.index);
    }
    if (f.relPath !== D42_TOOLS) {
      for (const m of code.matchAll(D42_MUTATOR_RE)) {
        push(f, "bound-prepare-set-frozen", code, m.index);
      }
    }
    if (f.relPath === D42_TOOLS) {
      const frozen =
        /\bObject\.freeze\s*\(/.test(code) &&
        /\badd\s*\([^)]*\)\s*:\s*never/.test(code) &&
        /\bdelete\s*\([^)]*\)\s*:\s*never/.test(code) &&
        /\bclear\s*\(\s*\)\s*:\s*never/.test(code);
      if (!frozen) whole(f, "bound-prepare-set-frozen", "PREPARE_TOOL_IDS is no longer frozen");
    }
    if (f.relPath === D42_EXECUTOR) {
      for (const v of d42ExecutorPins(f, code)) out.push(v);
    }
  }
  return out;
}
