import type { SyncContext } from "../sync/types.ts";
import { connectorFetch } from "./_lib/fetch-outcome.ts";
import { trimTrailingSlash } from "./_lib/field-helpers.ts";
import { asRecord } from "./unknown-record.ts";

export const DBT_SERVICE_ID = "dbt";
const DEFAULT_API_BASE = "https://cloud.getdbt.com";

export interface DbtCreds {
  readonly token: string;
  readonly apiBase: string;
  readonly accountId: number | null;
}

export async function loadDbtCreds(ctx: SyncContext): Promise<DbtCreds | null> {
  const token = (await ctx.getSecret("token"))?.trim() ?? "";
  if (token === "") {
    return null;
  }
  const baseRaw = (await ctx.getSecret("api_base"))?.trim() ?? "";
  const accountRaw = (await ctx.getSecret("account_id"))?.trim() ?? "";
  const parsedAccount = accountRaw === "" ? Number.NaN : Number.parseInt(accountRaw, 10);
  return {
    token,
    apiBase: baseRaw === "" ? DEFAULT_API_BASE : trimTrailingSlash(baseRaw),
    accountId: Number.isFinite(parsedAccount) ? parsedAccount : null,
  };
}

/** The largest artifact (by `Content-Length`) a sync reads: a bigger one reads as an HTTP 413. */
export const MAX_ARTIFACT_BYTES = 32 * 1024 * 1024;

type FetchFn = (input: string | URL, init?: RequestInit) => Promise<Response>;

/** `globalThis.fetch` read at call time, refusing a body that announces itself over the artifact cap. */
const cappedFetch: FetchFn = async (input, init) => {
  const res = await (globalThis.fetch as FetchFn)(input, init);
  const announced = Number(res.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_ARTIFACT_BYTES) {
    await res.body?.cancel();
    return new Response(null, { status: 413 });
  }
  return res;
};

export function dbtGet(ctx: SyncContext, creds: DbtCreds, path: string, capped = false) {
  return connectorFetch(
    ctx,
    DBT_SERVICE_ID,
    `${creds.apiBase}/api/v2${path}`,
    { headers: { Authorization: `Token ${creds.token}`, Accept: "application/json" } },
    capped ? cappedFetch : undefined,
  );
}

export function extractDbtData(parsed: unknown): unknown[] {
  const data = asRecord(parsed)?.["data"];
  if (Array.isArray(data)) {
    return data;
  }
  return Array.isArray(parsed) ? parsed : [];
}
