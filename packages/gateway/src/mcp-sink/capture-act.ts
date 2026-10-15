import { redactAuditPayload } from "../audit/format-audit-payload.ts";
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
// annotation characters. Also the fillers that render as nothing (combining grapheme joiner,
// Hangul fillers, Khmer inherent vowels, halfwidth Hangul filler), the variation selectors (BMP
// and supplement), and the astral TAG characters, which can spell a whole hidden instruction.
// NOT U+202F (narrow no-break space): it renders as a space.
// Written as NUMBERS, never as regex escapes or literals: a source formatter can rewrite a `\u`
// escape into the invisible character itself, and an invisible character in this list is
// exactly what a reviewer cannot see. Each entry is an inclusive [first, last] code point.
const INVISIBLE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x0000, 0x0009],
  [0x000b, 0x001f],
  [0x007f, 0x009f],
  [0x00ad, 0x00ad],
  [0x034f, 0x034f],
  [0x061c, 0x061c],
  [0x115f, 0x1160],
  [0x17b4, 0x17b5],
  [0x180e, 0x180e],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x206f],
  [0x3164, 0x3164],
  [0xfe00, 0xfe0f],
  [0xfeff, 0xfeff],
  [0xffa0, 0xffa0],
  [0xfff9, 0xfffb],
  [0xe0000, 0xe007f],
  [0xe0100, 0xe01ef],
];
// One alternative per range (each a single-range class) so no class mixes a base character with a
// combining one; the `u` flag makes every match a whole code point, astral included. The range ends
// are inserted as characters at RUNTIME: none of them is `]`, `-`, `^` or a backslash, so each
// class is literal.
const INVISIBLE_RE = new RegExp(
  INVISIBLE_RANGES.map(
    ([lo, hi]) => `[${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}]`,
  ).join("|"),
  "gu",
);

/** BMP as `\uXXXX`; astral as `\u{XXXXX}` (a 4-digit form would misrepresent the code point). */
function escapeCodePoint(c: string): string {
  const cp = c.codePointAt(0) ?? 0;
  return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, "0")}`;
}

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
    // `outcomeRef` is a connector-returned URL: it may carry a presigned/token secret (spec § 8.2).
    actionJson: redactAuditPayload(body),
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
  const visible = (s: string): string => s.replace(INVISIBLE_RE, escapeCodePoint);
  // A one-line field must not start a new prompt line either: LF is escaped here too. `\` and `"`
  // are escaped FIRST (before `visible` adds its own backslashes), so a quoted label cannot close
  // its quotes and fake the provenance text that follows it.
  const visibleLine = (s: string): string =>
    visible(s.replaceAll("\\", "\\\\").replaceAll('"', '\\"')).replaceAll("\n", "\\u000a");
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
