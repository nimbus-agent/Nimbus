// Static invariant rules: the agent door: window retired, origin writer and comparison, user MCP facts and reach.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import { lineOfOffset } from "./policy-chatops-writes.ts";

// ---- D49 (a), (c), (d), (e), (f): the agent door's enforcement (Phase 28 AD3a-2a, invariant I58) ---
// (a) The deprecation window's names are GONE (AD3b), and the door is built once. The retired names
//     (`ACTION_PROPOSABILITY`, `classifyActionType`, `proposableWriteTool`, `PROPOSABLE_WRITE_TOOLS`,
//     `actDoorRefusal`, `createActionDestinationRefusal`, `agentDoorLegacy`, `legacyActionTypesSince`,
//     `isLegacyBasis`) appear in NO production source file, so nothing can consult a table other than
//     the write table and the owner's list again; and `createAgentDoor` only in its module and
//     `platform/assemble.ts`, so a second door built over other facts cannot appear.
// (c) `origin: "agent"` is written only by `ipc/capture-rpc.ts` `buildActDeps`, the one place that
//     holds the accepting session's consent channel; a `proposer:` property only there and in the
//     two files that declare or project it (`engine/types.ts`, and `engine/executor.ts`'s audit
//     projection, which copies two fields out and sets no origin).
// (d) An action's `origin` is compared with a literal ("agent" or "model") only in
//     `engine/outside-origin.ts`; every other site asks `isOutsideOrigin` / `isAgentOrigin`.
// (e) The order of the three check points, read from the real sites (each an ordered list of named
//     steps): in `buildActDeps` the consent channel is built with `vetoingConsent(...)` and is the
//     executor's consent argument; in `acceptAction` the verdict step and the definition step both
//     come before `claimAction(`; in `submitCapture` the verdict and the definition step both come
//     before `writeSubmittedCapture(`; and each helper reads the injected dependency it is named for.
// (f) (retired in AD3b with the capture `legacy` flag; its names are covered by (a).)
// (g) The user-MCP call facts (Phase 28 AD5a, I42): the `userMcpCall` property of a planned action
//     (what the owner's prompt shows about third-party code) is written only by `ipc/capture-rpc.ts`
//     `buildActDeps`, from the agent door's own read, and named besides only by the file that declares
//     it (`engine/types.ts`), the two that read it (`engine/executor.ts`, `engine/user-mcp-call-block.ts`).
//     No other site may put facts on an action, so the prompt cannot be made to show a description the
//     definition check did not hash.
// (h) The agent door's reach into user-registered servers (AD5a): `listUserMcpToolDefinitions` (the
//     stripped listing that STARTS a third-party server) is named only by the mesh that defines it, the
//     assembly that wires the door's check, and the connector RPC that wires the owner's enable and
//     status; and `removeDoorApprovals` (what ends an agent approval with its registration) only by its
//     store, the disable handler and the two registration handlers (remove and add).
// Same stated bound as D32(a): a dynamically composed identifier evades a text scan; the behavioural
// tests under I58 and I42 are authoritative. Test files (and `.test-helpers.ts`) are not scanned.
export const D49_SRC = "packages/gateway/src/";
const D49_RETIRED_NAMES_RE =
  /\b(?:ACTION_PROPOSABILITY|classifyActionType|proposableWriteTool|PROPOSABLE_WRITE_TOOLS|actDoorRefusal|createActionDestinationRefusal|agentDoorLegacy|legacyActionTypesSince|isLegacyBasis|legacy_unapproved|legacy_mail_send|legacy_user_mcp)\b/g;
const D49_RETIRED_NAMES_ALLOWED: readonly string[] = [];
const D49_BUILD_DOOR_RE = /\bcreateAgentDoor\b/g;
const D49_BUILD_DOOR_ALLOWED: readonly string[] = [
  `${D49_SRC}connectors/connector-writes/agent-door-runtime.ts`,
  `${D49_SRC}platform/assemble.ts`,
];
const D49_AGENT_ORIGIN_RE = /\borigin\s*:\s*["']agent["']/g;
const D49_AGENT_ORIGIN_ALLOWED: readonly string[] = [`${D49_SRC}ipc/capture-rpc.ts`];
const D49_PROPOSER_PROP_RE = /\bproposer\s*\??\s*:/g;
const D49_PROPOSER_PROP_ALLOWED: readonly string[] = [
  `${D49_SRC}ipc/capture-rpc.ts`,
  `${D49_SRC}engine/types.ts`,
  `${D49_SRC}engine/executor.ts`,
];
const D49_ORIGIN_COMPARE_RE =
  /\borigin\s*[!=]==?\s*["'](?:agent|model)["']|["'](?:agent|model)["']\s*[!=]==?\s*[\w.?]*\borigin\b/g;
const D49_ORIGIN_COMPARE_ALLOWED: readonly string[] = [`${D49_SRC}engine/outside-origin.ts`];
const D49_USER_MCP_CALL_RE = /\buserMcpCall\b/g;
const D49_USER_MCP_CALL_ALLOWED: readonly string[] = [
  `${D49_SRC}ipc/capture-rpc.ts`,
  `${D49_SRC}engine/types.ts`,
  `${D49_SRC}engine/executor.ts`,
  `${D49_SRC}engine/user-mcp-call-block.ts`,
];
// An object-literal property (`{ userMcpCall: x }`). The same text inside a destructuring PATTERN
// (`const { userMcpCall: facts } = action`, a renamed READ) is skipped by `d49IsDestructuringTarget`.
const D49_USER_MCP_CALL_WRITE_RE = /\buserMcpCall\s*\??\s*:/g;
// A member assignment (`action.userMcpCall = facts`); ==, === and => are not assignments.
const D49_USER_MCP_CALL_ASSIGN_RE = /\.\s*userMcpCall\s*=(?![=>])/g;
// A member that is the TARGET of a destructuring assignment (`({ a: action.userMcpCall } = src)`,
// `[action.userMcpCall] = pair`): the member directly before `,`, `}` or `]`, counted only when an
// enclosing `{ ... }` or `[ ... ]` is itself assigned to (`d49IsMemberPatternTarget`). The same
// text as a VALUE (`send({ a: action.userMcpCall })`) is a read. Stated bound, fail closed: a
// member used as a default inside a pattern (`const { a = action.userMcpCall } = x`) is refused too.
const D49_USER_MCP_CALL_MEMBER_TARGET_RE = /\.\s*userMcpCall(?=\s*[,}\]])/g;
// The shorthand forms `{ userMcpCall }`, `{ ...x, userMcpCall }` and `{ a, userMcpCall, b }`: the
// name directly after `{` or `,` and directly before `,` or `}`, never a member access. A
// destructuring pattern (`const { userMcpCall, ...rest } = action`, a READ) is skipped by
// `d49IsDestructuringTarget`.
const D49_USER_MCP_CALL_SHORTHAND_RE = /(?<=[{,]\s*)userMcpCall(?=\s*[,}])/g;
const D49_USER_MCP_CALL_WRITE_ALLOWED: readonly string[] = [
  `${D49_SRC}ipc/capture-rpc.ts`,
  `${D49_SRC}engine/types.ts`,
];
const D49_USER_MCP_LISTER_RE = /\blistUserMcpToolDefinitions\b/g;
const D49_USER_MCP_LISTER_ALLOWED: readonly string[] = [
  `${D49_SRC}connectors/lazy-mesh/mesh/user-mcp-layer.ts`,
  `${D49_SRC}platform/assemble.ts`,
  `${D49_SRC}ipc/connector-rpc.ts`,
];
// The injected dependency the door's check and the owner's enable and status receive (the mesh method
// above, late-bound). Naming it is calling the lister, so it is confined to the files that declare,
// forward or call it; the ORDER of a call inside an allowed file (after the verdict and the approval
// checks, never before) is covered by the behavioural tests, not by this scan.
const D49_USER_MCP_INJECTED_LISTER_RE = /\blistUserMcpDefinitions\b/g;
const D49_USER_MCP_INJECTED_LISTER_ALLOWED: readonly string[] = [
  `${D49_SRC}connectors/connector-writes/agent-door-runtime.ts`,
  `${D49_SRC}ipc/connector-rpc-handlers/agent-writes.ts`,
  `${D49_SRC}ipc/connector-rpc-handlers/agent-writes-user-mcp.ts`,
  `${D49_SRC}ipc/connector-rpc-handlers/model-writes.ts`,
  `${D49_SRC}ipc/connector-rpc.ts`,
  `${D49_SRC}platform/assemble.ts`,
];
const D49_REMOVE_APPROVALS_RE = /\bremoveDoorApprovals\b/g;
const D49_REMOVE_APPROVALS_ALLOWED: readonly string[] = [
  `${D49_SRC}connectors/connector-writes/door-approval-store.ts`,
  `${D49_SRC}ipc/connector-rpc-handlers/model-writes.ts`,
  `${D49_SRC}ipc/connector-rpc-handlers/removal.ts`,
  `${D49_SRC}ipc/connector-rpc-handlers/config.ts`,
];
/** Production files under packages/gateway/src (no test file, no test helper), unless allowed. */
function d49ScanNames(
  files: readonly FileEntry[],
  re: RegExp,
  allowed: readonly string[],
  rule: string,
  keepStrings: boolean,
  skip?: (code: string, index: number) => boolean,
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts") || f.relPath.endsWith(".test-helpers.ts")) continue;
    if (!f.relPath.startsWith(D49_SRC) || allowed.includes(f.relPath)) continue;
    const commentFree = stripComments(f.contents);
    const code = keepStrings ? commentFree : stripStringLiterals(commentFree);
    const original = f.contents.split("\n");
    for (const m of code.matchAll(new RegExp(re.source, "g"))) {
      if (skip?.(code, m.index) === true) continue;
      const line = lineOfOffset(code, m.index);
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    }
  }
  return out;
}

/**
 * True when the identifier at `index` sits inside an object PATTERN: the `{ ... }` that encloses it
 * is followed by a single `=` (`const { a, ...rest } = x`). Such a name is a read, not a property
 * write. Strings and comments are already blanked in `code`, so a brace in either cannot desync the
 * depth.
 */
function d49IsDestructuringTarget(code: string, index: number): boolean {
  let depth = 0;
  let open = -1;
  for (let i = index - 1; i >= 0; i--) {
    const c = code[i];
    if (c === "}") depth++;
    else if (c === "{") {
      if (depth === 0) {
        open = i;
        break;
      }
      depth--;
    }
  }
  if (open < 0) return false;
  depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) {
        const rest = code.slice(i + 1).trimStart();
        return rest.startsWith("=") && !rest.startsWith("==") && !rest.startsWith("=>");
      }
    }
  }
  return false;
}

/** True when the single `=` of an assignment follows `rest` (never `==`, `===` or `=>`). */
function d49StartsWithAssignment(rest: string): boolean {
  return rest.startsWith("=") && !rest.startsWith("==") && !rest.startsWith("=>");
}

/** The index of the bracket that closes the `{` or `[` at `open`, or -1. */
function d49MatchingClose(code: string, open: number): number {
  let depth = 0;
  for (let i = open; i < code.length; i++) {
    const c = code[i];
    if (c === "{" || c === "[") depth++;
    else if (c === "}" || c === "]") {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Words after which a `[` opens an array, never an element access (`return [a] = pair`). */
const D49_KEYWORDS_BEFORE_ARRAY: ReadonlySet<string> = new Set([
  "return",
  "of",
  "in",
  "yield",
  "await",
  "case",
  "typeof",
  "void",
  "else",
  "do",
  "throw",
  "delete",
  "new",
  "instanceof",
]);

/** Statement heads whose `( ... )` is a control header, never a receiver (`if (x) [a] = pair`). */
const D49_CONTROL_HEADS: ReadonlySet<string> = new Set(["if", "while", "for", "with"]);

/**
 * True when the `)` that ends `before` closes a control header (`if (ready)`), so what follows is a
 * new statement. A `)` with no matching `(` is treated the same way: fail closed.
 */
function d49ClosesControlHeader(before: string): boolean {
  let depth = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const c = before[i];
    if (c === ")") depth++;
    else if (c === "(") {
      depth--;
      if (depth === 0) {
        const head = /[\w$]+$/.exec(before.slice(0, i).trimEnd())?.[0];
        return head !== undefined && D49_CONTROL_HEADS.has(head);
      }
    }
  }
  return true;
}

/**
 * True when the `[` at `open` is an element access (`slots[key]`): it follows a name, a `]`, or a
 * `)` that ends a receiver expression (`pick(a)[key]`), never one that ends a control header. What
 * it holds is a key, a READ, even when the indexed slot is then assigned to. Anything this cannot
 * tell is treated as a pattern, so a doubt is a violation, never a pass.
 */
function d49IsElementAccess(code: string, open: number): boolean {
  if (code[open] !== "[") return false;
  const before = code.slice(0, open).trimEnd();
  const last = before.at(-1);
  if (last === undefined) return false;
  if (last === "]") return true;
  if (last === ")") return !d49ClosesControlHeader(before);
  const word = /[\w$]+$/.exec(before)?.[0];
  return word !== undefined && !D49_KEYWORDS_BEFORE_ARRAY.has(word);
}

/**
 * True when the member at `index` sits inside a `{ ... }` or `[ ... ]` group, at any depth, that is
 * itself assigned to: a destructuring assignment whose target is the member, so a WRITE. Every
 * enclosing group is tried, innermost first, so a nested pattern is seen too. An element access is
 * not a pattern: the member inside it is a key that is read, and the walk stops there.
 */
function d49IsMemberPatternTarget(code: string, index: number): boolean {
  let depth = 0;
  for (let i = index - 1; i >= 0; i--) {
    const c = code[i];
    if (c === "}" || c === "]") depth++;
    else if (c === "{" || c === "[") {
      if (depth > 0) {
        depth--;
        continue;
      }
      if (d49IsElementAccess(code, i)) return false;
      const close = d49MatchingClose(code, i);
      if (close >= 0 && d49StartsWithAssignment(code.slice(close + 1).trimStart())) return true;
    }
  }
  return false;
}

export function checkAgentDoorWindowRetired(files: readonly FileEntry[]): Violation[] {
  return [
    ...d49ScanNames(
      files,
      D49_RETIRED_NAMES_RE,
      D49_RETIRED_NAMES_ALLOWED,
      "agent-door-window-names-absent",
      // Strings are KEPT: the three `legacy_*` bases were string literals (`basis: "legacy_mail_send"`),
      // so a scan of identifiers alone would miss them coming back.
      true,
    ),
    ...d49ScanNames(
      files,
      D49_BUILD_DOOR_RE,
      D49_BUILD_DOOR_ALLOWED,
      "agent-door-built-once",
      false,
    ),
  ];
}

export function checkAgentOriginWriter(files: readonly FileEntry[]): Violation[] {
  return [
    ...d49ScanNames(
      files,
      D49_AGENT_ORIGIN_RE,
      D49_AGENT_ORIGIN_ALLOWED,
      "agent-origin-written-once",
      true,
    ),
    ...d49ScanNames(
      files,
      D49_PROPOSER_PROP_RE,
      D49_PROPOSER_PROP_ALLOWED,
      "agent-origin-written-once",
      false,
    ),
  ];
}

export function checkOriginComparison(files: readonly FileEntry[]): Violation[] {
  return d49ScanNames(
    files,
    D49_ORIGIN_COMPARE_RE,
    D49_ORIGIN_COMPARE_ALLOWED,
    "origin-compared-once",
    true,
  );
}

export function checkUserMcpCallFacts(files: readonly FileEntry[]): Violation[] {
  return [
    ...d49ScanNames(
      files,
      D49_USER_MCP_CALL_RE,
      D49_USER_MCP_CALL_ALLOWED,
      "user-mcp-call-facts-confined",
      false,
    ),
    ...d49ScanNames(
      files,
      D49_USER_MCP_CALL_WRITE_RE,
      D49_USER_MCP_CALL_WRITE_ALLOWED,
      "user-mcp-call-facts-confined",
      false,
      d49IsDestructuringTarget,
    ),
    ...d49ScanNames(
      files,
      D49_USER_MCP_CALL_ASSIGN_RE,
      D49_USER_MCP_CALL_WRITE_ALLOWED,
      "user-mcp-call-facts-confined",
      false,
    ),
    ...d49ScanNames(
      files,
      D49_USER_MCP_CALL_MEMBER_TARGET_RE,
      D49_USER_MCP_CALL_WRITE_ALLOWED,
      "user-mcp-call-facts-confined",
      false,
      (code, index) => !d49IsMemberPatternTarget(code, index),
    ),
    ...d49ScanNames(
      files,
      D49_USER_MCP_CALL_SHORTHAND_RE,
      D49_USER_MCP_CALL_WRITE_ALLOWED,
      "user-mcp-call-facts-confined",
      false,
      d49IsDestructuringTarget,
    ),
  ];
}

export function checkUserMcpDoorReach(files: readonly FileEntry[]): Violation[] {
  return [
    ...d49ScanNames(
      files,
      D49_USER_MCP_LISTER_RE,
      D49_USER_MCP_LISTER_ALLOWED,
      "user-mcp-door-reach-confined",
      false,
    ),
    ...d49ScanNames(
      files,
      D49_USER_MCP_INJECTED_LISTER_RE,
      D49_USER_MCP_INJECTED_LISTER_ALLOWED,
      "user-mcp-door-reach-confined",
      false,
    ),
    ...d49ScanNames(
      files,
      D49_REMOVE_APPROVALS_RE,
      D49_REMOVE_APPROVALS_ALLOWED,
      "user-mcp-door-reach-confined",
      false,
    ),
  ];
}
