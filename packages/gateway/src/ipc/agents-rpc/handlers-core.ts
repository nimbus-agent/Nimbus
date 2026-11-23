import { emitCatchupBrief } from "../../agents/catchup.ts";
import { emitChangelogBrief } from "../../agents/changelog.ts";
import { emitExpertBrief } from "../../agents/expert.ts";
import { emitImpactBrief } from "../../agents/impact.ts";
import {
  emitOncallBrief,
  OncallIdentityUnresolvedError,
  OncallIncidentNotFoundError,
  OncallNoActiveIncidentError,
} from "../../agents/oncall.ts";
import { emitStandupBrief, StandupIdentityUnresolvedError } from "../../agents/standup.ts";
import { loadNimbusUserFromConfigDir } from "../../config/nimbus-toml.ts";
import {
  type AgentsRpcContext,
  AgentsRpcError,
  agentServiceConfigs,
  newSessionId,
} from "./_shared.ts";
import { requireCatchupParams, requireExpertParams, requireImpactParams } from "./params-common.ts";
import { requireOncallParams, requireStandupParams } from "./params-people.ts";

export async function handleExpert(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireExpertParams(params);
  const sessionId = newSessionId("expert");
  const expertCtx =
    ctx.runner === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, runner: ctx.runner, notify: ctx.notify, sessionId };
  return await emitExpertBrief(input, expertCtx);
}

export async function handleImpact(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireImpactParams(params);
  const sessionId = newSessionId("impact");
  const impactCtx =
    ctx.runner === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, runner: ctx.runner, notify: ctx.notify, sessionId };
  return await emitImpactBrief(input, impactCtx);
}

export async function handleCatchup(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireCatchupParams(params, "agents.catchup");
  const sessionId = newSessionId("catchup");
  const userToml = ctx.configDir === undefined ? {} : loadNimbusUserFromConfigDir(ctx.configDir);
  const catchupInput =
    userToml.mePersonId === undefined
      ? input
      : { ...input, mePersonIdOverride: userToml.mePersonId };
  const catchupCtx =
    ctx.runner === undefined
      ? { db: ctx.db, notify: ctx.notify, sessionId }
      : { db: ctx.db, runner: ctx.runner, notify: ctx.notify, sessionId };
  return await emitCatchupBrief(catchupInput, catchupCtx);
}

/**
 * The fallback window when a caller omits `sinceMs` — matches the CLI's own `--since 7d` default
 * (`packages/cli/src/commands/changelog.ts`) and the `7 * DAY` fixtures `agents/changelog.test.ts`
 * uses throughout. Needed HERE, unlike `catchup`'s/`decisions`' own `input.sinceMs ?? DEFAULT`
 * inside the agent itself, because `emitChangelogBrief`'s `lookbackMs` is a REQUIRED field with no
 * internal fallback — see `BuildChangelogArgs.lookbackMs`'s own doc comment on why this carries a
 * DURATION, never an absolute cutoff.
 */
const CHANGELOG_DEFAULT_SINCE_MS = 7 * 24 * 60 * 60 * 1000;

export async function handleChangelog(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  // Changelog's surface IS catchup's — same fields, same bounds — so it shares that validator.
  const input = requireCatchupParams(params, "agents.changelog");
  return await emitChangelogBrief({
    db: ctx.db,
    sessionId: newSessionId("changelog"),
    lookbackMs: input.sinceMs ?? CHANGELOG_DEFAULT_SINCE_MS,
    service: input.service ?? null,
    serviceConfigs: agentServiceConfigs(ctx, "agents.changelog"),
    notify: ctx.notify,
    ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
  });
}

/**
 * The fallback CHAT window when a caller omits `sinceMs` — matches the CLI's own `--since 24h`
 * default and the roadmap row's "Slack threads … in the last 24 h".
 *
 * Scoped to chat alone. The deploy, change and prior-incident lanes anchor on the incident's own
 * open time and are not windowed by this at all — see `ONCALL_DEFAULT_CHAT_LOOKBACK_MS`.
 */
const ONCALL_DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves `[user] mePersonId` and the DORA/CI service bindings, then delegates.
 *
 * Config is read HERE rather than inside the agent, mirroring `handleCatchup`/`handleStandup`:
 * `agents/oncall.ts` keeps no config-file dependency, and re-reading per call means a `[user]` or
 * `[metrics.dora.*]` edit applies without a gateway restart.
 *
 * All three refusals are translated to `-32000` rather than allowed to propagate raw. Each is a
 * REFUSAL the caller must act on rather than an internal fault, and the CLI prints the message
 * verbatim. `-32602` would be wrong for every one of them — the params are fine; it is the
 * machine's state that cannot answer.
 */
export async function handleOncall(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireOncallParams(params, ctx.caller);
  const userToml = ctx.configDir === undefined ? {} : loadNimbusUserFromConfigDir(ctx.configDir);
  const serviceConfigs = agentServiceConfigs(ctx, "agents.oncall");
  try {
    return await emitOncallBrief({
      db: ctx.db,
      sessionId: newSessionId("oncall"),
      ...(input.incidentId === undefined ? {} : { incidentId: input.incidentId }),
      ...(input.service === undefined ? {} : { serviceId: input.service }),
      chatLookbackMs: input.sinceMs ?? ONCALL_DEFAULT_SINCE_MS,
      serviceConfigs,
      ...(userToml.mePersonId === undefined ? {} : { mePersonIdOverride: userToml.mePersonId }),
      notify: ctx.notify,
      ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    });
  } catch (err) {
    if (
      err instanceof OncallNoActiveIncidentError ||
      err instanceof OncallIncidentNotFoundError ||
      err instanceof OncallIdentityUnresolvedError
    ) {
      throw new AgentsRpcError(-32000, err.message);
    }
    throw err;
  }
}

/**
 * The fallback window when a caller omits `sinceMs` — matches the CLI's own `--since 24h` default
 * (`packages/cli/src/commands/standup.ts`). Needed HERE, like `changelog`'s and unlike
 * `catchup`'s, because `emitStandupBrief`'s `lookbackMs` is a REQUIRED field with no internal
 * fallback — see `BuildStandupArgs.lookbackMs` on why it carries a DURATION, never a cutoff.
 *
 * 24 hours rather than `changelog`'s 7 days: this answers "what did I do since yesterday's
 * standup", which is the meeting the command is named for.
 */
const STANDUP_DEFAULT_SINCE_MS = 24 * 60 * 60 * 1000;

/**
 * Resolves `[user] mePersonId` and delegates.
 *
 * Read HERE rather than inside the agent, mirroring `handleCatchup` exactly — `agents/standup.ts`
 * keeps no config-file dependency, and re-reading per call means a `[user]` edit applies without
 * a gateway restart.
 *
 * `StandupIdentityUnresolvedError` is translated to `-32000` rather than allowed to propagate raw:
 * an unresolved identity is a REFUSAL the caller must act on, not an internal fault, and the CLI
 * prints this message verbatim. `-32602` would be wrong — the caller's params are fine; it is the
 * machine's state that cannot answer.
 */
export async function handleStandup(
  params: unknown,
  ctx: AgentsRpcContext,
): Promise<{ sessionId: string }> {
  const input = requireStandupParams(params);
  const userToml = ctx.configDir === undefined ? {} : loadNimbusUserFromConfigDir(ctx.configDir);
  try {
    return await emitStandupBrief({
      db: ctx.db,
      sessionId: newSessionId("standup"),
      lookbackMs: input.sinceMs ?? STANDUP_DEFAULT_SINCE_MS,
      ...(userToml.mePersonId === undefined ? {} : { mePersonIdOverride: userToml.mePersonId }),
      notify: ctx.notify,
      ...(ctx.runner === undefined ? {} : { runner: ctx.runner }),
    });
  } catch (err) {
    if (err instanceof StandupIdentityUnresolvedError) {
      throw new AgentsRpcError(-32000, err.message);
    }
    throw err;
  }
}
