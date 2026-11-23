import { isWhyPrInput, type WhyPeek } from "../../agents/_lib/why-types.ts";
import { emitDecisionsBrief } from "../../agents/decisions.ts";
import { emitGlossaryBrief } from "../../agents/glossary.ts";
import { emitNegotiateBrief } from "../../agents/negotiate.ts";
import { emitOwnershipBrief } from "../../agents/ownership.ts";
import { emitPremortemBrief } from "../../agents/premortem.ts";
import { emitWhyBrief } from "../../agents/why.ts";
import { runWhyPeek } from "../../agents/why-peek.ts";
import { loadNimbusFilesystemRootsFromConfigDir } from "../../config/filesystem-toml.ts";
import {
  loadNimbusDecisionsFromConfigDir,
  loadNimbusNegotiateFromConfigDir,
  loadNimbusServiceConfigsFromConfigDir,
} from "../../config/nimbus-toml.ts";
import { buildServiceIdentityResolver } from "../../metrics/service-identity.ts";
import { ownershipRoots } from "../../ownership/ownership-target.ts";
import { sourceMappingFor } from "../../sources/source-mapping.ts";
import { type AgentsRpcContext, newSessionId } from "./_shared.ts";
import {
  requireDecisionsParams,
  requireGlossaryParams,
  requirePremortemParams,
  requireWhyParams,
  requireWhyRefParams,
} from "./params-content.ts";
import { requireNegotiateParams, requireOwnershipParams } from "./params-people.ts";

function whyRoots(ctx: AgentsRpcContext) {
  return ctx.configDir === undefined ? [] : loadNimbusFilesystemRootsFromConfigDir(ctx.configDir);
}

export async function handleWhy(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireWhyParams(params);
  const sessionId = newSessionId("why");
  // `runWhy` never reads `roots` on the `prUrl` arm (it has no file/line subject to resolve
  // against a filesystem root) — skip the per-call TOML read on that arm rather than doing it
  // for nothing on the browser-facing path.
  const roots = isWhyPrInput(input) ? [] : whyRoots(ctx);
  return await emitWhyBrief(input, {
    db: ctx.db,
    roots,
    notify: ctx.notify,
    sessionId,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
  });
}

/**
 * The namespace's first synchronous method: no coordinator, no LLM, no
 * notification — returns its payload directly (spec: "a 10-second hover is
 * not a hover").
 */
export async function handleWhyPeek(params: unknown, ctx: AgentsRpcContext): Promise<WhyPeek> {
  const input = requireWhyRefParams(params);
  return await runWhyPeek(input, { db: ctx.db, roots: whyRoots(ctx) });
}

export async function handleGlossary(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireGlossaryParams(params);
  return await emitGlossaryBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("glossary"),
    mapping: sourceMappingFor(ctx.configDir),
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
  });
}

/**
 * `[decisions].min_confidence` as the read-path floor a caller gets when it
 * sends no `minConfidence`. Read here rather than in `agents/decisions.ts` so
 * the agent keeps no config-file dependency, and re-read per call (like the
 * `[user]` block above) so an edit applies without a gateway restart. With no
 * `configDir` — the test/embedded shape — the agent falls back to `0`.
 */
function decisionsMinConfidenceDefault(ctx: AgentsRpcContext): number | undefined {
  return ctx.configDir === undefined
    ? undefined
    : loadNimbusDecisionsFromConfigDir(ctx.configDir).minConfidence;
}

export async function handleDecisions(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireDecisionsParams(params);
  const defaultMinConfidence = decisionsMinConfidenceDefault(ctx);
  return await emitDecisionsBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("decisions"),
    // Built per call, like `defaultMinConfidence`: a `[sources]` or pack change applies live.
    mapping: sourceMappingFor(ctx.configDir),
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    ...(defaultMinConfidence === undefined ? {} : { defaultMinConfidence }),
  });
}

/**
 * `[negotiate] personal_sources` (spec § 3.3) — the personal-docs consent gate. Resolved HERE,
 * not defaulted inside `agents/negotiate.ts`, mirroring `handleOwnership`'s root-resolution rule:
 * `NegotiateContext.personalSources` is a REQUIRED field (Task 6), specifically so no caller can
 * omit it and silently disable the opt-in while `nimbus.toml` still claims it is active. With no
 * `configDir` — the test/embedded shape — the personal-docs opt-in is off (empty list), the same
 * fail-safe-toward-excluding default `nimbus-toml.ts` uses when the section is absent.
 */
function negotiatePersonalSources(ctx: AgentsRpcContext): readonly string[] {
  return ctx.configDir === undefined
    ? []
    : loadNimbusNegotiateFromConfigDir(ctx.configDir).personalSources;
}

export async function handleNegotiate(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireNegotiateParams(params);
  return await emitNegotiateBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("negotiate"),
    personalSources: negotiatePersonalSources(ctx),
    mapping: sourceMappingFor(ctx.configDir),
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
  });
}

/**
 * Roots are resolved HERE, not in the agent, so `agents/ownership.ts` keeps no config-file
 * dependency (the rule `handleDecisions` follows for `[decisions].min_confidence`), and are
 * re-read per call so a `[[filesystem.roots]]` edit or a fresh `nimbus index add` applies
 * without a gateway restart. With no configDir — the test/embedded shape — the root set is
 * empty and the brief reports that as its first gap rather than pretending to be complete.
 */
export async function handleOwnership(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireOwnershipParams(params);
  return await emitOwnershipBrief(input, {
    db: ctx.db,
    roots: ctx.configDir === undefined ? [] : ownershipRoots(ctx.configDir),
    notify: ctx.notify,
    sessionId: newSessionId("ownership"),
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
  });
}

/**
 * Resolved HERE, not in the agent, mirroring `handleOwnership`'s root-resolution rule: it keeps
 * `agents/premortem.ts` free of a config-file dependency, and is re-read per call so a
 * `[metrics.dora.*]`/`[ci.service.*]` edit applies without a gateway restart. Same construction
 * `ipc/index-regraph-rpc.ts` uses for the same resolver — the "same place other agents get their
 * service-identity resolver" the incident-coupling gap (Task 4) pointed at. With no `configDir` —
 * the test/embedded shape — the resolver is left unset and incident coupling reports a named gap
 * rather than a fabricated measurement.
 *
 * DEGRADES rather than throws. `loadNimbusServiceConfigsFromConfigDir` reads and parses
 * `nimbus.toml` with no internal try/catch (`config/nimbus-toml.ts:1941-1965`), and rejects a
 * malformed `[metrics.dora.*]` / `[ci.service.*]` block outright — a bad `deploy_workflow_pattern`
 * regex, a missing `repos`, an out-of-range incident window — as does an unreadable file. Left
 * unguarded, a single config typo would take down the WHOLE brief: this runs before
 * `emitPremortemBrief`, so nothing would be emitted at all, and the four lanes that never touch
 * service identity would be lost along with the one that does. Falling back to no resolver puts
 * incident coupling on the exact path the no-`configDir` case already takes — a named gap, never a
 * fabricated measurement — and leaves every other lane intact. The same degrade-don't-abort call
 * was made for gateway startup in `platform/assemble.ts`'s `loadServiceConfigsOrDegrade` (M-1).
 *
 * The cause is written to stderr because the incident-coupling gap note cannot name it: that note
 * is authored in `premortem/risks.ts`, which is deliberately database- and config-free and is
 * already hedged across the two causes it CAN distinguish. Silently widening it to cover a third
 * would state a cause that may not be true. `loadNimbusServiceConfigsFromConfigDir` warns on
 * stderr the same way for duplicate service ids.
 */
function premortemResolveServiceId(ctx: AgentsRpcContext) {
  const { configDir } = ctx;
  if (configDir === undefined) return undefined;
  try {
    return buildServiceIdentityResolver(loadNimbusServiceConfigsFromConfigDir(configDir));
  } catch (err) {
    process.stderr.write(
      `agents.premortem: failed to load [metrics.dora.*]/[ci.service.*] from nimbus.toml ` +
        `(${err instanceof Error ? err.message : String(err)}); incident coupling will report ` +
        `an unmeasurable gap until this is fixed.\n`,
    );
    return undefined;
  }
}

export async function handlePremortem(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requirePremortemParams(params);
  const resolveServiceId = premortemResolveServiceId(ctx);
  return await emitPremortemBrief(input, {
    db: ctx.db,
    notify: ctx.notify,
    sessionId: newSessionId("premortem"),
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    ...(resolveServiceId === undefined ? {} : { resolveServiceId }),
  });
}
