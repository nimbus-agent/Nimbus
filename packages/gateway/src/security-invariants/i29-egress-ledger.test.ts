import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import {
  checkAgentEmitterImportConfinement,
  checkEgressChokepointConfinement,
  checkEmbeddingConstructorConfinement,
} from "../../../../scripts/structure-audit/check-nimbus-invariants.ts";
import { stripComments } from "../../../../scripts/structure-audit/lib.ts";
import {
  censusCapabilities,
  censusPrepareReply,
  egressRows,
  freshEgressDb,
  grepRepo,
  REPO_ROOT,
  reachRunner,
  read,
  readDirFiles,
  writesUnderTest,
} from "../../test/helpers/security-invariants.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { COVERAGE_CLASSES, THIS_BINARY_COVERAGE } from "../egress/egress-coverage.ts";
import { makeEgressSink, NULL_EGRESS_SINK } from "../egress/egress-ledger.ts";
import { EGRESS_SOURCE_TYPES, MARKER_SOURCE_TYPES } from "../egress/egress-source-type.ts";
import { egressHead } from "../egress/egress-verify.ts";
import { serviceOf } from "../engine/service-of.ts";
import { extractToolInput } from "../engine/tool-input.ts";
import { CURRENT_SCHEMA_VERSION } from "../index/local-index.ts";
import { runIndexedSchemaMigrations } from "../index/migrations/runner.ts";

describe("I29 — egress-ledger completeness over the executor chokepoint", () => {
  test("egress.prune is in the I2 HITL frozen set", async () => {
    const { HITL_REQUIRED } = await import("../engine/executor.ts");
    expect(HITL_REQUIRED.has("egress.prune")).toBe(true);
  });

  test("executor.gate appends an egress row before dispatch, blocks on deny, aborts on append failure", async () => {
    const { ToolExecutor } = await import("../engine/executor.ts");
    const order: string[] = [];
    const appended: Array<{ resultStatus: string }> = [];
    const consent = {
      requestApproval: async () => ({ approved: true, answerSource: "human" as const }),
    };
    const audit = { recordAudit: () => {} };
    const connectors = {
      dispatch: async () => {
        order.push("dispatch");
        return {};
      },
    };
    const sink = {
      append: (e: { resultStatus: string }) => {
        order.push("append");
        appended.push(e);
      },
    };
    const exec = new ToolExecutor(consent, audit, connectors, undefined, sink);
    await exec.execute({ type: "search.run", payload: {} });
    expect(order).toEqual(["append", "dispatch"]);

    // deny → blocked row, no dispatch
    const order2: string[] = [];
    const denyConsent = {
      requestApproval: async () => ({ approved: false, answerSource: "human" as const }),
    };
    const sink2 = { append: (e: { resultStatus: string }) => order2.push(e.resultStatus) };
    const connectors2 = {
      dispatch: async () => {
        order2.push("dispatch");
        return {};
      },
    };
    const exec2 = new ToolExecutor(denyConsent, audit, connectors2, undefined, sink2);
    await exec2.execute({ type: "email.send", payload: {} });
    expect(order2).toContain("blocked");
    expect(order2).not.toContain("dispatch");

    // append throws → abort
    const throwingSink = {
      append: () => {
        throw new Error("x");
      },
    };
    const connectors3 = { dispatch: async () => ({}) };
    const exec3 = new ToolExecutor(consent, audit, connectors3, undefined, throwingSink);
    await expect(exec3.execute({ type: "search.run", payload: {} })).rejects.toThrow();
  });

  test("every connector write prompts the owner and appends exactly one egress row BEFORE dispatch", async () => {
    const { ToolExecutor } = await import("../engine/executor.ts");
    const failures: string[] = [];
    for (const { label, action } of writesUnderTest()) {
      const db = freshEgressDb();
      let prompts = 0;
      let dispatches = 0;
      let rowsAtDispatch = -1;
      // A bound write (D1c) runs its prepare read first: one more audited and ledgered row, before it.
      const boundRow = CONNECTOR_WRITE_ROWS.find(
        (r) => r.actionType === action.type && r.bound !== undefined,
      );
      const prepared = censusPrepareReply(
        boundRow,
        extractToolInput(action) as Record<string, unknown>,
      );
      const rowsExpected = boundRow === undefined ? 1 : 2;
      const exec = new ToolExecutor(
        {
          requestApproval: async () => {
            prompts += 1;
            return { approved: true, answerSource: "human" as const };
          },
          // A wave 4 write is approved by typing its confirm text; this owner types it exactly.
          requestConfirmedApproval: async (req) => {
            prompts += 1;
            return { approved: true, typed: req.confirmText, answerSource: "human" as const };
          },
        },
        { recordAudit: () => {} },
        {
          dispatch: async (a: { type: string }) => {
            if (prepared !== undefined && a.type.endsWith(".write.prepare")) return prepared;
            dispatches += 1;
            rowsAtDispatch = egressRows(db).length;
            return {};
          },
          ...censusCapabilities(boundRow),
        },
        undefined,
        makeEgressSink(db),
      );
      await exec.execute(action);
      const rows = egressRows(db);
      // A row the gate refuses itself (D2: the Pulumi apply) asks nobody and dispatches nothing,
      // but is still ledgered, blocked.
      if (
        CONNECTOR_WRITE_ROWS.some((r) => r.actionType === action.type && r.refuse !== undefined)
      ) {
        if (prompts !== 0 || dispatches !== 0) failures.push(`${label}: a refused row ran`);
        if (rows.length !== 1 || rows[0]?.resultStatus !== "blocked") {
          failures.push(`${label}: a refused row is not one blocked row`);
        }
        db.close();
        continue;
      }
      if (prompts !== 1) failures.push(`${label}: consent asked ${prompts} times`);
      if (dispatches !== 1) failures.push(`${label}: dispatched ${dispatches} times`);
      if (rowsAtDispatch !== rowsExpected) {
        failures.push(`${label}: ${rowsAtDispatch} rows at dispatch`);
      }
      const row = rows.at(-1);
      if (rows.length !== rowsExpected || row === undefined) {
        failures.push(`${label}: ${rows.length} rows after`);
      } else {
        if (row.resultStatus !== "authorized")
          failures.push(`${label}: result ${row.resultStatus}`);
        if (row.hitlStatus !== "approved") failures.push(`${label}: hitl ${row.hitlStatus}`);
        if (row.destination !== serviceOf(action.type)) {
          failures.push(`${label}: destination ${row.destination}`);
        }
      }
      db.close();
    }
    expect(failures).toEqual([]);
  });

  test("a denied write appends one blocked row and dispatches nothing", async () => {
    const { ToolExecutor } = await import("../engine/executor.ts");
    const failures: string[] = [];
    for (const { label, action } of writesUnderTest()) {
      const db = freshEgressDb();
      let dispatches = 0;
      let discards = 0;
      // A bound write (D1c) is prepared before anyone is asked: its read is ledgered, then denied.
      const boundRow = CONNECTOR_WRITE_ROWS.find(
        (r) => r.actionType === action.type && r.bound !== undefined,
      );
      const prepared = censusPrepareReply(
        boundRow,
        extractToolInput(action) as Record<string, unknown>,
      );
      const exec = new ToolExecutor(
        {
          requestApproval: async () => ({ approved: false, answerSource: "human" as const }),
          requestConfirmedApproval: async () => ({
            approved: false,
            typed: "",
            answerSource: "human" as const,
          }),
        },
        { recordAudit: () => {} },
        {
          dispatch: async (a: { type: string }) => {
            if (prepared !== undefined && a.type.endsWith(".write.prepare")) return prepared;
            // D2 (static D43): the gateway's own cleanup of the unused change set is the one
            // dispatch a declined write may be followed by; it is counted apart.
            if (a.type === "iac.cloudformation.changeset.discard") {
              discards += 1;
              return {};
            }
            dispatches += 1;
            return {};
          },
          ...censusCapabilities(boundRow),
        },
        undefined,
        makeEgressSink(db),
      );
      const r = await exec.execute(action);
      const rows = egressRows(db);
      if (r.status !== "rejected") failures.push(`${label}: status ${r.status}`);
      if (dispatches !== 0) failures.push(`${label}: dispatched`);
      // The discard follows only a declined CloudFormation deploy, with its own ledger row.
      const discarding = action.type === "iac.cloudformation.deploy";
      if (discards !== (discarding ? 1 : 0)) failures.push(`${label}: ${discards} discards`);
      const want = (boundRow === undefined ? 1 : 2) + (discarding ? 1 : 0);
      const writeRow = rows.at(discarding ? -2 : -1);
      if (rows.length !== want || writeRow?.resultStatus !== "blocked") {
        failures.push(`${label}: rows ${JSON.stringify(rows)}`);
      }
      if (discarding && rows.at(-1)?.hitlStatus !== "not_required") {
        failures.push(`${label}: the discard is not its own not_required row`);
      }
      db.close();
    }
    expect(failures).toEqual([]);
  });

  test("a failed append dispatches nothing", async () => {
    const { ToolExecutor } = await import("../engine/executor.ts");
    const failures: string[] = [];
    for (const { label, action } of writesUnderTest()) {
      let dispatches = 0;
      const exec = new ToolExecutor(
        { requestApproval: async () => ({ approved: true, answerSource: "human" as const }) },
        { recordAudit: () => {} },
        {
          dispatch: async () => {
            dispatches += 1;
            return {};
          },
        },
        undefined,
        {
          append: () => {
            throw new Error("append failed");
          },
        },
      );
      let threw = false;
      try {
        await exec.execute(action);
      } catch {
        threw = true;
      }
      if (!threw) failures.push(`${label}: execute did not reject`);
      if (dispatches !== 0) failures.push(`${label}: dispatched after a failed append`);
    }
    expect(failures).toEqual([]);
  });

  test("the coverage set is the whole table", () => {
    expect(CONNECTOR_WRITE_ROWS).toHaveLength(125);
    expect(writesUnderTest()).toHaveLength(CONNECTOR_WRITE_ROWS.length + 4);
  });

  test("D22 confines connectors.dispatch to executor.ts, the egress append to egress/*, the agent brief append to agents-rpc.ts, emitter imports to agents-rpc.ts, and registerRoute to llm/registry.ts", async () => {
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D22-connectors-dispatch");
    expect(audit).toContain("D22-egress-append");
    expect(audit).toContain("D22-agent-brief-egress");
    expect(audit).toContain("D22-agent-emitter-import");
    // (e) — the route-table chokepoint. Unlike (a), this one does NOT rest on its own name alone:
    // the "checker actually rejects an unwrapped route registration" test below drives
    // `checkEgressChokepointConfinement` directly, so a deleted rule body fails there too.
    expect(audit).toContain("D22-register-route");

    // The five assertions above are string-presence checks, and all five of those strings are
    // `rule:` literals INSIDE the check functions — so they scan for a token that lives in the
    // definition being scanned for. Deleting the `run()` block that INVOKES the checks leaves
    // every one of them green while `audit:invariants` stops executing D22 entirely.
    //
    // Rules (b), (c) and (e) survive that by luck or by design: (b) and (c) each have an
    // independent tree-scan further down this file, and (e) is driven directly through
    // `checkEgressChokepointConfinement` by the "rejects an unwrapped route registration" test.
    // Rule (a), the `connectors.dispatch` confinement, has none — so its only enforcement is
    // the invocation, and its only assertion was the presence of its own name.
    //
    // Same wiring shape as the scan-floor assertion in the audit script's own suite: prove the
    // function is CALLED, not merely that it exists.
    // Assert the INDEX, not the slice. `indexOf` returning -1 makes `slice(-1)` the last character
    // of the file — non-empty, so `expect(runBody).not.toBe("")` passes and the failure that
    // follows reads as "the invocation is missing" when the real cause is that `run` was renamed
    // or removed.
    const runAt = audit.indexOf("async function run(");
    expect(runAt).toBeGreaterThan(-1);
    const runBody = audit.slice(runAt);
    for (const invocation of [
      "checkEgressChokepointConfinement(files)",
      "checkAgentEmitterImportConfinement(files)",
      // D10-wrap-spec is per-SITE as of #1219, which makes its invocation worth pinning too:
      // it is the only thing standing between a dropped `wrap(` and an unsandboxed MCP child.
      "checkWrapServerSpecInvariant(files)",
    ]) {
      expect(runBody).toContain(invocation);
    }
  });

  test("D22(d): the emitter-import rule flags ALL THREE module-resolution forms", async () => {
    // Rule (c) pins the CALLER of the appender, which catches a second file ACQUIRING the appender
    // — but not a second file that serves a brief WITHOUT calling it. That path spells nothing (c)
    // matches: it would append no row, serve the brief, and leave audit:invariants green. This file
    // predicted that gap in prose before it was closed; rule (d) closes it.
    //
    // Both forms are required. A static-only regex is defeated by the one-character change from
    // `import x from "…"` to `await import("…")` — a bypass hiding in plain sight, and the reason
    // this asserts the two constants exist rather than trusting one pattern to cover both.
    const audit = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(audit).toContain("D22_EMITTER_STATIC_RE");
    expect(audit).toContain("D22_EMITTER_DYNAMIC_RE");
    // `require` is the third spelling, and Bun honours it from a .ts module — a rule matching only
    // the two `import` forms reported green while that door stood open.
    expect(audit).toContain("D22_EMITTER_REQUIRE_RE");

    // ...and the rule is exercised, not merely declared. A name-presence assertion passes for a
    // regex that is defined and never wired into the check, which is exactly the state this rule
    // was in before the `require` gap was closed. Each form is planted and the audit must flag it.
    for (const contents of [
      'import { emitWhyBrief } from "../agents/why.ts";',
      'const m = await import("../agents/why.ts");',
      'const m = require("../agents/why.ts");',
    ]) {
      const violations = checkAgentEmitterImportConfinement([
        { relPath: "packages/gateway/src/ipc/http-server.ts", contents: `${contents}\n` },
      ]);
      expect({ contents, flagged: violations.map((v) => v.rule) }).toEqual({
        contents,
        flagged: ["D22-agent-emitter-import"],
      });
    }
    // The negative control: the allowed door and the excluded `_lib` path must NOT be flagged, or
    // the loop above would pass for a rule that simply rejects everything.
    expect(
      checkAgentEmitterImportConfinement([
        {
          relPath: "packages/gateway/src/ipc/agents-rpc.ts",
          contents: 'import { emitWhyBrief } from "../agents/why.ts";\n',
        },
        {
          relPath: "packages/gateway/src/federation/peer-fanout.ts",
          contents: 'import type { GapNote } from "../agents/_lib/findings.ts";\n',
        },
      ]),
    ).toEqual([]);
    expect(audit).toContain("checkAgentEmitterImportConfinement");
  });

  test("D22(d): agents/_lib re-exports no emitter — the gap the import regex cannot see", async () => {
    // A regex over import SPECIFIERS does not follow re-export chains. Were an emitter re-exported
    // through `agents/_lib/`, a file could import it from the EXCLUDED path and rule (d) would miss
    // — the same shape as D22's recorded wrapper/façade limit. That gap is closed by ASSERTION
    // here, not by trusting the import rule to cover something it structurally cannot.
    //
    // Resolved from REPO_ROOT (which derives from this helper's own location), never the process CWD: a
    // CWD-relative read passes from the repo root and throws ENOENT under CI's sharded runner,
    // which is how a guard ends up dead in the only place it has to work.
    const libDir = resolve(REPO_ROOT, "packages/gateway/src/agents/_lib");
    const entries = await readdir(libDir);
    const offenders: string[] = [];
    for (const f of entries) {
      if (!f.endsWith(".ts") || f.endsWith(".test.ts")) continue;
      const src = await readFile(resolve(libDir, f), "utf8");
      // Any re-export whose specifier climbs out of _lib and back into agents/ itself.
      if (/export\s[^;]*from\s+["'`]\.\.\/[A-Za-z][\w-]*\.ts["'`]/.test(src)) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    // Guard the guard: if the directory scan finds nothing, the assertion above is vacuous.
    expect(entries.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(5);
  });

  test("I29: the D22 comment does not claim totality it cannot enforce", async () => {
    // D22 matches a literal string; it cannot see `inner.dispatch(action)`. Claiming otherwise is
    // the defect Phase 1 fixes — a label that leads its mechanism.
    const src = await read("scripts/structure-audit/check-nimbus-invariants.ts");
    expect(src).not.toContain("no escape hatch");
    expect(src).toContain("matches the literal string");
  });

  test("appendEgressEntry( is called only from files under packages/gateway/src/egress/", async () => {
    // A source scan of the CALL form, not the bare identifier: matching `appendEgressEntry\(`
    // (with the open paren) means an import (`import { appendEgressEntry } from ...`) or a
    // comment mentioning the name cannot satisfy — or falsely trip — this guard. Only an actual
    // invocation counts. Scans production `.ts` AND `.tsx` (fix 4 — `packages/gateway/src` has no
    // `.tsx` today, so this is forward-looking hardening; without it, a future `appendEgressEntry(`
    // call in a production `.tsx` outside `egress/` would silently bypass this guard by extension
    // alone) and excludes `.test.ts`/`.test.tsx`. The relative path is derived via `relative()` +
    // `sep` from `node:path` rather than manual slicing/backslash normalization, so it holds up
    // across platforms. Mirrors the production D22 static audit's scope
    // (`checkEgressChokepointConfinement` in check-nimbus-invariants.ts), which also exempts
    // test files — egress-adjacent tests (e.g. `ipc/egress-rpc.test.ts`) legitimately call
    // it directly to seed fixture rows.
    const dir = resolve(REPO_ROOT, "packages/gateway/src");
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const offenders: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isSourceFile = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
      const isTestFile = entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx");
      if (!isSourceFile || isTestFile) continue;
      const parentDir = "path" in entry && typeof entry.path === "string" ? entry.path : dir;
      const abs = resolve(parentDir, entry.name);
      const relFromGatewaySrc = relative(dir, abs).split(sep).join("/");
      const contents = await readFile(abs, "utf8");
      if (contents.includes("appendEgressEntry(") && !relFromGatewaySrc.startsWith("egress/")) {
        offenders.push(relFromGatewaySrc);
      }
    }
    expect(offenders).toEqual([]);
  });

  test("I29/D22(c): recordAgentBriefEgress is named by exactly two production files", async () => {
    // The MCP brief chokepoint is TOTAL only if the appender has one caller. Scanned the same way
    // as the `appendEgressEntry(` guard above — a `readdir` walk of production `.ts`/`.tsx` under
    // `packages/gateway/src`, with `relative()` + `sep` so the paths hold up on every platform —
    // rather than shelling out to `rg`, which is not guaranteed present on a CI runner.
    //
    // The BARE identifier is matched, not the call form: a file that merely imports the appender
    // has already acquired the capability. That is the same regex the production D22 rule (c)
    // uses, with ONE deliberate difference — the static audit strips comments first, this scan
    // does not. So naming the appender in a doc comment elsewhere fails HERE and not there. That
    // asymmetry is the conservative direction and is kept on purpose (it also keeps this guard
    // free of a comment-stripper of its own to drift); refer to the module path
    // `egress/agent-brief-egress.ts` in prose rather than the bare symbol.
    const dir = resolve(REPO_ROOT, "packages/gateway/src");
    const entries = await readdir(dir, { recursive: true, withFileTypes: true });
    const namers: string[] = [];
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const isSourceFile = entry.name.endsWith(".ts") || entry.name.endsWith(".tsx");
      const isTestFile = entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx");
      if (!isSourceFile || isTestFile) continue;
      const parentDir = "path" in entry && typeof entry.path === "string" ? entry.path : dir;
      const abs = resolve(parentDir, entry.name);
      const contents = await readFile(abs, "utf8");
      if (contents.includes("recordAgentBriefEgress")) {
        namers.push(relative(dir, abs).split(sep).join("/"));
      }
    }
    expect(namers.sort()).toEqual(["egress/agent-brief-egress.ts", "ipc/agents-rpc.ts"]);
  });

  test("I29: the MCP brief append runs BEFORE the dispatch and is not swallowed", async () => {
    // Ordering and the absence of a try/catch are the whole property: an append that runs after
    // the handler, or one whose failure is caught, records a brief that has already been served.
    //
    // The scanned region runs from the FUNCTION HEADER to the dispatch, not from the append to the
    // dispatch. An append-to-dispatch window plus a `catch` check was evadable twice over: a `try
    // {` opened before the append with its `catch` placed after the dispatch sits entirely outside
    // such a window at both ends, so neither the opener nor the handler is ever looked at. Widening
    // the region is what makes the added `try` assertion bite; the `try` assertion alone on the
    // narrow window would have proved nothing.
    const src = await read("packages/gateway/src/ipc/agents-rpc.ts");
    const fnAt = src.indexOf("export async function dispatchAgentsRpc(");
    const appendAt = src.indexOf("recordAgentBriefEgress(ctx.db");
    const dispatchAt = src.indexOf("dispatchByMethod<AgentsRpcContext>");
    expect(fnAt).toBeGreaterThan(-1);
    expect(appendAt).toBeGreaterThan(-1);
    expect(dispatchAt).toBeGreaterThan(-1);
    expect(fnAt).toBeLessThan(appendAt);
    expect(appendAt).toBeLessThan(dispatchAt);
    const guardedRegion = src.slice(fnAt, dispatchAt);
    expect(guardedRegion).not.toContain("catch");
    expect(guardedRegion).not.toContain("try");
    // The ledgered set is the SERVED set: the append is gated on membership of the handler map the
    // dispatch itself consumes, never on the `agents.` namespace prefix. Prefix-gating appended an
    // `authorized` row for an unrecognised method that then failed -32601, so `nimbus prove`
    // over-counted, and it admitted an unbounded caller-controlled `method` into a hashed,
    // append-only column (`payload_summary` is capped at 256 bytes; `method` is not).
    expect(guardedRegion).toContain("Object.hasOwn(AGENTS_RPC_HANDLERS, method)");
    expect(guardedRegion).not.toContain('method.startsWith("agents.")');
    // The caller kind is server-derived (`ctx.caller`), never read out of the RPC params. The
    // condition is a lookup over a TOTAL map rather than an equality on one transport, so a new
    // client kind is a compile error rather than a silently unledgered surface — see
    // egress/egress-bearing-kinds.ts.
    expect(src).toContain("egressSourceTypeForClientKind(ctx.caller?.kind)");
    // ...and the kind is never reconstructed from the payload. Asserted as an absence because the
    // presence check above would still pass if a params-derived fallback were added beside it.
    expect(src).not.toMatch(/params\s*\.\s*kind/);
    expect(src).not.toMatch(/\bp\.kind\b/);
  });

  test("I29: COVERAGE_CLASSES is exactly the non-marker source types", () => {
    // The two lists are separate declarations, so a tenth source type can land in one and not the
    // other. That mismatch is silent: an egress-bearing class with no coverage entry is never
    // claimed and never noticed. This is the assertion that makes adding a class a deliberate act.
    // Compared as plain strings: the two arrays have different (deliberately non-overlapping)
    // literal-union element types, so `toEqual` would not typecheck on the narrow types.
    const nonMarker: string[] = EGRESS_SOURCE_TYPES.filter((t) => !MARKER_SOURCE_TYPES.has(t));
    const classes: string[] = [...COVERAGE_CLASSES];
    expect(classes.sort()).toEqual(nonMarker.sort());
  });

  test("I29: every coverage class claiming non-none has a landed appender", () => {
    // `mcp` and `http` are per-call because recordAgentBriefEgress serves BOTH transports and its
    // dispatcher condition ships in the same commit as this claim. `sync` is now `per-run`: BOTH of
    // its injection seams (`sync/scheduler.ts`'s `appendSyncEgress`, `sync/targeted-fetch.ts`'s
    // `appendEgress`) are wired in the same commit as this raise — `platform/assemble.ts`'s only
    // production `new SyncScheduler(...)` passes `appendSyncEgress`, and it is the sole builder of
    // `targetedFetch`'s deps — both closures around ONE appender, `egress/sync-egress.ts`'s
    // `recordSyncEgress`. `per-run`, not `per-call`, because the scheduler side appends ONE row per
    // paginated run (many upstream calls), the weaker of the two shapes this class actually backs.
    // (A THIRD closure around the same appender landed in a later commit than this raise, and
    // serves TWO more callers: `multimodal/cloud-url-resolver.ts`'s append before the credentialed
    // byte-URL resolve round-trip and `multimodal/cloud-bytes.ts`'s per-attempt cloud byte-fetch
    // append. A later commit added a FIFTH caller directly, with no closure of its own:
    // `ipc/connector-rpc-handlers/auth.ts`'s `verifyBeforeStoreWithScopes`, before the pre-store
    // credential probe — so the class has FIVE callers behind one appender. None changes the
    // `per-run` granularity, since none is weaker than the scheduler's already-weakest shape.)
    // `model` is now the FIFTH non-`none` class, backed by FOUR appenders: the route-table
    // provider wrapper (`egress/model-egress.ts`'s `wrapLedgeredProvider`, applied at
    // `LlmRegistry.addRoute`, covering `LlmRouter.generate`/`generateMarkdown`/every
    // `selectProvider()` caller — synthesis among them, via `agents/_lib/synthesis-llm.ts` under
    // `[agents] synthesis = "local"` or `"allow-remote"`, reached in production from
    // `ipc/server/dispatchers.ts` and `agent-runs/agent-http-invoke.ts`'s
    // `buildAgentSynthesisRunner`); the Mastra engine agent (`egress/mastra-model-egress.ts`'s
    // `wrapLedgeredMastraModel`, since that agent resolves its model through `@mastra/core` outside
    // the route table entirely); remote embeddings (`egress/embedding-egress.ts`'s
    // `wrapLedgeredEmbedder`, applied at each of the embedding pipeline's three construction sites);
    // and vision (`egress/vlm-egress.ts`'s `wrapLedgeredVlm`, the same decorator shape applied to a
    // `VlmProvider` — confined to its own file plus `multimodal/build-media-pass-deps.ts` by static
    // D22(g), with no remote `VlmProvider` constructed yet in production, so this appender ships
    // before the caller that will exercise it, same as the other three did in their turn).
    // The local-vs-remote split is enforced INSIDE each wrapper — derived from `provider.isLocal` /
    // the embedder's own locality, never a caller-supplied boolean — so a wiring mistake at a call
    // site cannot fabricate a `model` row for a local generation, embed, or vision describe. It is
    // `per-call` over all four, and the class still carries no NAMED exclusion: a local provider, a
    // locally-run Mastra model, a local embedder (MiniLM), or a local VLM (Ollama) each append
    // nothing by design, not as a gap — that is the bound that survives, not a claim that no vector,
    // prompt, or image can ever leave unrecorded.
    // `chatops` is now the SIXTH non-`none` class, per-call, and unlike `mcp`/`http` it is NOT
    // narrower than its name: its appender (`egress/chatops-egress.ts`'s `buildLedgeredChatPosts`)
    // decorates the single `post` closure that every chat consumer shares, so one row is appended
    // per outbound post regardless of which consumer sent it.
    // `browser` is the SEVENTH non-`none` class, `per-run`, RAISED in the same commit as its
    // production caller — `computer-use/cu-lanes/browser.ts`'s `openBrowserLane`, which wraps the
    // CDP-backed context it constructs and enables `Fetch` interception THROUGH the wrapper, so
    // every request is decided and ledgered before it is allowed to proceed. `per-run` rather than
    // `per-call`: one row per (destination origin, verdict) pair, so a row can stand for many
    // requests to that origin. This entry was raised ONCE before, early and wrongly — on the
    // reasoning that the appender's own commit would follow immediately, which it did not, because
    // the driver task was re-planned mid-slice — and was restored to `none` until a caller existed.
    // That caller now exists and is pinned by the D26(c) test in the I35 block below.
    // `tool` is the EIGHTH non-`none` class, `per-call`, RAISED in the same commit that gave
    // `recordToolEgress` its production caller — `toolgen/toolgen-broker.ts`'s brokered-fetch
    // handler, wired onto the spawned tool's stdio protocol by `toolgen-client.ts`'s
    // `spawnGeneratedTool`. Per this file's own rule, never ahead of that landing (I39).
    // `registry` is the NINTH non-`none` class, `per-call`, RAISED in the same commit that gave
    // `recordRegistryEgress` its production caller, `extensions/registry/registry-fetch.ts`, the
    // one function that fetches registry bytes (static D22(h)).
    // `peer`/`session` stay `none` until THEIR appenders land — raising an
    // entry without a landed appender behind it is a review moment, not a test to re-bank. (An
    // earlier version of this comment pointed to an `EgressCompleteness.tier` #1057 note in
    // `egress/egress-verify.ts` for whoever landed the fifth class to read; that field existed and
    // was removed in #1057 per `docs/CHANGELOG.md`'s 2026-08-11 entry — "`EgressCompleteness.tier`
    // is gone; the coverage vector is the only claim" — so the pointer was stale, not fictional, and
    // there was nothing left in that file to settle or re-defer.)
    const claimed = COVERAGE_CLASSES.filter((c) => THIS_BINARY_COVERAGE[c] !== "none");
    expect([...claimed].sort()).toEqual([
      "browser",
      "chatops",
      "http",
      "mcp",
      "model",
      "registry",
      "sync",
      "task",
      "tool",
    ]);
  });

  test("the executor's egress sink is a REQUIRED constructor parameter", async () => {
    // A required parameter makes an unwired sink a compile error rather than a silent no-op. The
    // named NULL_EGRESS_SINK keeps the "this executor performs no egress" decision on the record.
    const src = await read("packages/gateway/src/engine/executor.ts");
    expect(src).toContain("private readonly egressSink: EgressSink,");
    expect(src).not.toContain("private readonly egressSink?: EgressSink,");
  });

  test("I29: runAsk's egress sink is a REQUIRED field, and the getDatabase-guarded NULL_EGRESS_SINK fallback is gone", async () => {
    // runAsk is the agent-action path (nimbus ask / agent.invoke / the ChatOps read path) — the
    // most dispatch-capable path in the product, and the one `nimbus prove` itself exercises. It
    // used to silently substitute NULL_EGRESS_SINK whenever `p.localIndex.getDatabase` wasn't a
    // function, which meant a real dispatch could execute with zero ledger rows and no signal.
    // `RunAskParams.egressSink` is now a required field, consumed directly (`p.egressSink`) — the
    // file no longer imports `makeEgressSink`/`NULL_EGRESS_SINK` as VALUES (only `EgressSink` as a
    // type) or constructs a sink itself, so it cannot silently manufacture a no-op fallback.
    const src = await read("packages/gateway/src/engine/run-ask.ts");
    expect(src).toContain("egressSink: EgressSink;");
    expect(src).not.toContain("egressSink?: EgressSink");
    expect(src).toContain("p.egressSink");
    // Neither NULL_EGRESS_SINK nor makeEgressSink is imported as a VALUE from egress-ledger.ts —
    // only the EgressSink TYPE is imported — so the file has nothing to build a fallback sink from.
    // (Matched against the import line specifically: both names legitimately appear in doc-comment
    // prose above, e.g. "a caller ... must pass `NULL_EGRESS_SINK` explicitly".)
    expect(src).not.toMatch(
      /import\s*\{[^}]*(NULL_EGRESS_SINK|makeEgressSink)[^}]*\}\s*from\s*"\.\.\/egress\/egress-ledger\.ts"/,
    );
  });

  test("NULL_EGRESS_SINK leaves a real ledger untouched, where makeEgressSink writes", () => {
    // Asserts REAL behaviour against a real ledger — not that a spy counted a call. The two sinks
    // are handed the identical entry so the only variable is which sink received it.
    const entry = {
      timestamp: 1,
      sourceType: "task",
      sourceId: null,
      destination: "d",
      method: "m",
      payloadSummary: "{}",
      hitlStatus: "not_required",
      resultStatus: "authorized",
    } as const;

    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);

    NULL_EGRESS_SINK.append(entry);
    expect(egressHead(db).count).toBe(0);

    makeEgressSink(db).append(entry);
    expect(egressHead(db).count).toBe(1);
    db.close();
  });

  // The route table is the boundary the model-class appender sits on. A file that calls
  // `registerRoute` directly enters that table WITHOUT `addRoute`'s `wrapLedgeredProvider`,
  // so its provider would generate with no ledger row -- I29's `model` class silently
  // incomplete, with the static audit green.
  test("I29/D22(e): registerRoute is named only by registry.ts and its own definition", async () => {
    const files = await readDirFiles("packages/gateway/src");
    const callers = files
      .filter((f) => /\bregisterRoute\b/.test(stripComments(f.contents)))
      .map((f) => `packages/gateway/src/${f.rel}`)
      .sort();
    expect(callers).toEqual([
      "packages/gateway/src/llm/registry.ts",
      "packages/gateway/src/llm/router.ts",
    ]);
  });

  // D22(e) stops a SECOND file entering the route table unwrapped. This stops the ONE
  // permitted file entering it with nothing to ledger to: `addRoute` hands `this.db` to
  // `wrapLedgeredProvider`, so an optional `db` meant a registry could exist that could not
  // record egress. That was a runtime refusal until 2026-08-28 and is now a type error --
  // asserted here on the SOURCE, because a type error is invisible to a runtime suite and
  // would otherwise be pinned nowhere the invariant's own tests can see.
  test("I29: LlmRegistryOptions.db is non-optional, so an unledgerable registry cannot exist", async () => {
    // Resolved from REPO_ROOT, never cwd — every other file-reading helper here does the
    // same. A bare relative path passes locally (repo root) and fails in the coverage step,
    // which runs with a different working directory: ENOENT, not a real invariant breach.
    const src = stripComments(
      await readFile(resolve(REPO_ROOT, "packages/gateway/src/llm/registry.ts"), "utf8"),
    );
    const optionsBlock = /export type LlmRegistryOptions = \{([\s\S]*?)\}/.exec(src)?.[1] ?? "";
    expect(optionsBlock).not.toBe("");
    // The whole assertion: `db: Database`, never `db?: Database`.
    expect(/\bdb\s*\?\s*:/.test(optionsBlock)).toBe(false);
    expect(/\bdb\s*:\s*Database\b/.test(optionsBlock)).toBe(true);
  });

  test("I29: the checker actually rejects an unwrapped route registration", () => {
    const violations = checkEgressChokepointConfinement([
      {
        relPath: "packages/gateway/src/platform/assemble.ts",
        contents: "router.registerRoute(provider, 'm');",
      },
    ]);
    expect(violations.map((v) => v.rule)).toContain("D22-register-route");
  });

  test("I29: every remote-embedder construction site wraps with the appender", async () => {
    // Rule (f) stops a NEW file calling the appender; this stops an EXISTING construction site
    // quietly dropping it. Asserted on source because the sites build real network clients.
    //
    // A plain `toContain("createOpenAIEmbedder")` + `toMatch(/wrapLedgeredEmbedder\(/)` pair --
    // the previous shape of this test -- proves only CO-OCCURRENCE: a SECOND, unwrapped
    // `createOpenAIEmbedder(...)` added anywhere else in the same file would satisfy both
    // assertions while the second call shipped un-ledgered. Delegating to
    // `checkEmbeddingConstructorConfinement` proves ASSOCIATION instead -- every call is
    // paren-matched as textually nested inside a `wrapLedgeredEmbedder(...)` argument list --
    // against the REAL file contents, so this fails the moment a real site regresses.
    const sites = [
      "packages/gateway/src/embedding/create-routing-runtime.ts",
      "packages/gateway/src/embedding/create-embedding-runtime.ts",
      "packages/gateway/src/ipc/index-reembed-rpc.ts",
    ];
    for (const rel of sites) {
      const contents = await readFile(resolve(REPO_ROOT, rel), "utf8");
      const violations = checkEmbeddingConstructorConfinement([{ relPath: rel, contents }]);
      expect(violations).toEqual([]);
    }
  });

  test("I29: an unwrapped createOpenAIEmbedder call in an approved file is still caught", () => {
    // The regression this closes: the allow-list used to skip ALL checking once a file's path
    // matched, so a SECOND, bare `createOpenAIEmbedder(...)` added to an already-approved file
    // -- as opposed to a brand-new file -- was invisible to every guard. This fixture is exactly
    // that shape: a real appender call earns the file its place on the allow-list, and a second,
    // unwrapped construction sits right beside it, unassociated with any `wrapLedgeredEmbedder`.
    const unwrappedFixture = [
      "const wrapped = wrapLedgeredEmbedder(db, await createOpenAIEmbedder({ apiKey }));",
      "const rogue = await createOpenAIEmbedder({ apiKey: other });",
    ].join("\n");
    const violations = checkEmbeddingConstructorConfinement([
      {
        relPath: "packages/gateway/src/embedding/create-routing-runtime.ts",
        contents: unwrappedFixture,
      },
    ]);
    expect(violations.map((v) => v.rule)).toEqual(["embedding-constructor-confined"]);
    expect(violations[0]?.snippet).toContain("rogue");
  });

  test("I29/D22(g): wrapLedgeredVlm and createOllamaVlm are confined to their allow-lists", async () => {
    const { checkVlmAppenderConfinement } = await import(
      "../../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    // Same content, two paths -- the "clean" case passes because of allow-list MEMBERSHIP, not
    // because this content is inherently harmless: the same string at a non-allow-listed path
    // (below) trips both rules, proving the fixture would fail if the allow-list were wrong.
    const content = "const vlm = wrapLedgeredVlm(db, createOllamaVlm({}));";
    const clean = checkVlmAppenderConfinement([
      { relPath: "packages/gateway/src/multimodal/build-media-pass-deps.ts", contents: content },
    ]);
    expect(clean).toHaveLength(0);

    const dirty = checkVlmAppenderConfinement([
      { relPath: "packages/gateway/src/multimodal/media-pass.ts", contents: content },
    ]);
    expect(dirty.map((v) => v.rule).sort()).toEqual([
      "vlm-appender-confined",
      "vlm-constructor-confined",
    ]);
  });

  test("I29/D22(g): wrapLedgeredVlm referenced outside its allow-list is caught", async () => {
    // The decorator half has no dedicated test on its own -- without this, the "clean"
    // assertion above would pass just as well against `checkVlmAppenderConfinement` stubbed to
    // `return []`. A bare reference (no call parens) is enough to trip it, since it also catches
    // a stray IMPORT of the decorator, not only a call.
    const { checkVlmAppenderConfinement } = await import(
      "../../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    const dirty = checkVlmAppenderConfinement([
      {
        relPath: "packages/gateway/src/multimodal/media-pass.ts",
        contents: 'import { wrapLedgeredVlm } from "../egress/vlm-egress.ts";',
      },
    ]);
    expect(dirty.map((v) => v.rule)).toContain("vlm-appender-confined");
  });

  test("I29/D22(g): a SECOND, unwrapped createOllamaVlm beside a wrapped one in an approved file is still caught", async () => {
    // The regression item 1 exists to close: an earlier shape of this rule skipped an
    // allow-listed file wholesale once its path matched, so a second, unwrapped construction
    // planted beside a legitimate wrapped call was invisible to every guard. This fixture is
    // exactly that shape, mirroring the analogous embedding-constructor test above.
    const { checkVlmAppenderConfinement } = await import(
      "../../../../scripts/structure-audit/check-nimbus-invariants.ts"
    );
    const unwrappedFixture = [
      "const wrapped = wrapLedgeredVlm(db, createOllamaVlm({ baseUrl }));",
      'const rogue = createOllamaVlm({ baseUrl: "https://vendor.example" });',
    ].join("\n");
    const violations = checkVlmAppenderConfinement([
      {
        relPath: "packages/gateway/src/multimodal/build-media-pass-deps.ts",
        contents: unwrappedFixture,
      },
    ]);
    expect(violations.map((v) => v.rule)).toEqual(["vlm-constructor-confined"]);
    expect(violations[0]?.snippet).toContain("rogue");
  });

  test("I29: a non-local VlmProvider cannot describe without a model-class row", async () => {
    // The decorator, not a call site, is the appender — so this holds for callers written later.
    // `read()`, not a bare relative `Bun.file("packages/...")`: CI's coverage job `cd`s into
    // `packages/gateway` before running `bun test`, so a cwd-relative path ENOENTs there while
    // resolving fine from the repo root. That is why this helper exists.
    const src = await read("packages/gateway/src/egress/vlm-egress.ts");
    // Append precedes delegation, and the append failure path throws rather than continuing.
    // Anchored on the CALL (`appendEgressEntry(db`), matching the precedent this file already
    // uses for `recordAgentBriefEgress(ctx.db` — a bare `indexOf("appendEgressEntry")` would
    // match the IMPORT statement near the top of the file instead, which sits before every
    // ordering regardless of where the call itself moved, making the assertion pass even if the
    // decorator delegated first and appended after.
    const appendAt = src.indexOf("appendEgressEntry(db");
    const delegateAt = src.indexOf("provider.describe(input)");
    expect(appendAt).toBeGreaterThan(-1);
    expect(delegateAt).toBeGreaterThan(appendAt);
    expect(src).toContain("throw new EgressAppendFailedError");
    // Locality is DERIVED, never a parameter (I34).
    expect(src).toContain("if (provider.isLocal)");
    expect(src).not.toMatch(/\bisLocal\s*:\s*boolean\s*[,)]/);
  });

  test("the pre-store credential probe appends one sync row BEFORE its request (connector.credentialProbe)", async () => {
    const { Database } = await import("bun:sqlite");
    const { LocalIndex } = await import("../index/local-index.ts");
    const { createMockVault } = await import("../vault/mock.ts");
    const { handleConnectorAuth } = await import("../ipc/connector-rpc-handlers/auth.ts");
    const db = new Database(":memory:");
    try {
      LocalIndex.ensureSchema(db);
      const count = (): number =>
        db
          .query<{ n: number }, []>(
            "SELECT COUNT(*) AS n FROM egress_ledger WHERE method = 'connector.credentialProbe'",
          )
          .get()?.n ?? 0;
      let atProbe = -1;
      await handleConnectorAuth({
        rec: { service: "github", token: "ghp_invariant" },
        vault: createMockVault(),
        localIndex: new LocalIndex(db),
        openUrl: async () => {},
        syncScheduler: undefined,
        connectorMesh: undefined,
        runCredentialProbe: async () => {
          atProbe = count();
          return { kind: "valid" };
        },
      });
      expect(atProbe).toBe(1);
      const src = await read("packages/gateway/src/ipc/connector-rpc-handlers/auth.ts");
      expect(src).toMatch(/method: "connector\.credentialProbe"/);
    } finally {
      db.close();
    }
  });

  test("behavioural: an extension sync appends ONE sync.run row per run under its index id, and none while its credential is blank", async () => {
    const { insertExtensionRow } = await import("../automation/extension-store.ts");
    const { upsertRunGrant } = await import("../extensions/run-grant-store.ts");
    const { createExtensionCredentialsResolver } = await import(
      "../connectors/extension-sync/extension-identity.ts"
    );
    const { createExtensionSyncRegistrar } = await import("../platform/register-extension-sync.ts");
    const { SyncScheduler } = await import("../sync/scheduler.ts");
    const { ProviderRateLimiter } = await import("../sync/rate-limiter.ts");
    const { unboundSyncCapabilities } = await import("../sync/sync-capabilities.ts");
    const { createMemoryVault, openMemoryIndexDatabase } = await import(
      "../testing/bun-test-support.ts"
    );
    const pino = (await import("pino")).default;
    const db = openMemoryIndexDatabase();
    const vault = createMemoryVault();
    const manifest = {
      id: "i29.sync",
      version: "1.0.0",
      permissions: { network: [], filesystem: { read: [], write: [] } },
      updateChannel: "stable" as const,
      credentials: { token: { env: "I29_TOKEN" } },
      sync: { contract: "1" as const, intervalSeconds: 300, itemTypes: ["note"] },
    };
    insertExtensionRow(db, {
      id: "i29.sync",
      version: "1.0.0",
      install_path: join(tmpdir(), "i29-nowhere"),
      manifest_hash: "h",
      entry_hash: "e",
      installed_at: 1,
      last_verified_at: 1,
      tree_digest: "d",
    });
    upsertRunGrant(db, {
      extension_id: "i29.sync",
      service_id: "ext_i29_sync",
      version: "1.0.0",
      tree_digest: "d",
      permissions_json: JSON.stringify({ network: [], read: [], write: [] }),
      model_access: 0,
      approved_at: 1,
      credentials_json: JSON.stringify({
        token: { env: "I29_TOKEN", vaultKey: "ext.ext_i29_sync.token" },
      }),
    });
    const rows: Array<{ destination: string; sourceType: string; method: string }> = [];
    const sched = new SyncScheduler(
      {
        ...unboundSyncCapabilities(),
        db,
        vault,
        logger: pino({ level: "silent" }),
        rateLimiter: new ProviderRateLimiter(),
        sandboxCwd: tmpdir(),
        credentialFor: () => ({ credential: "personal" }),
        runTeamList: async () => [],
        depth: "full",
        extensionCredentialsFor: createExtensionCredentialsResolver(db, [], () => manifest),
      },
      undefined,
      { appendSyncEgress: (r) => rows.push(r) },
    );
    let calls = 0;
    try {
      createExtensionSyncRegistrar({
        db,
        vault,
        scheduler: sched,
        mesh: {
          callExtensionSyncTool: async () => {
            calls += 1;
            return {
              status: "ok",
              items: [
                { type: "note", externalId: `n${calls}`, title: "t", modifiedAt: 1, metadata: {} },
              ],
              cursor: `c${calls}`,
              hasMore: calls === 1,
            };
          },
        },
        sandbox: reachRunner(() => null),
        runtimeReadPaths: () => [],
        table: [],
        readManifest: () => manifest,
      }).refresh("i29.sync");
      await vault.set("ext.ext_i29_sync.token", "  ");
      await sched.forceSync("ext_i29_sync");
      expect({ rows: rows.length, calls }).toEqual({ rows: 0, calls: 0 });
      await vault.set("ext.ext_i29_sync.token", "tok");
      await sched.forceSync("ext_i29_sync");
      // Two pages, one run, one row.
      expect(calls).toBe(2);
      expect(rows).toEqual([
        { destination: "ext_i29_sync", sourceType: "sync", method: "sync.run" },
      ]);
    } finally {
      await sched.stop();
      db.close();
    }
  });

  // ---- Phase 28 AD4: the door and the proposer in BOTH ledgers ------------------------------------

  test("AD4: an outside agent's write and its before-state read name the SAME capture in both ledgers, and no hashed egress field holds the label", async () => {
    const { ToolExecutor, NO_POLICY_OVERLAY } = await import("../engine/executor.ts");
    const { createBeforeStateRunner, isBeforeReadActionType } = await import(
      "../engine/before-state.ts"
    );
    const { appendAuditEntry } = await import("../db/audit-chain.ts");
    const { makeEgressSink } = await import("../egress/egress-ledger.ts");
    const db = freshEgressDb();
    const captureId = `cap_${"5a".repeat(16)}`;
    const label = `a|b"cd${String.fromCodePoint(0x1f600)}|agent:cap_other`;
    const exec = new ToolExecutor(
      { requestApproval: async () => ({ approved: true, answerSource: "human" as const }) },
      { recordAudit: (e) => appendAuditEntry(db, e) },
      {
        dispatch: async (a) =>
          isBeforeReadActionType(a.type)
            ? {
                key: "NIM-1",
                fields: { summary: "s", status: { name: "Open" }, issuetype: { name: "Bug" } },
              }
            : { ok: true },
      },
      undefined,
      makeEgressSink(db),
      NO_POLICY_OVERLAY,
      () => "team",
      { beforeState: createBeforeStateRunner({ rows: CONNECTOR_WRITE_ROWS }) },
    );
    await exec.execute({
      type: "jira.comment.add",
      origin: "agent",
      proposer: {
        door: "agent",
        captureId,
        label,
        labelSource: "declared",
        summary: "s",
        createdAt: 0,
        expiresAt: 1,
      },
      payload: { mcpToolId: "jira_comment_add", input: { issueKey: "NIM-1", body: "hi" } },
    });
    const ledger = db
      .query("SELECT source_id, payload_summary FROM egress_ledger ORDER BY id")
      .all() as Array<{
      source_id: string;
      payload_summary: string;
    }>;
    expect(ledger.map((r) => r.source_id)).toEqual([`agent:${captureId}`, `agent:${captureId}`]);
    const audit = db.query("SELECT action_json FROM audit_log ORDER BY id").all() as Array<{
      action_json: string;
    }>;
    expect(audit).toHaveLength(2);
    for (const r of audit) expect(r.action_json).toContain(`"captureId":"${captureId}"`);
    // The label is only in the unhashed summary (cut) and the audit JSON; never in source_id.
    expect(ledger.some((r) => r.source_id.includes("|"))).toBe(false);
    db.close();
  });

  test("AD4: the egress entry is built BEFORE the audit row, so a malformed capture id writes neither (source pin on gateWithin)", async () => {
    const src = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    const start = src.indexOf("private async gateWithin(");
    expect(start).toBeGreaterThan(0);
    const body = src.slice(start);
    const build = body.indexOf("const egressEntry = buildEgressEntry({");
    const audit = body.indexOf("this.audit.recordAudit({");
    const append = body.indexOf("this.egressSink.append(egressEntry);");
    expect(build).toBeGreaterThan(0);
    expect(build).toBeLessThan(audit);
    expect(audit).toBeLessThan(append);
  });

  test("AD4: the audit projection copies exactly door, captureId, label and labelSource, by name, before the payload (static D49(c))", async () => {
    const src = stripComments(await read("packages/gateway/src/engine/executor.ts"));
    expect(src).toMatch(
      /proposer:\s*\{\s*door:\s*proposer\.door,\s*captureId:\s*proposer\.captureId,\s*label:\s*proposer\.label,\s*labelSource:\s*proposer\.labelSource,\s*\},\s*\.\.\.others,/,
    );
    // The three sub-step sites pass the parent's attribution in their scope.
    expect(src.split("...subStepAttribution(action, scope)").length - 1).toBe(3);
  });

  test("AD4: the agent: source prefix is written only by egress-record.ts and read only by the proof reader", async () => {
    expect(await grepRepo(/\bAGENT_SOURCE_PREFIX\b/)).toEqual([
      "packages/gateway/src/audit/agent-door-proof.ts",
      "packages/gateway/src/egress/egress-record.ts",
    ]);
  });

  test("AD4: the two proof methods check the connection's kind first, off the LAN and off the renderer allowlist", async () => {
    const src = stripComments(await read("packages/gateway/src/ipc/audit-rpc.ts"));
    for (const fn of ["handleProveByProposer", "handleListByDoor"]) {
      const start = src.indexOf(`function ${fn}(`);
      expect(start).toBeGreaterThan(0);
      const body = src.slice(start, start + 400);
      expect(body.indexOf("requireProofCaller(ctx,")).toBeGreaterThan(0);
      expect(body.indexOf("requireProofCaller(ctx,")).toBeLessThan(
        body.indexOf("paramsObject(params,"),
      );
    }
    expect(src).toContain(`new Set<ClientKind>(["cli", "ui"])`);
    const rust = await read("packages/ui/src-tauri/src/gateway_bridge.rs");
    expect(rust).not.toMatch(/^\s*"audit\.(proveByProposer|listByDoor)",/m);
  });

  test("AD4: the submit and accept rows carry the label and the SUBMITTING connection's id inside their hashed JSON", async () => {
    const gate = stripComments(await read("packages/gateway/src/mcp-sink/capture-gate.ts"));
    expect(gate).toContain("connection: caller.clientId,");
    const act = stripComments(await read("packages/gateway/src/mcp-sink/capture-act.ts"));
    expect(act).toContain('door: "agent",');
    expect(act).toContain("clientLabel: row.clientLabel,");
    expect(act).toContain("connection: row.sessionId,");
  });
});

describe("I29 — the ChatOps watcher notice is ledgered before the post and fails closed", () => {
  test("the watcherNotice kind is in the total ChatPostKind record with its own method", async () => {
    const src = await read("packages/gateway/src/egress/chatops-egress.ts");
    expect(src).toContain('| "watcherNotice"');
    expect(src).toContain('watcherNotice: "chatops.watcherNotice"');
    expect(src).toContain('watcherNotice: wrap("watcherNotice")');
  });

  test("the boot's watcher dispatcher posts through posts.watcherNotice and no other kind", async () => {
    const src = stripComments(await read("packages/gateway/src/chatops/chatops-boot.ts"));
    expect(src).toMatch(
      /watcherNoticeDispatcher = new ReplyDispatcher\(\{\s*post: posts\.watcherNotice,/,
    );
    expect(src).toMatch(
      /postWatcherNotice: \(namespace, text\) =>\s*cfg\.slackEnabled\s*\?\s*watcherNoticeDispatcher\.send\(/,
    );
  });

  test("a watcher notice appends one row BEFORE the post, and a failed append posts nothing", async () => {
    const { buildLedgeredChatPosts } = await import("../egress/chatops-egress.ts");
    const { runIndexedSchemaMigrations } = await import("../index/migrations/runner.ts");
    const { CURRENT_SCHEMA_VERSION } = await import("../index/local-index.ts");
    const { listEgress } = await import("../egress/egress-verify.ts");
    const { EgressAppendFailedError } = await import("../egress/model-egress.ts");
    const db = new Database(":memory:");
    runIndexedSchemaMigrations(db, CURRENT_SCHEMA_VERSION);
    const salt = Buffer.alloc(32, 3).toString("base64");
    const order: string[] = [];
    const posts = buildLedgeredChatPosts(
      db,
      async () => {
        order.push(`post-with-${String(listEgress(db, { limit: 10 }).length)}-rows`);
      },
      salt,
    );
    await posts.watcherNotice("slack", "C1", "Nimbus watcher notice");
    expect(order).toEqual(["post-with-1-rows"]);
    expect(listEgress(db, { limit: 10 }).map((r) => r.method)).toEqual(["chatops.watcherNotice"]);
    db.close();
    await expect(posts.watcherNotice("slack", "C1", "x")).rejects.toBeInstanceOf(
      EgressAppendFailedError,
    );
    expect(order).toEqual(["post-with-1-rows"]);
  });
});
