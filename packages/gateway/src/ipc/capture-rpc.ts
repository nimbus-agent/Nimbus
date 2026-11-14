import { agentDoorRow } from "../connectors/connector-writes/agent-door.ts";
import { legacyNoticeFor } from "../connectors/connector-writes/agent-door-legacy.ts";
import type {
  AgentDoor,
  DefinitionVerification,
} from "../connectors/connector-writes/agent-door-runtime.ts";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  beforeReaderMissing,
  prepareToolMissing,
  type ServerToolListing,
} from "../connectors/connector-writes/listed-support.ts";
import type { TribalKbConfig } from "../connectors/connector-writes/model-write-refusals.ts";
import { rowNamedByToolId } from "../connectors/connector-writes/preview.ts";
import type {
  ConnectorWriteRow,
  PreviewCredentialResolver,
} from "../connectors/connector-writes/types.ts";
import { userMcpToolKeyForActionType } from "../connectors/user-mcp-store.ts";
import type { EgressSink } from "../egress/egress-ledger.ts";
import { classifyDoorRejection } from "../engine/door-rejection.ts";
import type { ExecuteOptions, ExecutorPolicyDep } from "../engine/executor.ts";
import { escapeUnverifiedLine } from "../engine/proposer-block.ts";
import { buildAgentWriteExecutor } from "../engine/run-ask.ts";
import { serviceOf } from "../engine/service-of.ts";
import type {
  AgentProposer,
  AuditSink,
  ConnectorDispatcher,
  PlannedAction,
} from "../engine/types.ts";
import { describeActions } from "../mcp-sink/capture-describe.ts";
import {
  acceptCapture,
  type CaptureCaller,
  type CaptureGateDeps,
  captureMine,
  captureStateFor,
  captureStatus,
  getCapture,
  listCaptures,
  purgeCapture,
  rejectCapture,
  revokeCapture,
  submitCapture,
} from "../mcp-sink/capture-gate.ts";
import type { CaptureAttemptLimiter } from "../mcp-sink/capture-rate-limit.ts";
import { actionTypeOfPayload } from "../mcp-sink/capture-store.ts";
import {
  type ActDeps,
  type ActionProvenance,
  type ActionRejectCode,
  CaptureError,
  isLegacyBasis,
} from "../mcp-sink/capture-types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { type ConsentCoordinator, humanOnlyConsent, vetoingConsent } from "./consent.ts";
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
  /**
   * `capture.describe` (AD3a-2b): the describer (`createAgentDoor(...).describe`) and the limiter
   * that bounds describe attempts on a window of their own. Absent → the method refuses
   * ERR_CAPTURE_DISABLED. Built once in platform/assemble.ts.
   */
  readonly describe?: {
    readonly limiter: CaptureAttemptLimiter;
    readonly actions: AgentDoor["describe"];
  };
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
  /**
   * The agent door's runtime half (AD3a-2a, invariant I58): an `approved` proposal is re-checked
   * after the owner's answer, and a row's before-state reader and prepare tool are checked against
   * the live listing. Absent, an `approved` proposal is refused (fail closed); a legacy one still runs.
   */
  readonly agentDoor?: AgentDoorActWiring;
}

/** What `buildActDeps` needs from the agent door's runtime (`createAgentDoor`, bound to the mesh). */
export interface AgentDoorActWiring {
  /** One first-party server's raw listing, or `undefined` when it cannot be listed now. */
  readonly listServerTools: (service: string) => Promise<ServerToolListing | undefined>;
  /** The door's definition check (`createAgentDoor(...).verifyDefinition`); marks a suspension itself. */
  readonly verifyDefinition: (
    actionType: string,
    proposedAt?: number,
  ) => Promise<DefinitionVerification>;
}

/**
 * The write rows the act door previews and runs from: the wiring's rows (a test seam) or the write
 * table. The one place outside `run-ask.ts` that names that seam, so its reach stays pinned.
 */
export function actWriteRows(w: CaptureActWiring | undefined): readonly ConnectorWriteRow[] {
  return w?.beforeStateRows ?? CONNECTOR_WRITE_ROWS;
}

/** The fixed text when the write's credential instance cannot be established (echoes no stored value). */
const CREDENTIAL_UNVERIFIED_REASON = "the credential the write would use could not be verified";

/** The stored row's provenance as the executor's gateway-set proposer (all of it UNVERIFIED). */
function agentProposerOf(p: ActionProvenance, actionType: string): AgentProposer {
  return {
    door: "agent",
    captureId: p.captureId,
    label: p.clientLabel,
    labelSource: p.labelSource,
    summary: p.summary,
    createdAt: p.createdAt,
    expiresAt: p.expiresAt,
    // The prompt's line follows the approval-time basis (R-7): fixed gateway text, never the agent's.
    ...(isLegacyBasis(p.basis) ? { deprecation: legacyNoticeFor(actionType) } : {}),
  };
}

/** The wire code for a veto: the closed set has one code for "the tool's approval no longer holds". */
const VETO_CODE: ActionRejectCode = "ERR_AGENT_TOOL_SUSPENDED";

/**
 * What the live listing says about a row's support tools, as the model door computes it: the
 * row's `before` reader (first or `also` tool) and its bound prepare tool. A row with neither
 * needs no listing. A listing that cannot be had counts as "unlisted" for whatever the row needs
 * (fail closed: a Wave 4 write is then refused before any prompt, a lower wave shows
 * `before: unavailable`, a bound write is refused).
 */
async function executeOptionsFor(
  door: AgentDoorActWiring | undefined,
  row: ConnectorWriteRow | undefined,
): Promise<ExecuteOptions | undefined> {
  if (door === undefined || row === undefined) return undefined;
  if (row.before === undefined && row.bound === undefined) return undefined;
  const service = serviceOf(row.actionType);
  const listing = await door.listServerTools(service).catch(() => undefined);
  const beforeReaderUnlisted =
    row.before !== undefined &&
    (listing === undefined || beforeReaderMissing(row, service, listing));
  const prepareToolUnlisted =
    row.bound !== undefined && (listing === undefined || prepareToolMissing(row, service, listing));
  if (!beforeReaderUnlisted && !prepareToolUnlisted) return undefined;
  return {
    ...(beforeReaderUnlisted ? { beforeReaderUnlisted: true } : {}),
    ...(prepareToolUnlisted ? { prepareToolUnlisted: true } : {}),
  };
}

/** The row as the executor sees it: the same tool in the wiring's rows (a test seam), else the row. */
function rowNamed(
  row: ConnectorWriteRow | undefined,
  w: CaptureActWiring,
): ConnectorWriteRow | undefined {
  return row === undefined ? undefined : rowNamedByToolId(row.toolId, actWriteRows(w));
}

/** The fixed owner-side text of an `approved` proposal run without the door's runtime wired. */
const NO_DOOR_RUNTIME_REASON = "the agent door is not available; nothing was run";

/**
 * The act door's executor seam (I28 + I2/I29/I22/I42): one fresh door executor per accept
 * (`buildAgentWriteExecutor`, static D39(e)), bound to the ACCEPTING session's consent channel,
 * with NO delegate (the local owner answers) and the proposal run as an `origin: "agent"` action.
 *
 * AD3a-2a: the tool is routed by `agentDoorRow` (every write row, not the 47-type table), so a
 * Wave 4 or bound row reaches the SAME executor with its typed confirmation, before-state and
 * prepare step. What may reach this function is decided by the gate's verdict at submit and
 * approval, never by routing. An `approved`-basis proposal runs on a consent channel that
 * re-checks the tool's definition after the owner's answer (`vetoingConsent`); a legacy basis has
 * no approval to compare against and is never vetoed.
 */
export function buildActDeps(
  w: CaptureActWiring,
  coordinator: ConsentCoordinator,
  clientId: string,
  opts: { readonly humanOnly?: { readonly onNonHuman: () => void } } = {},
): ActDeps {
  // The flag and the wrapper it vouches for come from this ONE place: asked for humanOnly, the
  // consent channel is wrapped here (inside the vetoing wrapper below) and the flag is set, so no
  // caller can claim "a person answered" over a channel that takes any answer.
  const humanChannel =
    opts.humanOnly === undefined
      ? coordinator
      : humanOnlyConsent(coordinator, opts.humanOnly.onNonHuman);
  return {
    ...(opts.humanOnly === undefined ? {} : { humanOnly: true }),
    async execute(actionType, input, provenance) {
      // The tool is ALWAYS gateway-chosen: the write row for a first-party type, the canonical
      // `<serviceId>_<tool>` key for a user-MCP type (the exact pair `connector.userMcpCall` builds,
      // and the only key the dispatcher's I42 pairing accepts for that type). The second lookup
      // returns undefined for anything that is not an `mcp_*` type.
      // Routed by the PRODUCTION write table (the `beforeStateRows` seam only changes what the
      // preview and the before-state are built from). What may reach here is decided by the gate's
      // verdict at submit and at approval (the agent door), never by routing.
      const row = agentDoorRow(actionType);
      const toolId = row?.toolId ?? userMcpToolKeyForActionType(actionType);
      if (toolId === undefined) {
        // Never dispatch a first-party write by its type (spec § 6.3): no routing row, no call.
        // This exact message is what classifyActionError maps to ERR_ACTION_TOOL_NOT_FOUND.
        throw new Error("Tool not found");
      }
      const door = w.agentDoor;
      if (provenance.basis === "approved" && door === undefined) {
        return { status: "rejected", reason: NO_DOOR_RUNTIME_REASON };
      }
      // The prompt must name the instance the write WILL run against, read fresh from the Vault
      // the write uses (as the executor does on every other door). A credential whose instance
      // cannot be established (a present but invalid base) is rejected here: no prompt, no
      // dispatch, a fixed outcome that echoes no stored value.
      try {
        await w.previewCredentialFor?.refresh?.(serviceOf(actionType));
      } catch {
        return {
          status: "rejected",
          reason: CREDENTIAL_UNVERIFIED_REASON,
          code: "ERR_ACTION_CREDENTIAL_UNVERIFIED",
        };
      }
      const options = await executeOptionsFor(door, rowNamed(row, w));
      let vetoed: string | undefined;
      let vetoCode: ActionRejectCode | undefined;
      const channel =
        provenance.basis === "approved" && door !== undefined
          ? vetoingConsent(
              humanChannel,
              async () => {
                const v = await door.verifyDefinition(actionType, provenance.createdAt);
                if (v.ok) return undefined;
                // Only the recheck's own suspension code is stored: a tool merely missing from the
                // listing is refused without a mark and without a code (OR-AD-14).
                vetoCode = v.code === VETO_CODE ? VETO_CODE : undefined;
                return v.detail;
              },
              (reason) => {
                vetoed = reason;
              },
            )
          : humanChannel;
      // Phase 28 AD1: the SAME door maker as the model door (no delegate, no standing rule, the
      // before-state runner), so the executor's own prompt (the typed preview with the target's
      // current state) is what the owner sees. The LOCAL owner who ran `captures accept` answers.
      // The action's `origin` and `proposer` are set here, by the gateway, from the stored row;
      // the tool is the routing table's, never the proposer's (I3).
      const executor = buildAgentWriteExecutor({
        clientId,
        consentCoordinator: channel,
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
      const action: PlannedAction = {
        type: actionType,
        origin: "agent",
        proposer: agentProposerOf(provenance, actionType),
        payload: { mcpToolId: toolId, input },
      };
      const out =
        options === undefined
          ? await executor.execute(action)
          : await executor.execute(action, options);
      if (out.status === "ok") return { status: "ok", result: out.result };
      // A veto is the owner's answer overruled: the executor recorded a decline, the capture
      // records why. Escaped HERE, once, so both captures.accept and approvals.approve return a
      // one-line, control-free reason (a guard's text can quote agent-supplied values).
      if (vetoed !== undefined) {
        return {
          status: "rejected",
          reason: escapeUnverifiedLine(vetoed),
          ...(vetoCode === undefined ? {} : { code: vetoCode }),
        };
      }
      const code = classifyDoorRejection(rowNamed(row, w), out.reason);
      return {
        status: "rejected",
        ...(out.reason === undefined ? {} : { reason: escapeUnverifiedLine(out.reason) }),
        ...(code === undefined ? {} : { code }),
      };
    },
  };
}

type Ctx = { readonly gate: CaptureGateDeps; readonly caller: CaptureCaller };

/**
 * `capture.submit` (AD3a-2a, D-7): the gate's reply, plus a fixed `deprecation` line ONLY for a proposal
 * accepted under the deprecation window. Added here because `mcp-sink/` cannot import the module that
 * holds the text. An approved proposal and every other kind get the reply exactly as before.
 */
async function submitWithNotice(
  gate: CaptureGateDeps,
  caller: CaptureCaller,
  params: unknown,
): Promise<unknown> {
  const out = await submitCapture(gate, caller, params);
  if (out.legacy !== true) return out;
  const actionType = actionTypeOfPayload(gate.store.get(out.id)?.payloadJson ?? null);
  return { ...out, deprecation: legacyNoticeFor(actionType ?? "") };
}

export function idParam(params: unknown): unknown {
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
        "capture.mine": (_p, c) => captureMine(c.gate, c.caller),
        "capture.describe": (p, c) =>
          describeActions(
            {
              capability: () => c.gate.capability(),
              refusals: c.gate.refusals,
              now: () => c.gate.now(),
              ...(ctx.describe === undefined ? {} : { describer: ctx.describe }),
            },
            c.caller,
            p,
          ),
        "capture.submit": (p, c) => submitWithNotice(c.gate, c.caller, p),
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
    return captureErrorToRpc(e);
  }
}

/** A `CaptureError` becomes the JSON-RPC error both capture namespaces answer with; anything else rethrows. */
export function captureErrorToRpc(e: unknown): never {
  if (e instanceof CaptureError) throw new RpcMethodError(-32001, e.message, { code: e.code });
  throw e;
}
