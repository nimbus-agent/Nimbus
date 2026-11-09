/**
 * The settlers of a plan-bound IaC write (Phase 9.7 D2, invariant I54, spec § 15.5).
 *
 * A bound row's prepare child (`terraform plan`, `create-change-set`) is the same kind of process
 * that will later apply, so nothing it says about its own result is an identity. The settle step
 * runs AFTER the prepare reply passes its size cap and BEFORE the row's bound values are taken, and
 * it fixes the identity itself:
 *
 *  - {@link settleTerraformPlan}: the plan file the child saved is checked to be THE regular,
 *    unlinked file the child was asked to write inside this run's staging directory, MOVED into a
 *    gateway-owned `approved/<runId>/<planId>/` directory, re-checked, read ONCE into memory and
 *    hashed by the gateway, made read-only, and shown to a second `terraform show -json` child that
 *    sees no network and no credential. The hash that child reports must equal the gateway's own.
 *    The values bound are the MOVED path and the GATEWAY's hash, never the child's.
 *  - {@link settleCfnChangeSet}: the credentialed connector's `describe-change-set` projection
 *    cannot be re-derived without a second credentialed AWS call, so the reply is cross-checked
 *    against the caller's own input (stack, template hash, a name that carries that hash, the
 *    capability set) and what cannot be checked is stated (I54): the change list is the
 *    connector's word; what AWS executes is the immutable change set named by the bound ARN.
 *
 * Both are pure over injected operations (no dispatch, no executor) and refuse with a fixed
 * {@link PREPARE_REFUSALS} reason on every mismatch. They self-clean on a refusal: nothing a
 * refused plan left on disk lingers. The runtime capabilities that call them reach the gate through
 * {@link BoundWriteCapabilities} on the dispatcher (round-2 fix 1): this file defines the type and
 * wires nothing.
 *
 * The only filesystem calls on a plan file are in this module (static rule D42(h), planned).
 */

import { createHash } from "node:crypto";
import {
  chmod,
  copyFile,
  constants as fsConstants,
  lstat,
  mkdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
} from "node:fs/promises";
import { basename, isAbsolute, join } from "node:path";
import { IAC_LIMITS } from "../connectors/connector-writes/iac-limits.ts";
import {
  escapeOneLine,
  renderedText,
  renderPlanPreview,
} from "../connectors/connector-writes/iac-plan-preview.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import { sha256HexEqualConstantTime } from "../util/timing-safe-compare.ts";
import type { SettledWrite } from "./bound-write-capabilities.ts";
import { PREPARE_REFUSALS, PrepareRefusedError } from "./prepare-step.ts";

// The shapes the gate sees live in ./bound-write-capabilities.ts (a leaf module, so the dispatcher's
// type can name them without a cycle); re-exported here for the settlers' callers.
export type {
  BoundWriteCapabilities,
  PreflightOutcome,
  SettleContext,
  SettledWrite,
} from "./bound-write-capabilities.ts";

// ---------------------------------------------------------------------------------------------
// The filesystem, injected.

export interface SettleStat {
  readonly isFile: boolean;
  readonly isDirectory: boolean;
  readonly isSymbolicLink: boolean;
  readonly size: number;
  readonly nlink: number;
}

/** The filesystem operations a Terraform settle needs; {@link nodeSettleFs} is the real one. */
export interface SettleFs {
  /** `lstat` (never follows a link); `undefined` when the path does not exist. */
  lstat(path: string): Promise<SettleStat | undefined>;
  /** The real path (links and aliases resolved). Rejects when the path does not exist. */
  realpath(path: string): Promise<string>;
  /** Creates `path` and its parents (mode 0700). Existing is fine. */
  mkdirp(path: string): Promise<void>;
  /** Creates `path` (mode 0700), whose parent exists. Rejects when it already exists. */
  mkdirNew(path: string): Promise<void>;
  /** Moves a file; copies and unlinks across devices. Never overwrites. */
  move(from: string, to: string): Promise<void>;
  readFile(path: string): Promise<Uint8Array>;
  chmod(path: string, mode: number): Promise<void>;
  /** Removes a tree without following a link; a missing path is fine. */
  removeTree(path: string): Promise<void>;
}

interface NodeSettleFsDeps {
  /** The rename seam (a test makes it fail with EXDEV). */
  readonly rename?: (from: string, to: string) => Promise<void>;
}

/** The real {@link SettleFs}, on `node:fs/promises`. */
export function nodeSettleFs(deps: NodeSettleFsDeps = {}): SettleFs {
  const doRename = deps.rename ?? rename;
  return {
    async lstat(path) {
      try {
        const s = await lstat(path);
        return {
          isFile: s.isFile(),
          isDirectory: s.isDirectory(),
          isSymbolicLink: s.isSymbolicLink(),
          size: s.size,
          nlink: s.nlink,
        };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
        throw e;
      }
    },
    realpath: (path) => realpath(path),
    async mkdirp(path) {
      await mkdir(path, { recursive: true, mode: 0o700 });
    },
    async mkdirNew(path) {
      await mkdir(path, { mode: 0o700 });
    },
    async move(from, to) {
      try {
        // rename replaces an existing destination on POSIX; the settler's destination is a fresh
        // directory, so there is nothing to replace.
        await doRename(from, to);
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EXDEV") throw e;
        await copyFile(from, to, fsConstants.COPYFILE_EXCL);
        await unlink(from);
      }
    },
    readFile: (path) => readFile(path),
    chmod: (path, mode) => chmod(path, mode),
    async removeTree(path) {
      await rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Terraform.

export interface TerraformSettleOps {
  readonly fs: SettleFs;
  /**
   * The gate's `iac_terraform_show_json` call, run in the `show` profile (no network, no
   * credential). Resolves the raw reply; rejects with a {@link PrepareRefusedError} the gate maps.
   */
  show(args: { readonly workingDirectory: string; readonly planFile: string }): Promise<unknown>;
  /** `bytes` random bytes as lower-case hex (the run id). */
  randomHex(bytes: number): string;
}

export interface TerraformSettleRequest {
  /** `true` for the destroy row: the plan must be `destroy.tfplan`. */
  readonly destroy: boolean;
  readonly workingDirectory: string;
  /** The plan child's raw reply (`{planId, planFile, planSha256, hasChanges}`). */
  readonly reply: unknown;
  /** The directory the gateway gave THIS run's plan child as `NIMBUS_IAC_PLAN_DIR`. */
  readonly stagingDir: string;
  /** `<iacRoot>/approved`; the settler makes `<runId>/<planId>` under it. */
  readonly approvedRoot: string;
}

export interface TerraformSettleLimits {
  readonly maxPlanFileBytes?: number;
  readonly maxPlanJsonBytes?: number;
}

const PLAN_ID = /^[0-9a-f]{32}$/;
const PLAN_NAME = "plan.tfplan";
const DESTROY_PLAN_NAME = "destroy.tfplan";

function refuse(reason: string): PrepareRefusedError {
  return new PrepareRefusedError(reason);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function field(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

interface PlanReply {
  readonly planId: string;
  readonly planFile: string;
  readonly hasChanges: boolean;
}

/** The plan child's reply, by shape alone. Anything else it said is not read. */
function readPlanReply(reply: unknown, name: string): PlanReply {
  if (!isRecord(reply)) throw refuse(PREPARE_REFUSALS.unbound);
  const planId = field(reply, "planId");
  const planFile = field(reply, "planFile");
  const hasChanges = field(reply, "hasChanges");
  if (typeof planId !== "string" || !PLAN_ID.test(planId)) throw refuse(PREPARE_REFUSALS.unbound);
  if (typeof planFile !== "string" || typeof hasChanges !== "boolean") {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  // A device or network form, a relative path, or the other kind of plan's name.
  if (
    planFile.startsWith("\\\\") ||
    planFile.startsWith("//") ||
    !isAbsolute(planFile) ||
    basename(planFile) !== name
  ) {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  return { planId, planFile, hasChanges };
}

function isPlainFile(st: SettleStat | undefined, max: number): boolean {
  if (st === undefined) return false;
  return st.isFile && !st.isSymbolicLink && !st.isDirectory && st.nlink === 1 && st.size <= max;
}

/**
 * Settles a Terraform plan (module comment). On success the caller owns `cleanup()`; on any refusal
 * the settler has already removed what it created and the staging directory, and throws a
 * {@link PrepareRefusedError} with a fixed reason (an error of any other kind becomes
 * `settleFailed`; its text goes nowhere).
 */
export async function settleTerraformPlan(
  ops: TerraformSettleOps,
  req: TerraformSettleRequest,
  limits: TerraformSettleLimits = {},
): Promise<SettledWrite> {
  const created: { runDir?: string; planDir?: string } = {};
  const cleanup = async (): Promise<void> => {
    try {
      if (created.planDir !== undefined) {
        // The plan directory was made read-only; a tree cannot be removed from under that.
        await ops.fs.chmod(created.planDir, 0o700).catch(() => undefined);
      }
      if (created.runDir !== undefined) await ops.fs.removeTree(created.runDir);
      await ops.fs.removeTree(req.stagingDir);
    } catch {
      // Best effort: a plan left behind is swept at the next gateway boot.
    }
  };
  try {
    return await settle(ops, req, limits, created, cleanup);
  } catch (e) {
    await cleanup();
    if (e instanceof PrepareRefusedError) throw e;
    throw refuse(PREPARE_REFUSALS.settleFailed);
  }
}

async function settle(
  ops: TerraformSettleOps,
  req: TerraformSettleRequest,
  limits: TerraformSettleLimits,
  created: { runDir?: string; planDir?: string },
  cleanup: () => Promise<void>,
): Promise<SettledWrite> {
  const maxFile = limits.maxPlanFileBytes ?? IAC_LIMITS.maxPlanFileBytes;
  const maxJson = limits.maxPlanJsonBytes ?? IAC_LIMITS.maxPlanJsonBytes;
  const name = req.destroy ? DESTROY_PLAN_NAME : PLAN_NAME;
  const { planId, planFile, hasChanges } = readPlanReply(req.reply, name);
  const fs = ops.fs;

  // 1. The file is the one the child was asked to write, inside this run's staging directory:
  //    its REAL path equals <real staging>/<planId>/<name> exactly (a link anywhere in the path, a
  //    sibling prefix directory or another plan id makes it differ), and it is a plain file.
  const stagingReal = await fs.realpath(req.stagingDir);
  let fileReal: string;
  try {
    fileReal = await fs.realpath(planFile);
  } catch {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  if (fileReal !== join(stagingReal, planId, name)) throw refuse(PREPARE_REFUSALS.unbound);
  if (!isPlainFile(await fs.lstat(planFile), maxFile)) throw refuse(PREPARE_REFUSALS.unbound);

  // 2. Nothing to apply is not an approval.
  if (!hasChanges) throw refuse(PREPARE_REFUSALS.nothingToApply);

  // 3. Move it where the planning child cannot reach, re-check, read ONCE, hash it ourselves.
  const runDir = join(req.approvedRoot, ops.randomHex(16));
  const planDir = join(runDir, planId);
  await fs.mkdirp(req.approvedRoot);
  await fs.mkdirNew(runDir);
  created.runDir = runDir;
  await fs.mkdirNew(planDir);
  created.planDir = planDir;
  const moved = join(planDir, name);
  await fs.move(fileReal, moved);
  if (!isPlainFile(await fs.lstat(moved), maxFile)) throw refuse(PREPARE_REFUSALS.unbound);
  const bytes = await fs.readFile(moved);
  if (bytes.length > maxFile) throw refuse(PREPARE_REFUSALS.unbound);
  const planSha256 = createHash("sha256").update(bytes).digest("hex");
  await fs.chmod(moved, 0o400);
  await fs.chmod(planDir, 0o500);

  // 4. Show it, in a child with no network and no credential. The hash it reports must be ours.
  const shown = await ops.show({ workingDirectory: req.workingDirectory, planFile: moved });
  if (!isRecord(shown)) throw refuse(PREPARE_REFUSALS.unbound);
  const reported = field(shown, "planSha256");
  if (typeof reported !== "string" || !sha256HexEqualConstantTime(reported, planSha256)) {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  const planJson = field(shown, "planJson");
  if (typeof planJson !== "string" || Buffer.byteLength(planJson, "utf8") > maxJson) {
    throw refuse(PREPARE_REFUSALS.unshowable);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(planJson);
  } catch {
    throw refuse(PREPARE_REFUSALS.unshowable);
  }

  // 5. Render the owner's view from that JSON alone.
  const rendered = renderPlanPreview(parsed, planSha256);
  if (!rendered.ok) {
    throw refuse(
      rendered.reason === "tooLarge" ? PREPARE_REFUSALS.diffTooLarge : PREPARE_REFUSALS.unshowable,
    );
  }
  const { counts } = rendered.preview;
  return {
    values: Object.freeze({ planFile: moved, planSha256 }),
    fields: [
      { label: "Plan SHA-256", value: planSha256 },
      { label: "Workdir", value: req.workingDirectory },
      {
        label: "Changes",
        value: `${String(counts.create + counts.replace)} to add, ${String(counts.update)} to change, ${String(counts.delete + counts.replace)} to destroy`,
      },
    ],
    plan: rendered.preview,
    cleanup,
  };
}

// ---------------------------------------------------------------------------------------------
// CloudFormation.

/** The change set ARN the connector accepts (its own regex), with the region and account captured. */
const CHANGE_SET_ARN =
  /^arn:aws[a-z-]*:cloudformation:([a-z0-9-]+):(\d{12}):changeSet\/([A-Za-z][-A-Za-z0-9]{0,127})\/[0-9a-f-]{36}$/;
const CHANGE_SET_TYPES: readonly string[] = ["CREATE", "UPDATE"];

export interface CfnSettleRequest {
  /** The write's input: `{stackName, templateBody, capabilities?}`. */
  readonly input: Readonly<Record<string, unknown>>;
  /** The prepare child's raw reply. */
  readonly reply: unknown;
}

export interface CfnSettleLimits {
  readonly maxRenderedBytes?: number;
  readonly maxChanges?: number;
}

interface CfnChange {
  readonly action: string;
  readonly logicalId: string;
  readonly resourceType: string;
  readonly replacement: string;
  readonly scope: readonly string[];
  readonly physicalId: string | undefined;
}

function stringList(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  const list: unknown[] = v;
  return list.every((x) => typeof x === "string") ? (list as string[]) : undefined;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return new Set(a).size === a.length && a.length === b.length && a.every((x) => b.includes(x));
}

function readChange(v: unknown): CfnChange {
  if (!isRecord(v)) throw refuse(PREPARE_REFUSALS.unshowable);
  const action = field(v, "action");
  const logicalId = field(v, "logicalId");
  const resourceType = field(v, "resourceType");
  const replacement = field(v, "replacement");
  const scope = stringList(field(v, "scope"));
  const physicalId = field(v, "physicalId");
  if (
    typeof action !== "string" ||
    typeof logicalId !== "string" ||
    typeof resourceType !== "string" ||
    typeof replacement !== "string" ||
    scope === undefined ||
    (physicalId !== undefined && typeof physicalId !== "string")
  ) {
    throw refuse(PREPARE_REFUSALS.unshowable);
  }
  return { action, logicalId, resourceType, replacement, scope, physicalId };
}

/** A removal or a (possible) replacement: listed first and counted in the footer. */
function isDestructive(c: CfnChange): boolean {
  return c.action === "Remove" || c.replacement === "True" || c.replacement === "Conditional";
}

function changeLine(c: CfnChange): string {
  const scope = c.scope.length === 0 ? "-" : c.scope.map(escapeOneLine).join(", ");
  const physical =
    c.physicalId === undefined ? "" : `, physical id: ${escapeOneLine(c.physicalId)}`;
  return `[${escapeOneLine(c.action)}] ${escapeOneLine(c.logicalId)} (${escapeOneLine(c.resourceType)}) Replacement: ${escapeOneLine(c.replacement)}, Scope: ${scope}${physical}`;
}

/**
 * Cross-checks a CloudFormation change set reply against the caller's own input and renders it
 * (module comment). Pure and synchronous; throws a {@link PrepareRefusedError}.
 */
export function settleCfnChangeSet(
  req: CfnSettleRequest,
  limits: CfnSettleLimits = {},
): SettledWrite {
  const { input, reply } = req;
  const stackName = field(input, "stackName");
  const templateBody = field(input, "templateBody");
  if (typeof stackName !== "string" || typeof templateBody !== "string") {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  if (!isRecord(reply)) throw refuse(PREPARE_REFUSALS.unbound);
  const templateBytes = Buffer.byteLength(templateBody, "utf8");
  const templateSha256 = createHash("sha256").update(templateBody, "utf8").digest("hex");

  const replyTemplate = field(reply, "templateSha256");
  const name = field(reply, "changeSetName");
  const id = field(reply, "changeSetId");
  const type = field(reply, "changeSetType");
  const replyCaps = stringList(field(reply, "capabilities"));
  const wantCaps = stringList(field(input, "capabilities") ?? []);
  if (
    field(reply, "stackName") !== stackName ||
    typeof replyTemplate !== "string" ||
    !sha256HexEqualConstantTime(replyTemplate, templateSha256) ||
    typeof name !== "string" ||
    !new RegExp(`^nimbus-${templateSha256}-[0-9a-f]{12}$`).test(name) ||
    typeof id !== "string" ||
    typeof type !== "string" ||
    !CHANGE_SET_TYPES.includes(type) ||
    replyCaps === undefined ||
    wantCaps === undefined ||
    !sameSet(replyCaps, wantCaps)
  ) {
    throw refuse(PREPARE_REFUSALS.unbound);
  }
  const arn = CHANGE_SET_ARN.exec(id);
  if (arn === null || arn[3] !== name) throw refuse(PREPARE_REFUSALS.unbound);
  const [, region, account] = arn;

  const rawChanges = field(reply, "changes");
  const maxChanges = limits.maxChanges ?? IAC_LIMITS.maxChanges;
  if (!Array.isArray(rawChanges) || rawChanges.length > maxChanges) {
    throw refuse(PREPARE_REFUSALS.unshowable);
  }
  const changes = (rawChanges as unknown[]).map(readChange);
  const destructive = changes.filter(isDestructive);
  const rest = changes.filter((c) => !isDestructive(c));

  const capabilityText =
    wantCaps.length === 0 ? "(none)" : [...wantCaps].sort(codeUnitCompare).join(", ");
  const templateText = `${String(templateBytes)} bytes, sha256 ${templateSha256.slice(0, 16)}`;
  const stackText = escapeOneLine(stackName);
  const lines = [
    `Stack: ${stackText}`,
    `Account / Region: ${String(account)} / ${String(region)}`,
    `Change set type: ${type}`,
    `Capabilities: ${capabilityText}`,
    `Template: ${templateText}`,
    `Changes: ${String(changes.length)}`,
    ...[...destructive, ...rest].map(changeLine),
    `End of change set: ${String(changes.length)} changes (${String(destructive.length)} removals or replacements)`,
  ];
  const text = renderedText(lines);
  if (text.bytes > (limits.maxRenderedBytes ?? IAC_LIMITS.maxRenderedBytes)) {
    throw refuse(PREPARE_REFUSALS.diffTooLarge);
  }
  return {
    values: Object.freeze({ changeSetId: id }),
    fields: [
      { label: "Stack", value: stackName },
      { label: "Account / Region", value: `${String(account)} / ${String(region)}` },
      { label: "Change set type", value: type },
      { label: "Capabilities", value: capabilityText },
      { label: "Template", value: templateText },
      { label: "Changes", value: String(changes.length) },
    ],
    plan: text,
    // The change set is an AWS object, not a file: removing an unused one is the gate's discard step.
    cleanup: () => Promise.resolve(),
  };
}
