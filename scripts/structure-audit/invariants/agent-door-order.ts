// Static invariant rules: the agent door check order (D49).
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import { D49_SRC } from "./agent-door.ts";
import { lineOfOffset } from "./policy-chatops-writes.ts";
import { escapeRegex } from "./spawn-vault-db-identity.ts";

/**
 * The span `[start, end)` of the body of `function <name>(...) {...}` in `code` (strings and
 * comments already blanked, so a brace inside either cannot desync the depth), or `undefined`. Angle
 * brackets of the return type are skipped so an object type in it is not taken for the body.
 */
function d49FunctionBody(code: string, name: string): { start: number; end: number } | undefined {
  const decl = new RegExp(String.raw`\bfunction\s+${name}\s*[(<]`).exec(code);
  if (decl === null) return undefined;
  let i = code.indexOf("(", decl.index);
  let depth = 0;
  for (; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) break;
  }
  let angle = 0;
  let start = -1;
  for (i += 1; i < code.length; i++) {
    const c = code[i];
    if (c === "<") angle++;
    else if (c === ">" && code[i - 1] !== "=") angle = Math.max(0, angle - 1);
    else if (c === "{" && angle === 0) {
      start = i;
      break;
    }
  }
  if (start < 0) return undefined;
  depth = 0;
  for (i = start; i < code.length; i++) {
    if (code[i] === "{") depth++;
    else if (code[i] === "}" && --depth === 0) return { start, end: i + 1 };
  }
  return undefined;
}

/** The offsets of the `(` and the matching `)` of the first `call` (which ends in `(`) in `code`. */
function d49CallArgs(code: string, call: string): { open: number; close: number } | undefined {
  const at = code.indexOf(call);
  if (at < 0) return undefined;
  const open = at + call.length - 1;
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    if (code[i] === "(") depth++;
    else if (code[i] === ")" && --depth === 0) return { open, close: i };
  }
  return undefined;
}

const D49_RULE_ORDER = "agent-door-check-order";

/**
 * True when `body` INVOKES `dep` (`dep(` or `dep?.(`), directly or through a local alias of it
 * (`const verify = dep;` then `verify(` or `verify?.(`). A bare reference is not a call.
 */
function d49CallsDep(body: string, dep: string): boolean {
  const call = String.raw`\s*(?:\?\.)?\(`;
  if (new RegExp(escapeRegex(dep) + call).test(body)) return true;
  const alias = new RegExp(
    String.raw`(?:const|let)\s+([\w$]+)\s*=\s*${escapeRegex(dep)}\s*[;\n]`,
    "g",
  );
  for (const m of body.matchAll(alias)) {
    const name = m[1];
    if (
      name !== undefined &&
      new RegExp(String.raw`(?<![\w$.])` + escapeRegex(name) + call).test(body)
    ) {
      return true;
    }
  }
  return false;
}

/** One ordered site: every `before` marker is in `fn`'s body and precedes `after`; helpers read their dep. */
function d49OrderSite(
  file: FileEntry | undefined,
  path: string,
  fn: string,
  before: readonly string[],
  after: string,
  helpers: ReadonlyArray<readonly [string, string]>,
): Violation[] {
  const out: Violation[] = [];
  const miss = (why: string): Violation => ({
    rule: D49_RULE_ORDER,
    file: path,
    line: 1,
    snippet: why,
  });
  if (file === undefined) return [miss(`${path} is not scanned`)];
  const code = stripStringLiterals(stripComments(file.contents));
  const span = d49FunctionBody(code, fn);
  if (span === undefined) return [miss(`function ${fn} not found`)];
  const body = code.slice(span.start, span.end);
  const iAfter = body.indexOf(after);
  if (iAfter < 0) out.push(miss(`${fn} no longer calls ${after}`));
  for (const marker of before) {
    const i = body.indexOf(marker);
    const where = {
      rule: D49_RULE_ORDER,
      file: path,
      line: lineOfOffset(code, span.start + Math.max(i, 0)),
    };
    if (i < 0) out.push({ ...where, snippet: `${fn} no longer calls ${marker}` });
    else if (iAfter >= 0 && i > iAfter) {
      out.push({ ...where, snippet: `${marker} must come before ${after} in ${fn}` });
    }
  }
  for (const [helper, dep] of helpers) {
    const hs = d49FunctionBody(code, helper);
    if (hs === undefined || !d49CallsDep(code.slice(hs.start, hs.end), dep)) {
      out.push(miss(`${helper} must call ${dep}`));
    }
  }
  return out;
}

/** `buildActDeps`: the consent channel is `vetoingConsent(...)` and the executor's consent argument. */
function d49VetoSite(file: FileEntry | undefined, path: string): Violation[] {
  if (file === undefined) {
    return [{ rule: D49_RULE_ORDER, file: path, line: 1, snippet: `${path} is not scanned` }];
  }
  const code = stripStringLiterals(stripComments(file.contents));
  const span = d49FunctionBody(code, "buildActDeps");
  const at = (snippet: string): Violation => ({
    rule: D49_RULE_ORDER,
    file: path,
    line: lineOfOffset(code, span?.start ?? 0),
    snippet,
  });
  if (span === undefined) return [at("function buildActDeps not found")];
  const body = code.slice(span.start, span.end);
  const builder = d49CallArgs(body, "buildAgentWriteExecutor(");
  if (builder === undefined) return [at("buildActDeps no longer calls buildAgentWriteExecutor(")];
  // The variable the executor receives as its consent argument ...
  const arg = /consentCoordinator\s*:\s*([\w$]+)/.exec(body.slice(builder.open, builder.close));
  if (arg?.[1] === undefined) return [at("the executor must be given a consentCoordinator")];
  // ... must be declared with `const` (a `let` could be reassigned before the executor reads it)
  // before the executor is built, and `vetoingConsent(` must sit INSIDE its initializer expression (a bare call elsewhere wraps nothing).
  const decl = new RegExp(String.raw`\bconst\s+${escapeRegex(arg[1])}\s*=`).exec(body);
  if (decl === null || decl.index > builder.open) {
    return [
      at(
        "the executor's consentCoordinator must be a channel built before it, with vetoingConsent(",
      ),
    ];
  }
  const init = d49Initializer(body, decl.index + decl[0].length);
  if (!body.slice(init.start, init.end).includes("vetoingConsent(")) {
    return [at("the executor's consentCoordinator must be initialised with vetoingConsent(")];
  }
  return [];
}

/** The span of the expression that starts at `from`: up to the first `;` at bracket depth 0. */
function d49Initializer(code: string, from: number): { start: number; end: number } {
  let depth = 0;
  for (let i = from; i < code.length; i++) {
    const c = code[i];
    if (c === "(" || c === "[" || c === "{") depth++;
    else if (c === ")" || c === "]" || c === "}") depth--;
    else if (c === ";" && depth === 0) return { start: from, end: i };
  }
  return { start: from, end: code.length };
}

export function checkAgentDoorCheckOrder(files: readonly FileEntry[]): Violation[] {
  const byPath = new Map(files.map((f) => [f.relPath, f]));
  const rpc = `${D49_SRC}ipc/capture-rpc.ts`;
  const act = `${D49_SRC}mcp-sink/capture-act.ts`;
  const gate = `${D49_SRC}mcp-sink/capture-gate.ts`;
  return [
    ...d49VetoSite(byPath.get(rpc), rpc),
    ...d49OrderSite(
      byPath.get(act),
      act,
      "acceptAction",
      ["requireVerdictAtApproval(", "requireDefinitionAtApproval("],
      "claimAction(",
      [
        ["requireVerdictAtApproval", "deps.classifyAction"],
        ["requireDefinitionAtApproval", "deps.verifyActionDefinition"],
      ],
    ),
    ...d49OrderSite(
      byPath.get(gate),
      gate,
      "submitCapture",
      ["deps.classifyAction", "requireDefinitionVerified("],
      "writeSubmittedCapture(",
      [["requireDefinitionVerified", "ctx.deps.verifyActionDefinition"]],
    ),
  ];
}
