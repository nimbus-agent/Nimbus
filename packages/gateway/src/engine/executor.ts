import { randomUUID } from "node:crypto";

import { redactAuditPayload } from "../audit/format-audit-payload.ts";
import type { ConsentCoordinator } from "../ipc/consent.ts";
import { ConsentDisconnectedError } from "../ipc/consent.ts";
import { getAgentRequestSessionId } from "./agent-request-context.ts";
import type {
  ActionResult,
  AuditSink,
  ConnectorDispatcher,
  ConsentChannel,
  PlannedAction,
} from "./types.ts";

/**
 * HITL whitelist — immutable at runtime.
 * Source of truth: `architecture.md` §HITL Consent Gate — Implementation Contract.
 */
const HITL_REQUIRED_BACKING = new Set<string>([
  // Cloud storage & communication
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
  // Linear
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
  "obsidian.note.append",
  "confluence.page.create",
  "confluence.page.update",
  "confluence.comment.add",
  // Source control
  "repo.pr.merge",
  "repo.pr.close",
  "repo.branch.delete",
  "repo.tag.create",
  "repo.commit.push",
  // CI/CD
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
  // Cloud & infra (tool ids in registry.ts / connector packages)
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
  // Deployments & infrastructure
  "deployment.apply",
  "deployment.rollback",
  "infra.apply",
  "infra.destroy",
  "k8s.apply",
  "k8s.delete",
  "k8s.rollout.restart",
  "cloud.resource.scale",
  "cloud.resource.stop",
  // Monitoring & incidents
  "alert.acknowledge",
  "alert.silence",
  "incident.escalate",
  "incident.resolve",
  // IPC-native destructive operations
  "data.delete",
  "connector.remove",
  "extension.autoUpdate",
  "extension.downgrade",
  "extension.install",
  "connector.addMcp",
  "data.export",
  "connector.reindex",
  // Vault writes — any IPC client planting / overwriting / deleting a
  // secret requires a consent prompt. Internal callers holding a typed
  // NimbusVault reference bypass the gate by design (S2-F8).
  "vault.set",
  "vault.delete",
]);

/** Runtime value is an immutable facade; typed as `ReadonlySet` for call sites (`.has`, iteration). */
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

/** Deep-redact object keys that may hold credentials before consent UI / IPC. */
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

export class ToolExecutor {
  constructor(
    private readonly consent: ConsentChannel,
    private readonly audit: AuditSink,
    private readonly connectors: ConnectorDispatcher,
  ) {}

  /**
   * Runs the HITL consent gate and writes the audit record.
   * Returns `"proceed"` when the action is approved or not gate-required.
   * Returns an `ActionResult` with status `"rejected"` when the user declines
   * or the consent channel disconnects — audit already written, do NOT write again.
   *
   * Use this when the caller owns execution (not MCP dispatch). For MCP dispatch
   * use `execute()` which calls `gate()` internally.
   */
  async gate(action: PlannedAction): Promise<ActionResult | "proceed"> {
    const requiresHITL = HITL_REQUIRED.has(action.type);

    let hitlStatus: "approved" | "rejected" | "not_required";
    let rejectReason: string | undefined;
    let auditExtras: { hitlRejectReason?: string } | undefined;

    try {
      if (requiresHITL) {
        const details =
          action.payload === undefined
            ? undefined
            : (redactPayloadForConsentDisplay(action.payload) as Record<string, unknown>);
        const approved = await this.consent.requestApproval(formatConsentPrompt(action), details);
        hitlStatus = approved ? "approved" : "rejected";
        if (!approved) rejectReason = "User declined consent gate.";
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

    // ALWAYS write audit record BEFORE any execution
    const sessionId = getAgentRequestSessionId();
    this.audit.recordAudit({
      actionType: action.type,
      hitlStatus,
      actionJson: auditPayload(action, auditExtras),
      timestamp: Date.now(),
      ...(sessionId !== undefined ? { sessionId } : {}),
    });

    if (hitlStatus === "rejected") {
      return { status: "rejected", reason: rejectReason ?? "User declined consent gate." };
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

/**
 * Binds IPC consent to a single client for use inside `ToolExecutor`.
 */
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
