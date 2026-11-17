// packages/gateway/src/automation/workflow-import.ts
// `importWorkflowBundle()`: the ONLY way a workflow definition from outside this install enters the
// saved-workflow store (I59, static D50(b)). In order, and every step before the write:
//
//   1. the connection is the owner's CLI or desktop (a kind the server holds, never a param);
//   2. the bundle verifies: size, strict envelope, Ed25519 signature over the domain-tagged canonical
//      body, canonical deterministic steps, `stepsSha256` (`workflow-bundle.ts`);
//   3. the optional `--signer` pin, the replay floor, the signer-change rule and the collision rule;
//   4. the schedule the OWNER asked for (a bundle cannot carry one), through `resolveSaveSchedule`;
//   5. the approval text is rendered from the STORED structure and is at most 64 KiB;
//   6. `dryRun` stops here; otherwise the LOCAL owner approves `workflow.import` over that text through
//      an executor with no delegation, honoured only for a `human` answer;
//   7. ONE transaction re-reads the target and the floor, compares them with what the prompt showed and
//      only then writes the workflow and its provenance together.
//
// What is shown, signed, stored and hashed is one string. An import creates no standing rule and inherits
// none (static D50(d): this module names no rule or learning table), and no schedule exists unless the
// owner asked for it in this same approval.

import type { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import type { OwnerApproval } from "../engine/owner-only-approval.ts";
import type { PlannedAction } from "../engine/types.ts";
import type { ClientKind } from "../ipc/server/client-kind.ts";
import { constantTimeStringEqual } from "../util/timing-safe-compare.ts";
import { verifyBundle } from "./workflow-bundle.ts";
import {
  type ImportPromptInput,
  ImportPromptTooLargeError,
  renderImportPrompt,
} from "./workflow-import-prompt.ts";
import {
  floorFor,
  readImportSource,
  recordImport,
  signerHistory,
  signersForName,
} from "./workflow-import-store.ts";
import { resolveSaveSchedule, ScheduleSaveError } from "./workflow-schedule.ts";
import { parseWorkflowSteps, workflowStepsSha256 } from "./workflow-steps.ts";
import {
  getWorkflowByName,
  upsertWorkflowByName,
  type WorkflowRow,
  type WorkflowSchedule,
} from "./workflow-store.ts";
import { writeToolInfo } from "./workflow-write-info.ts";

/** A refused import: `code` is the stable `ERR_*` a caller can match. */
export class ImportError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export const IMPORT_ERR = {
  LOCAL_ONLY: "ERR_WORKFLOW_IMPORT_LOCAL_ONLY",
  STALE: "ERR_WORKFLOW_IMPORT_STALE",
  SIGNER_MISMATCH: "ERR_WORKFLOW_IMPORT_SIGNER_MISMATCH",
  BAD_PIN: "ERR_WORKFLOW_IMPORT_BAD_SIGNER_PIN",
  REPLACE_REQUIRED: "ERR_WORKFLOW_IMPORT_REPLACE_REQUIRED",
  SIGNER_CHANGE: "ERR_WORKFLOW_IMPORT_SIGNER_CHANGED",
  NEEDS_HUMAN: "ERR_WORKFLOW_IMPORT_NEEDS_HUMAN",
  DECLINED: "ERR_WORKFLOW_IMPORT_DECLINED",
  CHANGED: "ERR_WORKFLOW_IMPORT_CHANGED",
  TOO_LARGE_TO_SHOW: "ERR_WORKFLOW_IMPORT_TOO_LARGE_TO_SHOW",
} as const;

/** The pin `--signer` takes: at least 12 hex characters of the signer's fingerprint. */
const PIN_PATTERN = /^[0-9a-fA-F]{12,32}$/;

export interface ImportDeps {
  readonly db: Database;
  readonly now: () => number;
  /** The LOCAL owner's approval (no delegation, a human answer only): `createOwnerOnlyAsk`. */
  readonly askOwner: (action: PlannedAction) => Promise<OwnerApproval>;
  /** The CONNECTION's declared kind (server-held), never a request field. */
  readonly clientKind: ClientKind;
}

export interface ImportParams {
  readonly bundleText: string;
  readonly replace?: boolean;
  readonly acceptSignerChange?: boolean;
  /** `--signer`: the fingerprint (at least 12 hex characters) the owner expects. */
  readonly signer?: string;
  /** The owner-typed schedule; never from the bundle. */
  readonly schedule?: unknown;
  readonly scheduleTz?: unknown;
  readonly dryRun?: boolean;
}

export type ImportResult =
  | {
      readonly dryRun: true;
      readonly promptText: string;
      readonly name: string;
      readonly signerFingerprint: string;
      readonly bundleSha256: string;
      readonly stepsSha256: string;
      readonly replaces: boolean;
      readonly signerChanged: boolean;
      readonly alreadyImported: boolean;
    }
  | {
      readonly dryRun: false;
      readonly id: string;
      readonly replaced: boolean;
      readonly alreadyImported: boolean;
      readonly name: string;
      readonly signerFingerprint: string;
      readonly stepsSha256: string;
      readonly scheduled: boolean;
    };

/** What the prompt showed about the target; the commit transaction must still find exactly this. */
type Showed = {
  readonly exists: boolean;
  readonly id: string | null;
  readonly stepsJson: string | null;
  readonly updatedAt: number | null;
  readonly schedule: string | null;
  readonly scheduleTz: string | null;
};

type FloorSeen = { readonly issuedAt: number; readonly bundleSha256: string } | null;

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex");

function showedOf(w: WorkflowRow | null): Showed {
  return {
    exists: w !== null,
    id: w?.id ?? null,
    stepsJson: w?.steps_json ?? null,
    updatedAt: w?.updated_at ?? null,
    schedule: w?.schedule ?? null,
    scheduleTz: w?.schedule_tz ?? null,
  };
}

function sameShowed(a: Showed, b: Showed): boolean {
  return (
    a.exists === b.exists &&
    a.id === b.id &&
    a.stepsJson === b.stepsJson &&
    a.updatedAt === b.updatedAt &&
    a.schedule === b.schedule &&
    a.scheduleTz === b.scheduleTz
  );
}

/** The `workflowStepsSha256` of a stored workflow, or `null` when its steps do not parse. */
function contentHashOf(stepsJson: string): string | null {
  try {
    return workflowStepsSha256(parseWorkflowSteps(stepsJson));
  } catch {
    return null;
  }
}

/** I10: digests are compared in constant time; an unknown hash never equals anything. */
function sameContentHash(a: string | null, b: string): boolean {
  return a !== null && constantTimeStringEqual(a, b);
}

function checkPin(pin: string | undefined, fingerprint: string): void {
  if (pin === undefined) return;
  if (!PIN_PATTERN.test(pin)) {
    throw new ImportError(
      IMPORT_ERR.BAD_PIN,
      "--signer must be at least 12 hexadecimal characters of the signer's fingerprint",
    );
  }
  if (!fingerprint.startsWith(pin.toLowerCase())) {
    throw new ImportError(
      IMPORT_ERR.SIGNER_MISMATCH,
      "the bundle is signed by a different key than the fingerprint you expected",
    );
  }
}

/**
 * The replay floor (spec § 2.2). A bundle older than the floor, or at it with different bytes, is stale.
 * The bundle the floor row itself recorded (equal time AND equal bytes) is a RESTORE: allowed, and the
 * floor does not move.
 */
function floorVerdict(
  seen: ReturnType<typeof floorFor>,
  issuedAt: number,
  bundleSha256: string,
): { restore: boolean; restoreAt: number | null } {
  if (seen === null) return { restore: false, restoreAt: null };
  if (
    issuedAt < seen.issuedAt ||
    (issuedAt === seen.issuedAt && !constantTimeStringEqual(bundleSha256, seen.bundleSha256))
  ) {
    throw new ImportError(
      IMPORT_ERR.STALE,
      "this bundle is not newer than one you already imported from this signer; ask the author to export it again",
    );
  }
  const restore = issuedAt === seen.issuedAt;
  return { restore, restoreAt: restore ? seen.importedAt : null };
}

function scheduleOf(
  deps: ImportDeps,
  params: ImportParams,
  stepsJson: string,
): WorkflowSchedule | null {
  try {
    return resolveSaveSchedule({
      schedule: params.schedule,
      scheduleTz: params.scheduleTz,
      stepsJson,
      clientKind: deps.clientKind,
      now: deps.now(),
    });
  } catch (e) {
    if (e instanceof ScheduleSaveError) throw new ImportError(e.code, e.message);
    throw e;
  }
}

function commit(
  deps: ImportDeps,
  p: {
    name: string;
    description: string | null;
    canonicalSteps: string;
    schedule: WorkflowSchedule | null;
    showed: Showed;
    floorSeen: FloorSeen;
    record: Omit<
      Parameters<typeof recordImport>[1],
      "workflowId" | "importedAt" | "approvalAuditId"
    >;
    auditId: number;
  },
): string {
  const { db } = deps;
  return db.transaction(() => {
    // The owner approved a state that must still hold: the target, its schedule and the floor.
    if (!sameShowed(p.showed, showedOf(getWorkflowByName(db, p.name)))) {
      throw new ImportError(
        IMPORT_ERR.CHANGED,
        "the workflow changed while you were being asked; nothing was written. Run the import again",
      );
    }
    const floorNow = floorFor(db, p.record.signerFingerprint, p.record.bundleName);
    const floorSame =
      p.floorSeen === null
        ? floorNow === null
        : floorNow !== null &&
          floorNow.issuedAt === p.floorSeen.issuedAt &&
          constantTimeStringEqual(floorNow.bundleSha256, p.floorSeen.bundleSha256);
    if (!floorSame) {
      throw new ImportError(
        IMPORT_ERR.CHANGED,
        "an import of this bundle changed while you were being asked; nothing was written",
      );
    }
    const now = deps.now();
    const id = upsertWorkflowByName(db, p.name, p.description, p.canonicalSteps, now, p.schedule);
    const recorded = recordImport(db, {
      ...p.record,
      workflowId: id,
      importedAt: now,
      approvalAuditId: p.auditId,
    });
    if (!recorded) {
      throw new ImportError(
        IMPORT_ERR.STALE,
        "a newer bundle from this signer was imported meanwhile",
      );
    }
    return id;
  })();
}

export async function importWorkflowBundle(
  deps: ImportDeps,
  params: ImportParams,
): Promise<ImportResult> {
  // 1. The owner's own connection (the kind is the CONNECTION's, never a param).
  if (deps.clientKind !== "cli" && deps.clientKind !== "ui") {
    throw new ImportError(
      IMPORT_ERR.LOCAL_ONLY,
      "a workflow is imported only from the owner's CLI or desktop on the local socket",
    );
  }
  const { db } = deps;
  // 2. Verify (throws BundleError; nothing else has happened).
  const bundle = verifyBundle(params.bundleText, deps.now());
  const { body } = bundle;
  const fp = bundle.signerFingerprint;
  // 3. Pin, floor, signer change, collision.
  checkPin(params.signer, fp);
  const { restore, restoreAt } = floorVerdict(
    floorFor(db, fp, body.name),
    body.issuedAt,
    bundle.bundleSha256,
  );
  const existing = getWorkflowByName(db, body.name);
  const stepsSha = body.stepsSha256;
  // A repeat of the recorded bundle with no schedule request and no dry run changes nothing. A dry
  // run still renders its preview, and a schedule request still goes through scheduleOf and approval.
  const noScheduleRequest = params.schedule === undefined && params.scheduleTz === undefined;
  if (
    restore &&
    params.dryRun !== true &&
    noScheduleRequest &&
    existing !== null &&
    sameContentHash(contentHashOf(existing.steps_json), stepsSha)
  ) {
    return {
      dryRun: false,
      id: existing.id,
      replaced: false,
      alreadyImported: true,
      name: body.name,
      signerFingerprint: fp,
      stepsSha256: stepsSha,
      scheduled: existing.schedule !== null && existing.schedule !== undefined,
    };
  }
  let signerChange: { fromFingerprint: string; at: number } | null = null;
  let importedFromFp12: string | null = null;
  if (existing !== null) {
    const source = readImportSource(db, existing.id);
    if (source !== null) importedFromFp12 = source.signerFingerprint.slice(0, 12);
    if (source !== null && source.signerFingerprint !== fp) {
      signerChange = { fromFingerprint: source.signerFingerprint, at: source.importedAt };
    }
    if (params.replace !== true) {
      throw new ImportError(
        IMPORT_ERR.REPLACE_REQUIRED,
        `a workflow named "${body.name}" already exists; pass --replace to replace it`,
      );
    }
    if (signerChange !== null && params.acceptSignerChange !== true) {
      throw new ImportError(
        IMPORT_ERR.SIGNER_CHANGE,
        "this workflow was imported from a different signer; pass --replace and --accept-signer-change to accept the new signer",
      );
    }
  }
  const deletedPriorSigner =
    existing === null
      ? (signersForName(db, body.name).find((r) => r.signerFingerprint !== fp)?.signerFingerprint ??
        null)
      : null;
  // 4. The schedule the owner asked for (never the bundle's: it has no field for one).
  const schedule = scheduleOf(deps, params, bundle.canonicalSteps);
  const showed = showedOf(existing);
  const floorSeenRow = floorFor(db, fp, body.name);
  const floorSeen: FloorSeen =
    floorSeenRow === null
      ? null
      : { issuedAt: floorSeenRow.issuedAt, bundleSha256: floorSeenRow.bundleSha256 };
  // 5. The approval text, from the stored structure.
  const clearsSchedule = existing?.schedule != null;
  const promptInput: ImportPromptInput = {
    name: body.name,
    signerFingerprint: fp,
    signerPrior: signerHistory(db, fp),
    authorLabel: body.author,
    issuedAt: body.issuedAt,
    description: body.description,
    target:
      existing === null
        ? { kind: "new" }
        : {
            kind: "replace",
            contentSha12: (contentHashOf(existing.steps_json) ?? sha256(existing.steps_json)).slice(
              0,
              12,
            ),
            updatedAt: existing.updated_at,
            importedFromFp12,
            identical: sameContentHash(contentHashOf(existing.steps_json), stepsSha),
            schedule:
              existing.schedule != null
                ? { expr: existing.schedule, tz: existing.schedule_tz ?? "" }
                : null,
          },
    signerChange,
    deletedPriorSigner,
    restoreOf: restoreAt,
    schedule,
    steps: bundle.steps,
    stepsSha256: stepsSha,
    writeInfo: writeToolInfo,
  };
  let promptText: string;
  try {
    promptText = renderImportPrompt(promptInput);
  } catch (e) {
    if (e instanceof ImportPromptTooLargeError) {
      throw new ImportError(IMPORT_ERR.TOO_LARGE_TO_SHOW, e.message);
    }
    throw e;
  }
  // 6. A dry run stops here: nothing is written and nobody is asked.
  if (params.dryRun === true) {
    return {
      dryRun: true,
      promptText,
      name: body.name,
      signerFingerprint: fp,
      bundleSha256: bundle.bundleSha256,
      stepsSha256: stepsSha,
      replaces: existing !== null,
      signerChanged: signerChange !== null,
      alreadyImported: false,
    };
  }
  // 7. The LOCAL owner approves; only a human answer counts.
  const approval = await deps.askOwner({
    type: "workflow.import",
    payload: {
      name: body.name,
      signerFingerprint: fp,
      bundleSha256: bundle.bundleSha256,
      stepsSha256: stepsSha,
      issuedAt: body.issuedAt,
      replace: existing !== null,
      schedule: schedule === null ? null : { expr: schedule.expr, tz: schedule.tz },
      clearsSchedule,
      promptText,
    },
  });
  if (!approval.approved) {
    throw new ImportError(
      approval.reason === "not_human" ? IMPORT_ERR.NEEDS_HUMAN : IMPORT_ERR.DECLINED,
      approval.reason === "not_human"
        ? "importing a workflow needs a person to answer the prompt (not --yes, a script or an old client)"
        : "the import was not approved; nothing was written",
    );
  }
  // 8. One transaction: re-check, then write the workflow and its provenance together.
  const id = commit(deps, {
    name: body.name,
    description: body.description,
    canonicalSteps: bundle.canonicalSteps,
    schedule,
    showed,
    floorSeen,
    record: {
      signerFingerprint: fp,
      bundleName: body.name,
      issuedAt: body.issuedAt,
      bundleSha256: bundle.bundleSha256,
      stepsSha256: stepsSha,
      signerPubkey: bundle.signerPubkeyB64,
      authorLabel: body.author,
    },
    auditId: approval.auditId,
  });
  return {
    dryRun: false,
    id,
    replaced: existing !== null,
    alreadyImported: false,
    name: body.name,
    signerFingerprint: fp,
    stepsSha256: stepsSha,
    scheduled: schedule !== null,
  };
}
