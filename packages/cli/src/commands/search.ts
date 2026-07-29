import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

type SearchFlags = {
  limit: number;
  semantic: boolean;
  service?: string;
  itemType?: string;
  positional: string[];
};

function consumeSearchArg(args: string[], i: number, f: SearchFlags): number {
  const a = args[i];
  if (a === undefined) {
    return i + 1;
  }
  if (a === "--limit" || a === "-n") {
    const n = args[i + 1];
    if (n !== undefined) {
      f.limit = Math.min(500, Math.max(1, Number.parseInt(n, 10) || 20));
      return i + 2;
    }
    return i + 1;
  }
  if (a === "--semantic") {
    f.semantic = true;
    return i + 1;
  }
  if (a === "--no-semantic" || a === "--keyword-only") {
    f.semantic = false;
    return i + 1;
  }
  if (a === "--service" || a === "-s") {
    const v = args[i + 1];
    if (v !== undefined) {
      f.service = v;
      return i + 2;
    }
    return i + 1;
  }
  if (a === "--type" || a === "-t") {
    const v = args[i + 1];
    if (v !== undefined) {
      f.itemType = v;
      return i + 2;
    }
    return i + 1;
  }
  if (a.startsWith("-")) {
    throw new Error(`Unknown flag: ${a}`);
  }
  f.positional.push(a);
  return i + 1;
}

function parseSearchArgs(args: string[]): {
  query: string;
  limit: number;
  semantic: boolean;
  service?: string;
  itemType?: string;
} {
  const f: SearchFlags = { limit: 20, semantic: true, positional: [] };
  let i = 0;
  while (i < args.length) {
    i = consumeSearchArg(args, i, f);
  }
  const query = f.positional.join(" ").trim();
  const out: {
    query: string;
    limit: number;
    semantic: boolean;
    service?: string;
    itemType?: string;
  } = { query, limit: f.limit, semantic: f.semantic };
  if (f.service !== undefined) {
    out.service = f.service;
  }
  if (f.itemType !== undefined) {
    out.itemType = f.itemType;
  }
  return out;
}

export async function runSearch(args: string[]): Promise<void> {
  const { query, limit, semantic, service, itemType } = parseSearchArgs(args);
  if (query === "") {
    throw new Error(
      "Usage: nimbus search <query> [--limit N] [--semantic|--no-semantic] [--service S] [--type T]",
    );
  }
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running (start with: nimbus start)");
  }
  const client = new IPCClient(state.socketPath);
  try {
    await client.connect();
    const params: Record<string, unknown> = {
      name: query,
      limit,
      semantic,
      contextChunks: 2,
    };
    if (service !== undefined) {
      params["service"] = service;
    }
    if (itemType !== undefined) {
      params["itemType"] = itemType;
    }
    const rows = await searchWithWarmingFallback(client, params, semantic);
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await client.disconnect().catch(() => {});
  }
}

/**
 * Since #928 the gateway binds its IPC socket BEFORE the embedding model finishes
 * loading, so a semantic search on a cold machine can arrive while there are no
 * vectors yet. The gateway answers with JSON-RPC `-32021`
 * (`EMBEDDING_WARMING_RPC_CODE`) rather than silently degrading to BM25 — which is
 * the right call, but the CLI had no handler, so `nimbus search` on a first run
 * printed a raw JSON-RPC error.
 *
 * Recovery is LAZY — try the search, and only on failure ask `gateway.ping` what
 * the embedding runtime is doing — for two reasons. It keeps the happy path at a
 * single round-trip, and it avoids branching on the error's shape: the
 * `@nimbus-dev/client` transport rejects with a plain `Error` carrying only
 * `error.message`, discarding the JSON-RPC `code` and `data`, so `-32021` is not
 * visible to us here. Matching the message text would be brittle; asking the
 * gateway for structured state is not.
 *
 * (The durable fix is for the client to preserve `code`/`data` on rejection, which
 * would let this — and every other typed gateway error — be matched directly.)
 *
 * No race: readiness moves warming -> ready monotonically. It never returns to
 * `warming`, so a retry cannot land in the state that produced the error.
 */
async function searchWithWarmingFallback(
  client: IPCClient,
  params: Record<string, unknown>,
  semantic: boolean,
): Promise<unknown[]> {
  try {
    return await client.call<unknown[]>("index.searchRanked", params);
  } catch (err) {
    // A keyword-only search can never trip the warming gate, so nothing to recover.
    if (!semantic) {
      throw err;
    }
    if (!(await isEmbeddingWarming(client))) {
      throw err;
    }
    // stderr, not stdout: stdout carries the JSON result and must stay parseable
    // by anything piping this command into `jq`.
    console.error(
      "note: semantic search is still warming up; showing keyword-only results. Retry shortly for semantic ranking.",
    );
    return await client.call<unknown[]>("index.searchRanked", { ...params, semantic: false });
  }
}

/** Asks the gateway whether the embedding runtime is warming. Any doubt answers false. */
async function isEmbeddingWarming(client: IPCClient): Promise<boolean> {
  try {
    const ping = await client.call<{ embedding?: { state?: unknown } }>("gateway.ping", {});
    return ping.embedding?.state === "warming";
  } catch {
    // The ping is a diagnostic, not the operation. If it fails, the caller must
    // still see the ORIGINAL search error rather than one about pinging.
    return false;
  }
}
