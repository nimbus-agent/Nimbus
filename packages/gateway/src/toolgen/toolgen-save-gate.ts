import type { Database } from "bun:sqlite";
import type { NimbusToolGenerationToml } from "../config/nimbus-toml.ts";
import { appendAuditEntry } from "../db/audit-chain.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { artifactDigest, canonicalArtifactBytes } from "./toolgen-artifact.ts";
import type { ToolgenSaveApprovalInput } from "./toolgen-consent-broker.ts";
import { signArtifact } from "./toolgen-keypair.ts";
import type { ToolgenRegistry } from "./toolgen-registry.ts";
import { getSavedTool, insertSavedTool, repairDisabledSavedTool } from "./toolgen-saved-repo.ts";
import { writeSavedTool } from "./toolgen-saved-store.ts";
import { emitToolScript } from "./toolgen-stub.ts";
import {
  ERR_TOOLGEN_SAVE_DISABLED,
  ERR_TOOLGEN_SAVE_NOT_LIVE,
  type GeneratedToolArtifact,
  ToolgenError,
} from "./toolgen-types.ts";

const CAPABILITY = "tool_generation";
const APPROVAL_TTL_MS = 120_000;

export interface ToolgenSaveDeps {
  readonly db: Database;
  /** Where `saved/<toolId>` lives — `toolgen-saved-store.ts`'s `savedToolDir` is derived from it. */
  readonly configDir: string;
  readonly config: Pick<NimbusToolGenerationToml, "enabled">;
  readonly enforced?: Pick<EnforcedPolicy, "capabilitiesDisabled"> | undefined;
  readonly registry: ToolgenRegistry;
  readonly vault: NimbusVault;
  readonly requestApproval: (input: ToolgenSaveApprovalInput, ttlMs: number) => Promise<boolean>;
  readonly now: () => number;
}

export type ToolgenSaveOutcome =
  | { readonly status: "saved"; readonly toolId: string }
  | { readonly status: "already_saved"; readonly toolId: string }
  | { readonly status: "repaired"; readonly toolId: string }
  | { readonly status: "denied" }
  | { readonly status: "refused"; readonly code: string };

type SaveOutcomeTag =
  | "already_saved"
  | "saved"
  | "repaired"
  | "denied_by_owner"
  | "refused_before_consent"
  | "failed_after_approval";

/**
 * `audit_log.hitl_status` is CHECK-constrained to approved/rejected/not_required
 * (`toolgen-gate.ts`'s `audit()` carries the same note for `tool.generate`). `tool.save` has TWO
 * outcomes with no fresh consent decision behind them at all — `already_saved` (a pure no-op: the
 * exact bytes are already durably saved and healthy) and `repaired` (the healing path skips the
 * prompt on purpose, spec § 6 step 6) — and both record `not_required` rather than `approved`,
 * because neither call made a NEW approval decision: claiming `approved` on either row would tell
 * an auditor a fresh consent event happened on a call where none did. `repaired` still reflects a
 * REAL earlier approval — that is exactly why it does not re-prompt — but the audit row is about
 * THIS call, not the one it is honoring.
 */
function hitlStatusFor(outcome: SaveOutcomeTag): "approved" | "rejected" | "not_required" {
  switch (outcome) {
    case "saved":
    case "failed_after_approval":
      return "approved";
    case "already_saved":
    case "repaired":
      return "not_required";
    case "denied_by_owner":
    case "refused_before_consent":
      return "rejected";
    default: {
      const exhaustive: never = outcome;
      throw new Error(`unreachable save outcome: ${String(exhaustive)}`);
    }
  }
}

function audit(
  deps: ToolgenSaveDeps,
  toolId: string,
  outcome: SaveOutcomeTag,
  payload: Record<string, unknown>,
): void {
  appendAuditEntry(deps.db, {
    actionType: "tool.save",
    hitlStatus: hitlStatusFor(outcome),
    actionJson: JSON.stringify({ outcome, toolId, ...payload }),
    timestamp: deps.now(),
  });
}

/**
 * Refusals decidable WITHOUT the owner — before any prompt, so a disabled capability never
 * advertises its own existence by prompting (mirrors `createGeneratedTool`'s step 1-2, and
 * `media.understand`'s I22 posture: fail-closed when the accessor itself is absent, never
 * defaulting to enabled).
 */
function assertSaveEnabled(deps: ToolgenSaveDeps): void {
  if (!deps.config.enabled) {
    throw new ToolgenError(ERR_TOOLGEN_SAVE_DISABLED, "tool generation is disabled");
  }
  if (deps.enforced === undefined) {
    throw new ToolgenError(ERR_TOOLGEN_SAVE_DISABLED, "org policy unavailable; refusing");
  }
  if (deps.enforced.capabilitiesDisabled.has(CAPABILITY)) {
    throw new ToolgenError(ERR_TOOLGEN_SAVE_DISABLED, "disabled by org policy");
  }
}

/**
 * The artifact comes from the live registry ENVELOPE, never re-read from disk — I33's read-once
 * rule, one hop on: the bytes the owner is about to be asked to persist forever must be exactly the
 * bytes they already approved to run once. Re-deriving them from anywhere else, disk included, is a
 * TOCTOU that defeats the gate, because the human is the entire boundary here.
 *
 * A terminated tool refuses the same way an unknown one does: saving code the owner may reasonably
 * believe has already stopped would resurrect it under a different guarantee (`ToolgenRegistry
 * .markTerminated`'s docstring, extended one hop).
 */
function liveArtifact(deps: ToolgenSaveDeps, toolId: string): GeneratedToolArtifact {
  const envelope = deps.registry.get(toolId);
  if (envelope === undefined || deps.registry.isTerminated(toolId)) {
    throw new ToolgenError(ERR_TOOLGEN_SAVE_NOT_LIVE, "tool is not live in this session");
  }
  return envelope.artifact;
}

type ExistingClassification =
  | { readonly kind: "absent_or_changed" }
  | { readonly kind: "healthy_match" }
  | { readonly kind: "disabled_match" };

/**
 * Whether a `generated_tool` row already covers EXACTLY this digest, and if it does, whether it is
 * healthy. This decides BOTH whether a prompt is shown and how the write at the end is performed —
 * checked before the prompt because a matching digest means nothing NEW is being consented to
 * (spec § 6, step 6):
 *
 * - `healthy_match` — the exact bytes are already durably saved and loadable. Nothing to do.
 * - `disabled_match` — the exact bytes were already approved for persistence once, but the row is
 *   currently disabled (a corrupt signature, a missing file, a rotated key). This is the REPAIR
 *   path, and it does NOT re-prompt: the digest match means the owner already said yes to these
 *   bytes; a second prompt would spend their attention for zero additional security (spec § 6.1).
 * - `absent_or_changed` — no row at all, OR a row whose digest differs (the owner revised the tool
 *   since the last save). Both need a FRESH approval and a fresh write; `insertSavedTool`'s upsert
 *   (see its docstring) handles writing either case identically, since from the database's
 *   perspective a first save and a resave-after-edit are the same operation.
 */
function classifyExisting(
  deps: ToolgenSaveDeps,
  toolId: string,
  digest: string,
): ExistingClassification {
  const existing = getSavedTool(deps.db, toolId);
  if (existing?.artifactDigest !== digest) {
    return { kind: "absent_or_changed" };
  }
  return existing.disabledReason === null ? { kind: "healthy_match" } : { kind: "disabled_match" };
}

/**
 * What the owner is asked to approve. `grounding` is always `description_only`: saving drafts
 * nothing new — the body being persisted is exactly the one already approved to RUN, not a fresh
 * draft — so there is no endpoint grounding to disclose here. That is a neutral, never-overclaiming
 * value; inventing an `endpoints` grounding that was never recomputed for this call would be worse.
 */
function buildApprovalInput(artifact: GeneratedToolArtifact): ToolgenSaveApprovalInput {
  return {
    toolId: artifact.toolId,
    toolName: artifact.toolName,
    description: artifact.description,
    body: artifact.body,
    approvedHosts: artifact.approvedHosts,
    credentialHosts: artifact.credentialHosts,
    inputSchema: artifact.inputSchema,
    grounding: { kind: "description_only" },
    initiator: "owner",
    persistence: true,
  };
}

/**
 * The ONE path from a live, session-only generated tool to a durable one that survives a gateway
 * restart (I40 / spec § 6). This is the first STANDING approval in this codebase: every other HITL
 * gate here (I33, I35, I39's own create gate) approves a single act inside one session. Persisting
 * a tool is consenting to a different fact about the same bytes — "run this in every future
 * session, without being asked again" — which the create-time approval never offered and therefore
 * never covered (spec § 6.1). Reusing that earlier "yes" here would make this a privilege escalation
 * that requires no privilege of its own.
 *
 * The ORDER is load-bearing and mirrors `createGeneratedTool`: every refusal decidable WITHOUT the
 * owner happens before the consent prompt, so a disabled capability never advertises its own
 * existence by prompting, and the idempotency/repair check runs before the prompt too, because
 * whether a prompt is even shown depends on it.
 */
export async function saveGeneratedTool(
  req: { readonly toolId: string },
  deps: ToolgenSaveDeps,
): Promise<ToolgenSaveOutcome> {
  const { toolId } = req;
  let approved = false;
  try {
    // 1-2. Local kill-switch, then org policy (I22) — both before consent, both fail-closed.
    assertSaveEnabled(deps);

    // 3-4. The live artifact, straight from the registry envelope.
    const artifact = liveArtifact(deps, toolId);

    // 5. What gets signed, and what a prior save is compared against.
    const canonicalJson = canonicalArtifactBytes(artifact);
    const digest = artifactDigest(artifact);

    // 6. Idempotency / repair short-circuit — see classifyExisting's docstring.
    const existing = classifyExisting(deps, toolId, digest);
    if (existing.kind === "healthy_match") {
      audit(deps, toolId, "already_saved", { digest });
      return { status: "already_saved", toolId };
    }

    // 7. Approval — skipped ONLY for a digest-matching repair. A brand-new tool and a resave of
    // DIFFERENT approved bytes under the same toolId both require it: widening a standing approval
    // to bytes nobody approved is exactly the escalation this gate exists to prevent (spec § 6.1).
    if (existing.kind !== "disabled_match") {
      approved = await deps.requestApproval(buildApprovalInput(artifact), APPROVAL_TTL_MS);
      if (!approved) {
        audit(deps, toolId, "denied_by_owner", { digest });
        return { status: "denied" };
      }
    }

    // 8. Only now does anything reach the Vault or the filesystem — sign, write, persist, in that
    // order, so a crash between any two steps never leaves a row pointing at unwritten/unsigned
    // files (or files with no row, which the boot-time orphan sweep — spec § 7.1 — cleans up).
    const { sigB64, pubkeyB64 } = await signArtifact(deps.vault, canonicalJson);
    const script = emitToolScript(artifact);
    await writeSavedTool(deps.configDir, toolId, { canonicalJson, sigB64, script });

    if (existing.kind === "disabled_match") {
      repairDisabledSavedTool(deps.db, toolId, {
        signature: sigB64,
        pubkey: pubkeyB64,
        savedAt: deps.now(),
      });
      audit(deps, toolId, "repaired", { digest });
      return { status: "repaired", toolId };
    }

    insertSavedTool(deps.db, {
      toolId,
      toolName: artifact.toolName,
      description: artifact.description,
      artifactJson: canonicalJson,
      artifactDigest: digest,
      signature: sigB64,
      pubkey: pubkeyB64,
      approvedAt: deps.now(),
      savedAt: deps.now(),
      lastLoadedAt: null,
      disabledReason: null,
    });
    audit(deps, toolId, "saved", { digest });
    return { status: "saved", toolId };
  } catch (err) {
    const code = err instanceof ToolgenError ? err.code : "ERR_TOOLGEN_INTERNAL";
    // An owner-approved attempt that then failed (a Vault or filesystem error after `approved`
    // becomes true) is recorded as APPROVED, because it was — the owner saw and consented to the
    // exact artifact, and the failure happened afterward. Only a pre-consent failure may claim the
    // owner never saw it (mirrors `createGeneratedTool`'s identical `approved`-flag branch).
    audit(deps, toolId, approved ? "failed_after_approval" : "refused_before_consent", {
      code,
      message: (err as Error).message,
    });
    return { status: "refused", code };
  }
}
