import { appendAuditEntry } from "../db/audit-chain.ts";
import { serviceOf } from "../engine/service-of.ts";
import { CAPTURE_ROLE_BY_KIND } from "./capture-client-policy.ts";
import type { CaptureCaller, CaptureGateDeps } from "./capture-gate.ts";
import {
  type ActDeps,
  type ActionErrorCode,
  type ActionPayload,
  type ActionProvenance,
  CaptureError,
  type CaptureRow,
} from "./capture-types.ts";

/**
 * Invariant I28's act door (spec 2026-10-15 § 8). The ONE place a proposed connector action leaves
 * the machine: `acceptAction`, defined only here and called only from `capture-gate.ts`'s
 * `acceptCapture` (static D32(e)). Read the fixed order top to bottom. This module never imports
 * the executor or `connectors/` (D32(f)): execution arrives as `ActDeps`, built per call by
 * `ipc/capture-rpc.ts`.
 */
export type ActGateDeps = Pick<
  CaptureGateDeps,
  "db" | "store" | "capability" | "classifyAction" | "isServiceConfigured" | "now"
>;

export type ActionAcceptResult = {
  readonly id: string;
  readonly state: "executed" | "rejected" | "failed";
  readonly outcomeRef?: string;
  readonly errorCode?: ActionErrorCode;
};

const OUTCOME_FIELDS = ["url", "html_url", "webUrl", "permalink"] as const;
const OUTCOME_MAX = 512;
// Shown VISIBLY in the prompt, never rendered: the input is sent verbatim and cannot be stripped
// (Review Focus 1). Covers C0 controls except LF (the provenance lines never pass through
// JSON.stringify, and the pretty-printed JSON's own layout newlines must survive), DEL + C1, soft
// hyphen, the Arabic letter mark, the Mongolian vowel separator, ZWSP..RLM (incl. LRM/RLM),
// U+2028..U+202E (line/para separators + bidi embeddings/overrides), U+2060..U+206F (word joiner,
// invisible operators, bidi isolates, deprecated format chars), the BOM and the interlinear
// annotation characters. NOT U+202F (narrow no-break space): it renders as a space.
const INVISIBLE_RE =
  // biome-ignore lint/suspicious/noControlCharactersInRegex: escaping control characters is the purpose
  /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u00AD\u061C\u180E\u200B-\u200F\u2028-\u202E\u2060-\u206F\uFEFF\uFFF9-\uFFFB]/g;

function audit(
  deps: Pick<ActGateDeps, "db">,
  actionType: string,
  body: Record<string, unknown>,
  now: number,
  sessionId: string,
): void {
  appendAuditEntry(deps.db, {
    actionType,
    // I4: no consent gate ran HERE — the approval is the executor's own `approved` row.
    hitlStatus: "not_required",
    actionJson: JSON.stringify(body),
    timestamp: now,
    sessionId,
  });
}

export function expireDueActionsAudited(
  deps: Pick<ActGateDeps, "db" | "store">,
  nowMs: number,
  sessionId: string,
): string[] {
  let ids: string[] = [];
  deps.db.transaction(() => {
    ids = deps.store.expireDueActions(nowMs);
    for (const id of ids) {
      audit(
        deps,
        "capture.action.expire",
        { captureId: id, expiredAt: nowMs, outcome: "expired" },
        nowMs,
        sessionId,
      );
    }
  })();
  return ids;
}

export function reconcileActionsAtBoot(
  deps: Pick<ActGateDeps, "db" | "store">,
  nowMs: number,
): { expired: number; interrupted: number } {
  const expired = expireDueActionsAudited(deps, nowMs, "gateway-boot");
  let interrupted: string[] = [];
  deps.db.transaction(() => {
    interrupted = deps.store.failInterruptedActions(nowMs);
    for (const id of interrupted) {
      audit(
        deps,
        "capture.action.outcome",
        { captureId: id, outcome: "failed", errorCode: "ERR_ACTION_INTERRUPTED" },
        nowMs,
        "gateway-boot",
      );
    }
  })();
  return { expired: expired.length, interrupted: interrupted.length };
}

export function classifyActionError(e: unknown): ActionErrorCode {
  const msg = e instanceof Error ? e.message : "";
  if (/ exceeded \d+ms timeout$/.test(msg)) return "ERR_ACTION_TIMEOUT";
  if (msg === "Tool not found" || / has no execute implementation$/.test(msg))
    return "ERR_ACTION_TOOL_NOT_FOUND";
  return "ERR_ACTION_DISPATCH";
}

export function outcomeRefOf(result: unknown): string | undefined {
  if (typeof result !== "object" || result === null || Array.isArray(result)) return undefined;
  const r = result as Record<string, unknown>;
  for (const k of OUTCOME_FIELDS) {
    const v = r[k];
    if (typeof v === "string" && v.length <= OUTCOME_MAX && v.startsWith("https:")) return v;
  }
  return undefined;
}

export function formatActionConsent(
  p: ActionProvenance,
  actionType: string,
  input: Readonly<Record<string, unknown>>,
): string {
  const visible = (s: string): string =>
    s.replace(INVISIBLE_RE, (c) => `\\u${(c.codePointAt(0) ?? 0).toString(16).padStart(4, "0")}`);
  // A one-line field must not start a new prompt line either: LF is escaped here too.
  const visibleLine = (s: string): string => visible(s).replaceAll("\n", "\\u000a");
  return [
    "Agent-proposed action — requires your approval",
    `Proposed by MCP client "${visibleLine(p.clientLabel ?? "unlabelled")}" at ${new Date(p.createdAt).toISOString()}, expires ${new Date(p.expiresAt).toISOString()}`,
    `Agent's summary (unverified): ${visibleLine(p.summary)}`,
    `Type: ${actionType}`,
    "Input (verbatim, exactly what will be sent):",
    visible(JSON.stringify(input, null, 2)),
  ].join("\n");
}

function parseStored(row: CaptureRow): ActionPayload {
  if (row.payloadJson === null || row.expiresAt === null) {
    throw new CaptureError("ERR_CAPTURE_STATE", `capture ${row.id} has no action payload`);
  }
  return JSON.parse(row.payloadJson) as ActionPayload;
}

export async function acceptAction(
  deps: ActGateDeps,
  caller: CaptureCaller,
  row: CaptureRow,
  act: ActDeps | undefined,
): Promise<ActionAcceptResult> {
  // 1. Capability incl. mcp_action (live, fail-closed). No ActDeps means no way to execute: refuse.
  const cap = deps.capability();
  if (!cap.actionEnabled || act === undefined) {
    throw new CaptureError("ERR_CAPTURE_DISABLED", "the act door is off; rejecting still works");
  }
  // 2. Owner only.
  if (CAPTURE_ROLE_BY_KIND[caller.kind] !== "owner") {
    throw new CaptureError(
      "ERR_CAPTURE_FORBIDDEN_CLIENT",
      `a ${caller.kind} client cannot review captures`,
    );
  }
  // 3. State + expiry. The row is read ONCE (by the caller) and never re-read after the claim.
  if (row.state !== "proposed") {
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${row.id} is ${row.state}; only a proposed action can be accepted`,
    );
  }
  const stored = parseStored(row);
  const expiresAt = row.expiresAt as number;
  if (deps.now() >= expiresAt) {
    expireDueActionsAudited(deps, deps.now(), caller.clientId);
    throw new CaptureError(
      "ERR_CAPTURE_EXPIRED",
      `capture ${row.id} expired; ask the agent to propose it again`,
    );
  }
  // 4. Re-classify and re-check configured-ness (a --model revoke, a policy tightening, a removed
  //    connector). A refusal leaves the row proposed.
  const verdict = deps.classifyAction?.(stored.actionType) ?? { kind: "unknown" as const };
  if (verdict.kind !== "proposable") {
    throw new CaptureError(
      "ERR_CAPTURE_ACTION_NOT_PROPOSABLE",
      `${stored.actionType} is not proposable now; the capture stays proposed`,
    );
  }
  const configured = (await deps.isServiceConfigured?.(serviceOf(stored.actionType))) === true;
  if (!configured) {
    throw new CaptureError(
      "ERR_CAPTURE_CONNECTOR_UNCONFIGURED",
      `${serviceOf(stored.actionType)} is not configured; the capture stays proposed`,
    );
  }
  // 5. Claim: ONE transaction, CAS incl. the expiry predicate (closes the window across step 4's await).
  const claimAt = deps.now();
  let won = false;
  deps.db.transaction(() => {
    won = deps.store.claimAction(row.id, claimAt);
    if (won)
      audit(
        deps,
        "capture.action.accept",
        { captureId: row.id, actionType: stored.actionType },
        claimAt,
        caller.clientId,
      );
  })();
  if (!won)
    throw new CaptureError(
      "ERR_CAPTURE_STATE",
      `capture ${row.id} changed state or expired concurrently`,
    );
  // 6. Build from the row read in step 3.
  const provenance: ActionProvenance = {
    captureId: row.id,
    clientLabel: row.clientLabel,
    createdAt: row.createdAt,
    expiresAt,
    summary: stored.summary,
  };
  // 7. Execute through the executor the RPC layer built (I2, I29, I22, I42 apply unchanged).
  let result: ActionAcceptResult;
  try {
    const out = await act.execute(stored.actionType, stored.input, provenance);
    if (out.status === "ok") {
      const outcomeRef = outcomeRefOf(out.result);
      result =
        outcomeRef === undefined
          ? { id: row.id, state: "executed" }
          : { id: row.id, state: "executed", outcomeRef };
    } else {
      result = { id: row.id, state: "rejected" };
    }
  } catch (e) {
    result = { id: row.id, state: "failed", errorCode: classifyActionError(e) };
  }
  // 8. Finalize: ONE transaction. A failure here leaves `executing` for the boot reconcile.
  const doneAt = deps.now();
  try {
    deps.db.transaction(() => {
      const ok = deps.store.finalizeAction(
        row.id,
        result.state,
        {
          ...(result.outcomeRef === undefined ? {} : { outcomeRef: result.outcomeRef }),
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        },
        doneAt,
      );
      if (!ok) throw new Error(`capture ${row.id} was not executing at finalize`);
      audit(
        deps,
        "capture.action.outcome",
        {
          captureId: row.id,
          actionType: stored.actionType,
          outcome: result.state,
          ...(result.outcomeRef === undefined ? {} : { outcomeRef: result.outcomeRef }),
          ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
        },
        doneAt,
        caller.clientId,
      );
    })();
  } catch (e) {
    process.stderr.write(
      `[capture-act] finalize failed for ${row.id} after dispatch (state stays executing; boot marks it failed): ${e instanceof Error ? e.message : String(e)}\n`,
    );
  }
  return result;
}
