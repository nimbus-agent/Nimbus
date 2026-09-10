import { asRecord } from "../connectors/unknown-record.ts";
import type { ToolgenConsentBroker } from "../toolgen/toolgen-consent-broker.ts";
import { createGeneratedTool, type ToolgenGateDeps } from "../toolgen/toolgen-gate.ts";
import type { SavedToolEnvelope } from "../toolgen/toolgen-registry.ts";
import type { ToolCredentialParam, ToolgenEnvelope } from "../toolgen/toolgen-types.ts";
import {
  dispatchByMethod,
  type RpcMethodHandlerMap,
  type RpcMissOrHit,
} from "./_lib/dispatch-by-method.ts";

/** A `ToolgenRpcError` carries the JSON-RPC error code surfaced by the dispatcher chain. */
export class ToolgenRpcError extends Error {
  constructor(
    readonly rpcCode: number,
    message: string,
  ) {
    super(message);
    this.name = "ToolgenRpcError";
  }
}

export interface ToolgenRpcCtx {
  /** Everything `createGeneratedTool` needs; assembled once at boot. Carries the registry. */
  readonly gateDeps: ToolgenGateDeps;
  /** The owner-approval broker this surface answers into. */
  readonly consent: ToolgenConsentBroker;
  /**
   * Task 11's `removeToolScript`, bound to the config dir. `toolgen.revoke` must drop THREE halves
   * -- the live child (`registry.revoke`, closes the spawned process), the approved body on disk
   * (this), and the Vault credential (`revokeCredentialsForTool` below) -- a revoked tool that
   * leaves its script behind is a tool the next session could still be pointed at. The CLI cannot
   * do this itself: it never touches the gateway's config dir directly, only IPC, so the drop has
   * to happen on this side of the wire.
   */
  readonly removeScript: (toolId: string) => Promise<void>;
  /**
   * The THIRD half of `toolgen.revoke`. Backed by `deleteCredentialsForTool`
   * (`toolgen-credentials.ts`), which deletes every `toolgen.<toolId>.*` Vault key by PREFIX --
   * no host list, so it also catches a credential for a host no longer in the tool's current
   * envelope. Until this existed, a revoked tool's per-host Vault bindings outlived both the tool
   * and the gateway, keyed to a toolId nothing would ever call again.
   */
  readonly revokeCredentialsForTool: (toolId: string) => Promise<void>;
}

/**
 * Module-private, matching `exec-rpc.ts:35` / `share-rpc.ts:108`.
 *
 * There is no shared IPC validation module: `requireString` is redefined in every `ipc/*-rpc.ts`
 * file across three signatures. Consolidating them is a worthwhile cleanup but would put most of
 * this feature's diff in unrelated RPC modules, so it is deliberately left alone here.
 */
function requireString(params: unknown, key: string): string {
  const rec = asRecord(params);
  const v = rec === undefined ? undefined : rec[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new ToolgenRpcError(-32602, `ERR_INVALID_PARAMS: ${key} (non-empty string) required`);
  }
  return v;
}

/**
 * Every element must be a string; a non-array or a mixed array yields an EMPTY host list, never a
 * partial one -- a half-parsed host list is a set the caller did not ask for, and silently
 * dropping the bad element would approve a tool for a host list nobody typed. `createGeneratedTool`
 * refuses an empty host list outright (`ERR_TOOLGEN_HOST_NOT_ALLOWED`), so a malformed `hosts`
 * array is turned into a clean refusal rather than a partially-granted tool.
 */
function stringArray(v: unknown): string[] {
  if (!Array.isArray(v)) return [];
  return v.every((e) => typeof e === "string") ? [...(v as string[])] : [];
}

/**
 * `<host>=<token>` from `nimbus tool create` means a BEARER binding (spec § 9.2). `header` and
 * `basic` bindings are reachable from no user-facing path in this slice — a stated bound, not an
 * oversight: the broker applies them correctly and nothing yet writes one.
 *
 * A malformed entry is DROPPED rather than throwing: a partially-typed credential must not abort a
 * create the owner is about to be asked to approve, and the approval prompt shows the hosts that
 * actually got one, so a dropped entry is visible there.
 */
function parseCredentials(raw: unknown): ToolCredentialParam[] {
  if (!Array.isArray(raw)) return [];
  const out: ToolCredentialParam[] = [];
  for (const entry of raw) {
    const rec = asRecord(entry);
    if (rec === undefined) continue;
    const host = rec["host"];
    const token = rec["token"];
    if (typeof host !== "string" || host === "") continue;
    if (typeof token !== "string" || token === "") continue;
    out.push({ host, binding: { type: "bearer", token } });
  }
  return out;
}

/**
 * `ToolgenRegistry.forSession` (Task 9) now unions in the SAVED collection, which is not a
 * `ToolgenEnvelope` at all -- it has no live `sessionId`/`scriptPath`/`approvedAt` (see
 * `SavedToolEnvelope`'s docstring for why those are not fabricated). Filtering to the ephemeral
 * shape here keeps `toolgen.list`'s CURRENT behaviour byte-for-byte unchanged (it never showed a
 * saved tool before this task, and every existing test needs that to stay true) rather than
 * exposing a saved tool through a listing shape that has no field for `needsCredentials` or
 * `disabledReason` to go in. Task 10 owns building the real merged view (spec § 9: `{ saved,
 * needsCredentials, disabledReason }`) -- this predicate is an interim seam for THIS task to keep
 * the tree compiling, not a design decision about what `toolgen.list` should eventually show.
 */
function isEphemeralEnvelope(entry: ToolgenEnvelope | SavedToolEnvelope): entry is ToolgenEnvelope {
  return "sessionId" in entry;
}

/**
 * The `toolgen.list` wire shape: enough for an owner to recognise and manage a tool (I don't
 * return `body`/`manifest`/`scriptPath` here — those are plumbing, not a listing). The full
 * artifact the owner approved is `toolgen.approvalRequest`'s payload, not this one.
 */
function toListEntry(envelope: ToolgenEnvelope): Record<string, unknown> {
  return {
    toolId: envelope.artifact.toolId,
    toolName: envelope.artifact.toolName,
    description: envelope.artifact.description,
    approvedHosts: envelope.artifact.approvedHosts,
    credentialHosts: envelope.artifact.credentialHosts,
    sessionId: envelope.sessionId,
    approvedAt: envelope.approvedAt,
  };
}

const HANDLERS: RpcMethodHandlerMap<ToolgenRpcCtx> = {
  // The I39 chokepoint's only transport. Everything crossing this boundary is `unknown` until
  // validated -- no casts on `params`.
  "toolgen.create": async (params, ctx) => {
    const rec = asRecord(params) ?? {};
    const sessionId = requireString(params, "sessionId");
    const description = requireString(params, "description");
    const hosts = stringArray(rec["hosts"]);
    return createGeneratedTool(
      { sessionId, description, hosts },
      ctx.gateDeps,
      parseCredentials(rec["credentials"]),
    );
  },

  "toolgen.approvalRespond": (params, ctx) => {
    const requestId = requireString(params, "requestId");
    // Strict `=== true`: a missing or malformed field must read as denial, never approval.
    const approved = asRecord(params)?.["approved"] === true;
    return { matched: ctx.consent.respond(requestId, approved) };
  },

  // Live tools only (a terminated tool is not offered back to a caller as though it still
  // worked) -- `ToolgenRegistry.forSession` already applies that filter. Saved tools are filtered
  // OUT here for now -- see `isEphemeralEnvelope`'s docstring.
  "toolgen.list": (params, ctx) => {
    const sessionId = requireString(params, "sessionId");
    return {
      tools: ctx.gateDeps.registry
        .forSession(sessionId)
        .filter(isEphemeralEnvelope)
        .map(toListEntry),
    };
  },

  "toolgen.revoke": async (params, ctx) => {
    const toolId = requireString(params, "toolId");
    // THREE halves, always -- see `ToolgenRpcCtx.removeScript`'s doc comment. `registry.revoke` on
    // an unknown toolId is a no-op (Task 10), `removeScript` on one that never wrote a script is
    // idempotent (Task 11), and `revokeCredentialsForTool` on one that never bound a credential
    // deletes nothing (Task 5) -- so this is safe to call unconditionally rather than probing
    // first.
    await ctx.gateDeps.registry.revoke(toolId);
    await ctx.removeScript(toolId);
    // The THIRD half. Until this landed, a revoked tool's per-host Vault bindings outlived both
    // the tool and the gateway, keyed to a toolId nothing would ever call again.
    await ctx.revokeCredentialsForTool(toolId);
    return { revoked: true };
  },
};

export function dispatchToolgenRpc(
  method: string,
  params: unknown,
  ctx: ToolgenRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod(method, params, ctx, HANDLERS);
}
