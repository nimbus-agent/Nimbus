// packages/gateway/src/egress/egress-bearing-kinds.ts

import type { ClientKind } from "../ipc/server/client-kind.ts";
import type { AgentBriefSourceType } from "./agent-brief-egress.ts";

/**
 * Which client kinds' agent briefs are ledgered, and under which `egress_ledger.source_type`.
 *
 * TOTAL over `ClientKind`, on purpose. This started life as `ctx.caller?.kind === "mcp"` — an
 * equality that was correct for one transport and silently appended nothing for the second. Written
 * as a `Partial` map or a `Map`, a THIRD transport would be an `undefined` lookup: the brief would
 * be served, no row would be written, and no test would fail. As a total `Record`, adding a member
 * to `ClientKind` without deciding its egress status does not compile.
 *
 * `null` means "append nothing" and ONLY that. It is not overloaded with "not found" — an absent
 * key is a type error, not a null. (A lookup whose `null` also means "I could not find it", and
 * whose null is consumed as permission, is how the clip-scope fail-open shipped in the previous PR.
 * The fail direction here is inverted — a null suppresses a RECORD rather than granting a request —
 * but the totality is what keeps it from becoming a silent coverage hole either way.)
 *
 * `cli` and `ui` are the owner reading their own index on their own machine; recording those as
 * outbound egress would make `nimbus prove` count the user against themselves. `unknown` is a
 * client that declared nothing, which is not evidence of egress either — and guessing "yes" would
 * write into an append-only, hash-chained record whose only mutation path is a HITL-gated prune.
 */
export const EGRESS_BEARING_CLIENT_KINDS: Readonly<
  Record<ClientKind, AgentBriefSourceType | null>
> = Object.freeze({
  cli: null,
  ui: null,
  unknown: null,
  mcp: "mcp",
  http: "http",
  // NOT the same `null` as `cli`/`ui`. Those are the owner reading their own index, which is not
  // egress at all. A channel brief IS egress — and it is ledgered at the POST, by
  // `egress/chatops-egress.ts`, where the bytes actually leave the machine. Appending here as well
  // would write TWO rows for ONE outbound event: exactly the double-count `outcome` was made a
  // marker to avoid. If the chatops post appender is ever removed, this must become "chatops".
  chatops: null,
});

/**
 * The ledger source type for a caller kind, or null when that kind bears no egress.
 *
 * `undefined` (no caller descriptor at all — unit tests and in-process callers) reaches the same
 * answer as a non-bearing kind rather than throwing.
 */
export function egressSourceTypeForClientKind(
  kind: ClientKind | undefined,
): AgentBriefSourceType | null {
  return kind === undefined ? null : EGRESS_BEARING_CLIENT_KINDS[kind];
}
