/**
 * `media.understand`, `media.allowRemote`, `media.grants.list` and `media.grants.revoke` (spec
 * § 8, § 18–19). All four are LAN-FORBIDDEN (the whole `media` namespace, `lan-rpc.ts`) and absent
 * from the Tauri allowlist: `media.understand` reads local files and spawns subprocesses, the same
 * posture the whole `exec.*` namespace has, and the other three grant/enumerate/revoke consent to
 * send a user's photos to a third party -- the local owner's to give, never a paired peer's. Do
 * not add any of the four to `ALLOWED_METHODS`.
 *
 * Params are validated, never coerced — an unparseable `limit` is a caller error, and silently
 * defaulting it would run an unbounded pass the caller thought they had bounded. Same posture for
 * `media.allowRemote`'s `vendor`: a mismatch against the CONFIGURED `[multimodal] remote_vlm` is
 * REFUSED, never silently rewritten to the configured vendor — the user asked for a specific third
 * party, and granting a different one behind their back is worse than granting none.
 */
import type { MediaGrantWithTitle } from "../multimodal/media-grant-store.ts";
import type { MediaPassSummary } from "../multimodal/media-pass.ts";
import type { MediaModality, RemoteVlmVendor } from "../multimodal/media-types.ts";
import type { EnforcedPolicy } from "../policy/policy-gate.ts";

/**
 * The boot-assembled seam behind `media.understand`.
 *
 * `enforced` is the live org-policy accessor (invariant I22), matching `ExecGateDeps.enforced` and
 * `CuGateDeps.enforced`. It is a GETTER at the wiring site rather than a snapshot, so a policy
 * installed after boot tightens the next pass rather than the next restart.
 *
 * REQUIRED, not optional-with-a-default. `media.understand` refuses when this ctx is absent: a
 * `?? false` fallback would silently restore the state where an org policy disabling
 * `multimodal_input` did nothing, and nothing in the suite would go red. Same reasoning as
 * `MediaGateDeps.gpu.touch` being required rather than defaulted.
 */
export interface MediaRpcCtx {
  readonly enforced: Pick<EnforcedPolicy, "capabilitiesDisabled">;
}

export interface MediaRpcDeps {
  readonly runPass?: (opts: {
    service?: string;
    modality?: MediaModality;
    sinceMs?: number;
    limit: number;
    /**
     * Overrides `MediaPassDeps.fetchBudgetBytes` (the `[multimodal] fetch_budget_bytes` config
     * default) for this call ONLY — omitted, the caller's own default carries through, since the
     * dispatcher wiring spreads these opts over an already-complete deps object.
     */
    fetchBudgetBytes?: number;
    /** Overrides `MediaPassDeps.preferRenditions` for this call only. Same shape as above. */
    preferRenditions?: boolean;
  }) => Promise<MediaPassSummary>;
  readonly nowMs?: () => number;
  /**
   * `[multimodal] remote_vlm`, resolved ONCE by the server wiring and handed down here — never
   * re-read from the request. `media.allowRemote` refuses when the caller's `vendor` does not
   * match this exactly (§ 19.5): writing a grant for a vendor the install cannot use is the
   * ships-inert pattern this whole PR exists to close, and silently substituting the configured
   * vendor for the one the caller asked for would be worse, since the user named a specific third
   * party. Required for `media.allowRemote` specifically — a caller that omits it is a wiring bug,
   * not a request the method can answer either way.
   */
  readonly configuredRemoteVlm?: RemoteVlmVendor | null;
  /**
   * The grant-store write for ONE item, bound to a real `Database` by the server wiring
   * (`media-grant-store.ts`'s `createGrant`, confined there by D27(b) — this file never touches
   * `media_grant` itself). `alreadyActive` is what lets `media.allowRemote` report a batch's
   * new-vs-already-granted split honestly rather than treating every call as new.
   */
  readonly grantRemote?: (args: {
    readonly itemId: string;
    readonly vendor: string;
    readonly nowMs: number;
  }) => { readonly alreadyActive: boolean };
  /** `media-grant-store.ts`'s `listActiveGrantsWithTitles`, bound to a real `Database`. */
  readonly listGrants?: () => readonly MediaGrantWithTitle[];
  /** `media-grant-store.ts`'s `revokeGrant`, bound to a real `Database`. Returns the row count. */
  readonly revokeGrants?: (args: {
    readonly itemId: string;
    readonly modelVendor?: string;
    readonly nowMs: number;
  }) => number;
}

const DEFAULT_LIMIT = 50;
const DAY_MS = 86_400_000;

const MEDIA_RPC_METHODS = new Set([
  "media.understand",
  "media.allowRemote",
  "media.grants.list",
  "media.grants.revoke",
]);

export type MediaRpcResult =
  | MediaPassSummary
  | { readonly granted: number; readonly alreadyGranted: number }
  | { readonly grants: readonly MediaGrantWithTitle[] }
  | { readonly revoked: number };

export async function dispatchMediaRpc(
  method: string,
  rawParams: unknown,
  deps: MediaRpcDeps,
): Promise<MediaRpcResult | undefined> {
  if (!MEDIA_RPC_METHODS.has(method)) {
    return undefined;
  }
  if (method === "media.allowRemote") {
    return handleAllowRemote(rawParams, deps);
  }
  if (method === "media.grants.list") {
    return handleGrantsList(deps);
  }
  if (method === "media.grants.revoke") {
    return handleGrantsRevoke(rawParams, deps);
  }
  return handleUnderstand(rawParams, deps);
}

async function handleUnderstand(rawParams: unknown, deps: MediaRpcDeps): Promise<MediaPassSummary> {
  if (deps.runPass === undefined) {
    throw new Error("media.understand requires deps.runPass");
  }
  const params = asRecord(rawParams);

  const limit = readLimit(params["limit"]);
  const modality = readModality(params["modality"]);
  const service = typeof params["service"] === "string" ? params["service"] : undefined;
  const sinceMs = readSinceMs(params["sinceDays"], deps.nowMs ?? (() => Date.now()));
  const fetchBudgetBytes = readBudgetBytes(params["budgetBytes"]);
  const preferRenditions = readRenditionPreference(params["renditions"], params["originals"]);

  return deps.runPass({
    limit,
    ...(service === undefined ? {} : { service }),
    ...(modality === undefined ? {} : { modality }),
    ...(sinceMs === undefined ? {} : { sinceMs }),
    ...(fetchBudgetBytes === undefined ? {} : { fetchBudgetBytes }),
    ...(preferRenditions === undefined ? {} : { preferRenditions }),
  });
}

/**
 * `itemIds` is deliberately NOT deduplicated before granting: a duplicate id in the same call
 * naturally reports as `granted: 1, alreadyGranted: 1` because the second `grantRemote` call sees
 * the first's write — the same idempotent lookup-then-insert `createGrant` already applies to any
 * two calls, whether they land in one request or two.
 */
function readItemIds(v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0) {
    throw new Error("media.allowRemote: itemIds must be a non-empty array of strings");
  }
  return v.map((entry, i) => {
    if (typeof entry !== "string" || entry.length === 0) {
      throw new Error(`media.allowRemote: itemIds[${i}] must be a non-empty string`);
    }
    return entry;
  });
}

function readVendor(v: unknown, methodLabel: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${methodLabel}: vendor must be a non-empty string`);
  }
  return v;
}

/**
 * The refusal this whole method exists to enforce (§ 19.5): a grant for a vendor the install
 * cannot use is the ships-inert pattern again, and silently substituting the configured vendor
 * for the one the caller asked for would be worse, since the caller named a specific third party.
 */
function requireConfiguredVendorMatch(
  configured: RemoteVlmVendor | null | undefined,
  vendor: string,
): void {
  if (configured === undefined) {
    throw new Error("media.allowRemote requires deps.configuredRemoteVlm to be wired");
  }
  if (configured === null) {
    throw new Error(
      `media.allowRemote: no remote vision vendor is configured ([multimodal] remote_vlm is unset); ` +
        `refusing to grant "${vendor}" rather than accepting a grant nothing can ever use`,
    );
  }
  if (configured !== vendor) {
    throw new Error(
      `media.allowRemote: requested vendor "${vendor}" does not match the configured ` +
        `[multimodal] remote_vlm ("${configured}"); refusing rather than silently substituting it`,
    );
  }
}

async function handleAllowRemote(
  rawParams: unknown,
  deps: MediaRpcDeps,
): Promise<{ granted: number; alreadyGranted: number }> {
  if (deps.grantRemote === undefined) {
    throw new Error("media.allowRemote requires deps.grantRemote to be wired");
  }
  const params = asRecord(rawParams);
  const itemIds = readItemIds(params["itemIds"]);
  const vendor = readVendor(params["vendor"], "media.allowRemote");
  requireConfiguredVendorMatch(deps.configuredRemoteVlm, vendor);

  const nowMs = deps.nowMs ?? (() => Date.now());
  let granted = 0;
  let alreadyGranted = 0;
  for (const itemId of itemIds) {
    const { alreadyActive } = deps.grantRemote({ itemId, vendor, nowMs: nowMs() });
    if (alreadyActive) {
      alreadyGranted += 1;
    } else {
      granted += 1;
    }
  }
  return { granted, alreadyGranted };
}

function handleGrantsList(deps: MediaRpcDeps): { grants: readonly MediaGrantWithTitle[] } {
  if (deps.listGrants === undefined) {
    throw new Error("media.grants.list requires deps.listGrants to be wired");
  }
  return { grants: deps.listGrants() };
}

function readItemId(v: unknown, methodLabel: string): string {
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${methodLabel}: itemId must be a non-empty string`);
  }
  return v;
}

function readOptionalVendor(v: unknown, methodLabel: string): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`${methodLabel}: modelVendor must be a non-empty string`);
  }
  return v;
}

function handleGrantsRevoke(rawParams: unknown, deps: MediaRpcDeps): { revoked: number } {
  if (deps.revokeGrants === undefined) {
    throw new Error("media.grants.revoke requires deps.revokeGrants to be wired");
  }
  const params = asRecord(rawParams);
  const itemId = readItemId(params["itemId"], "media.grants.revoke");
  const modelVendor = readOptionalVendor(params["modelVendor"], "media.grants.revoke");
  const nowMs = deps.nowMs ?? (() => Date.now());
  const revoked = deps.revokeGrants({
    itemId,
    ...(modelVendor === undefined ? {} : { modelVendor }),
    nowMs: nowMs(),
  });
  return { revoked };
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : {};
}

function readLimit(v: unknown): number {
  if (v === undefined || v === null) return DEFAULT_LIMIT;
  if (typeof v !== "number" || !Number.isInteger(v) || v <= 0) {
    throw new Error("media.understand: limit must be a positive integer");
  }
  return v;
}

function readModality(v: unknown): MediaModality | undefined {
  if (v === undefined || v === null) return undefined;
  if (v !== "image" && v !== "av") {
    throw new Error('media.understand: modality must be "image" or "av"');
  }
  return v;
}

function readBudgetBytes(v: unknown): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error("media.understand: budgetBytes must be a non-negative number");
  }
  return v;
}

/**
 * `renditions`/`originals` are mutually exclusive request flags, not a resolved preference — the
 * CLI already rejects the pair before this ever runs, but this dispatcher is reachable from any
 * IPC caller, so the rejection is re-asserted here rather than trusted from the edge. Resolving by
 * precedence instead (say, `originals` wins) would be exactly the silent override the CLI-side
 * check exists to prevent — a caller who set both would get one honored and one dropped with no
 * error at all.
 */
function readRenditionPreference(
  renditionsRaw: unknown,
  originalsRaw: unknown,
): boolean | undefined {
  const renditions = readOptionalBool("renditions", renditionsRaw);
  const originals = readOptionalBool("originals", originalsRaw);
  if (renditions === true && originals === true) {
    throw new Error("media.understand: renditions and originals are mutually exclusive");
  }
  if (renditions === true) return true;
  if (originals === true) return false;
  return undefined;
}

function readOptionalBool(name: string, v: unknown): boolean | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "boolean") {
    throw new TypeError(`media.understand: ${name} must be a boolean`);
  }
  return v;
}

function readSinceMs(v: unknown, nowMs: () => number): number | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new Error("media.understand: sinceDays must be a non-negative number");
  }
  const floorMs = nowMs() - v * DAY_MS;
  // A huge sinceDays (e.g. Number.MAX_SAFE_INTEGER) produces a floor before the Unix epoch —
  // silently nonsensical, or even negative-overflowed — rather than "no since bound". Reject it
  // instead of handing runPass() a floor that means something other than what the caller asked.
  if (!Number.isFinite(floorMs) || floorMs < 0) {
    throw new Error(
      "media.understand: sinceDays is too large — the resulting floor predates the Unix epoch",
    );
  }
  return floorMs;
}
