import {
  actDoorRefusal,
  type TribalKbConfig,
} from "../connectors/connector-writes/model-write-refusals.ts";
import type {
  ConnectorWriteRow,
  PreviewCredentialResolver,
} from "../connectors/connector-writes/types.ts";
import { proposableWriteTool } from "../connectors/proposable-actions.ts";
import { userMcpToolKeyForActionType } from "../connectors/user-mcp-store.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import type { ExecutorPolicyDep } from "../engine/executor.ts";
import { buildAgentWriteExecutor } from "../engine/run-ask.ts";
import { serviceOf } from "../engine/service-of.ts";
import type { AgentProposer, AuditSink, ConnectorDispatcher } from "../engine/types.ts";
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
  /** Test seam: the rows the typed preview and the before-state are built from. Production: the write table. */
  readonly beforeStateRows?: readonly ConnectorWriteRow[];
  /**
   * The tribal KB destinations the before-state guards read (REQUIRED: an absent config would let
   * the KB-child guards pass). The same accessor the model door gets.
   */
  readonly getTribalKbConfig: () => TribalKbConfig | undefined;
}

/**
 * The act door's destination refusal (owner rulings OR1/OR2, OR-B2-2, OR-B2-3, OR-B3-1, OR-B3-3),
 * injected into the capture gate as `actionDestinationRefusal` (built in `platform/assemble.ts`).
 * It is `actDoorRefusal`: the SAME `messagingDestinationRefusal` the model door calls, then the act
 * door's Linear rule, then the SAME KB-target check the model door calls, then the act door's
 * KB-child rule, run on the routing table's tool for the type, so a proposed post to a channel
 * ChatOps listens on, text carrying a broadcast mention or a GitLab quick action, a GitLab scoped
 * label, (B4a) a calendar or Drive create with an optional field set to `null`, an Outlook or
 * iCloud event time that does not show its zone, an iCloud event field or attendee with a line
 * break or control character, a Linear update that sets `assigneeId`, a page write to the tribal
 * KB destination, or (while a KB destination is configured for that service) a Notion/Confluence
 * page update or append is refused at submit and again at accept. Both accessors are read per call: the ChatOps
 * bindings from the LIVE enforced policy (a throw passes `undefined`, which refuses every
 * Slack/Teams post) and the KB destinations (a throw refuses every KB-capable row, fail closed). A
 * type with no routing row (a user-MCP type) has no destination here: `undefined`.
 */
export function createActionDestinationRefusal(
  enforcedPolicy: () => EnforcedPolicy | undefined,
  tribalKbConfig: () => TribalKbConfig | undefined,
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
    let kb: TribalKbConfig | undefined;
    let kbUnreadable = false;
    try {
      kb = tribalKbConfig();
    } catch {
      kbUnreadable = true;
    }
    return actDoorRefusal(tool, input, { chatops, kb, kbUnreadable });
  };
}

/** The fixed text when the write's credential instance cannot be established (echoes no stored value). */
const CREDENTIAL_UNVERIFIED_REASON = "the credential the write would use could not be verified";

/** The stored row's provenance as the executor's gateway-set proposer (all of it UNVERIFIED). */
function agentProposerOf(p: ActionProvenance): AgentProposer {
  return {
    door: "agent",
    captureId: p.captureId,
    label: p.clientLabel,
    labelSource: "declared",
    summary: p.summary,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
  };
}

/**
 * The act door's executor seam (I28 + I2/I29/I22/I42): one fresh door executor per accept
 * (`buildAgentWriteExecutor`, static D39(e)), bound to the ACCEPTING session's consent channel,
 * with NO delegate (the local owner answers) and the proposal run as an `origin: "agent"` action.
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
      // The prompt must name the instance the write WILL run against, read fresh from the Vault
      // the write uses (as the executor does on every other door). A credential whose instance
      // cannot be established (a present but invalid base) is rejected here: no prompt, no
      // dispatch, a fixed outcome that echoes no stored value.
      try {
        await w.previewCredentialFor?.refresh?.(serviceOf(actionType));
      } catch {
        return { status: "rejected", reason: CREDENTIAL_UNVERIFIED_REASON };
      }
      // Phase 28 AD1: the SAME door maker as the model door (no delegate, no standing rule, the
      // before-state runner), so the executor's own prompt (the typed preview with the target's
      // current state) is what the owner sees. The LOCAL owner who ran `captures accept` answers.
      // The action's `origin` and `proposer` are set here, by the gateway, from the stored row;
      // the tool is the routing table's, never the proposer's (I3).
      const executor = buildAgentWriteExecutor({
        clientId,
        consentCoordinator: coordinator,
        audit: w.audit,
        dispatcher: w.dispatcher,
        egressSink: w.egressSink,
        policyHitl: w.policyHitl,
        getTribalKbConfig: w.getTribalKbConfig,
        ...(w.previewCredentialFor === undefined
          ? {}
          : { previewCredentialFor: w.previewCredentialFor }),
        ...(w.beforeStateRows === undefined ? {} : { beforeStateRows: w.beforeStateRows }),
      });
      const out = await executor.execute({
        type: actionType,
        origin: "agent",
        proposer: agentProposerOf(provenance),
        payload: { mcpToolId: toolId, input },
      });
      return out.status === "ok"
        ? { status: "ok", result: out.result }
        : { status: "rejected", reason: out.reason };
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
