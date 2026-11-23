import { emitConflictsBrief } from "../../agents/conflicts.ts";
import { emitGhostBrief } from "../../agents/ghost.ts";
import { emitHuddleBrief } from "../../agents/huddle.ts";
import { emitJanitorBrief } from "../../agents/janitor.ts";
import { emitPreflightBrief } from "../../agents/preflight.ts";
import { type AgentsRpcContext, federatedAgentBase, newSessionId } from "./_shared.ts";
import { requireFileParam } from "./file-param.ts";
import { requireHuddleParams } from "./params-common.ts";
import { requireJanitorParams, requirePreflightParams } from "./params-people.ts";

export async function handleGhost(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireFileParam(ctx.db, params);
  return await emitGhostBrief(input, federatedAgentBase(ctx, newSessionId("ghost")));
}

export async function handleConflicts(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireFileParam(ctx.db, params);
  return await emitConflictsBrief(input, federatedAgentBase(ctx, newSessionId("conflicts")));
}

export async function handleHuddle(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireHuddleParams(params);
  return await emitHuddleBrief(input, federatedAgentBase(ctx, newSessionId("huddle")));
}

export async function handleJanitor(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requireJanitorParams(params);
  return await emitJanitorBrief(input, federatedAgentBase(ctx, newSessionId("janitor")));
}

export async function handlePreflight(params: unknown, ctx: AgentsRpcContext): Promise<unknown> {
  const input = requirePreflightParams(params);
  return await emitPreflightBrief(input, federatedAgentBase(ctx, newSessionId("preflight")));
}
