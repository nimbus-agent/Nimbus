import type { Database } from "bun:sqlite";
import type { EvalReport } from "@nimbus-dev/registry-format";

import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";
import type { NimbusVault } from "../vault/index.ts";
import { loadEvalClientFactory } from "./eval/eval-role.ts";
import { type EvalRuntimeDeps, runEvalSession } from "./eval/eval-runtime.ts";
import {
  type EvalPackageSource,
  EvalRunError,
  loadEvalPackage,
  messageOf,
} from "./eval/eval-source.ts";
import type { ExtensionRunGrantEnv } from "./extension-run-grants.ts";
import { ExtensionRunGrantError } from "./run-grant-error.ts";
import { readVerifiedExtensionForEval } from "./verified-extension.ts";

/**
 * Evaluating INSTALLED extensions through the gateway (invariant I49): every extension is verified
 * and its suites read BEFORE the owner is asked (no extension code runs), the LOCAL owner approves
 * the whole call ONCE (`extension.eval`), and then each extension is reloaded, re-verified and
 * evaluated in the sandbox, one at a time. This lives outside `extensions/eval/` because it reads
 * the DB and the Vault, which D38 forbids there.
 */

export type InstalledEvalResult =
  | { id: string; version: string; ok: true; report: EvalReport }
  | { id: string; version: string | null; ok: false; error: { code: string; message: string } };

export interface InstalledEvalDeps {
  readonly db: Database;
  readonly vault: NimbusVault;
  readonly env: ExtensionRunGrantEnv;
  /** The executor's gate: resolves `true` only when the LOCAL owner approved the action. */
  readonly ownerGate: (action: {
    type: string;
    payload: Record<string, unknown>;
  }) => Promise<boolean>;
  readonly sandboxDir: string;
  readonly runtimeReadPaths: readonly string[];
  readonly canConfine: (p: SandboxPolicy) => string | null;
  /** Defaults to the eval role's adapter over a dynamically imported `@mastra/mcp`. */
  readonly createClient?: EvalRuntimeDeps["createClient"];
  readonly verify?: typeof readVerifiedExtensionForEval;
  readonly load?: typeof loadEvalPackage;
  readonly run?: typeof runEvalSession;
}

export const EXTENSION_EVAL_ACTION_TYPE = "extension.eval";

/** The owner denied (or did not answer) the one `extension.eval` approval: nothing ran. */
export class EvalApprovalDenied extends Error {
  readonly code = "ERR_EXTENSION_EVAL_NOT_APPROVED";
  constructor() {
    super("ERR_EXTENSION_EVAL_NOT_APPROVED: the evaluation was not approved; nothing ran");
    this.name = "EvalApprovalDenied";
  }
}

/** The extension is no longer what the owner approved (or its files disagree with its row). */
export class InstalledEvalChanged extends Error {
  readonly code = "ERR_EXTENSION_EVAL_CHANGED";
  constructor(message: string) {
    super(`ERR_EXTENSION_EVAL_CHANGED: ${message}`);
    this.name = "InstalledEvalChanged";
  }
}

/** One extension that passed every pre-consent check, as the owner is shown it. */
interface Prepared {
  readonly id: string;
  readonly version: string;
  readonly installPath: string;
  readonly treeDigest: string;
  readonly filesDigest: string;
  readonly cases: number;
}

interface Io {
  readonly verify: typeof readVerifiedExtensionForEval;
  readonly load: typeof loadEvalPackage;
  readonly run: typeof runEvalSession;
}

type Results = Map<string, InstalledEvalResult>;

function errorOf(e: unknown): { code: string; message: string } {
  if (
    e instanceof ExtensionRunGrantError ||
    e instanceof EvalRunError ||
    e instanceof InstalledEvalChanged
  ) {
    return { code: e.code, message: e.message };
  }
  return { code: "ERR_EVAL_INTERNAL", message: messageOf(e) };
}

function failure(id: string, version: string | null, e: unknown): InstalledEvalResult {
  return { id, version, ok: false, error: errorOf(e) };
}

function caseCount(src: EvalPackageSource): number {
  return src.suites.reduce((n, s) => n + s.cases.length, 0);
}

/** The package on disk must be the extension the row names, at the row's version. */
function assertSamePackage(id: string, version: string, src: EvalPackageSource): void {
  if (src.extensionId !== id || src.version !== version) {
    throw new InstalledEvalChanged(
      `${id}@${version}'s files declare ${src.extensionId}@${src.version}; reinstall it`,
    );
  }
}

// ── Phase 1: pre-consent — verify and read every extension; no extension code runs ──────────────

/** One extension's pre-consent checks; a failure is returned as that extension's result. */
async function prepareOne(
  id: string,
  deps: InstalledEvalDeps,
  io: Io,
): Promise<Prepared | InstalledEvalResult> {
  // Known once verification passed, so a later failure is reported against it.
  let version: string | null = null;
  try {
    const verified = await io.verify(id, { db: deps.db, vault: deps.vault, env: deps.env });
    version = verified.version;
    const src = await io.load(verified.installPath);
    assertSamePackage(id, verified.version, src);
    return {
      id,
      version: verified.version,
      installPath: verified.installPath,
      treeDigest: verified.treeDigest,
      filesDigest: src.filesDigest,
      cases: caseCount(src),
    };
  } catch (e) {
    return failure(id, version, e);
  }
}

async function prepareAll(
  ids: readonly string[],
  deps: InstalledEvalDeps,
  io: Io,
  results: Results,
): Promise<Prepared[]> {
  const prepared: Prepared[] = [];
  for (const id of ids) {
    const r = await prepareOne(id, deps, io);
    if ("ok" in r) results.set(id, r);
    else prepared.push(r);
  }
  return prepared;
}

// ── Phase 2: ONE approval for the whole call ────────────────────────────────────────────────────

async function askOwnerOnce(prepared: readonly Prepared[], deps: InstalledEvalDeps): Promise<void> {
  const approved = await deps.ownerGate({
    type: EXTENSION_EVAL_ACTION_TYPE,
    payload: {
      extensions: prepared.map((p) => ({ id: p.id, version: p.version, cases: p.cases })),
    },
  });
  if (approved !== true) throw new EvalApprovalDenied();
}

// ── Phase 3: post-consent — per extension, reload → re-verify → evaluate ────────────────────────

/**
 * The ORDER is the TOCTOU defence: a change before or during the reload is caught by the
 * re-verification that follows it; a change after it by staging's copy-vs-`filesDigest` check.
 */
async function evaluateOne(
  p: Prepared,
  deps: InstalledEvalDeps,
  io: Io,
  createClient: () => Promise<EvalRuntimeDeps["createClient"]>,
): Promise<EvalReport> {
  const src = await io.load(p.installPath);
  const verified = await io.verify(p.id, { db: deps.db, vault: deps.vault, env: deps.env });
  if (
    verified.treeDigest !== p.treeDigest ||
    verified.version !== p.version ||
    verified.installPath !== p.installPath ||
    src.filesDigest !== p.filesDigest
  ) {
    throw new InstalledEvalChanged(`${p.id} changed after it was approved; nothing was run`);
  }
  assertSamePackage(p.id, p.version, src);
  return io.run(src, {
    sandboxDir: deps.sandboxDir,
    runtimeReadPaths: deps.runtimeReadPaths,
    canConfine: deps.canConfine,
    createClient: await createClient(),
  });
}

/** The client factory, resolved once and only after consent (no `@mastra/mcp` load before). */
function clientFactory(deps: InstalledEvalDeps): () => Promise<EvalRuntimeDeps["createClient"]> {
  let pending: Promise<EvalRuntimeDeps["createClient"]> | undefined;
  return () => {
    if (deps.createClient !== undefined) return Promise.resolve(deps.createClient);
    pending ??= loadEvalClientFactory();
    return pending;
  };
}

async function evaluateEach(
  prepared: readonly Prepared[],
  deps: InstalledEvalDeps,
  io: Io,
  results: Results,
): Promise<void> {
  const createClient = clientFactory(deps);
  for (const p of prepared) {
    try {
      const report = await evaluateOne(p, deps, io, createClient);
      results.set(p.id, { id: p.id, version: p.version, ok: true, report });
    } catch (e) {
      results.set(p.id, failure(p.id, p.version, e));
    }
  }
}

/**
 * Evaluate installed extensions behind ONE owner approval. Returns one result per requested id,
 * in request order (a duplicate id is evaluated once and its result repeated). Throws
 * {@link EvalApprovalDenied} when the owner denies, in which case nothing ran.
 */
export async function evaluateInstalledExtensions(
  ids: readonly string[],
  deps: InstalledEvalDeps,
): Promise<InstalledEvalResult[]> {
  const io: Io = {
    verify: deps.verify ?? readVerifiedExtensionForEval,
    load: deps.load ?? loadEvalPackage,
    run: deps.run ?? runEvalSession,
  };
  const unique = [...new Set(ids)];
  const results: Results = new Map();
  // 1. pre-consent: verify + read suites + count cases; failures become per-id errors
  const prepared = await prepareAll(unique, deps, io, results);
  if (prepared.length > 0) {
    // 2. one approval; a denial throws and nothing runs
    await askOwnerOnce(prepared, deps);
    // 3. post-consent, sequentially: reload → re-verify → evaluate
    await evaluateEach(prepared, deps, io, results);
  }
  return ids.map((id) => resultFor(results, id));
}

function resultFor(results: Results, id: string): InstalledEvalResult {
  const r = results.get(id);
  if (r === undefined) throw new Error(`internal: no eval result for ${id}`);
  return r;
}
