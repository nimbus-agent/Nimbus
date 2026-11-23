import type { ActuationRequest } from "../cu-actuate.ts";
import type { BrowserActionInput } from "../cu-classify.ts";
import { originOf } from "../cu-request-policy.ts";
import type { BrowserLane } from "../cu-types.ts";
import type { CuActionKind } from "./kinds.ts";
import type { RunActionRequest } from "./types.ts";

/** Every `ActuationRequest.kind` value maps to a `BrowserActionInput` the classifier reads. */
export async function buildBrowserActionInput(
  lane: BrowserLane,
  req: RunActionRequest,
): Promise<BrowserActionInput> {
  const currentOrigin = lane.currentOrigin();
  switch (req.kind) {
    case "read":
    case "screenshot":
    case "download":
      return { kind: req.kind, node: null, currentOrigin, targetOrigin: null };
    case "navigate":
      return {
        kind: req.kind,
        node: null,
        currentOrigin,
        targetOrigin: originOf(req.url ?? ""),
      };
    case "click":
    case "type":
      return {
        kind: req.kind,
        node: await lane.observe(req.selector ?? ""),
        currentOrigin,
        targetOrigin: null,
      };
    case "terminal_write":
      // Unreachable in production: `runActionExclusive` routes a terminal session to its own arm
      // before this is called, and `kindBelongsToLane` refuses a terminal kind on a browser session
      // before a budget slot is even spent. Handled explicitly rather than left to the `never`
      // below, because a bare exhaustiveness throw here would report "unrecognised action kind" for
      // a kind that is perfectly well recognised — just not by this lane.
      throw new Error("ERR_CU_LANE_KIND_MISMATCH: terminal_write is not a browser action");
    default: {
      // Exhaustiveness (ruling D): a Task 5+6 review flagged that an unrecognised kind fell
      // through to the click/type node path with no rule of its own. A kind this switch was never
      // told to handle is now a COMPILE ERROR, matching I29's total `ClientKind` map precedent.
      const exhaustive: never = req.kind;
      throw new Error(`unrecognised action kind: ${String(exhaustive)}`);
    }
  }
}

export function describeObservedTarget(kind: CuActionKind, input: BrowserActionInput): string {
  if (input.node !== null) {
    const parts = [kind, input.node.tagName.toLowerCase()];
    if (input.node.type !== null) parts.push(`type=${input.node.type}`);
    if (input.node.accessibleName !== null) parts.push(`"${input.node.accessibleName}"`);
    return parts.join(" ");
  }
  if (kind === "navigate") {
    return `navigate ${input.currentOrigin ?? "?"} -> ${input.targetOrigin ?? "unknown"}`;
  }
  return kind;
}

/**
 * The parameters `performActuation` is handed for a browser action.
 *
 * `exactOptionalPropertyTypes` forbids handing an optional `string | undefined` prop straight
 * through to a target whose optional prop is typed as bare `string` — so an absent field is
 * OMITTED here rather than explicitly set to `undefined`.
 */
export function browserActuationInput(req: RunActionRequest): ActuationRequest {
  return {
    kind: req.kind,
    ...(req.selector !== undefined ? { selector: req.selector } : {}),
    ...(req.text !== undefined ? { text: req.text } : {}),
    ...(req.url !== undefined ? { url: req.url } : {}),
  };
}
