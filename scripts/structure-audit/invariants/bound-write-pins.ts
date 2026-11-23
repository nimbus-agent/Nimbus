// Pin helpers shared by the model write door (D41), the IaC rules (D42, D43) and standing approvals (D44).

import type { FileEntry, Violation } from "./_shared.ts";

/** `[start, end)` of the method or function whose signature matches `sig` in `code`, or undefined. */
export function d41Span(
  code: string,
  sig: RegExp,
  close: string,
): readonly [number, number] | undefined {
  const at = code.search(sig);
  if (at === -1) return undefined;
  const end = code.indexOf(close, at);
  return [at, end === -1 ? code.length : end];
}

// ---- D42 (bound writes, I54, Phase 9.7 D0b) ------------------------------------------------------
// A BOUND connector write (a row that declares `bound`) is dispatched only with the values its own
// gate-run prepare step produced, injected by the gateway. Seven clauses keep that the only way in:
// (a) confinement of the spelling and the capability: the `.write.prepare` action-type literal only
//     in `engine/prepare-step.ts`; `injectBoundFields` and `runPrepareStep` only in that module and
//     `engine/executor.ts`; `isPrepareActionType` additionally in `connectors/registry.ts` (the
//     dispatcher guard); `isPrepareToolId` only in `connectors/connector-writes/prepare-tools.ts`,
//     the registry and `connectors/connector-write-registry.ts` (the one composed federation
//     predicate `isConnectorWriteOrPrepareToolId`, D1c; that file and that name only); `PREPARE_TOOL_IDS` only in prepare-tools.ts, `connectors/connector-writes/
//     types.ts` (the `withBound` default), the executor and the registry;
// (b) the order is pinned in `engine/executor.ts`: `resolveHitlApproval` calls `captureBeforePhase`,
//     then `preflightPhase` (D2: the refusals that must cost no child, before the prepare child
//     exists), then `preparePhase`, then `renderConfirmPhase`, then `approvalPhase` (a delegate can
//     never skip the prepare); `runPrepareStep(` is called once, in `preparePhase`; `injectBoundFields(`
//     once, in `dispatchBoundPhase`; and `execute` calls `gateWithin`, then `dispatchBoundPhase`,
//     then `connectors.dispatch`;
// (c) no production code replaces the write table: `writeTable`, `WriteTable` and `prepareToolIds`
//     are named only by the executor, the registry, `engine/prepare-step.ts`, prepare-tools.ts and
//     types.ts (test files, and a test-support `*.test-helpers.ts` that NO production file imports, are
//     exempt), no `new ToolExecutor(`
//     passes a ninth argument, no `createConnectorDispatcher(` options name `prepareToolIds` and no
//     `withBound(` passes a third argument;
// (d) `PREPARE_TOOL_IDS` is frozen (source pins on prepare-tools.ts: `Object.freeze(` and the three
//     throwing mutators) and nothing outside tests calls `.add(`, `.delete(` or `.clear(` on it;
// (e) the public `gate()` can never bind: it passes `{ bind: false }`, `execute()` passes
//     `{ bind: true }` (each once, in its own method), and `boundRefusal` tests `!scope.bind`
//     before it calls `boundInputRefusal(`;
// (f) a prepare action type is the step's own read: `prepareStep: true` is written once, in
//     `preparePhase`, and `runGateChecks` (the ordered checks `gateWithin` runs first) tests `isPrepareActionType(` together with
//     `scope.prepareStep` before it reaches `resolveHitlApproval(`, so a caller's `<svc>.write.prepare`
//     is refused whichever door sent it.
// (i) the read-only Terraform drift check (Phase 10 IaC drift D2, owner ruling OR-DRIFT-1) is the ONE
//     other caller of a prepare step: `runPrepareStep(` and `prepareStep: true` each appear once more,
//     inside `checkTerraformDrift`; `driftCheck: true` is written only in `engine/run-ask.ts` (inside
//     `buildIacDriftExecutor`) and in that method (the settle context); `buildIacDriftExecutor(` is
//     called only by `gateway-main.ts`, and `checkTerraformDrift(` only by `iac-drift/drift-runner.ts`.
//     The method never calls `injectBoundFields` or dispatches the apply (behavioural tests).
// (g) the unified diff an approver is shown is rendered only by the prepare step (D1c): the
//     `renderUnifiedDiff` name is confined to `engine/prepare-step.ts` and `connectors/connector-writes/
//     diff.ts` itself, so no other module can put a diff of its own making in front of an approver.
//     The executor only carries `prepared.diff` into the preview (a source pin on `withPrepared`).
// Comments and string literals are stripped before identifiers are matched; test files and anything
// outside packages/gateway/src/ are not scanned. STATED BOUND, as D33(c)/D41: a dynamically composed
// name evades a text scan, a second use inside an allow-listed file is exempt whole-file (the order
// pins narrow that for the executor), and an alias is not followed. The order pins are TEXTUAL: the
// behavioural tests are authoritative. The behaviour is pinned by
// `engine/executor-bound.test.ts`, `engine/prepare-step.test.ts` and `connectors/registry.test.ts`.
export const D42_EXECUTOR = "packages/gateway/src/engine/executor.ts";
/** D42(i): the drift check's own method, the one other caller of a prepare step. */
export const D42_DRIFT_SIG = /\basync\s+checkTerraformDrift\s*\(/;
export const D42_REGISTRY = "packages/gateway/src/connectors/registry.ts";

/** Clause (f): the prepare step's private gate scope, and the gate's refusal of a caller's prepare type. */
function d42PrepareScopePins(
  code: string,
  span: (sig: RegExp) => string,
  fail: (what: string) => void,
): void {
  const scoped = /\bprepareStep\s*:\s*true\b/g;
  const total = [...code.matchAll(scoped)].length;
  const within = [...span(/\bprivate\s+async\s+preparePhase\s*\(/).matchAll(scoped)].length;
  const drift = [...span(D42_DRIFT_SIG).matchAll(scoped)].length;
  if (total !== 2 || within !== 1 || drift !== 1) {
    fail(
      "prepareStep: true must be written twice: once in preparePhase, once in checkTerraformDrift",
    );
  }
  const gate = span(/\bprivate\s+async\s+runGateChecks\s*\(/);
  const refusal = gate.search(/\bisPrepareActionType\s*\([^)]*\)\s*&&\s*scope\.prepareStep\b/);
  const hitl = gate.search(/\bthis\.resolveHitlApproval\s*\(/);
  if (refusal === -1 || hitl === -1 || refusal > hitl) {
    fail(
      "runGateChecks must refuse a prepare type unless scope.prepareStep, before resolveHitlApproval",
    );
  }
}

/** Clauses (b), (e) and (f): the phase order, the single injection site and the public gate's refusal. */
export function d42ExecutorPins(f: FileEntry, code: string): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "bound-order-pinned", file: f.relPath, line: 1, snippet: what });
  };
  const span = (sig: RegExp): string => {
    const s = d41Span(code, sig, "\n  }\n");
    return s === undefined ? "" : code.slice(s[0], s[1]);
  };
  const resolve = span(/\bprivate\s+async\s+resolveHitlApproval\s*\(/);
  const at = (needle: string): number => resolve.indexOf(needle);
  const phases = [
    at("this.captureBeforePhase("),
    at("this.preflightPhase("),
    at("this.preparePhase("),
    at("this.renderConfirmPhase("),
    at("this.approvalPhase("),
  ];
  if (phases.some((p, i) => p === -1 || (i > 0 && p < (phases[i - 1] ?? 0)))) {
    fail(
      "resolveHitlApproval must call captureBeforePhase, preflightPhase, preparePhase, renderConfirmPhase, approvalPhase in that order",
    );
  }
  const once = (needle: RegExp, inside: string, what: string): void => {
    const total = [...code.matchAll(needle)].length;
    const within = [...inside.matchAll(needle)].length;
    if (total !== 1 || within !== 1) fail(what);
  };
  // (b) and (i): the prepare step runs in preparePhase and, for the drift check alone, in checkTerraformDrift.
  const prepareCalls = /\brunPrepareStep\s*\(/g;
  if (
    [...code.matchAll(prepareCalls)].length !== 2 ||
    [...span(/\bprivate\s+async\s+preparePhase\s*\(/).matchAll(prepareCalls)].length !== 1 ||
    [...span(D42_DRIFT_SIG).matchAll(prepareCalls)].length !== 1
  ) {
    fail("runPrepareStep must be called twice: once in preparePhase, once in checkTerraformDrift");
  }
  once(
    /\binjectBoundFields\s*\(/g,
    span(/\bprivate\s+dispatchBoundPhase\s*\(/),
    "injectBoundFields must be called once, in dispatchBoundPhase",
  );
  const exec = span(/\basync\s+execute\s*\(/);
  const g = exec.indexOf("this.gateWithin(");
  const b = exec.indexOf("this.dispatchBoundPhase(");
  const d = exec.indexOf("this.connectors.dispatch(");
  if (g === -1 || b === -1 || d === -1 || !(g < b && b < d)) {
    fail("execute must call gateWithin, then dispatchBoundPhase, then connectors.dispatch");
  }
  const noBind = (code.match(/\{\s*bind\s*:\s*false\s*\}/g) ?? []).length;
  const yesBind = (code.match(/\{\s*bind\s*:\s*true\s*\}/g) ?? []).length;
  const gate = span(/\basync\s+gate\s*\(/);
  if (
    noBind !== 1 ||
    yesBind !== 1 ||
    !/\{\s*bind\s*:\s*false\s*\}/.test(gate) ||
    !/\{\s*bind\s*:\s*true\s*\}/.test(exec)
  ) {
    out.push({
      rule: "bound-public-gate-refuses",
      file: f.relPath,
      line: 1,
      snippet: "gate() must pass { bind: false } and execute() { bind: true }, once each",
    });
  }
  d42PrepareScopePins(code, span, fail);
  // Clause (g): the diff the approver is shown is the prepare step's own, carried unchanged.
  const carry = d41Span(code, /\bfunction\s+withPrepared\s*\(/, "\n}\n");
  const carried = carry === undefined ? "" : code.slice(carry[0], carry[1]);
  if (!/\bdiff\s*:\s*prepared\.diff\b/.test(carried)) {
    fail("withPrepared must carry only prepared.diff into the preview");
  }
  const refusal = span(/\bprivate\s+boundRefusal\s*\(/);
  const guard = refusal.search(/!\s*scope\.bind\b/);
  const input = refusal.search(/\bboundInputRefusal\s*\(/);
  if (guard === -1 || input === -1 || guard > input) {
    out.push({
      rule: "bound-public-gate-refuses",
      file: f.relPath,
      line: 1,
      snippet: "boundRefusal must test !scope.bind before it calls boundInputRefusal",
    });
  }
  return out;
}

/** Clause (b): the discard happens only at the end of a run that never dispatched, in a private scope. */
export function d43ExecutorPins(f: FileEntry, code: string, commentFree: string): Violation[] {
  const out: Violation[] = [];
  const fail = (what: string): void => {
    out.push({ rule: "discard-order-pinned", file: f.relPath, line: 1, snippet: what });
  };
  const span = (sig: RegExp): string => {
    const s = d41Span(code, sig, "\n  }\n");
    return s === undefined ? "" : code.slice(s[0], s[1]);
  };
  const count = (src: string, re: RegExp): number => [...src.matchAll(re)].length;
  const discarding = span(/\bprivate\s+async\s+discardUnusedChangeSet\s*\(/);
  const scopeKey = /\bdiscardStep\s*:/g;
  if (count(code, scopeKey) !== 1 || count(discarding, scopeKey) !== 1) {
    fail("discardStep: must be written once, in discardUnusedChangeSet");
  }
  // The scope member may be WRITTEN in no other form: shorthand, a member assignment, `Object.assign`
  // or a computed/quoted key would each set it without the `discardStep:` this rule counts.
  for (const re of [
    /[{,]\s*discardStep\s*[,}]/,
    /\.discardStep\s*=(?!=)/,
    /\bObject\s*\.\s*(?:assign|defineProperty|fromEntries)\b[^;]*discardStep/,
    /\[\s*["'`]discardStep["'`]\s*\]/,
    /["'`]discardStep["'`]\s*:/,
  ]) {
    if (re.test(commentFree))
      fail(`discardStep set by a form the rule does not count: ${re.source}`);
  }
  // `dispatched` only ever becomes true, once: a reset would let a discard follow a dispatch.
  if (
    count(code, /\bdispatched\s*=\s*false\b/g) !== 0 ||
    count(code, /\bdispatched\s*=\s*true\b/g) !== 1
  ) {
    fail("dispatched must never be assigned false and assigned true exactly once");
  }
  const finish = span(/\bprivate\s+async\s+finishScope\s*\(/);
  const caller = /\bthis\.discardUnusedChangeSet\s*\(/g;
  if (
    count(code, caller) !== 1 ||
    !/\bif\s*\(\s*!dispatched\s*\)\s*await\s+this\.discardUnusedChangeSet\s*\(/.test(finish)
  ) {
    fail("discardUnusedChangeSet must be called once, in finishScope, under if (!dispatched)");
  }
  const exec = span(/\basync\s+execute\s*\(/);
  const set = exec.search(/\bdispatched\s*=\s*true\b/);
  const send = exec.indexOf("this.connectors.dispatch(");
  const fin = exec.search(/\bfinally\s*\{[^}]*this\.finishScope\s*\(/);
  if (set === -1 || send === -1 || fin === -1 || !(set < send && send < fin)) {
    fail(
      "execute must set dispatched = true before connectors.dispatch, and call finishScope in finally",
    );
  }
  const checks = span(/\bprivate\s+async\s+runGateChecks\s*\(/);
  const branch = checks.search(/\brequiresHITL\s*&&\s*scope\.discardStep\s*!==\s*undefined\b/);
  const verify = checks.search(/\bisDiscardOf\s*\(/);
  const prompt = checks.search(/\bthis\.resolveHitlApproval\s*\(/);
  if (branch === -1 || verify === -1 || prompt === -1 || !(branch < verify && verify < prompt)) {
    fail(
      "runGateChecks must reach the no-prompt discard only under scope.discardStep, after isDiscardOf, before resolveHitlApproval",
    );
  }
  return out;
}
