// Static invariant rules: standing approvals and pack layer writers.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import { d41Span } from "./bound-write-pins.ts";
import { sqlTableReferenceRe } from "./vlm-media-capture-door.ts";

// ---- D44 (standing approvals, I55, Phase 10 SA3) -------------------------------------------------
// A standing rule approves a write without a prompt, so five things must stay the only way in:
// (a) the owner-workflow PROVENANCE is built only by `automation/workflow-write-step.ts`: the
//     `kind: "owner_workflow"` literal is written there and in the type (`engine/types.ts`); the
//     literal is READ (never constructed) only by `engine/standing-rule-step.ts`; the type and its
//     `fieldSources` member are named only by those files and `engine/executor.ts` (the audit row's
//     trimmed copy). No IPC method, door, payload, ChatOps, LAN or HTTP path can supply one;
// (b) the `standing_rule` and `standing_rule_fire` tables are referenced only by
//     `standing/standing-rule-store.ts` and their V88 DDL, and the store's writers (`insertRule`,
//     `resumeRule`, `pauseRule`, `revokeRule`) only by the store and the `standing.*` RPC handler
//     (`ipc/standing-rpc.ts`); the counter claim `claimFire` only by the store and the check;
// (c) the order, pinned in `engine/executor.ts`: `resolveHitlApproval` calls `renderConfirmPhase`
//     BEFORE `approvalPhase`; `standingRuleStep(` is called exactly once, inside `approvalPhase`,
//     BEFORE `tryDelegatedApproval(`; the name `standingRuleStep` is used only by the executor and
//     its own module; and the `kind: "standing_approved"` / `hitlStatus: "standing_approved"` literal
//     is constructed only by the executor, the check and the type;
// (d) the UNATTENDED executor (Phase 10 SA4, scheduled runs): the property name `unattended` appears
//     only in `engine/executor.ts` (the option's type, its field, and ONE read) and, as a value, only
//     inside `newWorkflowWriteExecutor` in `engine/run-ask.ts`; the read is a single `this.unattended`
//     test inside `approvalPhase`, AFTER `standingRuleStep(` and BEFORE `tryDelegatedApproval(`, so an
//     unattended executor consults a rule and then refuses without asking anyone; the refusal text
//     `UNATTENDED_NO_RULE_REASON` is returned only in `approvalPhase` (the workflow write step may
//     compare it, to block the run); and the trigger literal `trigger: "schedule"` is produced only
//     by `automation/workflow-scheduler.ts` (no IPC path can: `workflowTriggerOf` returns only
//     `owner_cli` / `owner_ui`). `buildUnattendedWorkflowWriteExecutor` is confined by D39;
// (e) the executor dependency `standingRules` is handed over only by the workflow write executors in
//     `engine/run-ask.ts`: the identifier is named only by the executor, run-ask and the standing
//     module that builds it, and run-ask writes `standingRules:` exactly once, inside the private
//     `newWorkflowWriteExecutor`, which only `buildWorkflowWriteExecutor` and
//     `buildUnattendedWorkflowWriteExecutor` call (once each). Every other executor therefore has
//     none and can never approve by a rule.
// (f) approval learning (Phase 10 SA5): the `standing_streak` and `standing_suggestion` tables are
//     referenced only by `standing/standing-suggestion-store.ts` and their V90 DDL, which also name
//     neither rule table (clause (b) covers that: the store is not exempt from it); the store's
//     streak and suggestion writers (`applyStepRun`, `openSuggestion`, `markStaleFor`) are named only by
//     the store and the learning pass (`standing/approval-learning.ts`); `learnFromStepRun` is named
//     only by that pass and the workflow runner (`automation/workflow-runner.ts`); and
//     `hasLiveRuleFor`, the pass's one question to the rule store, only by the rule store and the
//     pass. The pass may READ the `"owner_workflow"` literal (clause (a)) but never construct it.
// (g) workflow `when` guards (Phase 10, workflow conditionals): a guard only REMOVES runs, decided by
//     the runner before an action exists, so it must stay out of the approval check. The guard module
//     `automation/workflow-guard.ts` imports only `./workflow-steps.ts` and
//     `connectors/connector-writes/sanitise.ts` (no executor, vault, egress, network or model
//     module); its functions `evaluateGuard`, `guardRequiresPresence` and `guardRuleLines` are named
//     only by it, the runner (the decision and the learner's `ruleEligibleGuard` field), rule
//     derivation and the `standing.*` RPC handler (rule creation and resume); and
//     `engine/standing-rule-step.ts` never reads a `when` or names the guard module, so nothing the
//     step does depends on a guard and a guard cannot widen what a rule approves.
// Comments are stripped before matching (string literals are kept for the literal clauses); test
// files, a test-support `*.test-helpers.ts` that no production file imports, and anything outside
// packages/gateway/src/ are not scanned. STATED BOUND, as D33(c)/D41/D42: a dynamically composed
// name evades a text scan, a second use inside an allow-listed file is exempt whole-file (the order
// pins narrow that for the executor), and an alias is not followed. The order pins are TEXTUAL:
// the behavioural tests in `i55-standing-rule.test.ts` (I55) are authoritative.
const D44_SRC = "packages/gateway/src/";
const D44_EXECUTOR = `${D44_SRC}engine/executor.ts`;
const D44_STEP = `${D44_SRC}engine/standing-rule-step.ts`;
const D44_TYPES = `${D44_SRC}engine/types.ts`;
const D44_WRITE_STEP = `${D44_SRC}automation/workflow-write-step.ts`;
const D44_STORE = `${D44_SRC}standing/standing-rule-store.ts`;
const D44_V88 = `${D44_SRC}index/standing-rule-v88-sql.ts`;
const D44_RPC = `${D44_SRC}ipc/standing-rpc.ts`;
const D44_RUN_ASK = `${D44_SRC}engine/run-ask.ts`;
const D44_SCHEDULER = `${D44_SRC}automation/workflow-scheduler.ts`;
const D44_LEARNING = `${D44_SRC}standing/approval-learning.ts`;
const D44_SUGGESTION_STORE = `${D44_SRC}standing/standing-suggestion-store.ts`;
const D44_V90 = `${D44_SRC}index/standing-suggestion-v90-sql.ts`;
const D44_RUNNER = `${D44_SRC}automation/workflow-runner.ts`;
const D44_GUARD = `${D44_SRC}automation/workflow-guard.ts`;
const D44_DERIVE = `${D44_SRC}standing/standing-rule-derive.ts`;
/** What the guard module may import: the step types and the text sanitiser, nothing else. */
const D44_GUARD_IMPORTS: readonly string[] = [
  "./workflow-steps.ts",
  "../connectors/connector-writes/sanitise.ts",
];
const D44_LEARNING_TABLE_RES: readonly RegExp[] = ["standing_streak", "standing_suggestion"].map(
  (t) => {
    const re = sqlTableReferenceRe(t);
    return new RegExp(re.source, "gi");
  },
);
const D44_TABLE_RES: readonly RegExp[] = ["standing_rule", "standing_rule_fire"].map((t) => {
  const re = sqlTableReferenceRe(t);
  return new RegExp(re.source, "gi");
});
const D44_NAME_RULES: ReadonlyArray<{
  readonly rule: string;
  readonly re: RegExp;
  readonly allowed: readonly string[];
  /** Match against comment-stripped source with strings kept (a string spelling is a spelling). */
  readonly keepStrings: boolean;
}> = [
  {
    rule: "standing-provenance-confined",
    re: /["']owner_workflow["']/g,
    // The learning pass READS the literal off a parsed audit row; the construction rule below is not widened.
    allowed: [D44_WRITE_STEP, D44_TYPES, D44_STEP, D44_LEARNING],
    keepStrings: true,
  },
  {
    rule: "standing-provenance-confined",
    // Construction in any spelling: `kind:`, a quoted key `"kind":`, or an assignment `p.kind =` /
    // `p["kind"] =` (never `===`, so a reader's comparison is not a construction).
    re: /(?:\bkind|["']kind["'])\s*:\s*["']owner_workflow["']|(?:\.\s*kind|\[\s*["']kind["']\s*\])\s*=(?!=)\s*["']owner_workflow["']/g,
    allowed: [D44_WRITE_STEP, D44_TYPES],
    keepStrings: true,
  },
  {
    rule: "standing-provenance-confined",
    re: /\bWorkflowProvenance\b|\bfieldSources\b/g,
    allowed: [D44_WRITE_STEP, D44_TYPES, D44_STEP, D44_EXECUTOR],
    keepStrings: false,
  },
  {
    rule: "standing-tables-confined",
    re: /\b(?:insertRule|resumeRule|pauseRule|revokeRule)\b/g,
    allowed: [D44_STORE, D44_RPC],
    keepStrings: false,
  },
  {
    rule: "standing-tables-confined",
    re: /\bclaimFire\b/g,
    allowed: [D44_STORE, D44_STEP],
    keepStrings: false,
  },
  {
    rule: "standing-outcome-confined",
    re: /\b(?:kind|hitlStatus)\s*:\s*["']standing_approved["']/g,
    allowed: [D44_EXECUTOR, D44_STEP, D44_TYPES],
    keepStrings: true,
  },
  {
    rule: "standing-outcome-confined",
    re: /\bstandingRuleStep\b/g,
    allowed: [D44_EXECUTOR, D44_STEP],
    keepStrings: false,
  },
  {
    rule: "standing-rules-dep-confined",
    re: /\bstandingRules\b/g,
    allowed: [D44_EXECUTOR, D44_RUN_ASK],
    keepStrings: false,
  },
  // (d) the property name; run-ask's own use is narrowed to one function by `d44RunAskPins`.
  {
    rule: "standing-unattended-confined",
    re: /\bunattended\b/g,
    allowed: [D44_EXECUTOR, D44_RUN_ASK],
    keepStrings: false,
  },
  // (d) the one producer of the trigger "schedule".
  {
    rule: "standing-unattended-confined",
    re: /\btrigger\s*:\s*["']schedule["']/g,
    allowed: [D44_SCHEDULER],
    keepStrings: true,
  },
  // (d) the refusal text: the executor returns it, the write step compares it.
  {
    rule: "standing-unattended-confined",
    re: /\bUNATTENDED_NO_RULE_REASON\b/g,
    allowed: [D44_EXECUTOR, D44_WRITE_STEP],
    keepStrings: false,
  },
  // (f) approval learning.
  {
    rule: "standing-learning-confined",
    re: /\blearnFromStepRun\b/g,
    allowed: [D44_LEARNING, D44_RUNNER],
    keepStrings: false,
  },
  {
    rule: "standing-learning-confined",
    re: /\b(?:applyStepRun|openSuggestion|markStaleFor)\b/g,
    allowed: [D44_SUGGESTION_STORE, D44_LEARNING],
    keepStrings: false,
  },
  {
    rule: "standing-learning-confined",
    re: /\bhasLiveRuleFor\b/g,
    allowed: [D44_STORE, D44_LEARNING],
    keepStrings: false,
  },
  {
    rule: "standing-guard-confined",
    re: /\b(?:evaluateGuard|guardRequiresPresence|guardRuleLines)\b/g,
    allowed: [D44_GUARD, D44_RUNNER, D44_DERIVE, D44_RPC],
    keepStrings: false,
  },
];

/** Clause (g): the guard module is pure and the approval check never reads a guard. */
function d44GuardPins(f: FileEntry, commentFree: string, code: string): Violation[] {
  const out: Violation[] = [];
  const add = (src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule: "standing-guard-confined",
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  if (f.relPath === D44_GUARD) {
    for (const m of commentFree.matchAll(
      /\bfrom\s*["']([^"']+)["']|\bimport\s*["']([^"']+)["']/g,
    )) {
      const spec = m[1] ?? m[2] ?? "";
      if (!D44_GUARD_IMPORTS.includes(spec)) add(commentFree, m.index);
    }
    for (const m of code.matchAll(/\bfetch\s*\(|\bimport\s*\(|\brequire\s*\(|\bglobalThis\b/g)) {
      add(code, m.index);
    }
  }
  if (f.relPath === D44_STEP) {
    for (const m of commentFree.matchAll(
      // A property read, a destructure or object key, a quoted bracket read (`step["when"]`), or the
      // guard module's name.
      /\.\s*when\b|\bwhen\s*[:,}]|\[\s*["'`]when["'`]\s*\]|workflow-guard/g,
    )) {
      add(commentFree, m.index);
    }
  }
  return out;
}

export function checkStandingApprovals(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (f: FileEntry, rule: string, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D44_SRC)) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (f.relPath !== D44_STORE && f.relPath !== D44_V88) {
      for (const re of D44_TABLE_RES) {
        for (const m of commentFree.matchAll(re))
          add(f, "standing-tables-confined", commentFree, m.index);
      }
    }
    if (f.relPath !== D44_SUGGESTION_STORE && f.relPath !== D44_V90) {
      for (const re of D44_LEARNING_TABLE_RES) {
        for (const m of commentFree.matchAll(re))
          add(f, "standing-learning-confined", commentFree, m.index);
      }
    }
    for (const r of D44_NAME_RULES) {
      if (r.allowed.includes(f.relPath)) continue;
      const src = r.keepStrings ? commentFree : code;
      for (const m of src.matchAll(r.re)) add(f, r.rule, src, m.index);
    }
    for (const v of d44GuardPins(f, commentFree, code)) out.push(v);
    if (f.relPath === D44_EXECUTOR) for (const v of d44ExecutorPins(f, code)) out.push(v);
    if (f.relPath === D44_RUN_ASK) for (const v of d44RunAskPins(f, code)) out.push(v);
  }
  return out;
}

/** Clause (c): the order inside the executor. */
function d44ExecutorPins(f: FileEntry, code: string): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "standing-step-order-pinned", file: f.relPath, line: 1, snippet: what });
  };
  const span = (sig: RegExp): string => {
    const s = d41Span(code, sig, "\n  }\n");
    return s === undefined ? "" : code.slice(s[0], s[1]);
  };
  const calls = [...code.matchAll(/\bstandingRuleStep\s*\(/g)];
  const approval = span(/\bprivate\s+async\s+approvalPhase\s*\(/);
  const stepAt = approval.search(/\bstandingRuleStep\s*\(/);
  const delegateAt = approval.search(/\bthis\.tryDelegatedApproval\s*\(/);
  if (calls.length !== 1 || stepAt === -1 || delegateAt === -1 || !(stepAt < delegateAt)) {
    fail(
      "standingRuleStep( must be called exactly once, in approvalPhase, before tryDelegatedApproval(",
    );
  }
  const resolve = span(/\bprivate\s+async\s+resolveHitlApproval\s*\(/);
  const renderAt = resolve.indexOf("this.renderConfirmPhase(");
  const approveAt = resolve.indexOf("this.approvalPhase(");
  if (renderAt === -1 || approveAt === -1 || !(renderAt < approveAt)) {
    fail("resolveHitlApproval must call renderConfirmPhase before approvalPhase");
  }
  for (const v of d44UnattendedPins(f, code, approval, stepAt, delegateAt)) out.push(v);
  return out;
}

/**
 * Clause (d), inside the executor: the `unattended` option is read once, in `approvalPhase`, after
 * the standing-rule step and before any delegate, and the refusal text is returned only there.
 */
function d44UnattendedPins(
  f: FileEntry,
  code: string,
  approval: string,
  stepAt: number,
  delegateAt: number,
): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "standing-unattended-confined", file: f.relPath, line: 1, snippet: what });
  };
  // A read is `this.unattended` not followed by an assignment.
  const readRe = /\bthis\.unattended\b(?!\s*=[^=])/;
  const reads = [...code.matchAll(new RegExp(readRe.source, "g"))];
  const readAt = approval.search(readRe);
  if (reads.length !== 1 || readAt === -1 || !(stepAt < readAt && readAt < delegateAt)) {
    fail(
      "this.unattended must be read exactly once, in approvalPhase, after standingRuleStep( and before tryDelegatedApproval(",
    );
  }
  const reasonInApproval = [...approval.matchAll(/\bUNATTENDED_NO_RULE_REASON\b/g)].length;
  const reasonAll = [...code.matchAll(/\bUNATTENDED_NO_RULE_REASON\b/g)].length;
  const definitions = [...code.matchAll(/\bconst\s+UNATTENDED_NO_RULE_REASON\b/g)].length;
  if (reasonInApproval === 0 || reasonAll - reasonInApproval !== definitions) {
    fail("UNATTENDED_NO_RULE_REASON must be returned in approvalPhase and used nowhere else");
  }
  return out;
}

/**
 * Clauses (d) and (e), in run-ask: `standingRules:` and the `unattended` value are written once,
 * inside the private `newWorkflowWriteExecutor`, which only the two public builders call (once each).
 */
function d44RunAskPins(f: FileEntry, code: string): Violation[] {
  const out: Violation[] = [];
  const fail = (rule: string, what: string): void => {
    out.push({ rule, file: f.relPath, line: 1, snippet: what });
  };
  const maker = d41Span(code, /\bfunction\s+newWorkflowWriteExecutor\s*\(/, "\n}\n");
  const inSpan = (span: readonly [number, number] | undefined, at: number | undefined): boolean =>
    span !== undefined && at !== undefined && at >= span[0] && at < span[1];
  const writes = [...code.matchAll(/\bstandingRules\s*:/g)];
  if (writes.length !== 1 || !inSpan(maker, writes[0]?.index)) {
    fail(
      "standing-rules-dep-confined",
      "standingRules: must be written once, inside newWorkflowWriteExecutor",
    );
  }
  for (const m of code.matchAll(/\bunattended\b/g)) {
    if (!inSpan(maker, m.index)) {
      fail(
        "standing-unattended-confined",
        "the unattended option may be named only inside newWorkflowWriteExecutor",
      );
      break;
    }
  }
  const calls = [...code.matchAll(/(?<!function\s)\bnewWorkflowWriteExecutor\s*\(/g)];
  const attended = d41Span(code, /\bexport\s+function\s+buildWorkflowWriteExecutor\s*\(/, "\n}\n");
  const unattended = d41Span(
    code,
    /\bexport\s+function\s+buildUnattendedWorkflowWriteExecutor\s*\(/,
    "\n}\n",
  );
  const within = (span: readonly [number, number] | undefined): number =>
    calls.filter((c) => inSpan(span, c.index)).length;
  // The attended builder passes `false` and the unattended one `true`, literally.
  const passes = (span: readonly [number, number] | undefined, flag: string): boolean =>
    calls.some((c) => {
      if (!inSpan(span, c.index)) return false;
      // The statement ends at its `;` (the arguments may nest calls and span lines).
      const statementEnd = code.indexOf(";", c.index);
      return new RegExp(String.raw`,\s*${flag}\s*,?\s*\)\s*$`).test(
        code.slice(c.index, statementEnd),
      );
    });
  if (
    calls.length !== 2 ||
    within(attended) !== 1 ||
    within(unattended) !== 1 ||
    !passes(attended, "false") ||
    !passes(unattended, "true")
  ) {
    fail(
      "standing-rules-dep-confined",
      "newWorkflowWriteExecutor must be called exactly once by each of buildWorkflowWriteExecutor and buildUnattendedWorkflowWriteExecutor, and by nothing else",
    );
  }
  return out;
}

// ---- D36 (role-pack layer writers, I47) ----------------------------------------------------------
// A role-pack layer changes the owner's effective config, so I47 lets `packs/pack-install.ts` write
// one only after the LOCAL owner approved `pack.install` over the pack's exact `defaults` text. The
// store's write half — `setPackLayer` and `removePackLayer` — is named only by its definition
// (`packs/pack-layer-store.ts`) and that one gate module. Any other mention — a call, a destructured
// alias, an import of a re-export — is a violation. Comments and string literals are stripped
// first; test files and anything outside packages/gateway/src/ are not scanned. Stated bound, as
// D33(c): a dynamically composed call (`store["set" + "PackLayer"]`) evades a text scan, and a
// second call inside an allow-listed file is exempt whole-file; capability confinement (only the
// gate module is ever handed the store's write half in production) is the real defense.
const D36_WRITER_RE = /\b(?:setPackLayer|removePackLayer)\b/g;
const D36_WRITER_ALLOWED: readonly string[] = [
  "packages/gateway/src/packs/pack-layer-store.ts",
  "packages/gateway/src/packs/pack-install.ts",
];

export function checkPackLayerWriters(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D36_WRITER_ALLOWED.includes(f.relPath)) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const original = f.contents.split("\n");
    for (const m of code.matchAll(D36_WRITER_RE)) {
      const line = code.slice(0, m.index).split("\n").length;
      out.push({
        rule: "pack-layer-writers",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}
