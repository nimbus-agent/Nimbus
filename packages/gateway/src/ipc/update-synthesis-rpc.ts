import type { Database } from "bun:sqlite";

import { UPDATE_AUDIENCES, type UpdateAudience } from "../agents/_lib/incident-update-render.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { IncidentError } from "../incident/assemble.ts";
import { draftUpdateWithLead } from "../update-synthesis/update-lead.ts";
import type { RpcMissOrHit } from "./_lib/dispatch-by-method.ts";
import { IncidentRpcError, requireOwnerKind } from "./incident-rpc.ts";
import { recordIdFor, requireKeys } from "./incident-rpc-params.ts";
import type { ClientKind } from "./server/client-kind.ts";

/**
 * `incident.updateSynthesize` (Phase 10 IC9b; owner ruling OR-S4-SCRIBE, `nimbus incident update --synthesize`).
 *
 *   incident.updateSynthesize { id, audience?, version? }
 *       -> { recordId, version, currentVersion, audience, text, lead, synthesis }       a read
 *
 * Serves only a connection whose DECLARED kind is `cli` or `ui` (`requireOwnerKind`, before any query or model
 * build); the `incident` namespace is LAN-forbidden (I5) and not renderer-callable (I7). It posts NOTHING: the
 * text is a draft, sent only through `incident.updateSend` behind the owner's own approval. A model is reached
 * only here, on this owner request, never by the scribe (OR-10-8).
 */

export interface UpdateSynthesisRpcCtx {
  readonly db: Database;
  readonly now: () => number;
  /** Builds the synthesis runner for `agents.incident_update`; `undefined` when no model can be used. */
  readonly runner: () => SynthesisRunner | undefined;
}

export type UpdateSynthesisCaller = { readonly clientId: string; readonly kind: ClientKind };

export async function dispatchUpdateSynthesisRpc(
  method: string,
  params: unknown,
  ctx: UpdateSynthesisRpcCtx,
  caller: UpdateSynthesisCaller,
): Promise<RpcMissOrHit> {
  if (method !== "incident.updateSynthesize") return { kind: "miss" };
  requireOwnerKind(caller.kind);
  const p = requireKeys(method, params, ["id", "audience", "version"]);
  const recordId = recordIdFor(ctx.db, method, p);
  const audienceRaw = p["audience"];
  if (
    audienceRaw !== undefined &&
    (typeof audienceRaw !== "string" ||
      !(UPDATE_AUDIENCES as readonly string[]).includes(audienceRaw))
  ) {
    throw new IncidentRpcError(-32602, `${method}: audience must be stakeholders or engineers`);
  }
  const versionRaw = p["version"];
  if (
    versionRaw !== undefined &&
    (typeof versionRaw !== "number" || !Number.isSafeInteger(versionRaw) || versionRaw < 1)
  ) {
    throw new IncidentRpcError(-32602, `${method}: version must be a positive integer`);
  }
  try {
    const out = await draftUpdateWithLead({
      db: ctx.db,
      recordId,
      audience: (audienceRaw ?? "stakeholders") as UpdateAudience,
      version: versionRaw as number | undefined,
      nowMs: ctx.now(),
      runner: ctx.runner(),
    });
    return {
      kind: "hit",
      value: {
        recordId: out.recordId,
        version: out.version,
        currentVersion: out.currentVersion,
        audience: out.audience,
        text: out.text,
        lead: out.lead,
        synthesis: out.synthesis,
      },
    };
  } catch (e) {
    if (e instanceof IncidentError) {
      throw new IncidentRpcError(-32602, `${e.code}: ${e.message.replace(/^[A-Z_]+: /, "")}`);
    }
    throw e;
  }
}
