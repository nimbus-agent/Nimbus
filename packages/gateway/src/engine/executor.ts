import { randomUUID } from "node:crypto";

import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { buildEgressEntry } from "../egress/egress-record.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { ConsentDisconnectedError } from "../ipc/consent.ts";
import { getAgentRequestSessionId } from "./agent-request-context.ts";
import { type RemoteApprovalOutcome, resolveDelegatedApproval } from "./delegated-approval.ts";
import type { DelegationReader } from "./delegation-store.ts";
import { serviceOf } from "./service-of.ts";
import type {
  ActionResult,
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "./types.ts";

const HITL_REQUIRED_BACKING = new Set<string>([
  "file.delete",
  "file.move",
  "file.rename",
  "file.create",
  "email.send",
  "email.draft.send",
  "email.draft.create",
  "calendar.event.create",
  "calendar.event.delete",
  "photo.delete",
  "onedrive.delete",
  "onedrive.move",
  "slack.message.post",
  "teams.message.post",
  "teams.message.postChat",
  "linear.issue.create",
  "linear.issue.update",
  "linear.comment.create",
  "jira.issue.create",
  "jira.issue.update",
  "jira.comment.add",
  "notion.page.create",
  "notion.page.update",
  "notion.block.append",
  "notion.comment.create",
  "notion.knowledge.write",
  "obsidian.note.append",
  "confluence.page.create",
  "confluence.page.update",
  "confluence.comment.add",
  "confluence.knowledge.write",
  "repo.pr.merge",
  "repo.pr.close",
  "repo.branch.delete",
  "repo.tag.create",
  "repo.commit.push",
  // Per-connector git-host action types. `repo.*` above stays: removing a generic type silently
  // ungates anything still emitting it. The prefix is what `serviceOf()` records as I29's egress
  // destination and scopes an I20 delegation by, so "github" beats a shared "repo".
  "github.pr.merge",
  "github.pr.close",
  "github.issue.create",
  "github.branch.delete",
  "github.tag.create",
  // Wave 4 — comms.
  "slack.chat.post",
  "teams.chat.post",
  // Wave 3 — repos + CI.
  "bitbucket.pr.merge",
  "gitlab.mr.merge",
  "pipeline.trigger",
  "pipeline.cancel",
  "pipeline.rerun",
  "jenkins.build.trigger",
  "jenkins.build.abort",
  "github_actions.run.trigger",
  "github_actions.run.cancel",
  "circleci.pipeline.trigger",
  "circleci.job.cancel",
  "gitlab.pipeline.retry",
  "gitlab.pipeline.cancel",
  "aws.ecs.service.update",
  "aws.lambda.invoke",
  "aws.ec2.instance.stop",
  "aws.ec2.instance.start",
  "azure.app_service.restart",
  "azure.aks.node_pool.scale",
  "gcp.cloud_run.deploy",
  "gcp.gke.workload.restart",
  "iac.terraform.apply",
  "iac.terraform.destroy",
  "iac.cloudformation.deploy",
  "iac.pulumi.up",
  "kubernetes.rollout.restart",
  "kubernetes.pod.delete",
  "kubernetes.deployment.scale",
  "pagerduty.incident.acknowledge",
  "pagerduty.incident.resolve",
  "pagerduty.incident.escalate",
  "deployment.apply",
  "deployment.rollback",
  "infra.apply",
  "infra.destroy",
  "k8s.apply",
  "k8s.delete",
  "k8s.rollout.restart",
  "cloud.resource.scale",
  "cloud.resource.stop",
  "alert.acknowledge",
  "alert.silence",
  "incident.escalate",
  "incident.resolve",
  "data.delete",
  "connector.remove",
  "extension.autoUpdate",
  "extension.downgrade",
  "extension.install",
  "connector.addMcp",
  "data.export",
  "connector.reindex",
  "vault.set",
  "vault.delete",
  "teamvault.put",
  "teamvault.delete",
  // Phase 6 Slice 7 Wave 7c — warehouse/BI writes (kept in sync with WAREHOUSE_BI_WRITES;
  // see connectors/warehouse-write-tools.ts; drift asserted in warehouse-write-tools.test.ts).
  "snowflake.tag.set",
  "snowflake.comment.set",
  "tableau.datasource.refresh",
  "tableau.workbook.refresh",
  "looker.datagroup.trigger",
  "looker.schedule.run_once",
  "powerbi.dataset.refresh",
  "powerbi.dataflow.refresh",
  "montecarlo.incident.acknowledge",
  "montecarlo.incident.resolve",
  "bigeye.issue.acknowledge",
  "bigeye.issue.resolve",
  // Phase 6 Slice 9 W1 — GitOps + ML writes (kept in sync with GITOPS_ML_WRITES; see
  // connectors/gitops-ml-write-tools.ts; drift asserted in connector-write-registry.test.ts).
  "argocd.app.sync",
  "argocd.app.rollback",
  "flux.kustomization.reconcile",
  "flux.helmrelease.reconcile",
  "mlflow.model.promote",
  "mlflow.model.transition_stage",
  // Phase 6 Slice 8 — outbound share publish is owner-HITL-gated (I27); the share-gate
  // (share/share-gate.ts) redacts → owner HITL → signs → persists → audits.
  "share.publish",
  // Phase 7 egress-ledger — the sole retention-edit mutation (I29) is owner-HITL-gated;
  // the egress.prune RPC consults the owner consent broker before pruning the ledger.
  "egress.prune",
]);

export const HITL_REQUIRED = Object.freeze({
  has(x: string): boolean {
    return HITL_REQUIRED_BACKING.has(x);
  },
  get size(): number {
    return HITL_REQUIRED_BACKING.size;
  },
  *[Symbol.iterator](): IterableIterator<string> {
    yield* HITL_REQUIRED_BACKING;
  },
  entries(): IterableIterator<[string, string]> {
    return HITL_REQUIRED_BACKING.entries();
  },
  keys(): IterableIterator<string> {
    return HITL_REQUIRED_BACKING.keys();
  },
  values(): IterableIterator<string> {
    return HITL_REQUIRED_BACKING.values();
  },
  forEach(
    callbackfn: (value: string, value2: string, set: ReadonlySet<string>) => void,
    thisArg?: unknown,
  ): void {
    for (const v of HITL_REQUIRED_BACKING) {
      callbackfn.call(thisArg, v, v, HITL_REQUIRED);
    }
  },
  add(_value: string): never {
    throw new TypeError(
      "HITL_REQUIRED is immutable; edit HITL_REQUIRED_BACKING in executor.ts instead",
    );
  },
}) as unknown as ReadonlySet<string>;

const SENSITIVE_PAYLOAD_KEY = /(token|key|secret|password|credential|bearer|auth)/i;

export function redactPayloadForConsentDisplay(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(redactPayloadForConsentDisplay);
  }
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_PAYLOAD_KEY.test(k) ? "[REDACTED]" : redactPayloadForConsentDisplay(v);
  }
  return out;
}

export function formatConsentPrompt(action: PlannedAction): string {
  const lines = [`Action requires your approval`, ``, `Type: ${action.type}`];
  if (action.payload !== undefined && Object.keys(action.payload).length > 0) {
    lines.push("", `Details: ${JSON.stringify(redactPayloadForConsentDisplay(action.payload))}`);
  }
  return lines.join("\n");
}

function auditPayload(
  action: PlannedAction,
  extras: { hitlRejectReason?: string } | undefined,
): string {
  return redactAuditPayload(extras === undefined ? { action } : { action, ...extras });
}

/**
 * Optional multi-user/delegated-HITL wiring (Slice 2). When present, the gate routes a HITL
 * action's approval to an active in-scope delegate before falling back to the local owner prompt.
 */
export interface ExecutorDelegationDep {
  readonly store: DelegationReader;
  /** I18: the answering delegate's operator identity must be valid. */
  readonly isOperatorValid: () => boolean;
  /** Route the approval request to the delegate over federation; resolve with their answer. */
  readonly requestRemote: (actionType: string) => Promise<RemoteApprovalOutcome>;
}

/**
 * I22 — the tighten-only HITL overlay from a signature-verified org policy.
 *
 * `PolicyGate` has always computed `EnforcedPolicy.hitlRequired` as a monotonic union (baseline ∪
 * `[policy.hitl] require`), `docs/SECURITY-INVARIANTS.md` has always described enforcement as
 * reading it, and until 2026-08-16 **nothing read it**: `isHitlRequiredByPolicy` had zero
 * production callers, so an org admin could sign a policy, watch it verify, and get no gate. This
 * is the consumer that makes the resolved field mean something.
 *
 * It can only ADD. `gate()` ORs this with `HITL_REQUIRED.has(action.type)`, so no policy — signed,
 * unsigned, hostile or merely wrong — can take an action type OUT of the frozen set. That ordering
 * is the whole reason this is compatible with I2's "cannot be bypassed or configured away": the
 * frozen set is the floor, policy is a ratchet above it.
 */
export interface ExecutorPolicyDep {
  readonly isHitlRequiredByPolicy: (actionType: string) => boolean;
}

/**
 * The explicit "no org policy applies here" overlay.
 *
 * Named rather than `undefined` for the same reason `NULL_EGRESS_SINK` is (I29): every
 * `new ToolExecutor(...)` site then states its choice, and a site that simply forgot is a missing
 * argument rather than a silent default. An enforcement test pins that every production site
 * passes one or the other.
 */
export const NO_POLICY_OVERLAY: ExecutorPolicyDep = Object.freeze({
  isHitlRequiredByPolicy: () => false,
});

export class ToolExecutor {
  constructor(
    private readonly consent: ConsentChannel,
    private readonly audit: AuditSink,
    private readonly connectors: ConnectorDispatcher,
    private readonly delegation: ExecutorDelegationDep | undefined,
    private readonly egressSink: EgressSink,
    private readonly policy: ExecutorPolicyDep = NO_POLICY_OVERLAY,
  ) {}

  /**
   * Whether an org policy requires HITL for this action type on top of the frozen set.
   *
   * Fails toward the frozen set: a throwing or absent overlay adds nothing rather than gating
   * everything, because the alternative — an overlay fault turning every read into a consent
   * prompt — is a self-inflicted denial of service, and the floor below it is still I2.
   */
  private requiredByPolicy(actionType: string): boolean {
    try {
      return this.policy.isHitlRequiredByPolicy(actionType);
    } catch {
      return false;
    }
  }

  /** I20/D10: when a HITL action has an active delegate, route the approval to them; honor only a
   *  live in-scope, identity-valid answerer; otherwise fall back to the local owner prompt. */
  private async tryDelegatedApproval(
    action: PlannedAction,
  ): Promise<"approved" | "rejected" | "fallback"> {
    if (this.delegation === undefined) return "fallback";
    const del = this.delegation;
    const service = serviceOf(action.type);
    const now = Date.now();
    if (del.store.activeDelegateePeer(action.type, service, now) === undefined) return "fallback";
    const outcome = await resolveDelegatedApproval({
      isActiveDelegate: (peerId) =>
        del.store.activeDelegateFor("action_type", action.type, peerId, now) ||
        del.store.activeDelegateFor("service", service, peerId, now),
      isOperatorValid: del.isOperatorValid,
      requestRemote: () => del.requestRemote(action.type),
    });
    return outcome === "fallback_to_owner" ? "fallback" : outcome;
  }

  /** Resolve a HITL action's approval: a delegated answer when one applies (I20), otherwise the
   *  local owner consent prompt (payload shown redacted, for display only). */
  private async resolveHitlApproval(action: PlannedAction): Promise<boolean> {
    const delegated = await this.tryDelegatedApproval(action);
    if (delegated === "fallback") {
      const details =
        action.payload === undefined
          ? undefined
          : (redactPayloadForConsentDisplay(action.payload) as Record<string, unknown>);
      return this.consent.requestApproval(formatConsentPrompt(action), details);
    }
    return delegated === "approved";
  }

  async gate(action: PlannedAction): Promise<ActionResult | "proceed"> {
    // I2 first, policy second, joined by OR — never by assignment, and never the other way round.
    // The frozen set is the floor: `HITL_REQUIRED.has(...)` alone decides `true`, so an org policy
    // is only ever consulted about action types the frozen set does NOT already cover. That is
    // what makes I22's overlay tighten-only and keeps I2 non-configurable (see ExecutorPolicyDep).
    const requiresHITL = HITL_REQUIRED.has(action.type) || this.requiredByPolicy(action.type);

    let hitlStatus: "approved" | "rejected" | "not_required";
    // Reason for the rejected path. Defaults to the user-declined message (the only other
    // rejection source — a consent disconnect — overwrites it below), so it is always a defined
    // string by the time the rejected branch returns it (no nullish fallback needed).
    let rejectReason = "User declined consent gate.";
    let auditExtras: { hitlRejectReason?: string } | undefined;

    try {
      if (requiresHITL) {
        const approved = await this.resolveHitlApproval(action);
        hitlStatus = approved ? "approved" : "rejected";
      } else {
        hitlStatus = "not_required";
      }
    } catch (e) {
      if (e instanceof ConsentDisconnectedError) {
        hitlStatus = "rejected";
        rejectReason = e.message;
        auditExtras = { hitlRejectReason: e.hitlAuditReason };
      } else {
        throw e;
      }
    }

    const sessionId = getAgentRequestSessionId();
    this.audit.recordAudit({
      actionType: action.type,
      hitlStatus,
      actionJson: auditPayload(action, auditExtras),
      timestamp: Date.now(),
      ...(sessionId === undefined ? {} : { sessionId }),
    });

    this.egressSink.append(
      buildEgressEntry({
        action,
        hitlStatus,
        resultStatus: hitlStatus === "rejected" ? "blocked" : "authorized",
        sessionId,
        now: Date.now(),
      }),
    );

    if (hitlStatus === "rejected") {
      return { status: "rejected", reason: rejectReason };
    }
    return "proceed";
  }

  async execute(action: PlannedAction): Promise<ActionResult> {
    const gateResult = await this.gate(action);
    if (gateResult === "proceed") {
      const result = await this.connectors.dispatch(action);
      return { status: "ok", result };
    }
    return gateResult;
  }
}

export function bindConsentChannel(
  coordinator: ConsentCoordinator,
  clientId: string,
): ConsentChannel {
  return {
    requestApproval(prompt: string, details?: Record<string, unknown>): Promise<boolean> {
      return coordinator.requestConsent(clientId, {
        requestId: randomUUID(),
        prompt,
        details,
      });
    },
  };
}
