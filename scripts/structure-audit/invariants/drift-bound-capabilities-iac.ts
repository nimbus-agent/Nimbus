// Static invariant rules: the drift check, bound capabilities, write-dir declaration and the IaC discard.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import {
  D42_DRIFT_SIG,
  D42_EXECUTOR,
  D42_REGISTRY,
  d41Span,
  d43ExecutorPins,
} from "./bound-write-pins.ts";
import { lineOfOffset } from "./policy-chatops-writes.ts";

// ---- D42(h) (the bound IaC capabilities, I54, Phase 9.7 D2) --------------------------------------
// The runtime capabilities of a bound IaC row (its settle step and its preflight) reach the gate only
// through the dispatcher's `boundWriteCapabilities` member (the production `ToolExecutor` keeps its
// constructor, D42(c)). Two pins keep that the only way in:
// (h1) the member `boundWriteCapabilities` is named only by `engine/executor.ts` (the reader),
//      `engine/types.ts` (the interface member) and `connectors/registry.ts` (the one place the
//      production dispatcher sets it), and a `BoundWriteCapabilities` VALUE is built (a typed
//      initialiser, a return type, `implements`, `as`/`satisfies`) only in `connectors/registry.ts`;
// (h2) in the executor the member is read exactly three times, once each in `preflightPhase`,
//      `preparePhase` and `checkTerraformDrift` (D42(i)); `.preflight(` is called only in the first and
//      the third and `.settle(` only in the second and the third, so no other phase or method can
//      reach a capability.
// Comments and string literals are stripped; test files are not scanned. STATED BOUND, as D42: a
// dynamically composed name or an alias evades a text scan; the behavioural tests are authoritative.
const D42H_PROP_RE = /\bboundWriteCapabilities\b/g;
const D42H_TYPES = "packages/gateway/src/engine/types.ts";
const D42H_PROP_ALLOWED: readonly string[] = [D42_EXECUTOR, D42H_TYPES, D42_REGISTRY];
// (h3) the Kubernetes settler (D3a) is named only by its own module and the registry, which reaches
// it through the capability's `settle`: no other production file can settle a plan on its own.
const D42H_K8S_SETTLER_RE = /\bsettleK8sManifest\b/g;
const D42H_K8S_SETTLER_ALLOWED: readonly string[] = [
  "packages/gateway/src/engine/k8s-settle.ts",
  D42_REGISTRY,
];
const D42H_BUILD_RE =
  /:\s*BoundWriteCapabilities(?:\s*\|\s*undefined)?\s*(?:=|\{)|\bimplements\s+BoundWriteCapabilities\b|\b(?:as|satisfies)\s+BoundWriteCapabilities\b/g;

const D42I_RUN_ASK = "packages/gateway/src/engine/run-ask.ts";
const D42I_GATEWAY_MAIN = "packages/gateway/src/gateway-main.ts";
const D42I_RUNNER = "packages/gateway/src/iac-drift/drift-runner.ts";
const D42I_FLAG_RE = /\bdriftCheck\s*:\s*true\b/g;
const D42I_BUILD_CALL_RE = /\bbuildIacDriftExecutor\s*\(/g;
const D42I_METHOD_CALL_RE = /\.checkTerraformDrift\s*\(/g;
// D42(k) (OR-S4-ACCEPT-DRIFT): the owner's accept-drift executor. Built only in run-ask.ts and called only by
// gateway-main.ts, which hands it a HUMAN-ONLY consent coordinator in that very call; its body carries none of
// the machinery that would let anything but a person approve or that would change what it runs.
const D42K_BUILD_CALL_RE = /\bbuildIacAcceptExecutor\s*\(/g;
const D42K_DEF_RE = /\bexport\s+function\s+buildIacAcceptExecutor\s*\(/;
const D42K_BODY_FORBIDDEN_RE =
  /\b(?:standingRules|beforeState|driftCheck|dryRun|unattended|NEVER_ASKED_CONSENT|delegation)\b/;
/** How far after a call's name its human-only argument must appear (the call is about 10 lines). */
const D42K_CALL_WINDOW = 600;

/**
 * D42(i): the drift check's flag is written only inside `buildIacDriftExecutor` (run-ask.ts) and inside
 * `checkTerraformDrift` (executor.ts, the settle context); the builder is called only by gateway-main.ts;
 * the method only by the drift runner. Comments and string literals are stripped; tests are not scanned.
 */
export function checkDriftCheckConfined(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    const add = (index: number | undefined): void => {
      const line = code.slice(0, index ?? 0).split("\n").length;
      out.push({
        rule: "bound-drift-confined",
        file: f.relPath,
        line,
        snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
      });
    };
    const inside = (index: number | undefined, s: readonly [number, number] | undefined): boolean =>
      s !== undefined && index !== undefined && index >= s[0] && index < s[1];
    // Each span ends at its own closing brace: a top-level function in run-ask.ts ("\n}\n"), a class
    // method in the executor ("\n  }\n"), so a later sibling cannot ride inside the allowed span.
    let flagSpan: readonly [number, number] | undefined;
    if (f.relPath === D42I_RUN_ASK) {
      flagSpan = d41Span(code, /\bexport\s+function\s+buildIacDriftExecutor\s*\(/, "\n}\n");
    }
    if (f.relPath === D42_EXECUTOR) flagSpan = d41Span(code, D42_DRIFT_SIG, "\n  }\n");
    for (const m of code.matchAll(D42I_FLAG_RE)) if (!inside(m.index, flagSpan)) add(m.index);
    if (f.relPath !== D42I_GATEWAY_MAIN && f.relPath !== D42I_RUN_ASK) {
      for (const m of code.matchAll(D42I_BUILD_CALL_RE)) add(m.index);
    }
    if (f.relPath === D42I_RUN_ASK) {
      // The definition is the one occurrence allowed here; any other is a call.
      const n = [...code.matchAll(D42I_BUILD_CALL_RE)];
      for (const m of n.slice(1)) add(m.index);
    }
    if (f.relPath !== D42I_RUNNER) {
      for (const m of code.matchAll(D42I_METHOD_CALL_RE)) add(m.index);
    }
    // D42(k).
    const builds = [...code.matchAll(D42K_BUILD_CALL_RE)];
    if (f.relPath === D42I_RUN_ASK) {
      for (const m of builds.slice(1)) add(m.index);
      const s = d41Span(code, D42K_DEF_RE, "\n}\n");
      // A missing definition confines nothing (a call to it would not compile); a present one is pinned.
      const body = s === undefined ? "" : code.slice(s[0], s[1]);
      if (
        s !== undefined &&
        (D42K_BODY_FORBIDDEN_RE.test(body) || !body.includes("bindConsentChannel("))
      ) {
        add(s[0]);
      }
    } else if (f.relPath === D42I_GATEWAY_MAIN) {
      for (const m of builds) {
        const call = code.slice(m.index ?? 0, (m.index ?? 0) + D42K_CALL_WINDOW);
        if (!call.includes("humanOnlyConsent(")) add(m.index);
      }
    } else {
      for (const m of builds) add(m.index);
    }
  }
  return out;
}

export function checkBoundCapabilities(files: readonly FileEntry[]): Violation[] {
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
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const code = stripStringLiterals(stripComments(f.contents));
    if (!D42H_PROP_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D42H_PROP_RE))
        add(f, "bound-capability-confined", code, m.index);
    }
    if (f.relPath !== D42_REGISTRY) {
      for (const m of code.matchAll(D42H_BUILD_RE))
        add(f, "bound-capability-confined", code, m.index);
    }
    if (!D42H_K8S_SETTLER_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D42H_K8S_SETTLER_RE))
        add(f, "bound-capability-confined", code, m.index);
    }
    if (f.relPath !== D42_EXECUTOR) continue;
    const span = (sig: RegExp): string => {
      const s = d41Span(code, sig, "\n  }\n");
      return s === undefined ? "" : code.slice(s[0], s[1]);
    };
    const preflight = span(/\bprivate\s+async\s+preflightPhase\s*\(/);
    const prepare = span(/\bprivate\s+async\s+preparePhase\s*\(/);
    const drift = span(D42_DRIFT_SIG);
    const reads = (src: string): number => [...src.matchAll(D42H_PROP_RE)].length;
    const calls = (src: string, name: string): number =>
      [...src.matchAll(new RegExp(`\\.${name}\\s*\\(`, "g"))].length;
    const fail = (what: string): void => {
      out.push({ rule: "bound-capability-calls", file: f.relPath, line: 1, snippet: what });
    };
    if (reads(code) !== 3 || reads(preflight) !== 1 || reads(prepare) !== 1 || reads(drift) !== 1) {
      fail(
        "boundWriteCapabilities must be read once each in preflightPhase, preparePhase and checkTerraformDrift",
      );
    }
    if (
      calls(code, "preflight") !== 2 ||
      calls(preflight, "preflight") !== 1 ||
      calls(drift, "preflight") !== 1
    ) {
      fail(
        "a capability's preflight must be called once in preflightPhase and once in checkTerraformDrift",
      );
    }
    if (
      calls(code, "settle") !== 2 ||
      calls(prepare, "settle") !== 1 ||
      calls(drift, "settle") !== 1
    ) {
      fail(
        "a capability's settle must be called once in preparePhase and once in checkTerraformDrift",
      );
    }
  }
  return out;
}

// ---- D43 (the gateway-internal discard of an unused change set, I2's one stated exception) -------
// A CloudFormation deploy's prepare step CREATES a change set. When the owner then declines, mistypes
// or times out, the gateway removes what it made. `iac_cloudformation_changeset_discard` is a connector
// WRITE and its action type is in I2's frozen set, so the public gate still prompts for it; the only
// way it runs without a prompt is the executor's own `discardUnusedChangeSet`, in a private gate scope
// that names the one change set the same run's settle bound. Three clauses keep that exemption narrow:
// (a) `discardStep` (the scope member) is named only by `engine/executor.ts`;
// (b) in the executor: `discardStep:` is written once, in `discardUnusedChangeSet`; that method is
//     called once, in `finishScope`, under `if (!dispatched)`; `execute` sets `dispatched = true`
//     BEFORE `this.connectors.dispatch(` (so a dispatch error is never followed by a discard) and
//     calls `finishScope(` in its `finally`; and `runGateChecks` reaches the no-prompt branch only
//     under `scope.discardStep !== undefined`, after `isDiscardOf(` and before
//     `this.resolveHitlApproval(`;
// (c) the tool id, the action type and the `IAC_DISCARD` constant are named only by the row table
//     (`cloud-infra.ts`, `iac-limits.ts`), the executor (frozen set, the discard step), the registry
//     (the dispatcher pin), `manifest.generated.ts`, the model-offerable
//     never-offered table and the iac runner's routing table.
// Clause (d) (only `lazy-mesh/iac-runner.ts` builds an iac or kubernetes `ServerSpec`, and only
// through `wrapIacServerSpec`; D3a added the kubernetes `kube` profile to it) is below. Comments are stripped (strings kept for (c));
// test files are not scanned. The behaviour is pinned by `engine/executor-iac-discard.test.ts`.
const D43_BASE = "packages/gateway/src/connectors/";
const D43_NAME_RE = /iac_cloudformation_changeset_discard|iac\.cloudformation\.changeset\.discard/g;
const D43_NAME_ALLOWED: readonly string[] = [
  `${D43_BASE}connector-writes/cloud-infra.ts`,
  `${D43_BASE}connector-writes/iac-limits.ts`,
  `${D43_BASE}connector-writes/manifest.generated.ts`,
  `${D43_BASE}connector-writes/model-offerable.ts`,
  `${D43_BASE}lazy-mesh/iac-runner.ts`,
  D42_EXECUTOR,
];
const D43_CONSTANT_RE = /\bIAC_DISCARD\b/g;
// Clause (d) (the iac and kubernetes connectors' per-run spawns): only `lazy-mesh/iac-runner.ts`
// builds an iac or kubernetes `ServerSpec`, and only through `wrapIacServerSpec` (defined in
// `wrap-server-spec.ts`; the kubernetes listing slot in `connector-spawns.ts` keeps `wrapServerSpec`,
// no network, and so a second file wrapping `connectorSpawn("kubernetes")` with the flag is a
// `wrapIacServerSpec` violation); the routing table of the nine kubernetes tools
// (`KUBE_TOOL_PROFILE`) is named only by the runner; the policy
// flag `iacProfile` and the seccomp program that answers `pidfd_send_signal` with ENOSYS (OR-D2-5)
// are named only by the policy wire, the wrapper, the Linux runner and the wrap function.
const D43_SPAWN_BASE = "packages/gateway/src/";
const D43_RUNNER = `${D43_BASE}lazy-mesh/iac-runner.ts`;
const D43_WRAP = `${D43_BASE}lazy-mesh/wrap-server-spec.ts`;
const D43_SPAWN_RULES: ReadonlyArray<{
  readonly re: RegExp;
  readonly allowed: readonly string[];
  /** Match against comment-stripped source with strings kept (a string spelling is a spelling). */
  readonly keepStrings: boolean;
}> = [
  { re: /\bwrapIacServerSpec\b/g, allowed: [D43_WRAP, D43_RUNNER], keepStrings: false },
  {
    re: /\biacProfile\b/g,
    allowed: [
      D43_WRAP,
      `${D43_SPAWN_BASE}platform/sandbox/sandbox-policy.ts`,
      `${D43_SPAWN_BASE}platform/sandbox/sandbox-wrapper.ts`,
      `${D43_SPAWN_BASE}platform/sandbox/linux.ts`,
    ],
    keepStrings: true,
  },
  {
    re: /\b(?:buildIacSeccompFilter|IAC_ENOSYS_SYSCALLS)\b/g,
    allowed: [
      `${D43_SPAWN_BASE}platform/sandbox/seccomp-filter.ts`,
      `${D43_SPAWN_BASE}platform/sandbox/linux.ts`,
    ],
    keepStrings: false,
  },
  { re: /com\.nimbus\.iac-/g, allowed: [D43_RUNNER], keepStrings: true },
  { re: /\bKUBE_TOOL_PROFILE\b/g, allowed: [D43_RUNNER], keepStrings: false },
];
const D43_CONSTANT_ALLOWED: readonly string[] = [
  `${D43_BASE}connector-writes/iac-limits.ts`,
  D42_EXECUTOR,
  D42_REGISTRY,
];

// ---- D10 `user-write` (a declared write DIRECTORY, I15; Phase 28 AD5b) ---------------------------
// A sandbox policy may declare a directory the child writes beneath (`canonicalWriteDirs`). The
// field is named only by the manifest type, the policy wire and the two checks that read it, so no
// connector, IPC handler or engine file can build a policy that carries one. The ONE `connectors/`
// file on the list is the builder of a user MCP write grant
// (`connectors/lazy-mesh/user-mcp-write-grant.ts`, AD5b-2): every other producer is a violation.
// Strings are kept: a string spelling of the field (a computed key) is a spelling.
// Stated bound: textual. A name composed at run time evades it; the real-sandbox tests are the
// authority on what a policy can do.
const D10_WRITE_DIR_RE = /\bcanonicalWriteDirs\b/g;
const D10_WRITE_DIR_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/manifest.ts",
  "packages/gateway/src/platform/sandbox/sandbox-policy.ts",
  "packages/gateway/src/platform/sandbox/canonical-path.ts",
  "packages/gateway/src/platform/sandbox/write-grant-check.ts",
  "packages/gateway/src/connectors/lazy-mesh/user-mcp-write-grant.ts",
];

export function checkWriteDirDeclarationConfined(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D10_WRITE_DIR_ALLOWED.includes(f.relPath)) continue;
    const commentFree = stripComments(f.contents);
    const original = f.contents.split("\n");
    for (const m of commentFree.matchAll(D10_WRITE_DIR_RE)) {
      const line = lineOfOffset(commentFree, m.index);
      out.push({
        rule: "D10-user-write",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

export function checkIacDiscard(files: readonly FileEntry[]): Violation[] {
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
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (f.relPath !== D42_EXECUTOR) {
      for (const m of code.matchAll(/\bdiscardStep\b/g)) {
        add(f, "discard-step-confined", code, m.index);
      }
    }
    if (!D43_NAME_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D43_NAME_RE)) {
        add(f, "discard-name-confined", commentFree, m.index);
      }
    }
    if (!D43_CONSTANT_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D43_CONSTANT_RE)) {
        add(f, "discard-name-confined", commentFree, m.index);
      }
    }
    for (const rule of D43_SPAWN_RULES) {
      if (rule.allowed.includes(f.relPath)) continue;
      const src = rule.keepStrings ? commentFree : code;
      for (const m of src.matchAll(rule.re)) add(f, "iac-spawn-confined", src, m.index);
    }
    if (f.relPath === D42_EXECUTOR) {
      for (const v of d43ExecutorPins(f, code, commentFree)) out.push(v);
    }
  }
  return out;
}
