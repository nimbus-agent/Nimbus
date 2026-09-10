import { asRecord } from "../connectors/unknown-record.ts";
import type {
  ToolgenConsentBroker,
  ToolgenSaveConsentBroker,
} from "../toolgen/toolgen-consent-broker.ts";
import { writeToolCredential } from "../toolgen/toolgen-credentials.ts";
import {
  createGeneratedTool,
  normalizeHost,
  type ToolgenGateDeps,
} from "../toolgen/toolgen-gate.ts";
import type { SavedToolEnvelope } from "../toolgen/toolgen-registry.ts";
import { saveGeneratedTool, type ToolgenSaveDeps } from "../toolgen/toolgen-save-gate.ts";
import { listSavedTools, type SavedToolRow } from "../toolgen/toolgen-saved-repo.ts";
import { parseCanonicalArtifact } from "../toolgen/toolgen-saved-store.ts";
import {
  ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN,
  type ToolCredentialBinding,
  type ToolCredentialParam,
  type ToolgenEnvelope,
  ToolgenError,
} from "../toolgen/toolgen-types.ts";
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
   * Everything `saveGeneratedTool` needs; assembled once at boot. Carries the SAME `registry` and
   * `db` instances `gateDeps` does -- a saved tool a session just created must be visible to a
   * `toolgen.save` call in the same process without a second lookup path.
   */
  readonly saveDeps: ToolgenSaveDeps;
  /**
   * The owner-approval broker `toolgen.save` answers into -- a SEPARATE instance from `consent`
   * above, deliberately. `ToolgenSaveConsentBroker` broadcasts under its own method name
   * (`toolgen.saveApprovalRequest`, never `toolgen.approvalRequest`), so a save prompt cannot be
   * rendered with the create prompt's copy (`toolgen-consent-broker.ts`'s docstring). Wiring THIS
   * field to the same instance as `consent` would make that distinction exist only in the type
   * system: every existing test for `toolgen.approvalRespond` would keep passing while a save
   * approval silently answered on the wrong broker.
   */
  readonly saveConsent: ToolgenSaveConsentBroker;
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
 * `ToolgenRegistry.forSession` unions in the SAVED collection, which is not a `ToolgenEnvelope` at
 * all -- it has no live `sessionId`/`scriptPath`/`approvedAt` (see `SavedToolEnvelope`'s docstring
 * for why those are not fabricated). This is the discriminator `toolgen.list` uses to pull the
 * EPHEMERAL half out of `forSession`'s union -- the SAVED half of the listing is built separately,
 * from `listSavedTools(db)` below, because that DB read is the only way to see a saved tool that
 * failed verification and is therefore absent from `registry.savedTools()` entirely (see
 * `toSavedListEntry`'s docstring).
 */
function isEphemeralEnvelope(entry: ToolgenEnvelope | SavedToolEnvelope): entry is ToolgenEnvelope {
  return "sessionId" in entry;
}

/**
 * The `toolgen.list` wire shape for a live, ephemeral tool (I don't return `body`/`manifest`/
 * `scriptPath` here — those are plumbing, not a listing). The full artifact the owner approved is
 * `toolgen.approvalRequest`'s payload, not this one.
 *
 * `saved`/`needsCredentials`/`disabledReason` are fixed values, not fields read off the envelope:
 * an EPHEMERAL tool is by definition not saved, its credentials were bound live at create time (an
 * ephemeral tool that lost its binding would simply fail its next request, never sit around
 * "needing" one -- there is no restart in between), and it has no `generated_tool` row to carry a
 * `disabledReason` at all.
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
    saved: false,
    needsCredentials: false,
    disabledReason: null,
  };
}

/**
 * The `toolgen.list` wire shape for a SAVED (persisted) tool -- built from the `generated_tool` DB
 * row, not from `registry.savedTools()` alone, because that registry collection holds ONLY tools
 * that verified cleanly at load (`loadSavedToolsIntoRegistry`'s docstring: a tool that fails
 * verification is "absent from the registry entirely, never registered as a tool that then errors
 * when the model tries to call it"). That is the right call for the MODEL-facing surface
 * (`buildGeneratedTools`) and the wrong one for `nimbus tool list`: an owner who saved a tool and
 * comes back to a `signature_mismatch` row deserves to see it, with a reason, not silence. Every
 * `generated_tool` row is therefore listed here, healthy or not.
 *
 * For a HEALTHY row (present in `healthyById`), every field comes from the verified, in-memory
 * artifact -- the same source `buildGeneratedTools` reads from.
 *
 * For a row with no healthy match, `approvedHosts`/`credentialHosts` fall back to a best-effort,
 * UNVERIFIED parse of the row's cached `artifact_json` column, for DISPLAY only. This never
 * touches the on-disk `saved/<toolId>/artifact.json` file `readVerifiedSavedTool` guards (D29(d))
 * -- it reads a plain SQLite column already loaded by `listSavedTools`, which this module's own
 * comments describe as "a health-report CACHE for `nimbus tool list`, never an authority a loader
 * or a spawn may rely on" (`toolgen-saved-spawn.ts`). A row whose JSON does not even parse against
 * this build's shape shows empty host lists rather than throwing -- the row is disabled either
 * way, and a broken listing helper must not stop `nimbus tool list` from working for every OTHER
 * tool.
 */
function toSavedListEntry(
  row: SavedToolRow,
  healthyById: ReadonlyMap<string, SavedToolEnvelope>,
): Record<string, unknown> {
  const healthy = healthyById.get(row.toolId);
  if (healthy !== undefined) {
    return {
      toolId: row.toolId,
      toolName: healthy.artifact.toolName,
      description: healthy.artifact.description,
      approvedHosts: healthy.artifact.approvedHosts,
      credentialHosts: healthy.artifact.credentialHosts,
      approvedAt: row.approvedAt,
      saved: true,
      needsCredentials: healthy.needsCredentials,
      disabledReason: null,
    };
  }
  const parsed = parseCanonicalArtifact(row.artifactJson);
  return {
    toolId: row.toolId,
    toolName: row.toolName,
    description: row.description,
    approvedHosts: parsed?.approvedHosts ?? [],
    credentialHosts: parsed?.credentialHosts ?? [],
    approvedAt: row.approvedAt,
    saved: true,
    needsCredentials: (parsed?.credentialHosts.length ?? 0) > 0,
    disabledReason: row.disabledReason,
  };
}

/**
 * Every host `toolgen.credentialSet` may bind a credential for: the LIVE ephemeral envelope's
 * signed `credentialHosts` if the tool is still running this session, else the HEALTHY saved
 * envelope's -- the exact same signed list the create/save gate already put in front of the owner.
 * An unknown or unhealthy-saved toolId resolves to an EMPTY list, so binding a credential for it
 * refuses the same way a genuinely-out-of-scope host would (`credentialHostsFor`'s `?? []` in
 * `platform/assemble.ts` is the identical fail-closed shape at the broker).
 */
function credentialHostsForTool(ctx: ToolgenRpcCtx, toolId: string): readonly string[] {
  const live = ctx.gateDeps.registry.get(toolId);
  if (live !== undefined) return live.artifact.credentialHosts;
  const saved = ctx.gateDeps.registry.savedTools().find((s) => s.toolId === toolId);
  return saved?.artifact.credentialHosts ?? [];
}

/**
 * Narrow `params.binding` into a `ToolCredentialBinding`, matching the CLI's `CredentialSchemeArg`
 * shape field-for-field. Every failure message names only FIELD NAMES, never a value -- a
 * malformed binding must not echo the secret the owner is trying to set back into an error.
 */
function parseCredentialBinding(raw: unknown): ToolCredentialBinding {
  const rec = asRecord(raw);
  if (rec === undefined) {
    throw new ToolgenRpcError(-32602, "ERR_INVALID_PARAMS: binding (object) required");
  }
  const type = rec["type"];
  if (type === "bearer") {
    const token = rec["token"];
    if (typeof token !== "string" || token === "") {
      throw new ToolgenRpcError(
        -32602,
        "ERR_INVALID_PARAMS: binding.token (non-empty string) required",
      );
    }
    return { type: "bearer", token };
  }
  if (type === "header") {
    const headerName = rec["headerName"];
    const value = rec["value"];
    if (
      typeof headerName !== "string" ||
      headerName === "" ||
      typeof value !== "string" ||
      value === ""
    ) {
      throw new ToolgenRpcError(
        -32602,
        "ERR_INVALID_PARAMS: binding.headerName and binding.value (non-empty strings) required",
      );
    }
    return { type: "header", headerName, value };
  }
  if (type === "basic") {
    const username = rec["username"];
    const password = rec["password"];
    if (
      typeof username !== "string" ||
      username === "" ||
      typeof password !== "string" ||
      password === ""
    ) {
      throw new ToolgenRpcError(
        -32602,
        "ERR_INVALID_PARAMS: binding.username and binding.password (non-empty strings) required",
      );
    }
    return { type: "basic", username, password };
  }
  throw new ToolgenRpcError(
    -32602,
    'ERR_INVALID_PARAMS: binding.type must be "bearer", "header", or "basic"',
  );
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

  // Live ephemeral tools for THIS session (a terminated one is not offered back to a caller as
  // though it still worked -- `ToolgenRegistry.forSession` already applies that filter), UNION
  // every SAVED tool regardless of session or health -- see `toSavedListEntry`'s docstring for why
  // that second half is read from the DB rather than `registry.savedTools()` alone.
  "toolgen.list": (params, ctx) => {
    const sessionId = requireString(params, "sessionId");
    const ephemeral = ctx.gateDeps.registry
      .forSession(sessionId)
      .filter(isEphemeralEnvelope)
      .map(toListEntry);
    const healthyById = new Map(
      ctx.gateDeps.registry.savedTools().map((e) => [e.toolId, e] as const),
    );
    const saved = listSavedTools(ctx.gateDeps.db).map((row) => toSavedListEntry(row, healthyById));
    return { tools: [...ephemeral, ...saved] };
  },

  // The SECOND standing-approval prompt in this codebase (I40 / spec § 6.1) -- see `saveGeneratedTool`'s
  // own docstring for why persisting a tool is a fact create-time consent never covered. Routed
  // through `ctx.saveDeps`, never `ctx.gateDeps`: they share ONE registry and db instance, but the
  // save gate's approval broker, org-policy read and Vault access are its own dependency set.
  "toolgen.save": async (params, ctx) => {
    const toolId = requireString(params, "toolId");
    return saveGeneratedTool({ toolId }, ctx.saveDeps);
  },

  // Answers a `toolgen.saveApprovalRequest` broadcast -- the SAVE broker's own respond channel,
  // deliberately never `ctx.consent` (the create broker). Mirrors `toolgen.approvalRespond` above
  // field-for-field; the only difference is which `ConsentBroker` instance owns the pending
  // request, and getting that wrong would make a save prompt silently unanswerable (it would time
  // out, fail-closed, rather than throwing -- see `saveConsent`'s docstring on `ToolgenRpcCtx`).
  "toolgen.saveApprovalRespond": (params, ctx) => {
    const requestId = requireString(params, "requestId");
    const approved = asRecord(params)?.["approved"] === true;
    return { matched: ctx.saveConsent.respond(requestId, approved) };
  },

  // Binds a credential to a host the tool was ALREADY approved to reach -- the fix for a saved
  // tool that lost its Vault binding across a restart (spec § 8.3/8.4), and the first user-facing
  // path for `header`/`basic` bindings. Never widens `credentialHosts`: that list is part of the
  // signed artifact, so admitting a new host here would let a standing approval quietly cover a
  // host the owner never consented to.
  "toolgen.credentialSet": async (params, ctx) => {
    const toolId = requireString(params, "toolId");
    const rawHost = requireString(params, "host");
    const binding = parseCredentialBinding(asRecord(params)?.["binding"]);
    // Normalised ONCE, then used for BOTH the membership check and the Vault key -- see
    // `toolgen-gate.ts:293-294`'s postmortem on what happens when those two uses see different
    // spellings of the same host.
    const host = normalizeHost(rawHost);
    const credentialHosts = credentialHostsForTool(ctx, toolId);
    if (!credentialHosts.includes(host)) {
      // Named codes exist so a caller distinguishes refusals via `.code`, never by matching on
      // message text (`ToolgenError`'s own docstring) -- no other `ToolgenError` site in
      // `toolgen/` embeds its code into the message, and Task 1 of this branch reverted the same
      // pattern on `toolgen-portable-manifest.ts` for the identical reason. The message still
      // names BOTH host spellings, which is the part that actually helps a refused owner.
      throw new ToolgenError(
        ERR_TOOLGEN_CREDENTIAL_HOST_UNKNOWN,
        `host "${rawHost}" (normalised: "${host}") is not among tool "${toolId}"'s approved ` +
          `credential hosts: [${credentialHosts.join(", ")}]`,
      );
    }
    // The Vault only -- never a log line, never the response. `ToolgenSaveDeps.vault` is reused
    // rather than adding a second Vault reference to this ctx: `toolgen.save` and
    // `toolgen.credentialSet` are the two write paths this surface adds, and both reach the same
    // Vault instance the gateway constructed once at boot.
    await writeToolCredential(ctx.saveDeps.vault, toolId, host, binding);
    return { bound: true };
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
