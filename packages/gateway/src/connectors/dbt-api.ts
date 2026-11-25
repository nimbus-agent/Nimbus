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

/** 413 for an oversized successful body; an unsuccessful response keeps its own status (a 503 or 429 stays retryable). */
const tooLarge = (res: Response): Response =>
  new Response(null, { status: res.ok ? 413 : res.status });

/**
 * `globalThis.fetch` read at call time, refusing a body over the artifact cap: by its announced
 * `Content-Length`, and by the bytes actually read (a missing or understated header is not trusted), so the
 * body is never buffered past the cap.
 */
const cappedFetch: FetchFn = async (input, init) => {
  const res = await (globalThis.fetch as FetchFn)(input, init);
  const announced = Number(res.headers.get("content-length"));
  if (Number.isFinite(announced) && announced > MAX_ARTIFACT_BYTES) {
    await res.body?.cancel();
    return tooLarge(res);
  }
  if (res.body === null) return res;
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_ARTIFACT_BYTES) {
      await reader.cancel();
      return tooLarge(res);
    }
    chunks.push(value);
  }
  return new Response(new Blob(chunks), { status: res.status, headers: res.headers });
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
