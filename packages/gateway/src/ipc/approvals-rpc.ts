import { agentDoorRow } from "../connectors/connector-writes/agent-door.ts";
import { LEGACY_LIST_HEADER } from "../connectors/connector-writes/agent-door-legacy.ts";
import { rowNamedByToolId } from "../connectors/connector-writes/preview.ts";
import { agentVerbatimInputLines, escapeUnverifiedLine } from "../engine/proposer-block.ts";
import { APPROVER_BY_KIND } from "../mcp-sink/capture-client-policy.ts";
import {
  acceptCapture,
  type CaptureCaller,
  getCapture,
  listActionProposals,
  rejectCapture,
} from "../mcp-sink/capture-gate.ts";
import {
  type ActionPayload,
  CAPTURE_LABEL_SOURCE,
  CaptureError,
} from "../mcp-sink/capture-types.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import {
  actWriteRows,
  buildActDeps,
  type CaptureActWiring,
  type CaptureRpcCtx,
  captureErrorToRpc,
  idParam,
} from "./capture-rpc.ts";
import type { ConsentCoordinator } from "./consent.ts";

/**
 * `approvals.*` (agent door AD2, spec § 7.2): the owner's queue of action proposals from MCP
 * agents and the one-step approval. A `cli` or `ui` connection only (`APPROVER_BY_KIND`; an
 * undeclared `unknown` connection is refused here though `captures.*` still serves it). LAN-
 * forbidden by namespace (I5), no HTTP route (I13), not on the Tauri allowlist (I7).
 *
 * `approvals.approve` reaches the act door ONLY through the gate's `acceptCapture` (the function
 * `captures.accept` uses), so `acceptAction` keeps its one caller (static D32(e)). What this module
 * adds is the human-only consent channel: an approval whose answer did not come from a person is
 * turned into a decline before the executor records it. This module imports nothing from `llm/`:
 * the whole flow needs no model.
 */
export const APPROVALS_METHODS = [
  "approvals.list",
  "approvals.get",
  "approvals.approve",
  "approvals.decline",
] as const;

/** The fixed owner-side text when an approval was not answered by a person. */
export const NON_HUMAN_REASON =
  "the approval did not come from a person at a terminal (--yes, a script and an old client cannot approve); nothing was run";

const GET_NOTE = "the typed preview and the target's current state appear when you approve";

type Ctx = { readonly rpc: CaptureRpcCtx; readonly caller: CaptureCaller };

/** Step 1 of every method: a declared `cli` or `ui` connection, else the standard forbidden-client error. */
function requireApprover(caller: CaptureCaller): void {
  if (!APPROVER_BY_KIND[caller.kind]) {
    throw new CaptureError(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      "approvals need a connection that declared cli or ui",
    );
  }
}

interface ProposalView {
  readonly wave: 2 | 3 | 4 | null;
  readonly typedConfirm: boolean;
}

/** The wave and typed-confirm flag of the real write row for an action type; a user-MCP type has none. */
function rowFacts(actionType: string, w: CaptureActWiring | undefined): ProposalView {
  const routed = agentDoorRow(actionType);
  const found = routed === undefined ? undefined : rowNamedByToolId(routed.toolId, actWriteRows(w));
  return found === undefined
    ? { wave: null, typedConfirm: false }
    : { wave: found.wave, typedConfirm: found.confirm !== undefined };
}

function escapedLabel(label: string | null): string | null {
  return label === null ? null : escapeUnverifiedLine(label);
}

function listView(
  rpc: CaptureRpcCtx,
  caller: CaptureCaller,
): { proposals: unknown[]; deprecation?: string } {
  const { proposals } = listActionProposals(rpc.gate, caller);
  return {
    // The deprecation header (AD3a-2a, D-7) only when a legacy row is shown; fixed gateway text.
    ...(proposals.some((p) => p.agentDoorLegacy) ? { deprecation: LEGACY_LIST_HEADER } : {}),
    proposals: proposals.map((p) => ({
      id: p.id,
      actionType: p.actionType,
      legacy: p.agentDoorLegacy,
      ...rowFacts(p.actionType, rpc.act),
      label: escapedLabel(p.clientLabel),
      labelSource: CAPTURE_LABEL_SOURCE,
      summary: escapeUnverifiedLine(p.summary),
      createdAt: p.createdAt,
      expiresAt: p.expiresAt,
    })),
  };
}

/** Step 2 of get/approve/decline: the row exists, the owner may read it, and it is an action. */
function requireActionRow(rpc: CaptureRpcCtx, caller: CaptureCaller, idRaw: unknown) {
  const detail = getCapture(rpc.gate, caller, idRaw);
  if (detail.kind !== "action") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      "approvals handle agent-proposed actions; use captures accept for a decision, term or link",
    );
  }
  return detail;
}

function getView(rpc: CaptureRpcCtx, caller: CaptureCaller, idRaw: unknown): unknown {
  const detail = requireActionRow(rpc, caller, idRaw);
  const stored = detail.payload as ActionPayload;
  // Read from the store, not from `captures.get`'s shape (the desktop's contract is unchanged).
  const legacy = rpc.gate.store.get(detail.id)?.agentDoorLegacy === true;
  const lines = agentVerbatimInputLines(stored.input)
    .slice(1)
    .flatMap((l) => l.split("\n"));
  return {
    id: detail.id,
    state: detail.state,
    actionType: stored.actionType,
    legacy,
    ...(legacy ? { deprecation: LEGACY_LIST_HEADER } : {}),
    ...rowFacts(stored.actionType, rpc.act),
    label: escapedLabel(detail.clientLabel),
    labelSource: CAPTURE_LABEL_SOURCE,
    summary: escapeUnverifiedLine(stored.summary),
    createdAt: detail.createdAt,
    expiresAt: detail.expiresAt,
    inputLines: lines,
    note: GET_NOTE,
  };
}

async function approve(
  rpc: CaptureRpcCtx,
  caller: CaptureCaller,
  idRaw: unknown,
  consent: ConsentCoordinator | undefined,
): Promise<unknown> {
  // 2. The row is an action the owner may read (NOT_FOUND, expiry sweep, owner role, kind).
  const detail = requireActionRow(rpc, caller, idRaw);
  // 3. The act door's deps, around THIS connection's consent channel, human answers only.
  let nonHuman = false;
  const act =
    rpc.act !== undefined && consent !== undefined
      ? buildActDeps(rpc.act, consent, caller.clientId, {
          humanOnly: {
            onNonHuman: () => {
              nonHuman = true;
            },
          },
        })
      : undefined;
  // 4. The gate's own accept: capability, owner role, state, expiry, classify, configured,
  //    destination, CAS claim, then the executor (static D32(e): its only door to acceptAction).
  const out = await acceptCapture(rpc.gate, caller, detail.id, act);
  if (out.state === "accepted") {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${detail.id} is not an action`);
  }
  // 5. The owner's reply. The reason is the owner's alone (never stored, never in capture.state).
  // (buildActDeps already escaped the executor's reason, for this path and captures.accept alike.)
  const reason = nonHuman ? NON_HUMAN_REASON : out.reason;
  return {
    id: out.id,
    state: out.state,
    ...(out.outcomeRef === undefined ? {} : { outcomeRef: out.outcomeRef }),
    ...(out.errorCode === undefined ? {} : { errorCode: out.errorCode }),
    ...(reason === undefined || out.state !== "rejected" ? {} : { reason }),
  };
}

function decline(rpc: CaptureRpcCtx, caller: CaptureCaller, idRaw: unknown): unknown {
  const detail = requireActionRow(rpc, caller, idRaw);
  return rejectCapture(rpc.gate, caller, detail.id);
}

export async function dispatchApprovalsRpc(
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
      { rpc: ctx, caller },
      {
        "approvals.list": (_p, c) => {
          requireApprover(c.caller);
          return listView(c.rpc, c.caller);
        },
        "approvals.get": (p, c) => {
          requireApprover(c.caller);
          return getView(c.rpc, c.caller, idParam(p));
        },
        "approvals.approve": (p, c) => {
          requireApprover(c.caller);
          return approve(c.rpc, c.caller, idParam(p), consent);
        },
        "approvals.decline": (p, c) => {
          requireApprover(c.caller);
          return decline(c.rpc, c.caller, idParam(p));
        },
      },
    );
  } catch (e) {
    return captureErrorToRpc(e);
  }
}
