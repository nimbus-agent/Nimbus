import type { Database } from "bun:sqlite";
import { CONNECTOR_VAULT_SECRET_KEYS } from "../connectors/connector-secrets-manifest.ts";
import { normaliseGithubApiBase } from "../connectors/github-api-base.ts";
import { teamVaultKey } from "../teamvault/team-vault-keys.ts";
import { TeamVaultStore } from "../teamvault/team-vault-store.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export class TeamVaultRpcError extends Error {
  readonly rpcCode: number;
  constructor(rpcCode: number, message: string) {
    super(message);
    this.name = "TeamVaultRpcError";
    this.rpcCode = rpcCode;
  }
}

export interface TeamVaultRpcContext {
  readonly db: Database;
  readonly vault: {
    set: (key: string, value: string) => Promise<void>;
    delete: (key: string) => Promise<void>;
  };
  /** Operator identity recorded as created_by. */
  readonly operator: string;
}

function rec(p: unknown): Record<string, unknown> {
  if (p === null || typeof p !== "object") {
    throw new TeamVaultRpcError(-32602, "ERR_INVALID_PARAMS: object expected");
  }
  return p as Record<string, unknown>;
}
function str(r: Record<string, unknown>, k: string): string {
  const v = r[k];
  if (typeof v !== "string" || v.length === 0) {
    throw new TeamVaultRpcError(-32602, `ERR_INVALID_PARAMS: ${k} must be a non-empty string`);
  }
  return v;
}

// The two halves of a github credential, named by the secrets manifest (static D11).
const [GITHUB_PAT_KEY, GITHUB_API_BASE_KEY] = CONNECTOR_VAULT_SECRET_KEYS.github;

/**
 * A github team entry's PAT and its `github.api_base` are one credential: the PAT is only ever
 * sent to the instance its own entry names (absent base = github.com). Readers pair them by
 * reading base, PAT, base again (`readGithubCredentialPair`), which is sound only if every writer
 * writes the PAT LAST and never leaves a stale base beside a new PAT. So a put that carries the
 * PAT deletes the PAT first, then writes the base (validated and normalised) or DELETES it when
 * the put has none, then writes the PAT. A put that sets a base without a PAT is refused: it
 * would re-point an existing PAT at another host. Other keys are written before the pair.
 */
async function putGithubTeamSecrets(
  entry: string,
  secrets: ReadonlyArray<readonly [string, string]>,
  ctx: TeamVaultRpcContext,
): Promise<void> {
  const pat = secrets.find(([k]) => k === GITHUB_PAT_KEY)?.[1];
  const base = secrets.find(([k]) => k === GITHUB_API_BASE_KEY)?.[1];
  if (pat === undefined && base !== undefined) {
    throw new TeamVaultRpcError(
      -32602,
      "ERR_INVALID_PARAMS: github.api_base can only be set together with github.pat",
    );
  }
  let normalisedBase: string | undefined;
  if (base !== undefined) {
    const n = normaliseGithubApiBase(base);
    if (!n.ok)
      throw new TeamVaultRpcError(-32602, `ERR_INVALID_PARAMS: github.api_base: ${n.reason}`);
    normalisedBase = n.base;
  }
  for (const [k, v] of secrets) {
    if (k === GITHUB_PAT_KEY || k === GITHUB_API_BASE_KEY) continue;
    await ctx.vault.set(teamVaultKey(entry, k), v); // NOSONAR S9382: sequential by design (one shared macOS key index)
  }
  if (pat === undefined) return;
  await ctx.vault.delete(teamVaultKey(entry, GITHUB_PAT_KEY));
  if (normalisedBase === undefined) {
    await ctx.vault.delete(teamVaultKey(entry, GITHUB_API_BASE_KEY));
  } else {
    await ctx.vault.set(teamVaultKey(entry, GITHUB_API_BASE_KEY), normalisedBase);
  }
  await ctx.vault.set(teamVaultKey(entry, GITHUB_PAT_KEY), pat);
}

export async function dispatchTeamVaultRpc(
  method: string,
  params: unknown,
  ctx: TeamVaultRpcContext,
): Promise<RpcMissOrHit> {
  const store = new TeamVaultStore(ctx.db);
  return dispatchByMethod<TeamVaultRpcContext>(method, params, ctx, {
    "teamvault.put": async (p) => {
      const r = rec(p);
      const entry = str(r, "entry");
      const service = str(r, "service");
      const secrets = r["secrets"];
      if (secrets === null || typeof secrets !== "object") {
        throw new TeamVaultRpcError(-32602, "ERR_INVALID_PARAMS: secrets object required");
      }
      const pairs = Object.entries(secrets as Record<string, unknown>);
      for (const [k, v] of pairs) {
        if (typeof v !== "string") {
          throw new TeamVaultRpcError(-32602, `ERR_INVALID_PARAMS: secret ${k} must be a string`);
        }
      }
      const strings = pairs as ReadonlyArray<readonly [string, string]>;
      if (service === "github") {
        await putGithubTeamSecrets(entry, strings, ctx);
      } else {
        for (const [k, v] of strings) {
          await ctx.vault.set(teamVaultKey(entry, k), v); // NOSONAR S9382: sequential by design - the macOS vault's set() read-modify-writes one shared key index (concurrent sets drop entries)
        }
      }
      store.createEntry(entry, service, ctx.operator);
      return { ok: true };
    },
    "teamvault.delete": async (p) => {
      const r = rec(p);
      const entry = str(r, "entry");
      const keys = r["keys"];
      if (Array.isArray(keys)) {
        for (const k of keys) {
          if (typeof k === "string") await ctx.vault.delete(teamVaultKey(entry, k)); // NOSONAR S9382: sequential by design - the macOS vault's delete() read-modify-writes one shared key index, so concurrent deletes would lose index updates
        }
      }
      return { ok: true };
    },
    "teamvault.grant": (p) => {
      const r = rec(p);
      store.grant(str(r, "entry"), str(r, "peerId"), str(r, "toolId"));
      return { ok: true };
    },
    "teamvault.revoke": (p) => {
      const r = rec(p);
      store.revoke(str(r, "entry"), str(r, "peerId"), str(r, "toolId"));
      return { ok: true };
    },
    "teamvault.list": () => {
      return { entries: store.listEntries() };
    },
  });
}
