import { extensionProcessEnv } from "../../extensions/spawn-env.ts";
import { spawnCapture } from "../../platform/spawn-capture.ts";
import {
  syncPassCursorParseEmpty,
  syncPassCursorSuccess,
} from "../../sync/pass-cursor-sync-result.ts";
import { type SyncContext, type SyncResult, syncNoopResult } from "../../sync/types.ts";
import type { NimbusVault } from "../../vault/nimbus-vault.ts";
import { readConnectorSecret } from "../connector-vault.ts";
import { asRecord, stringField } from "../unknown-record.ts";

interface AwsCredentialFields {
  readonly ak: string;
  readonly sk: string;
  readonly reg: string;
  readonly prof: string;
}

async function readAwsCredentialFields(vault: NimbusVault): Promise<AwsCredentialFields> {
  const ak = (await readConnectorSecret(vault, "aws", "access_key_id"))?.trim() ?? "";
  const sk = (await readConnectorSecret(vault, "aws", "secret_access_key"))?.trim() ?? "";
  const reg = (await readConnectorSecret(vault, "aws", "default_region"))?.trim() ?? "";
  const prof = (await readConnectorSecret(vault, "aws", "profile"))?.trim() ?? "";
  return { ak, sk, reg, prof };
}

/**
 * Usable combinations for the shared `aws.*` credential fields:
 *  - access key + secret + (region OR profile), or
 *  - profile alone (no access key).
 */
function hasUsableAwsCredentialFields(f: AwsCredentialFields): boolean {
  return (
    (f.ak !== "" && f.sk !== "" && (f.reg !== "" || f.prof !== "")) ||
    (f.prof !== "" && f.ak === "")
  );
}

/**
 * Whether the shared `aws.*` vault keys carry a usable credential combination — the SAME
 * predicate `awsCredentialsExtra` gates its spawn on, exposed standalone (vault-only, no
 * `SyncContext`) so `sync/connector-configured.ts` can reuse it as the configured-check for
 * every AWS-CLI-derived syncable (`athena`/`cloudwatch`/`sagemaker`) without duplicating the
 * usable-combination formula and risking drift between the two call sites.
 */
/**
 * The same fields, read through a connector's SHARED-credential capability instead of a vault
 * handle. Both forms exist deliberately: `hasUsableAwsCredentials` below is called by
 * `sync/connector-configured.ts` for I29's derived check, which runs gateway-side and legitimately
 * holds the vault, while a syncable has only its capability.
 */
async function readAwsCredentialFieldsVia(
  getShared: SyncContext["getSharedSecret"],
): Promise<AwsCredentialFields> {
  const ak = (await getShared("aws", "access_key_id"))?.trim() ?? "";
  const sk = (await getShared("aws", "secret_access_key"))?.trim() ?? "";
  const reg = (await getShared("aws", "default_region"))?.trim() ?? "";
  const prof = (await getShared("aws", "profile"))?.trim() ?? "";
  return { ak, sk, reg, prof };
}

export async function hasUsableAwsCredentials(vault: NimbusVault): Promise<boolean> {
  return hasUsableAwsCredentialFields(await readAwsCredentialFields(vault));
}

/**
 * Resolve the AWS credential environment from the shared `aws.*` vault keys
 * (`access_key_id`, `secret_access_key`, `default_region`, `profile`). Returns
 * the scoped env map to inject at spawn time, or `null` when no usable
 * credential combination is present (the caller degrades to a no-op).
 *
 * Usable combinations:
 *  - access key + secret + (region OR profile), or
 *  - profile alone (no access key).
 *
 * Shared by every AWS-CLI-backed connector (aws, athena, …). Adding a connector
 * that reuses AWS creds means importing this helper rather than re-reading keys.
 */
export async function awsCredentialsExtra(
  ctx: SyncContext,
): Promise<Record<string, string> | null> {
  const fields = await readAwsCredentialFieldsVia(ctx.getSharedSecret);
  if (!hasUsableAwsCredentialFields(fields)) {
    return null;
  }
  const { ak, sk, reg, prof } = fields;
  const extra: Record<string, string> = {};
  if (ak !== "") {
    extra["AWS_ACCESS_KEY_ID"] = ak;
  }
  if (sk !== "") {
    extra["AWS_SECRET_ACCESS_KEY"] = sk;
  }
  if (reg !== "") {
    extra["AWS_DEFAULT_REGION"] = reg;
  }
  if (prof !== "") {
    extra["AWS_PROFILE"] = prof;
  }
  return extra;
}

/**
 * Spawn `aws <args> --output json` with the resolved AWS credential env scoped
 * via `extensionProcessEnv` (invariant I1). Returns `{ ok, text }` — `ok` is the
 * exit-zero flag, `text` the captured stdout. Returns `{ ok: false, text: "" }`
 * when no usable credentials are present (no spawn). Never throws past this
 * boundary — callers degrade gracefully on `!ok`.
 */
export async function awsCliJson(
  ctx: SyncContext,
  args: string[],
): Promise<{ ok: boolean; text: string }> {
  const extra = await awsCredentialsExtra(ctx);
  if (extra === null) {
    return { ok: false, text: "" };
  }
  // `spawnCapture`, not `Bun.spawn`: the Gateway runs detached, so on Windows every
  // console-subsystem child gets a NEW console and a visible window. `cloudwatch` and
  // `sagemaker` spawn one of these PER INDEXED ITEM via `runAwsCliPaginatedWalk`, so the
  // unhidden version flashed dozens of windows per sync tick. See `platform/spawn-capture.ts`.
  const r = await spawnCapture(["aws", ...args, "--output", "json"], {
    env: extensionProcessEnv(extra),
  });
  return { ok: r.ok, text: r.stdout };
}

// ---------------------------------------------------------------------------
// Shared single-pass paginated AWS-CLI walk (cloudwatch, sagemaker, …)
// ---------------------------------------------------------------------------

/** Injectable AWS-CLI runner — defaults to {@link awsCliJson}; tests pass a stub. */
export type RunAwsCli = (
  ctx: SyncContext,
  args: string[],
) => Promise<{ ok: boolean; text: string }>;

/** Parse CLI stdout as JSON, returning `undefined` on any parse error. */
export function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

/** Read a non-empty string continuation token under `key` (e.g. `nextToken`/`NextToken`), else `null`. */
export function awsNextToken(parsed: unknown, key: string): string | null {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return null;
  }
  const tok = stringField(rec, key);
  return tok !== undefined && tok !== "" ? tok : null;
}

/** Extract `parsed[key]` as an array (empty array when absent / not an object / not an array). */
export function extractArray(parsed: unknown, key: string): unknown[] {
  const rec = asRecord(parsed);
  if (rec === undefined) {
    return [];
  }
  const arr = rec[key];
  return Array.isArray(arr) ? arr : [];
}

/** Mutable counters threaded through a paginated walk. */
export interface BaseWalkState {
  upserted: number;
  bytes: number;
  seen: number;
}

/**
 * Spec for {@link runAwsCliPaginatedWalk}. The connector supplies the list-page
 * argv, the continuation-token key + result-array key, the per-cycle item cap,
 * and a `processEntry` callback that enriches/maps/upserts one entry (mutating
 * the walk state's `upserted`/`bytes` as the hand-written connector bodies did).
 */
export interface AwsPaginatedWalkSpec<S extends BaseWalkState> {
  readonly ensureRunning: () => Promise<void>;
  /** Resolve credentials (or null → noop). Typically {@link awsCredentialsExtra}. */
  readonly loadCreds: () => Promise<unknown>;
  readonly pass1Cursor: () => string;
  readonly maxItems: number;
  readonly pageSize: number;
  /** Continuation-token key in the JSON response (`nextToken` / `NextToken`). */
  readonly tokenKey: string;
  /** Result-array key in the JSON response (`logGroups` / `Models`). */
  readonly arrayKey: string;
  readonly initialState: () => S;
  /** Build the list-page argv. `token` is null on the first page. */
  readonly buildPageArgs: (pageSize: number, token: string | null) => string[];
  /** Enrich + map + upsert one entry, mutating `state.upserted`/`state.bytes`. */
  readonly processEntry: (
    run: RunAwsCli,
    ctx: SyncContext,
    entry: unknown,
    now: number,
    state: S,
  ) => Promise<void>;
}

/**
 * Run a single-pass, token-paginated AWS-CLI walk: ensure-running → load creds
 * (noop if absent) → page through the list call (first-page failure degrades to
 * a parse-empty pass-cursor; a later-page failure breaks) → for each entry up to
 * `maxItems`, delegate to `processEntry` → pass-1 success. Byte/upsert accounting
 * is owned by `state`, threaded exactly as the hand-written connector `sync()`
 * bodies did. Per-item enrichment (and its own byte accounting + caps) lives in
 * the connector's `processEntry`.
 */
export async function runAwsCliPaginatedWalk<S extends BaseWalkState>(
  ctx: SyncContext,
  cursor: string | null,
  run: RunAwsCli,
  spec: AwsPaginatedWalkSpec<S>,
): Promise<SyncResult> {
  const t0 = performance.now();
  await spec.ensureRunning();

  const creds = await spec.loadCreds();
  if (creds === null) {
    return syncNoopResult(cursor, t0);
  }

  const now = Date.now();
  const state = spec.initialState();
  let token: string | null = null;
  let page = 0;

  while (state.seen < spec.maxItems) {
    const args = spec.buildPageArgs(spec.pageSize, token);
    const res = await run(ctx, args);
    state.bytes += res.text.length;
    if (!res.ok) {
      if (page === 0) {
        return syncPassCursorParseEmpty(t0, state.bytes, spec.pass1Cursor());
      }
      break;
    }
    const parsed = parseJson(res.text);
    for (const entry of extractArray(parsed, spec.arrayKey)) {
      if (state.seen >= spec.maxItems) {
        break;
      }
      state.seen += 1;
      await spec.processEntry(run, ctx, entry, now, state);
    }
    token = awsNextToken(parsed, spec.tokenKey);
    page += 1;
    if (token === null) {
      break;
    }
  }

  return syncPassCursorSuccess(t0, state.bytes, spec.pass1Cursor(), state.upserted);
}
