// Static invariant rules: incident remediation, findings and runbooks, plus the spawn-hidden, run-confined and client-kind rules.
// Moved verbatim out of check-nimbus-invariants.ts; docs/SECURITY-INVARIANTS.md describes each rule.

import { stripComments, stripStringLiterals } from "../lib.ts";
import type { FileEntry, Violation } from "./_shared.ts";
import { d46dWriteRe } from "./share-sync-index-incident.ts";

// D46(c) (Phase 10 IC5a, incident-engine spec § 5.5, invariant I57 (b)): an engine-proposed action is built in ONE
// module. Rule ids, over every non-test file of `packages/gateway/src/`, comments stripped:
//   `engine-proposal-key-confined`: the property key `engineProposal` (declared or assigned, quoted or not) only in
//       `incident/remediation.ts` (which sets it) and `engine/types.ts` (which declares it); the executor, the
//       prompt and the audit row only READ `action.engineProposal`;
//   `incident-proposal-table-confined`: a write verb on `incident_proposal` or `incident_engine_state` only in
//       `incident/proposal-store.ts` and the V102 DDL file;
//   `remediation-action-builder-confined`: the identifier `buildRemediationAction` only in `incident/remediation.ts`;
//   `remediation-executor-confined`: the identifier `buildRemediationExecutor` only in `engine/run-ask.ts` (its
//       definition) and `gateway-main.ts` (its one caller);
//   `remediation-dry-run-confined` (Phase 17 dry run): a call `.readBeforeOnly(` only in `incident/remediation.ts`
//       (its one caller), and the body of `ToolExecutor.readBeforeOnly` in `engine/executor.ts` holds no call of
//       `gateWithin(`, `approvalPhase(`, `dispatchBoundPhase(`, `.execute(` or `connectors.dispatch(`: it runs
//       the before-state reads (`readBeforeStateOf`, shared with `captureBeforePhase`, whose reads go through the gate) and never gates, asks
//       about or dispatches the write. The body is found by the method's own signature; a missing body is
//       itself a violation.
// Stated bounds: a text scan, so a dynamically composed key or name evades it (the executor refuses an engine proposal
// that is not beside a valid link, and `i57-incident-engine.test.ts` pins the behaviour: never delegated, never
// standing-approved, refused in advisory mode, never offered to the model); a write verb spelled in a template
// literal assembled from parts evades the table clause.
const D46C_SRC = "packages/gateway/src/";
const D46C_KEY_ALLOWED: readonly string[] = [
  `${D46C_SRC}incident/remediation.ts`,
  `${D46C_SRC}engine/types.ts`,
];
const D46C_STORE = `${D46C_SRC}incident/proposal-store.ts`;
const D46C_DDL = `${D46C_SRC}index/incident-proposal-v102-sql.ts`;
const D46C_BUILDER = `${D46C_SRC}incident/remediation.ts`;
const D46C_EXECUTOR_ALLOWED: readonly string[] = [
  `${D46C_SRC}engine/run-ask.ts`,
  `${D46C_SRC}gateway-main.ts`,
];
const D46C_KEY_RE = /\bengineProposal\s*\??\s*:|["']engineProposal["']\s*:/g;
const D46C_TABLE_WRITE_RE = d46dWriteRe("incident_(?:proposal|engine_state)");
const D46C_BUILDER_RE = /\bbuildRemediationAction\b/g;
const D46C_EXECUTOR_RE = /\bbuildRemediationExecutor\b/g;
const D46C_DRY_RUN_CALLER = `${D46C_SRC}incident/remediation.ts`;
const D46C_DRY_RUN_EXECUTOR = `${D46C_SRC}engine/executor.ts`;
const D46C_DRY_RUN_CALL_RE = /\.readBeforeOnly\s*\(/g;
const D46C_DRY_RUN_SIG =
  "async readBeforeOnly(planned: PlannedAction): Promise<BeforeOnlyOutcome> {";
const D46C_DRY_RUN_FORBIDDEN_RE =
  /\bgateWithin\s*\(|\bapprovalPhase\s*\(|\bdispatchBoundPhase\s*\(|\.execute\s*\(|\bconnectors\.dispatch\s*\(/g;

/** The body of `readBeforeOnly` in comment- and string-free source: from its signature to the method's closing brace. */
function d46cDryRunBody(code: string): { start: number; body: string } | undefined {
  const start = code.indexOf(D46C_DRY_RUN_SIG);
  if (start === -1) return undefined;
  const end = code.indexOf("\n  }\n", start);
  return end === -1 ? undefined : { start, body: code.slice(start, end) };
}

export function checkIncidentRemediationConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (/\.test(?:-helpers)?\.ts$/.test(f.relPath)) continue;
    if (!f.relPath.startsWith(D46C_SRC)) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (!D46C_KEY_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D46C_KEY_RE)) {
        add("engine-proposal-key-confined", f, commentFree, m.index);
      }
    }
    if (f.relPath !== D46C_STORE && f.relPath !== D46C_DDL) {
      for (const m of commentFree.matchAll(D46C_TABLE_WRITE_RE)) {
        add("incident-proposal-table-confined", f, commentFree, m.index);
      }
    }
    if (f.relPath !== D46C_BUILDER) {
      for (const m of code.matchAll(D46C_BUILDER_RE)) {
        add("remediation-action-builder-confined", f, code, m.index);
      }
    }
    if (!D46C_EXECUTOR_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D46C_EXECUTOR_RE)) {
        add("remediation-executor-confined", f, code, m.index);
      }
    }
    if (f.relPath !== D46C_DRY_RUN_CALLER) {
      for (const m of code.matchAll(D46C_DRY_RUN_CALL_RE)) {
        add("remediation-dry-run-confined", f, code, m.index);
      }
    }
    if (f.relPath === D46C_DRY_RUN_EXECUTOR) {
      // Scanned with comments AND string contents blanked (length preserved), so a forbidden call spelled inside a
      // string is not a call; the signature holds no string literal, so it is found the same way.
      const span = d46cDryRunBody(code);
      if (span === undefined) {
        add("remediation-dry-run-confined", f, code, 0);
      } else {
        for (const m of span.body.matchAll(D46C_DRY_RUN_FORBIDDEN_RE)) {
          add("remediation-dry-run-confined", f, code, span.start + (m.index ?? 0));
        }
      }
    }
  }
  return out;
}

// D46(f) (Phase 10 IC8, incident-engine spec § 5.8, invariant I57 (a)): the radar's and the anomaly baseline's
// tables are written only by their store. Rule id `incident-finding-table-confined`, over every non-test file of
// `packages/gateway/src/`, comments stripped: a write verb on `incident_finding` or `anomaly_baseline` only in
// `incident/finding-store.ts` and the V103 DDL file. Detection never acts (D-IC-5): a finding is written here and
// read for display only. Stated bounds: a text scan, so a write verb spelled in a template literal assembled from
// parts evades it.
const D46F_SRC = "packages/gateway/src/";
const D46F_STORE = `${D46F_SRC}incident/finding-store.ts`;
const D46F_DDL = `${D46F_SRC}index/incident-predict-v103-sql.ts`;
const D46F_TABLE_WRITE_RE = d46dWriteRe("(?:incident_finding|anomaly_baseline)");

export function checkIncidentFindingConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (/\.test(?:-helpers)?\.ts$/.test(f.relPath)) continue;
    if (!f.relPath.startsWith(D46F_SRC)) continue;
    if (f.relPath === D46F_STORE || f.relPath === D46F_DDL) continue;
    const commentFree = stripComments(f.contents);
    for (const m of commentFree.matchAll(D46F_TABLE_WRITE_RE)) {
      const line = commentFree.slice(0, m.index).split("\n").length;
      out.push({
        rule: "incident-finding-table-confined",
        file: f.relPath,
        line,
        snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D46(g) (Phase 10 IC6, incident-engine spec § 5.6, invariant I57 (c)): a runbook step is built in ONE module.
// Rule ids, over every non-test file of `packages/gateway/src/`, comments stripped:
//   `runbook-step-key-confined`: the property key `runbookStep` (declared or assigned, quoted or not) only in
//       `runbook/runbook-run.ts` (which sets it) and `engine/types.ts` (which declares it); the executor, the
//       prompt and the audit row only READ `action.runbookStep`;
//   `incident-runbook-table-confined`: a write verb on `incident_runbook_step` only in
//       `incident/runbook-step-store.ts` and the V104 DDL file;
//   `runbook-read-type-confined`: the identifier `runbookReadActionType` only in `engine/runbook-read.ts` (its
//       definition) and `runbook/runbook-run.ts` (its one caller), and the text `.runbook.read` only in
//       `engine/runbook-read.ts`, so no other module can build an action the dispatcher treats as a runbook read;
//   `runbook-dir-confined`: the identifier `loadRunbooks` only in `runbook/runbook-loader.ts` and
//       `runbook/runbook-run.ts`, the one reader of the owner's runbook folder.
// Stated bounds: a text scan, so a dynamically composed key, name or type evades it (the executor refuses a runbook
// step that is not beside a valid link or that sits beside an engine proposal; the dispatcher lets a runbook read
// resolve only to a read of its own service); a write verb spelled from parts evades the table clause.
const D46G_SRC = "packages/gateway/src/";
const D46G_RUN = `${D46G_SRC}runbook/runbook-run.ts`;
const D46G_KEY_ALLOWED: readonly string[] = [D46G_RUN, `${D46G_SRC}engine/types.ts`];
const D46G_STORE = `${D46G_SRC}incident/runbook-step-store.ts`;
const D46G_DDL = `${D46G_SRC}index/incident-runbook-v104-sql.ts`;
const D46G_READ_TYPE = `${D46G_SRC}engine/runbook-read.ts`;
const D46G_LOADER_ALLOWED: readonly string[] = [`${D46G_SRC}runbook/runbook-loader.ts`, D46G_RUN];
const D46G_KEY_RE = /\brunbookStep\s*\??\s*:|["']runbookStep["']\s*:/g;
// An assignment (`x.runbookStep = v`) and a shorthand key (`{ runbookStep }`) set it too. Matched on code with its
// strings stripped, so a bracketed quoted assignment (`x["runbookStep"] = v`) is the stated bound of the text scan.
const D46G_SET_RE = /\.\s*runbookStep\s*=(?![=>])|[{,]\s*runbookStep\s*[,}]/g;
const D46G_TABLE_WRITE_RE = d46dWriteRe("incident_runbook_step");
const D46G_TYPE_RE = /\brunbookReadActionType\b/g;
const D46G_SUFFIX_RE = /\.runbook\.read\b/g;
const D46G_LOADER_RE = /\bloadRunbooks\b/g;

export function checkRunbookConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  const add = (rule: string, f: FileEntry, src: string, index: number | undefined): void => {
    const line = src.slice(0, index).split("\n").length;
    out.push({
      rule,
      file: f.relPath,
      line,
      snippet: (f.contents.split("\n")[line - 1] ?? "").trim(),
    });
  };
  for (const f of files) {
    if (/\.test(?:-helpers)?\.ts$/.test(f.relPath)) continue;
    if (!f.relPath.startsWith(D46G_SRC)) continue;
    const commentFree = stripComments(f.contents);
    const code = stripStringLiterals(commentFree);
    if (!D46G_KEY_ALLOWED.includes(f.relPath)) {
      for (const m of commentFree.matchAll(D46G_KEY_RE))
        add("runbook-step-key-confined", f, commentFree, m.index);
      for (const m of code.matchAll(D46G_SET_RE))
        add("runbook-step-key-confined", f, code, m.index);
    }
    if (f.relPath !== D46G_STORE && f.relPath !== D46G_DDL) {
      for (const m of commentFree.matchAll(D46G_TABLE_WRITE_RE)) {
        add("incident-runbook-table-confined", f, commentFree, m.index);
      }
    }
    if (f.relPath !== D46G_READ_TYPE) {
      for (const m of commentFree.matchAll(D46G_SUFFIX_RE))
        add("runbook-read-type-confined", f, commentFree, m.index);
      if (f.relPath !== D46G_RUN) {
        for (const m of code.matchAll(D46G_TYPE_RE))
          add("runbook-read-type-confined", f, code, m.index);
      }
    }
    if (!D46G_LOADER_ALLOWED.includes(f.relPath)) {
      for (const m of code.matchAll(D46G_LOADER_RE)) add("runbook-dir-confined", f, code, m.index);
    }
  }
  return out;
}

// D25: a CONNECTOR SYNCABLE may not call `Bun.spawn` — it must go through
// `platform/spawn-capture.ts`, which spawns with `windowsHide`.
//
// The Gateway runs DETACHED, so on Windows a console-subsystem child with no console to inherit
// gets a brand-new one allocated, plus a `conhost.exe` to host it — i.e. a visible window that
// opens and closes for the lifetime of every CLI call. That is not a rare event at connector
// rates: `cloudwatch` and `sagemaker` spawn one `aws` process PER INDEXED ITEM through
// `runAwsCliPaginatedWalk`'s `processEntry`, and `aws` re-lists Lambda functions every 120 s, so
// the unhidden version flashed dozens of windows per sync tick on an otherwise idle machine.
//
// This is a STATIC rule because the failure is invisible to every test and to CI: it reproduces
// only on Windows, only when the parent has no console, and it breaks nothing — the sync still
// works. A reviewer on macOS or Linux cannot see it, and neither can the 3-OS matrix, whose
// Windows leg runs tests from a shell that HAS a console.
//
// `blame-index-sync.ts` and `filesystem-v2-sync.ts` are exempted: they take `Bun.spawn` as an
// INJECTED default parameter (`spawn: SpawnFn = Bun.spawn`) rather than calling it inline, and
// converting that seam is a wider change than this rule's subject. They spawn `git`, which is
// equally affected — tracked separately rather than silently blessed.
const D25_BUN_SPAWN_RE = /\bBun\s*\.\s*spawn\b/;
const D25_BUN_SPAWN_ALLOWED: readonly string[] = [
  "packages/gateway/src/connectors/blame-index-sync.ts",
  "packages/gateway/src/connectors/filesystem-v2-sync.ts",
];

export function checkConnectorSpawnIsHidden(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (!f.relPath.startsWith("packages/gateway/src/connectors/")) continue;
    if (f.relPath.startsWith("packages/gateway/src/connectors/lazy-mesh/")) continue;
    if (D25_BUN_SPAWN_ALLOWED.includes(f.relPath)) continue;
    // Scans the WHOLE stripped source, not line by line. `Bun` and `.spawn` may sit on
    // different lines — `Bun` then a newline then `.spawn(...)` is valid TypeScript, and a
    // per-line test matches NEITHER line, so the rule would silently miss it. `stripComments`
    // preserves length, so a match offset maps 1:1 onto the original's line numbering.
    const stripped = stripComments(f.contents);
    const original = f.contents.split("\n");
    const re = new RegExp(D25_BUN_SPAWN_RE.source, "g");
    for (const m of stripped.matchAll(re)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({
        rule: "connector-spawn-must-be-hidden",
        file: f.relPath,
        line,
        snippet: (original[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D23 (I33): `runConfined` — the confined-spawn primitive that turns user-supplied code into a
// running process — may be CALLED only from the exec gate (which performs the config/policy checks,
// the sandbox-posture assertion and the owner-HITL approval first) plus its own definition file.
// A second caller would be a second path from arbitrary code to a process, bypassing every one of
// those, which is precisely what I33 forbids. Mirrors D21's createShare/forwardShare confinement.
// Test files are exempt.
const D23_RUNCONFINED_ALLOWED = [
  "packages/gateway/src/exec/exec-gate.ts",
  "packages/gateway/src/exec/exec-run.ts",
];
const D23_RUNCONFINED_RE = /\brunConfined\s*\(/g;

export function checkRunConfinedConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D23_RUNCONFINED_ALLOWED.includes(f.relPath)) continue;
    // Whole-source match, so `runConfined\n(` is a call too; the line is where the callee starts.
    const stripped = stripStringLiterals(stripComments(f.contents));
    const originalLines = f.contents.split("\n");
    for (const m of stripped.matchAll(D23_RUNCONFINED_RE)) {
      const line = stripped.slice(0, m.index).split("\n").length;
      out.push({
        rule: "D23-runconfined-callsite",
        file: f.relPath,
        line,
        snippet: (originalLines[line - 1] ?? "").trim(),
      });
    }
  }
  return out;
}

// D28 (I38): the `fleet` ClientKind literal — the attribution that marks a call as unattended,
// owner-configured fleet work — may appear only where it is DEFINED, where its egress status is
// DECIDED, and in the one invoker that legitimately wears it. A second file naming it would be a
// second path able to file briefs under that attribution without passing the scheduler's config,
// policy, admission and I38 budget checks. Mirrors D23's runConfined confinement. Tests exempt.
//
// WHAT THIS RULE COVERS, and what it does not — stated plainly, in the style of D26(b), because a
// rule that implies completeness is worse than one that names its own edge. It matches the literal
// only where it is being ASSIGNED as a client kind:
//   * an object-literal property or a plain assignment — `kind: "fleet"`, `callerKind = "fleet"`
//     (any identifier ending in `kind`/`Kind`);
//   * a `ClientKind`-typed declaration — `const k: ClientKind = "fleet"`;
//   * a `ClientKind` assertion — `"fleet" as ClientKind`;
//   * a `ClientKindStore.declare(...)` second argument — `store.declare(id, "fleet")`;
//   * a quoted `"fleet":` map key whose value is `null` or a string, i.e. a second copy of the
//     egress classification.
// Each is checked against the line AND against that line joined with the next, so a formatter that
// breaks `kind:` from its literal does not slip past.
//
// It deliberately does NOT match a BARE `"fleet"` string. The word is a legitimate namespace token
// elsewhere — the LAN forbid-list (`ipc/lan-rpc.ts`) and the CLI command map both name it with no
// `ClientKind` involved — and a bare-string rule would false-positive on those, then be weakened or
// allow-listed until it caught nothing. A narrow rule that fires is worth more than a broad one
// that gets disarmed.
//
// WHAT THE ALLOW-LIST IMPLIES AND THE RULE DELIVERS — checked against the three files rather than
// inferred from the list's length. TWO of the three contain a shape this regex can see:
// `fleet-invoker.ts`'s `kind: "fleet"` and `egress-bearing-kinds.ts`'s `fleet: null`.
// `client-kind.ts` holds the union MEMBER (`| "fleet" |`), which matches no alternative above and
// is not meant to — a union member declares that the kind exists, it does not wear it.
//
// This paragraph previously said only ONE file was visible, and that a copy-paste of the REAL
// egress classification line would NOT be caught. That was true and is no longer: the map-key
// alternative required a QUOTED `"fleet":` while the shipped map writes it bare, so the rule caught
// a hand-written map and not this repo's own. Widening looked unsafe because `fleet:` is also how a
// CLI command map names the namespace — but the VALUE separates them exactly. An egress
// classification is `null`; a command-map entry is a function reference; a LAN forbid-list entry is
// a bare array element with no colon at all. Hence `\bfleet\s*:\s*null\b` and nothing wider.
//
// RESIDUAL BOUND: a regex cannot see every construction. An indirection
// (`const K = "fleet"; { kind: K }`), a computed key, or a value arriving from JSON all evade it —
// the same class of hole D23 carries and that D26(a) had to close at the import instead. The
// PRIMARY defense is capability confinement: the `ClientKind` value is only reachable where the
// scheduler builds its caller descriptor, and `RECOGNISED` in `client-kind.ts` independently
// refuses `fleet` as a client-DECLARED kind, so the socket path is closed by construction rather
// than by this scan. This rule is the backstop for the copy-paste case, not the boundary.
const D28_FLEET_KIND_ALLOWED = [
  "packages/gateway/src/ipc/server/client-kind.ts",
  "packages/gateway/src/egress/egress-bearing-kinds.ts",
  "packages/gateway/src/fleet/fleet-invoker.ts",
];
// The final alternative is the UNQUOTED map key, and it is pinned to a `null` VALUE on purpose.
// `fleet:` alone is how a CLI command map and a config object also name the namespace, which is why
// the rule previously stayed clear of the unquoted form altogether — but that left it unable to see
// the one line it most needs to: `egress-bearing-kinds.ts`'s real `fleet: null` classification, so a
// copy-paste of it into a fourth file passed. The value discriminates precisely: an egress
// classification is `null`, a command map entry is a function reference, and a forbid-list entry is
// a bare array element with no colon at all.
const D28_FLEET_KIND_RE =
  /\w*[Kk]ind\s*[:=]\s*["']fleet["']|:\s*ClientKind\s*=\s*["']fleet["']|["']fleet["']\s+as\s+ClientKind|\bdeclare\s*\([^)]*,\s*["']fleet["']|["']fleet["']\s*:\s*(?:null|["'])|\bfleet\s*:\s*null\b/;

export function checkFleetClientKindConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D28_FLEET_KIND_ALLOWED.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      const next = stripped[i + 1] ?? "";
      // The line alone, else the line joined with its successor. The joined form counts ONLY when
      // the successor does not match on its own: otherwise a violation sitting wholly on line i+1
      // would be reported twice — once here, at the wrong line number, and again at its own index.
      // The first line has to actually contribute for the window to mean anything.
      let matched = D28_FLEET_KIND_RE.test(line);
      if (!matched && !D28_FLEET_KIND_RE.test(next)) {
        matched = D28_FLEET_KIND_RE.test(`${line} ${next}`);
      }
      if (matched) {
        out.push({
          rule: "D28-fleet-client-kind",
          file: f.relPath,
          line: i + 1,
          snippet: (original[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}

const D28_PUSH_KIND_ALLOWED = [
  "packages/gateway/src/ipc/server/client-kind.ts",
  "packages/gateway/src/egress/egress-bearing-kinds.ts",
];
// Same shapes as D28_FLEET_KIND_RE with "push" substituted. Both quote styles match in each rule:
// a single-quoted `kind: 'push'` is the same assignment, and a double-quote-only regex passed it. The bare unquoted key matches only a
// `null` VALUE, so OWNER_SCOPED_ONCALL_ALLOWED's `push: false` and every `arr.push(x)` stay clear.
const D28_PUSH_KIND_RE =
  /\w*[Kk]ind\s*[:=]\s*["']push["']|:\s*ClientKind\s*=\s*["']push["']|["']push["']\s+as\s+ClientKind|\bdeclare\s*\([^)]*,\s*["']push["']|["']push["']\s*:\s*(?:null|["'])|\bpush\s*:\s*null\b/;

export function checkPushClientKindConfinement(files: readonly FileEntry[]): Violation[] {
  const out: Violation[] = [];
  for (const f of files) {
    if (f.relPath.endsWith(".test.ts")) continue;
    if (D28_PUSH_KIND_ALLOWED.includes(f.relPath)) continue;
    const stripped = stripComments(f.contents).split("\n");
    const original = f.contents.split("\n");
    for (let i = 0; i < stripped.length; i++) {
      const line = stripped[i] ?? "";
      const next = stripped[i + 1] ?? "";
      // The line alone, else the line joined with its successor. The joined form counts ONLY when
      // the successor does not match on its own: otherwise a violation sitting wholly on line i+1
      // would be reported twice — once here, at the wrong line number, and again at its own index.
      // The first line has to actually contribute for the window to mean anything.
      let matched = D28_PUSH_KIND_RE.test(line);
      if (!matched && !D28_PUSH_KIND_RE.test(next)) {
        matched = D28_PUSH_KIND_RE.test(`${line} ${next}`);
      }
      if (matched) {
        out.push({
          rule: "D28-push-client-kind",
          file: f.relPath,
          line: i + 1,
          snippet: (original[i] ?? "").trim(),
        });
      }
    }
  }
  return out;
}
