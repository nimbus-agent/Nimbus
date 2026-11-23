// Static invariant rules: actuation, lane and driver confinement, forward share, agent emitters, embedding and registry appenders.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";

// D26(a) (I35): `performActuation` — the primitive that turns a model-proposed action into a real
// interaction with the host — may be CALLED only from the computer-use gate (which performs the
// config/policy checks, the sandbox assertion, the envelope check, the structural classification,
// the ledger append and the owner-HITL approval first) plus its own definition file. A second
// caller would be a second path from a model proposal to the host, bypassing every one of those.
// Mirrors D23's runConfined confinement. Test files are exempt.
// The gate is the one legitimate CALLER. `cu-actuate.ts` is the definition file, not a caller
// exemption: a wholesale file allow-list (the earlier shape) let ANY occurrence of
// `performActuation(` inside `cu-actuate.ts` through, including a second, illegitimate direct
// invocation added below the real declaration — undetected, because the whole file was skipped.
// Only the DECLARATION line is exempt there now; any call-shaped occurrence elsewhere in that
// file (or anywhere outside `cu-gate.ts`) is a violation, matching D23's tighter shape.
const D26_ACTUATE_GATE_FILE = "packages/gateway/src/computer-use/cu-gate.ts";
const D26_ACTUATE_DEFINITION_FILE = "packages/gateway/src/computer-use/cu-actuate.ts";
const D26_ACTUATE_RE = /\bperformActuation\s*\(/;
const D26_ACTUATE_DECLARATION_RE = /\bfunction\s+performActuation\s*\(/;

// Review finding: a call-text scan alone is defeated by an ALIASED import --
// `import { performActuation as invoke }` followed by `invoke(...)` contains no `performActuation(`
// call-shaped text anywhere, so the scan above stays silent while a second, unauthorized path to
// the host exists. Closed at the IMPORT, not the call: no file other than the gate may import
// `performActuation` under ANY local name -- if the symbol can never enter scope outside cu-gate.ts,
// there is no alias left to call it through. `[^}]*` deliberately allows other named imports on the
// same line/braces; this only cares whether `performActuation` appears as one of the specifiers.
const D26_ACTUATE_IMPORT_RE = /\bimport\s*\{[^}]*\bperformActuation\b[^}]*\}\s*from/;

export function checkActuationConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath === D26_ACTUATE_GATE_FILE) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      const isImport = D26_ACTUATE_IMPORT_RE.test(line);
      const isCall = D26_ACTUATE_RE.test(line);
      if (!isImport && !isCall) continue;
      if (f.relPath === D26_ACTUATE_DEFINITION_FILE && D26_ACTUATE_DECLARATION_RE.test(line)) {
        continue; // the declaration itself, not a call or an import
      }
      out.push({
        rule: isImport ? "D26-actuation-import" : "D26-actuation-callsite",
        file: f.relPath,
        line: i + 1,
        snippet: (original[i] ?? "").trim(),
      });
    }
  }
  return out;
}

// D26(b) (I35): the browser-driving CAPABILITY may live only under `computer-use/cu-lanes/`.
// Confining the actuation primitive alone does not carry the invariant — a new file could open its
// own channel to a browser and dispatch clicks directly, reaching the host without passing the
// gate's envelope check, classifier, consent round-trip or audit append.
//
// TWO patterns, because the library check ALONE was the wrong guard for the driver that shipped.
// It matched `playwright`/`playwright-core` only, and the real driver is raw CDP over a WebSocket
// with no dependency at all — a file opening its own CDP socket passed this rule silently, which
// was disclosed in `SECURITY-INVARIANTS.md` and is now closed:
//
//   1. `D26_DRIVER_LIB_RE` — importing a browser-automation library, static or dynamic form
//      (matching D22(d)). Kept and widened past the one library this repo tried and rejected: the
//      rule should not have to be re-widened the day someone adds `puppeteer`.
//   2. `D26_CDP_METHOD_RE` — naming a CDP `Domain.method` string literal (`"Page.navigate"`,
//      `"Input.dispatchMouseEvent"`, `"Runtime.evaluate"`, …). This is the one that actually
//      catches "a new file opens a raw socket and clicks", because a CDP client cannot do anything
//      WITHOUT naming a protocol method, whatever transport it reaches the browser over. Verified
//      to have ZERO matches across `packages/gateway/src`, `packages/cli/src` and `scripts/`
//      outside `cu-lanes/`, so the false-positive rate is not merely low, it is measured.
const D26_DRIVER_DIR = "packages/gateway/src/computer-use/cu-lanes/";
const D26_DRIVER_LIB_RE =
  /(?:from\s*|import\s*\(\s*|require\s*\(\s*)["'](?:playwright(?:-core)?|puppeteer(?:-core)?|chrome-remote-interface|selenium-webdriver|chrome-launcher)["']/;
const D26_CDP_METHOD_RE =
  /["'`](?:Page|DOM|DOMDebugger|Runtime|Input|Target|Fetch|Network|Browser|Emulation|Security|Storage|Overlay|Accessibility)\.[A-Za-z][A-Za-z0-9]*["'`]/;

// D26(c) (I35): a LANE CONSTRUCTOR — `openBrowserLane`, `openTerminalLane` — may be named only by
// its own definition file and by the single wiring site that injects it into `CuGateDeps.lanes`.
//
// (b) confines the driver capability to `cu-lanes/`, but a wiring layer has to reach into that
// directory once to hand the constructor to the gate, and that one legitimate import is enough for
// a second, illegitimate one to hide beside it: any file importing `openBrowserLane` gets a live
// `BrowserLane` and can call `lane.click()` on it, with no envelope, no classification, no consent
// and no audit row — while (a) sees no `performActuation(` and (b) sees no driver capability,
// because the capability arrived as a function value rather than as protocol text.
//
// Exactly the shape D22(f) uses for `wrapLedgeredEmbedder` and its three construction sites, and
// the counterpart of the `CuRunDeps` split in `cu-gate.ts` — that split removes the constructor
// from the deps object the model-facing tool layer holds; this rule removes it from every module
// that could import it directly. Test files are exempt.
/**
 * KNOWN LIMIT of (b), stated rather than papered over: its two patterns — an automation-library
 * import and a CDP `Domain.method` literal — have NO TERMINAL ANALOGUE. The terminal lane's
 * capability is "spawn a process and write to its stdin", and `SandboxRunner.spawn` is used
 * legitimately by every connector and by `exec/`, so any regex over it would be noise or theatre.
 * What confines the terminal lane is (a), the rule below, and CAPABILITY REMOVAL (`CuRunDeps`
 * carries no lane constructor, so the model-facing tool layer cannot name one) — the same posture
 * D26 already records: capability removal is the primary defense, the static rules are the
 * backstop, and the runtime tests stay authoritative.
 */
const D26_LANE_CONSTRUCTORS: readonly { name: string; allowed: readonly string[] }[] = [
  {
    name: "openBrowserLane",
    allowed: [
      "packages/gateway/src/computer-use/cu-lanes/browser.ts", // the definition
      "packages/gateway/src/platform/assemble.ts", // the sole production wiring site
    ],
  },
  {
    name: "openTerminalLane",
    allowed: [
      "packages/gateway/src/computer-use/cu-lanes/terminal.ts", // the definition
      "packages/gateway/src/platform/assemble.ts", // the sole production wiring site
    ],
  },
];

function checkLaneConstructorConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const { name, allowed } of D26_LANE_CONSTRUCTORS) {
    const re = new RegExp(`\\b${name}\\b`);
    for (const f of files) {
      if (f.relPath.endsWith(".test.ts")) continue;
      if (allowed.includes(f.relPath)) continue;
      const stripped = stripComments(f.contents).split("\n");
      const original = f.contents.split("\n");
      for (let i = 0; i < stripped.length; i++) {
        if (re.test(stripped[i] ?? "")) {
          out.push({
            rule: "D26-lane-constructor",
            file: f.relPath,
            line: i + 1,
            snippet: (original[i] ?? "").trim(),
          });
        }
      }
    }
  }
  return out;
}

export function checkDriverImportConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (f.relPath.startsWith(D26_DRIVER_DIR)) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      if (D26_DRIVER_LIB_RE.test(line) || D26_CDP_METHOD_RE.test(line)) {
        out.push({
          rule: "D26-driver-import",
          file: f.relPath,
          line: i + 1,
          snippet: (original[i] ?? "").trim(),
        });
      }
    }
  }
  out.push(...checkLaneConstructorConfinement(files));
  return out;
}

// D21 (I27) extension: `forwardShare` — the re-forward chokepoint (owner-HITL + hop-append + emit) —
// may be CALLED only from its home (share-forward.ts) and the single wiring file federation-rpc.ts.
// Mirrors the createShare confinement so the SECOND outbound-share emit path cannot be invoked out of
// band, bypassing the owner's share.publish HITL gate (I27). Test files are exempt.
const D21_FORWARDSHARE_ALLOWED = [
  "packages/gateway/src/share/share-forward.ts",
  "packages/gateway/src/ipc/federation-rpc.ts",
];
const D21_FORWARDSHARE_RE = /\bforwardShare\b/;

export function checkForwardShareConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D21_FORWARDSHARE_ALLOWED.includes(f.relPath)) continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      if (D21_FORWARDSHARE_RE.test(strippedLines[i] ?? "")) {
        out.push({
          rule: "D21-forwardshare-callsite",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D22 — the egress chokepoint confinement.
//
// SCOPE, stated precisely because the previous comment overstated it: this rule matches the literal string
// `connectors.dispatch` line by line. It CANNOT see a dispatcher decorator that calls
// `inner.dispatch(action)` (see connectors/connector-write-dispatch.ts), a façade that re-exposes
// execution under another name, or a raw `tool.execute()` on a lazy-mesh tool record. Those paths
// are addressed by removing the capability (Phase 2 of the I29 security spec), not by this regex.
//
// What it does enforce: no NEW site may spell `connectors.dispatch` outside engine/executor.ts,
// `appendEgressEntry` stays inside egress/, and `recordAgentBriefEgress` is named only by its
// definition and its single caller (rule (c), below). Test files are exempt.
export const D22_DISPATCH_ALLOWED = "packages/gateway/src/engine/executor.ts";
export const D22_DISPATCH_RE = /\bconnectors\.dispatch\b/;
export const D22_APPEND_RE = /\bappendEgressEntry\b/;
export const D22_APPEND_ALLOWED_PREFIX = "packages/gateway/src/egress/";

// (c) the agent brief egress chokepoint must be TOTAL: `recordAgentBriefEgress` is CALLED from
// exactly one file. This mirrors (a) — it pins the caller, it does not merely permit an appender.
// Adding a file to an allowlist here would satisfy the checker while dissolving the property it
// protects.
//
// The symbol was `recordMcpBriefEgress` until agent briefs became reachable over HTTP as well as
// stdio. The rule moved with it IN THE SAME COMMIT: a rule pinning a symbol that no longer exists
// passes vacuously, which is indistinguishable from a rule that is working.
export const D22_AGENT_RECORD_RE = /\brecordAgentBriefEgress\b/;
export const D22_AGENT_RECORD_CALLER = "packages/gateway/src/ipc/agents-rpc.ts";
export const D22_AGENT_RECORD_DEFINITION = "packages/gateway/src/egress/agent-brief-egress.ts";

// (e) the ROUTE-TABLE chokepoint. `LlmRegistry.addRoute` is where a provider is passed
// through `wrapLedgeredProvider` (the I29 `model`-class appender). A file that calls
// `LlmRouter.registerRoute` directly puts an UNWRAPPED provider in the route table, which
// then generates with no ledger row -- the `model` class silently incomplete while this
// audit stays green.
//
// `registry.ts` is permitted twice over: `addRoute` (which wraps) and `refreshProviderMeta`
// (which re-registers an ALREADY-wrapped provider to update its meta, and must NOT wrap
// again or every generate would append twice). `router.ts` holds the definition.
export const D22_REGISTER_ROUTE_RE = /\bregisterRoute\b/;
export const D22_REGISTER_ROUTE_ALLOWED: readonly string[] = [
  "packages/gateway/src/llm/registry.ts",
  "packages/gateway/src/llm/router.ts",
];

// (d) the EMITTER chokepoint. Rule (c) pins the caller of the appender, which catches a second file
// acquiring the appender — but NOT a second file that serves a brief without calling it at all.
// That path spells nothing (c) matches: it would append no row, serve the brief, and leave
// audit:invariants green. docs/SECURITY-INVARIANTS.md recorded that gap in prose, naming a
// browser-reachable agent route as the surface that would hit it; this rule closes it before that
// surface can.
//
// The property: only ipc/agents-rpc.ts and the modules of its own folder, ipc/agents-rpc/, may
// import an agent EMITTER module. Emitters are
// `packages/gateway/src/agents/<name>.ts`; `agents/_lib/` is excluded because it holds types and
// shared helpers (findings.ts, demo-symbol.ts) that federation/ and ipc/ legitimately consume.
//
// ALL THREE module-resolution forms are matched. A static-only regex is defeated by the
// one-character change from `import x from "…"` to `await import("…")`, and BOTH are defeated by
// `require("…")` — which is not theoretical here: Bun resolves `require("../agents/why.ts")` from a
// TypeScript module and hands back the live emitter, verified by running it. An enumeration of
// import forms is only as good as its completeness, so adding a fourth spelling must add a fourth
// pattern rather than assume the existing ones generalise.
//
// KNOWN LIMIT, stated because D22's existing weakness is exactly this: a regex over import
// specifiers does not follow re-export chains. An emitter re-exported through `agents/_lib/` could
// be imported from the excluded path and this rule would miss. That is closed by an assertion in
// i29-egress-ledger.test.ts ("agents/_lib re-exports no emitter"), not by this regex — the same
// answer as the wrapper/façade limit above: address the capability, do not pretend the regex sees it.
const D22_EMITTER_ALLOWED = "packages/gateway/src/ipc/agents-rpc.ts";
// The door's own validator and handler modules (split out of agents-rpc.ts, which stays the one
// dispatcher). They sit behind that dispatcher and are reachable only through it.
const D22_EMITTER_ALLOWED_DIR = "packages/gateway/src/ipc/agents-rpc/";
const D22_EMITTER_DIR = "packages/gateway/src/agents/";
// SUBDIRECTORIES. All three patterns below carry `(?:\/[\w-]+)*` after the first path segment,
// because `[\w-]` cannot cross a `/`: the earlier `[A-Za-z][\w-]*\.ts` form matched
// `../agents/why.ts` and missed `../agents/briefs/summary.ts` outright, so nesting emitters one
// directory deep — an ordinary refactor once there are more than a handful — would have silently
// taken every emitter back out of this rule's sight.
//
// This is the SAME defect #1216 fixed for D17/I23, in the sibling rule, one commit earlier. Two
// rules written in the same style shared the same blind spot, which is the argument for the
// subdirectory case being part of the pattern rather than something each rule remembers.
//
// The `_lib/` exclusion still holds under nesting: the lookahead sits immediately after
// `/agents/`, so `agents/_lib/x/y.ts` is excluded by the same token as `agents/_lib/y.ts`.
//
// No catastrophic backtracking: each `(?:\/[\w-]+)` iteration must consume a literal `/`, which
// `[\w-]` cannot, so the split between the segments is unambiguous. Pinned by a time-bounded test
// rather than by argument — a correctness test cannot tell linear from quadratic.

/** `from ".../agents/<name>.ts"` or `.../agents/<sub>/<name>.ts` — any quote style, not `_lib/`. */
const D22_EMITTER_STATIC_RE =
  /\bfrom\s+["'`][^"'`]*\/agents\/(?!_lib\/)[A-Za-z][\w-]*(?:\/[\w-]+)*\.ts["'`]/;
/** `import(".../agents/<name>.ts")` — the dynamic form. */
const D22_EMITTER_DYNAMIC_RE =
  /\bimport\s*\(\s*["'`][^"'`]*\/agents\/(?!_lib\/)[A-Za-z][\w-]*(?:\/[\w-]+)*\.ts["'`]/;
/** `require(".../agents/<name>.ts")` — the CommonJS form, which Bun honours from a .ts module. */
const D22_EMITTER_REQUIRE_RE =
  /\brequire\s*\(\s*["'`][^"'`]*\/agents\/(?!_lib\/)[A-Za-z][\w-]*(?:\/[\w-]+)*\.ts["'`]/;

export function checkAgentEmitterImportConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    // An emitter importing a sibling emitter is internal to the agents package, not a second entry
    // point. The rule is about who can reach IN from outside.
    if (f.relPath.startsWith(D22_EMITTER_DIR)) continue;
    if (f.relPath === D22_EMITTER_ALLOWED || f.relPath.startsWith(D22_EMITTER_ALLOWED_DIR))
      continue;
    const strippedLines = stripComments(f.contents).split("\n");
    const originalLines = f.contents.split("\n");
    for (let i = 0; i < strippedLines.length; i++) {
      const line = strippedLines[i] ?? "";
      if (
        D22_EMITTER_STATIC_RE.test(line) ||
        D22_EMITTER_DYNAMIC_RE.test(line) ||
        D22_EMITTER_REQUIRE_RE.test(line)
      ) {
        out.push({
          rule: "D22-agent-emitter-import",
          file: f.relPath,
          line: i + 1,
          snippet: (originalLines[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

// D22 (f): the EMBEDDING appender. `egress/embedding-egress.ts`'s `wrapLedgeredEmbedder` is
// the I29 `model`-class appender for embeddings. A file that constructs a remote embedder
// without it puts an unrecorded egress path in the index pipeline -- the exact false zero
// `nimbus prove` would then report a clean window over.
const D22_EMBED_WRAP_RE = /\bwrapLedgeredEmbedder\b/;
const D22_EMBED_WRAP_ALLOWED: readonly string[] = [
  "packages/gateway/src/egress/embedding-egress.ts",
  "packages/gateway/src/embedding/create-routing-runtime.ts",
  "packages/gateway/src/embedding/create-embedding-runtime.ts",
  "packages/gateway/src/ipc/index-reembed-rpc.ts",
];

export function checkEmbeddingAppenderConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/")) continue;
    if (D22_EMBED_WRAP_ALLOWED.includes(f.relPath)) continue;
    // Whole-source scan, not per-line: `stripComments` preserves length, so a match offset
    // maps 1:1 onto the original line numbering.
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");
    const re = new RegExp(D22_EMBED_WRAP_RE.source, "g");
    for (const m of stripped.matchAll(re)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({
        rule: "embedding-appender-confined",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D22 (h): the REGISTRY appender and the registry fetch. `egress/registry-egress.ts`'s
// `recordRegistryEgress` is the I29 `registry`-class appender; its sole production caller is
// `extensions/registry/registry-fetch.ts`, the one function that fetches registry bytes. Two
// rules close the two ways to bypass it: (1) `recordRegistryEgress` named anywhere else is a
// second, unreviewed fetch path (or a forged row); (2) a bare `fetch(` call anywhere else under
// `extensions/` is a network request the registry ledger and its transport checks never saw.
// Stated bound: only the literal global `fetch(` is matched. An injected fetcher (`opts.fetcher(`,
// `deps.fetchFn(`) or an alias of `fetch` evades it, so capability confinement -- only
// `registry-fetch.ts` is ever handed the real `fetch` -- is the primary defense.
const D22_REGISTRY_APPENDER_RE = /\brecordRegistryEgress\b/;
const D22_REGISTRY_APPENDER_ALLOWED: readonly string[] = [
  "packages/gateway/src/egress/registry-egress.ts",
  "packages/gateway/src/extensions/registry/registry-fetch.ts",
];
const D22_REGISTRY_FETCH_RE = /\bfetch\s*\(/;
const D22_REGISTRY_FETCH_ALLOWED: readonly string[] = [
  "packages/gateway/src/extensions/registry/registry-fetch.ts",
];

function scanRegistryRule(
  files: readonly FileEntry[],
  prefix: string,
  re: RegExp,
  allowed: readonly string[],
  rule: string,
): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith(prefix)) continue;
    if (allowed.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");
    const g = new RegExp(re.source, "g");
    for (const m of stripped.matchAll(g)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({ rule, file: f.relPath, line, snippet: (original[line - 1] ?? "").trim() });
    }
  }
  return out;
}

export function checkRegistryAppenderConfinement(files: readonly FileEntry[]): Violation[] {
  return [
    ...scanRegistryRule(
      files,
      "packages/gateway/src/",
      D22_REGISTRY_APPENDER_RE,
      D22_REGISTRY_APPENDER_ALLOWED,
      "registry-appender-confined",
    ),
    ...scanRegistryRule(
      files,
      "packages/gateway/src/extensions/",
      D22_REGISTRY_FETCH_RE,
      D22_REGISTRY_FETCH_ALLOWED,
      "registry-fetch-confined",
    ),
  ];
}
