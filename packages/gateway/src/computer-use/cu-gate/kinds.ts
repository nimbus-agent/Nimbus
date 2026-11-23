import type { CuLane } from "../../config/nimbus-toml.ts";

const ACTION_KINDS = [
  "click",
  "type",
  "navigate",
  "read",
  "screenshot",
  "download",
  "terminal_write",
] as const;
export type CuActionKind = (typeof ACTION_KINDS)[number];

// `download` is a recognised kind but NOT a browser-lane action: no lane can perform one (the
// driver denies downloads at the browser level, and `performActuation` throws for it). Listing it
// here used to send the owner a consent prompt for an action that could only fail after approval;
// leaving it out refuses it out of envelope, before consent and without spending budget.
const BROWSER_KINDS: ReadonlySet<CuActionKind> = new Set<CuActionKind>([
  "click",
  "type",
  "navigate",
  "read",
  "screenshot",
]);
const TERMINAL_KINDS: ReadonlySet<CuActionKind> = new Set<CuActionKind>(["terminal_write"]);

/**
 * TOTAL over `CuLane`, so a third lane is a COMPILE ERROR here rather than a silent gap — the same
 * shape I29's `ClientKind` map uses.
 *
 * `screen` is listed with an EMPTY set because the lane exists in config and ships no actions:
 * naming it and giving it nothing is honest, and omitting it would be a hole that reads as an
 * oversight. Every kind proposed against it is refused out of envelope.
 */
const KINDS_BY_LANE: Readonly<Record<CuLane, ReadonlySet<CuActionKind>>> = {
  browser: BROWSER_KINDS,
  terminal: TERMINAL_KINDS,
  screen: new Set<CuActionKind>(),
};

export function kindBelongsToLane(kind: CuActionKind, lane: CuLane): boolean {
  return KINDS_BY_LANE[lane].has(kind);
}

/**
 * Runtime guard over `CuActionKind` (fix round 1, M-14). `RunActionRequest.kind` is typed, but a
 * TS type is erased at the JSON-RPC boundary Task 11 builds on top of this gate — an
 * externally-supplied `kind` reaches this module as `unknown` in practice, and without a runtime
 * check an unrecognised value would ride all the way to `buildBrowserActionInput`'s `never`
 * default branch, which throws (safely, now that every post-`seq` throw is captured by
 * `runAction`'s `finally` — see the C-1 fix). Task 11 should call this BEFORE constructing a
 * `RunActionRequest`, so a malformed `kind` is rejected at the transport boundary rather than by
 * consuming a budget slot first.
 */
export function isCuActionKind(v: unknown): v is CuActionKind {
  return typeof v === "string" && (ACTION_KINDS as readonly string[]).includes(v);
}
