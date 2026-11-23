import type { Database } from "bun:sqlite";
import { join } from "node:path";
import { loadNimbusLlmFromConfigDir } from "../../../config/nimbus-toml.ts";
import {
  type BuildMediaPassDepsInput,
  buildMediaPassDeps,
  resolveMediaRoots,
} from "../../../multimodal/build-media-pass-deps.ts";
import {
  createGrant,
  listActiveGrantsWithTitles,
  revokeGrant,
} from "../../../multimodal/media-grant-store.ts";
import { runMediaPass } from "../../../multimodal/media-pass.ts";
import { MULTIMODAL_CAPABILITY, type RemoteVlmVendor } from "../../../multimodal/media-types.ts";
import {
  loadMultimodalConfig,
  type MultimodalConfig,
} from "../../../multimodal/multimodal-config.ts";
import type { NimbusVault } from "../../../vault/nimbus-vault.ts";
import { dispatchMediaRpc } from "../../media-rpc.ts";
import { phase4RpcSkipped, type ServerCtx } from "../context.ts";
import { RpcMethodError } from "../rpc-error.ts";

/**
 * The pure mapping from the loaded `[multimodal]` config + the resolved capability verdict to the
 * exact `BuildMediaPassDepsInput` the `media.understand` dispatcher below passes to
 * `buildMediaPassDeps`.
 *
 * Extracted and exported for ONE reason: `vlmBaseUrl`/`vlmModel`/`maxFrames`/`fetchBudgetBytes`/
 * `preferRenditions` are all OPTIONAL on `BuildMediaPassDepsInput` and default internally, so a
 * caller that forgets to forward one fails NOTHING at the type level and NOTHING at the
 * `media.understand` result level (the pass still runs, still returns a summary) — the exact
 * "parses, validates, silently ignored" shape this whole task exists to close for the org-policy
 * flag, now closed for these five keys too. `fetchBudgetBytes`/`preferRenditions` were the most
 * recent instance of exactly that defect: PR 3 added the config keys and the `buildMediaPassDeps`
 * plumbing to honour them, but this mapping function — the one place that actually reaches
 * production — stopped at three fields and silently left the running byte budget, this PR's
 * headline feature, un-configurable (always the 2 GiB default, `preferRenditions` always false,
 * no matter what the operator wrote). A source-text grep for the forwarding lines cannot catch a
 * field SWAP (`vlmModel`'s value forwarded into `vlmBaseUrl`); a unit test asserting on this
 * function's return VALUES can. See `media-policy-wiring.test.ts` / `dispatchers.test.ts`.
 *
 * `vault` closes a SEPARATE instance of the same defect, one level up: `buildMediaPassDeps`'s
 * cloud-fetch `bearerFor` is genuinely Vault-backed, but resolves to a fail-closed null-returning
 * stub whenever no vault is supplied — which, before this change, was ALWAYS, since nothing forwarded
 * `ctx.options.vault` (present here, used by every other vault-consuming dispatcher in this file)
 * through this mapping. Every bearer-requiring cloud fetch (Drive always; Photos/OneDrive on their
 * resolve round-trip) skipped as `not_configured` regardless of how the operator authenticated.
 */
export function buildMediaPassDepsInput(input: {
  readonly db: Database;
  readonly configDir: string | undefined;
  readonly dataDir: string;
  readonly config: MultimodalConfig;
  readonly capabilityDisabled: boolean;
  readonly vault: NimbusVault;
  /** Forwarded verbatim to `BuildMediaPassDepsInput.sourceId` — see that field's doc comment. */
  readonly sourceId?: string;
  /**
   * Forwarded verbatim to `BuildMediaPassDepsInput.remoteVlmVendorEnabled` — see that field's doc
   * comment. Resolved by the caller (`isRemoteVlmVendorEnabled`, below) rather than by this pure
   * mapping function, matching how `config`/`capabilityDisabled`/`vault` are all resolved one
   * level up too: this function only forwards values by VALUE, it does not read `nimbus.toml`.
   */
  readonly remoteVlmVendorEnabled?: boolean;
}): BuildMediaPassDepsInput {
  return {
    db: input.db,
    roots: resolveMediaRoots(input.configDir),
    enabled: input.config.enabled,
    capabilityDisabled: input.capabilityDisabled,
    scratchDir: join(input.dataDir, "multimodal-scratch"),
    vlmBaseUrl: input.config.vlmBaseUrl,
    vlmModel: input.config.vlmModel,
    maxFrames: input.config.maxFrames,
    fetchBudgetBytes: input.config.fetchBudgetBytes,
    preferRenditions: input.config.preferRenditions,
    vault: input.vault,
    // `[multimodal] remote_vlm`. Without this line `buildMediaPassDeps` always sees `undefined`
    // regardless of what the operator configured: `buildRemoteFor` resolves `remoteFor` to
    // `undefined` unconditionally (no artifact can ever reach a remote model) and
    // `MediaPassDeps.remoteVendor` is never populated either (no granted artifact is ever even
    // re-offered by `findCandidates`). See `build-media-pass-deps.ts`'s `BuildMediaPassDepsInput.
    // remoteVlm` doc comment for both consumers this one value feeds.
    remoteVlm: input.config.remoteVlm,
    ...(input.remoteVlmVendorEnabled === undefined
      ? {}
      : { remoteVlmVendorEnabled: input.remoteVlmVendorEnabled }),
    ...(input.sourceId === undefined ? {} : { sourceId: input.sourceId }),
  };
}

/**
 * Gate 3 of § 18.1's own parent opt-in (spec § 18.2): `[multimodal] remote_vlm` naming a vendor
 * must not be enough on its own to enable the remote arm — that vendor's OWN
 * `[llm.remote.<vendor>].enabled` switch must ALSO be on, since `llm/vendor-vault-keys.ts`
 * deliberately shares `openai.api_key` with the embedding runtime and a credential that merely
 * exists must never itself enable anything (§ 18.2's own argument, applied to itself).
 *
 * Re-read on every call from the SAME nimbus.toml `loadMultimodalConfig` just read, matching that
 * function's own live-reload posture — an `[llm.remote.*]` edit applies without a gateway restart,
 * same as a `[multimodal]` edit does. An absent `configDir` (and therefore no file to read at all)
 * fails CLOSED, same direction as every other config-driven switch in this file.
 */
export function isRemoteVlmVendorEnabled(
  vendor: RemoteVlmVendor | null,
  configDir: string | undefined,
): boolean {
  if (vendor === null || configDir === undefined) return false;
  return loadNimbusLlmFromConfigDir(configDir).remoteVendors.get(vendor)?.enabled === true;
}

/**
 * `media.understand` (S2 multimodal I/O, PR 1). LAN-FORBIDDEN (`lan-rpc.ts`'s
 * `FORBIDDEN_OVER_LAN`) and absent from the Tauri allowlist — see `media-rpc.ts`'s own doc
 * comment; it reads local files and spawns subprocesses, the `exec.*` posture.
 *
 * `roots`, `enabled` and `capabilityDisabled` are all re-read on every call, so a
 * `[[filesystem.roots]]` edit, a `[multimodal]` edit, or a newly installed org policy applies
 * without a gateway restart. The org-policy half reads `ctx.options.mediaRpcCtx.enforced`
 * (invariant I22) — the same live accessor `code_execution` and `computer_use` use. When that ctx
 * is absent the method REFUSES: defaulting to `false` is what made this capability's policy
 * lockoff inert through PR 1.
 *
 * `clientId` labels the cloud arm's `sync`-class egress rows with the SERVER-derived caller kind
 * (`ctx.getClientKind`, keyed by the server-assigned connection id — never a request-body field):
 * `media.understand` is caller-initiated over IPC, unlike `sync/scheduler.ts`'s own timer-driven
 * runs, so without this every `media.resolveByteUrl`/`media.fetchBytes` row filed as an
 * unattributed background sync indistinguishable from one nobody asked for.
 */
/**
 * The four media methods (`media.understand`, `media.allowRemote`, `media.grants.list`,
 * `media.grants.revoke`), dispatched from `dispatchMediaRpc` — widened from an equality check on
 * `"media.understand"` alone once PR 4 added the consent-management three.
 */
const MEDIA_RPC_METHODS = new Set([
  "media.understand",
  "media.allowRemote",
  "media.grants.list",
  "media.grants.revoke",
]);

export async function tryDispatchMediaRpc(
  ctx: ServerCtx,
  method: string,
  params: unknown,
  clientId: string,
): Promise<unknown> {
  if (!MEDIA_RPC_METHODS.has(method)) {
    return phase4RpcSkipped;
  }
  if (ctx.options.localIndex === undefined) {
    throw new RpcMethodError(-32603, `${method} requires LocalIndex`);
  }
  const db = ctx.options.localIndex.getDatabase();

  if (method === "media.understand") {
    if (ctx.options.dataDir === undefined) {
      throw new RpcMethodError(-32603, "media.understand requires dataDir");
    }
    const mediaCtx = ctx.options.mediaRpcCtx;
    if (mediaCtx === undefined) {
      throw new RpcMethodError(
        -32603,
        "media.understand requires mediaRpcCtx (the org-policy accessor)",
      );
    }
    // `loadMultimodalConfig` throws `MultimodalConfigError` for a well-formed but non-loopback
    // `vlm_base_url` (this slice has no per-artifact remote grant). Deliberately uncaught here,
    // same shape as `runExecution`'s `ExecGateError` (`tryDispatchExecRpc`, below): it propagates
    // to `server.ts`'s generic top-level catch and surfaces as JSON-RPC `-32603` carrying that
    // error's own actionable message — never a silent substitution of the loopback default.
    const mmConfig = loadMultimodalConfig(ctx.options.configDir);
    const deps = buildMediaPassDeps(
      buildMediaPassDepsInput({
        db,
        configDir: ctx.options.configDir,
        dataDir: ctx.options.dataDir,
        config: mmConfig,
        capabilityDisabled: mediaCtx.enforced.capabilitiesDisabled.has(MULTIMODAL_CAPABILITY),
        vault: ctx.options.vault,
        sourceId: ctx.getClientKind(clientId),
        // Gate 3 of § 18.1's parent opt-in (§ 18.2, Finding 1 of the whole-branch review). Without
        // this, `[multimodal] remote_vlm` naming a vendor was sufficient on its own — a live
        // `openai.api_key` shared with the embedding runtime could silently reach a vision model
        // nobody separately opted into.
        remoteVlmVendorEnabled: isRemoteVlmVendorEnabled(mmConfig.remoteVlm, ctx.options.configDir),
      }),
    );
    const out = await dispatchMediaRpc(method, params, {
      runPass: (opts) => runMediaPass({ ...deps, ...opts }),
    });
    return out ?? phase4RpcSkipped;
  }

  // media.allowRemote / media.grants.list / media.grants.revoke: consent management over the
  // grant store (media-grant-store.ts, D27(b)-confined). None of the three run the understanding
  // pass, so neither `dataDir` nor `mediaRpcCtx` (the org-policy accessor) is required here — a
  // grant is a row in the local index, not a model call; the model call it later gates still goes
  // through `media.understand`'s own full check above.
  //
  // `loadMultimodalConfig` is resolved ONLY for `media.allowRemote`, the one branch that consumes
  // `configuredRemoteVlm` (`media-rpc.ts`'s `dispatchMediaRpc`). It throws `MultimodalConfigError`
  // for a well-formed but non-loopback `vlm_base_url` — a field `media.grants.list`/
  // `media.grants.revoke` never read — so resolving it unconditionally would block revocation, the
  // WITHDRAWAL path for consent, on a config error unrelated to grants.
  const out = await dispatchMediaRpc(method, params, {
    ...(method === "media.allowRemote"
      ? { configuredRemoteVlm: loadMultimodalConfig(ctx.options.configDir).remoteVlm }
      : {}),
    grantRemote: ({ itemId, vendor, nowMs }) => {
      const { alreadyActive } = createGrant(db, {
        itemId,
        modality: "image",
        modelVendor: vendor,
        nowMs,
      });
      return { alreadyActive };
    },
    listGrants: () => listActiveGrantsWithTitles(db),
    revokeGrants: ({ itemId, modelVendor, nowMs }) =>
      revokeGrant(db, { itemId, ...(modelVendor === undefined ? {} : { modelVendor }), nowMs }),
  });
  return out ?? phase4RpcSkipped;
}
