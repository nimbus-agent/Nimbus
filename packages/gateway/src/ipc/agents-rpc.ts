import { timeBriefSettlement } from "../agents/_lib/brief-latency.ts";
import { recordAgentBriefEgress } from "../egress/agent-brief-egress.ts";
import { egressSourceTypeForClientKind } from "../egress/egress-bearing-kinds.ts";
import { codeUnitCompare } from "../util/code-unit-compare.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";
import type { AgentsRpcContext } from "./agents-rpc/_shared.ts";
import {
  handleDecisions,
  handleGlossary,
  handleNegotiate,
  handleOwnership,
  handlePremortem,
  handleWhy,
  handleWhyPeek,
} from "./agents-rpc/handlers-content.ts";
import {
  handleCatchup,
  handleChangelog,
  handleExpert,
  handleImpact,
  handleOncall,
  handleStandup,
} from "./agents-rpc/handlers-core.ts";
import {
  handleConflicts,
  handleGhost,
  handleHuddle,
  handleJanitor,
  handlePreflight,
} from "./agents-rpc/handlers-federated.ts";

// The error class and the context type live in `agents-rpc/_shared.ts` (the validator and handler
// modules beside it import them from there); every importer of this path keeps its names.
export { AgentsRpcError } from "./agents-rpc/_shared.ts";
export type { AgentsRpcContext };

/**
 * The `agents.*` methods this module answers.
 *
 * Declared once and used for BOTH the egress-append test and the dispatch, so the ledgered set is
 * definitionally the served set. A second, hand-maintained list of the same seventeen strings is how
 * the over-counting defect this replaces was introduced: `method.startsWith("agents.")` appended an
 * `authorized` row for `agents.<anything>`, which then failed `-32601` having done no work — so
 * `nimbus prove` over-counted, and an unbounded caller-supplied `method` reached a hashed,
 * append-only column whose only mutation path is a HITL-gated prune.
 */
const AGENTS_RPC_HANDLERS = {
  "agents.expert": handleExpert,
  "agents.impact": handleImpact,
  "agents.catchup": handleCatchup,
  "agents.changelog": handleChangelog,
  "agents.standup": handleStandup,
  "agents.oncall": handleOncall,
  "agents.ghost": handleGhost,
  "agents.conflicts": handleConflicts,
  "agents.huddle": handleHuddle,
  "agents.janitor": handleJanitor,
  "agents.ownership": handleOwnership,
  "agents.premortem": handlePremortem,
  "agents.preflight": handlePreflight,
  "agents.why": handleWhy,
  "agents.whyPeek": handleWhyPeek,
  "agents.glossary": handleGlossary,
  "agents.decisions": handleDecisions,
  "agents.negotiate": handleNegotiate,
} as const satisfies RpcMethodHandlerMap<AgentsRpcContext>;

const AGENTS_METHOD_PREFIX = "agents.";

/**
 * Methods served on the socket but deliberately NOT exposed on any EXTERNAL surface — today the
 * HTTP API (`POST /v1/agents/{agent}` / `GET /v1/agents`); ChatOps is the next surface to consume
 * this same set, via `resolveExternalAgentMethod`/`EXTERNAL_AGENT_NAMES` below. This exclusion set
 * is not HTTP-specific reasoning re-applied by coincidence — it is INHERITED, not re-decided, by
 * every external surface that reaches this map: every reason below is *stronger*, not weaker, in a
 * shared channel like ChatOps, where a prompt is typed by one person and read by everyone in the
 * room.
 *
 * `agents.preflight` — the I24 federated-action path. A caller that can invoke it can queue consent
 * prompts on the owner's machine; an external caller must never originate one. Carried over
 * unchanged from the MCP tool surface, for the same reason. In a shared channel this is WORSE, not
 * better: anyone who can type in the channel could queue a consent prompt on the owner's machine.
 *
 * `agents.whyPeek` — the namespace's one SYNCHRONOUS method. It returns a WhyPeek payload directly
 * and never calls `notify`, so it cannot be represented on the HTTP `{runId}` + poll contract: the
 * run would never complete and the caller would poll until the TTL turned a success into a 410.
 * Exposing it needs its own inline-result route, which is a later decision rather than a second
 * response shape bolted onto this one. Note it is still LEDGERED when reached over any transport —
 * it is a member of AGENTS_RPC_HANDLERS, and the egress append is gated on that map, not on this
 * one.
 *
 * `agents.premortem` — unlike every other brief in this map, building it is NOT a pure read:
 * `runPremortem` calls `proposeWatchers`, which writes paused `watcher` rows (and their
 * `premortem_watcher_proposal` tombstone) directly via `insertWatcherIfAbsent` — no HITL gate,
 * because the watcher is created paused rather than armed. `repropose: true` goes further and
 * DELETES this epic's tombstones outright. Those writes were reviewed and accepted for a
 * same-machine caller (CLI socket, Tauri renderer — I7's XSS threat model, not "arbitrary
 * network caller"), but an external caller reaching them unprompted is the same shape of
 * concern `agents.preflight` is excluded for: side effects on the owner's machine an external
 * caller can trigger without the owner initiating them. In a shared channel, anyone able to post a
 * command could trigger these writes — worse than a single bearer-token holder. Keep this out of
 * every external surface until that gets its own deliberate review — carried over from the MCP
 * tool surface, which also does not define a premortem tool.
 *
 * `agents.negotiate` — excluded for a DIFFERENT reason than the three above: it has no side
 * effects (it writes nothing) and its response shape fits the runId+poll contract fine, so
 * neither the `preflight`/`premortem` nor the `whyPeek` criterion applies. Combined with
 * `--person`, external exposure would let any holder of the `agents` token/scope assemble a
 * contribution dossier on any indexed person without the owner initiating it. The CLI and Tauri
 * renderer are same-machine, owner-initiated surfaces (I7's XSS threat model, not "arbitrary
 * network caller"); the local HTTP API is not — a bearer token can be held and replayed by
 * anything on the loopback/LAN boundary that surface trusts. A shared ChatOps channel makes this
 * exclusion's reasoning *stronger*, not weaker: `negotiate --person` is a dossier-builder for
 * anyone who can read the room, not just a single token holder.
 *
 * `agents.changelog` — excluded for a SEQUENCING reason, not a subject-matter objection like the
 * three above or `negotiate`'s dossier concern: it is a pure read with no side effects and its
 * response shape fits the runId+poll contract fine. Shape is settling against ONE consumer (the
 * CLI) before it is committed across HTTP, MCP and ChatOps, each of which carries its own count
 * assertion. Revisit once the brief has been read in anger.
 *
 * `agents.standup` — excluded because it is OWNER-SCOPED BY CONSTRUCTION, which makes it the one
 * entry here whose reasoning is about what the brief IS rather than what a caller could do with
 * it. Every section is the local owner's own activity, resolved from local state — `git config
 * user.email`, the OS username, `[user] mePersonId` — and `requireStandupParams` accepts no
 * person parameter at all. On the CLI and the Tauri renderer that is exactly right: the caller
 * IS the owner. Over HTTP it is meaningless in one direction and leaky in the other — a bearer
 * token cannot ask about itself, so it would receive the OWNER's day, which is `negotiate
 * --person`'s dossier concern arriving without anyone having to pass a parameter. In a shared
 * ChatOps channel it is worse still: whoever typed the command would get a report on the person
 * running the gateway, posted where the room can read it. Unlike `changelog`'s, this exclusion is
 * not waiting on a sequencing decision — an external surface for this brief needs a way to
 * establish WHO IS ASKING first, which is a different feature.
 */
const EXTERNAL_EXCLUDED_AGENT_METHODS: ReadonlySet<string> = new Set([
  "agents.preflight",
  "agents.premortem",
  "agents.whyPeek",
  "agents.negotiate",
  // Sequencing, not subject-matter — see the doc comment above.
  "agents.changelog",
  // Owner-scoped by construction, which is the reason — see the doc comment above.
  "agents.standup",
]);

/**
 * The served agent methods, as a TYPE. `AGENTS_RPC_HANDLERS` itself stays unexported — handing the
 * map out would let another file invoke an agent directly, a bypass D22(d) cannot see. A type
 * export carries no runtime value, so it grants no such ability while still letting
 * `FLEET_ELIGIBILITY` be total over exactly this set.
 */
export type AgentMethod = keyof typeof AGENTS_RPC_HANDLERS;

export type FleetEligibility = "eligible" | "excluded_side_effects" | "excluded_shape" | "deferred";

/**
 * Which agents an UNATTENDED, owner-configured fleet run may invoke.
 *
 * TOTAL over `AgentMethod` on purpose: a sixteenth agent does not compile until someone classifies
 * it. An exclusion `Set` fails OPEN — a new agent would silently become fleet-eligible.
 *
 * NOT `EXTERNAL_EXCLUDED_AGENT_METHODS`. That set was reasoned about for an ARBITRARY NETWORK
 * CALLER; a fleet is a different principal — owner-configured in advance, absent when it fires.
 * The overlap is large and the justification is not transferable.
 *
 * `satisfies`, NOT an annotation. An annotation widens every value to `FleetEligibility`, which
 * would make `fleet/fleet-digest-types.ts`'s `EligibleAgentMethod` resolve to `never` for every
 * member and silently produce an EMPTY extractor map — a fail-open with no error to notice. The
 * `satisfies` clause keeps the same totality check while preserving the literals that derivation
 * needs.
 */
export const FLEET_ELIGIBILITY = Object.freeze({
  // Queues HITL consent prompts on the owner's machine (I24). At 03:00 that is a prompt nobody
  // is there to answer — worse than the HTTP case it is already excluded for.
  "agents.preflight": "excluded_side_effects",
  // NOT a pure read: `runPremortem` writes paused `watcher` rows and a proposal tombstone, and
  // `repropose: true` deletes tombstones. Nightly, that accumulates state nobody asked for.
  "agents.premortem": "excluded_side_effects",
  // Synchronous: returns its payload directly and never calls `notify`, so it cannot settle the
  // completion promise the invoker waits on.
  "agents.whyPeek": "excluded_shape",
  // No side effects and the shape fits — but `--person` makes it a dossier builder. SETTLED with
  // subject enumeration (PR 2b): a sweep would turn "the owner built one dossier" into "the machine
  // builds a dossier on every indexed person, nightly, unattended", which no current consent surface
  // covers. No sweep enumerator returns person-shaped subjects, and this stays deferred for that reason.
  "agents.negotiate": "deferred",
  "agents.catchup": "eligible",
  // Eligible, and the identity question is what makes that a real decision rather than a
  // default. A fleet run is unattended, so `resolveSelfPerson`'s git leg spawns `git config
  // user.email` in the GATEWAY's working directory rather than a repo the owner is sitting in —
  // but that leg reads a GLOBAL git config when no repo-local one applies, and the fallback order
  // ends at a refusal rather than at a guess, so an unattended run either resolves the same
  // person an interactive one would or refuses outright. It never silently profiles someone else.
  // `agents.catchup` is already eligible on this exact resolver, so excluding this one would
  // split a decision that has one answer. And unlike `negotiate`, there is no dossier concern to
  // weigh: a standup is about its own owner, and no request field can point it at anyone else.
  "agents.standup": "eligible",
  // Eligible, and reasoned about INDEPENDENTLY of the shape bound `requireOncallParams`
  // applies to external callers. A fleet job is owner-configured in advance and names its
  // `service`, so it takes the explicit shape and never reaches the owner-scoped selection —
  // and even if it did, `fleet` is the gateway's own scheduler on the owner's own machine,
  // which is the one unattended principal for whom "the owner's incidents" is the right answer.
  // Pure read, no side effects. What a nightly run is FOR here is recurrence: the prior-incident
  // lane is the half that moves between runs, and `nimbus fleet digest` reports exactly that.
  "agents.oncall": "eligible",
  // Reasoned about INDEPENDENTLY of `agents.changelog`'s external exclusion above — that set was
  // reasoned about for an ARBITRARY NETWORK CALLER; a fleet is a different principal,
  // owner-configured in advance and absent when it fires. A weekly changelog produced overnight
  // on idle hardware is close to the feature's stated purpose, and the agent is a pure read with
  // no side effects.
  "agents.changelog": "eligible",
  "agents.huddle": "eligible",
  "agents.glossary": "eligible",
  "agents.decisions": "eligible",
  "agents.ownership": "eligible",
  "agents.why": "eligible",
  "agents.ghost": "eligible",
  "agents.conflicts": "eligible",
  "agents.impact": "eligible",
  "agents.expert": "eligible",
  "agents.janitor": "eligible",
}) satisfies Readonly<Record<AgentMethod, FleetEligibility>>;

/**
 * The `agents.*` method a fleet job may invoke for a config-supplied agent name, or null.
 *
 * `Object.hasOwn`, never `in` — the name comes from `nimbus.toml` and `in` would resolve
 * `"constructor"` against the prototype. Same reasoning as `resolveExternalAgentMethod`.
 *
 * Returns `AgentMethod`, not `string`: the caller hands this straight to `dispatchAgentsRpc`, and
 * the narrower type is what stops a raw, unresolved method string being passed there instead. The
 * single assertion sits immediately after the `Object.hasOwn` guard that establishes it — the
 * membership check IS the narrowing, TypeScript just cannot see it through a template literal.
 */
export function resolveFleetAgentMethod(agent: string): AgentMethod | null {
  const method = `${AGENTS_METHOD_PREFIX}${agent}`;
  if (!Object.hasOwn(AGENTS_RPC_HANDLERS, method)) return null;
  const served = method as AgentMethod;
  return FLEET_ELIGIBILITY[served] === "eligible" ? served : null;
}

/**
 * The agent names every external surface accepts — today `POST /v1/agents/{agent}` and
 * `GET /v1/agents` publish exactly this set; ChatOps consumes the same names rather than deciding
 * its own.
 *
 * DERIVED from AGENTS_RPC_HANDLERS so it cannot drift from the served set — a hand-maintained
 * second list of the same names is the defect shape that cost the most on the MCP work. Sorted for
 * a stable wire response.
 */
export const EXTERNAL_AGENT_NAMES: readonly string[] = Object.freeze(
  Object.keys(AGENTS_RPC_HANDLERS)
    .filter((m) => !EXTERNAL_EXCLUDED_AGENT_METHODS.has(m))
    .map((m) => m.slice(AGENTS_METHOD_PREFIX.length))
    // The SHARED `codeUnitCompare` (`util/code-unit-compare.ts`), not an inline
    // `(a, b) => a < b ? -1 : a > b ? 1 : 0` — that nested ternary was S3358, and the same ordering
    // rule already had one home, used by the share canonicalizer.
    // Explicit code-unit comparator, NOT `localeCompare` (which S2871's message suggests) and not a
    // bare `.sort()` (whose implicit string coercion is what S2871 flags). This array is a WIRE
    // RESPONSE: `localeCompare` is locale-sensitive, so two gateways under different locales could
    // publish the same eleven agents in different orders. The names are ASCII identifiers, so a
    // code-unit comparison is total, stable and identical on every machine.
    .sort(codeUnitCompare),
);

/**
 * The `agents.*` method for a caller-supplied agent name (an HTTP path segment, a ChatOps command
 * argument, …), or null when that name names nothing this — any — external surface serves.
 *
 * `Object.hasOwn`, never `in`: the name is caller-supplied, and `in` would resolve
 * `"constructor"` / `"toString"` against the object prototype. Same reasoning as the egress
 * append's membership gate.
 *
 * AGENTS_RPC_HANDLERS itself is NOT exported. Handing the map out would let another file invoke an
 * agent directly — a bypass D22(d) cannot see, since it is not an `agents/<name>.ts` import.
 */
export function resolveExternalAgentMethod(agent: string): string | null {
  const method = `${AGENTS_METHOD_PREFIX}${agent}`;
  if (!Object.hasOwn(AGENTS_RPC_HANDLERS, method)) return null;
  if (EXTERNAL_EXCLUDED_AGENT_METHODS.has(method)) return null;
  return method;
}

export async function dispatchAgentsRpc(
  method: string,
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<RpcMissOrHit> {
  // I29/D22(c): an externally-originated brief is egress — the gateway synthesises from the private
  // index and hands the result to whatever model the calling client uses. Append BEFORE any work,
  // and let a failure propagate: no row, no brief. Gated on a RECOGNISED method, never on the
  // namespace prefix, so an unrecognised call is a `miss` that ledgers nothing.
  //
  // The caller kind selects the source type through a TOTAL map (egress/egress-bearing-kinds.ts)
  // rather than an equality. This read `ctx.caller?.kind === "mcp"` while stdio was the only
  // external transport; as an equality it was not wrong so much as unable to grow — the second
  // transport would have served briefs and appended nothing, passing every test. `cli`/`ui`/
  // `unknown`/absent map to null and append nothing, exactly as before.
  const egressSourceType = egressSourceTypeForClientKind(ctx.caller?.kind);
  if (egressSourceType !== null && Object.hasOwn(AGENTS_RPC_HANDLERS, method)) {
    recordAgentBriefEgress(ctx.db, {
      sourceType: egressSourceType,
      method,
      params,
      // Unreachable when null: a non-null source type implies ctx.caller exists. TypeScript cannot
      // narrow across the helper call, and `!` would assert what the compiler declines to check —
      // so the impossible branch is spelled out and made harmless instead.
      clientId: ctx.caller?.clientId ?? "",
      now: Date.now(),
    });
  }
  const recorder = ctx.agentLatencyRecorder;
  const timedCtx =
    recorder !== undefined && Object.hasOwn(AGENTS_RPC_HANDLERS, method)
      ? { ...ctx, notify: timeBriefSettlement(ctx.notify, recorder) }
      : ctx;
  return dispatchByMethod<AgentsRpcContext>(method, params, timedCtx, AGENTS_RPC_HANDLERS);
}
