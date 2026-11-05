import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import { actDoorRefusal } from "../connectors/connector-writes/model-write-refusals.ts";
import {
  buildConnectorWritePreviewFrom,
  isPlainObject,
  renderConnectorWritePreviewLines,
  sanitisePreviewText,
} from "../connectors/connector-writes/preview.ts";
import type {
  ConnectorWriteRow,
  PreviewCredentialResolver,
} from "../connectors/connector-writes/types.ts";
import { proposableWriteTool } from "../connectors/proposable-actions.ts";
import { userMcpToolKeyForActionType } from "../connectors/user-mcp-store.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { bindConsentChannel, type ExecutorPolicyDep, ToolExecutor } from "../engine/executor.ts";
import type { AuditSink, ConnectorDispatcher, ConsentChannel } from "../engine/types.ts";
import { formatActionConsent, formatActionProvenanceLines } from "../mcp-sink/capture-act.ts";
import {
  acceptCapture,
  type CaptureCaller,
  type CaptureGateDeps,
  captureStateFor,
  captureStatus,
  getCapture,
  listCaptures,
  purgeCapture,
  rejectCapture,
  revokeCapture,
  submitCapture,
} from "../mcp-sink/capture-gate.ts";
import { type ActDeps, type ActionProvenance, CaptureError } from "../mcp-sink/capture-types.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import type { ConsentCoordinator } from "./consent.ts";
import { RpcMethodError } from "./server/rpc-error.ts";

/**
 * `capture.*` (MCP-facing) and `captures.*` (owner-facing) — invariant I28. LAN-forbidden by
 * namespace (I5), no HTTP route; only `captures.list`/`captures.get` are on the Tauri allowlist
 * (I7), for the read-only desktop Captures page. The caller's kind comes
 * from the CONNECTION (`ServerCtx.getClientKind`), never from params.
 */
export interface CaptureRpcCtx {
  readonly gate: CaptureGateDeps;
  /** Absent → the act door cannot execute: an action accept refuses ERR_CAPTURE_DISABLED. */
  readonly act?: CaptureActWiring;
}

/**
 * What the act door executes WITH (spec § 3): the dispatcher runAsk and ChatOps use, the real egress
 * sink (I29) and the policy overlay (I22). Built once in platform/assemble.ts; the executor itself
 * is built per accept, around the ACCEPTING session's consent channel.
 */
export interface CaptureActWiring {
  readonly dispatcher: ConnectorDispatcher;
  readonly egressSink: EgressSink;
  readonly audit: AuditSink;
  readonly policyHitl: ExecutorPolicyDep;
  /** Which credential a write would use, for the typed preview's `Credential:` line (as runAsk). */
  readonly previewCredentialFor?: PreviewCredentialResolver;
  /** Test seam: the rows a typed preview is built from. Production: the write table. */
  readonly previewRows?: readonly ConnectorWriteRow[];
}

/**
 * The act door's prompt and details (F5). For a write whose row carries a preview template and an
 * object input: the provenance header, then the gateway-built typed preview; the details are that
 * preview with the proposer ONLY under `proposedBy` (its unverified summary as `unverifiedSummary`,
 * never overwriting the template's `summary`). Otherwise: the verbatim prompt and
 * `{ actionType, input }`, exactly as before.
 */
export function actConsentDisplay(
  w: Pick<CaptureActWiring, "previewCredentialFor" | "previewRows">,
  actionType: string,
  toolId: string,
  input: Readonly<Record<string, unknown>>,
  provenance: ActionProvenance,
): { prompt: string; details: Record<string, unknown> } {
  const preview = isPlainObject(input)
    ? buildConnectorWritePreviewFrom(
        { type: actionType, payload: { mcpToolId: toolId, input } },
        w.previewRows ?? CONNECTOR_WRITE_ROWS,
        w.previewCredentialFor,
      )
    : undefined;
  if (preview === undefined) {
    return {
      prompt: formatActionConsent(provenance, actionType, input),
      details: { actionType, input },
    };
  }
  return {
    prompt: [
      ...formatActionProvenanceLines(provenance),
      "",
      ...renderConnectorWritePreviewLines(preview),
    ].join("\n"),
    details: {
      ...preview,
      proposedBy: {
        clientLabel:
          provenance.clientLabel === null ? null : sanitisePreviewText(provenance.clientLabel),
        unverifiedSummary: sanitisePreviewText(provenance.summary),
        createdAt: provenance.createdAt,
        expiresAt: provenance.expiresAt,
      },
    },
  };
}

/**
 * The act door's destination refusal (owner rulings OR1/OR2, OR-B2-2, OR-B2-3), injected into the
 * capture gate as `actionDestinationRefusal` (built in `platform/assemble.ts`). It is
 * `actDoorRefusal`: the SAME `messagingDestinationRefusal` the model door calls, then the act
 * door's Linear rule, run on the routing table's tool for the type, so a proposed post to a channel
 * ChatOps listens on, text carrying a broadcast mention or a GitLab quick action, a GitLab scoped
 * label, or a Linear update that sets `assigneeId` is refused at submit and again at accept. The ChatOps bindings come from the
 * LIVE enforced policy, read per call; a throw passes `undefined`, which refuses every Slack/Teams
 * post. The knowledge-base refusal stays model-door-only. A type with no routing row (a user-MCP
 * type) has no messaging destination here: `undefined`.
 */
export function createActionDestinationRefusal(
  enforcedPolicy: () => EnforcedPolicy | undefined,
): CaptureGateDeps["actionDestinationRefusal"] {
  return (actionType, input) => {
    const tool = proposableWriteTool(actionType);
    if (tool === undefined) return undefined;
    let chatops: EnforcedPolicy["chatops"] | undefined;
    try {
      chatops = enforcedPolicy()?.chatops;
    } catch {
      chatops = undefined;
    }
    return actDoorRefusal(tool, input, { chatops });
  };
}

/**
 * Replace the executor's generic prompt with the provenance prompt (spec § 8 step 7). The details
 * are UNREDACTED on purpose: the owner approves the exact input that will be dispatched, and the
 * consent channel goes only to the accepting local session. The audit row stays redacted — the
 * executor's `auditPayload` is untouched.
 */
function provenanceConsent(
  inner: ConsentChannel,
  prompt: string,
  details: Record<string, unknown>,
): ConsentChannel {
  return {
    requestApproval: (_prompt, _details, actionType) =>
      inner.requestApproval(prompt, details, actionType),
  };
}

/**
 * The act door's executor seam (I28 + I2/I29/I22/I42): one fresh `ToolExecutor` per accept, bound
 * to the ACCEPTING session's consent channel, with NO delegate (the local owner answers).
 */
export function buildActDeps(
  w: CaptureActWiring,
  coordinator: ConsentCoordinator,
  clientId: string,
): ActDeps {
  return {
    async execute(actionType, input, provenance) {
      // The tool is ALWAYS gateway-chosen: the routing table for a first-party type, the canonical
      // `<serviceId>_<tool>` key for a user-MCP type (the exact pair `connector.userMcpCall` builds,
      // and the only key the dispatcher's I42 pairing accepts for that type). The second lookup
      // returns undefined for anything that is not an `mcp_*` type.
      const toolId = proposableWriteTool(actionType) ?? userMcpToolKeyForActionType(actionType);
      if (toolId === undefined) {
        // Never dispatch a first-party write by its type (spec § 6.3): no routing row, no call.
        // This exact message is what classifyActionError maps to ERR_ACTION_TOOL_NOT_FOUND.
        throw new Error("Tool not found");
      }
      const { prompt, details } = actConsentDisplay(w, actionType, toolId, input, provenance);
      const consent = provenanceConsent(bindConsentChannel(coordinator, clientId), prompt, details);
      // I20/I42: no delegate — the LOCAL owner who ran `captures accept` answers.
      const executor = new ToolExecutor(
        consent,
        w.audit,
        w.dispatcher,
        undefined,
        w.egressSink,
        w.policyHitl,
      );
      const out = await executor.execute({
        type: actionType,
        payload: { mcpToolId: toolId, input },
      });
      return out.status === "ok" ? { status: "ok", result: out.result } : { status: "rejected" };
    },
  };
}

type Ctx = { readonly gate: CaptureGateDeps; readonly caller: CaptureCaller };

function idParam(params: unknown): unknown {
  return typeof params === "object" && params !== null
    ? (params as Record<string, unknown>)["id"]
    : undefined;
}

export async function dispatchCaptureRpc(
  method: string,
  params: unknown,
  ctx: CaptureRpcCtx,
  caller: CaptureCaller,
  consent?: ConsentCoordinator,
): Promise<RpcMissOrHit> {
  try {
    return await dispatchByMethod<Ctx, unknown>(
      method,
      params,
      { gate: ctx.gate, caller },
      {
        "capture.status": (_p, c) => captureStatus(c.gate),
        "capture.state": (p, c) => captureStateFor(c.gate, c.caller, idParam(p)),
        "capture.submit": (p, c) => submitCapture(c.gate, c.caller, p),
        "captures.list": (p, c) => listCaptures(c.gate, c.caller, p),
        "captures.get": (p, c) => getCapture(c.gate, c.caller, idParam(p)),
        "captures.revoke": (p, c) => revokeCapture(c.gate, c.caller, idParam(p)),
        // Always awaited by dispatchByMethod: an action accept returns a Promise.
        "captures.accept": (p, c) =>
          acceptCapture(
            c.gate,
            c.caller,
            idParam(p),
            ctx.act !== undefined && consent !== undefined
              ? buildActDeps(ctx.act, consent, c.caller.clientId)
              : undefined,
          ),
        "captures.reject": (p, c) => rejectCapture(c.gate, c.caller, idParam(p)),
        "captures.purge": (p, c) => purgeCapture(c.gate, c.caller, idParam(p)),
      },
    );
  } catch (e) {
    if (e instanceof CaptureError) throw new RpcMethodError(-32001, e.message, { code: e.code });
    throw e;
  }
}
