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
    const rows = await client.call<unknown[]>("index.searchRanked", params);
    console.log(JSON.stringify(rows, null, 2));
  } finally {
    await client.disconnect().catch(() => {});
  }
}
