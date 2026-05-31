import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export async function runWatchList(client: IPCClient): Promise<void> {
  const out = await client.call<{ watchers: unknown }>("watcher.list", {});
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runWatchPause(client: IPCClient, id: string): Promise<void> {
  if (id === "") {
    throw new Error("Usage: nimbus watch pause <id>");
  }
  const out = await client.call<{ ok: boolean }>("watcher.pause", { id });
  console.log(JSON.stringify(out, undefined, 2));
}

export async function runWatchResume(client: IPCClient, id: string): Promise<void> {
  if (id === "") {
    throw new Error("Usage: nimbus watch resume <id>");
  }
  const out = await client.call<{ ok: boolean }>("watcher.resume", { id });
  console.log(JSON.stringify(out, undefined, 2));
}

async function withIpc<T>(fn: (c: IPCClient) => Promise<T>): Promise<T> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) {
    throw new Error("Gateway is not running. Start with: nimbus start");
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

export async function runWatch(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  const rest = args.slice(1);

  if (sub === "list" || sub === "") {
    await withIpc((c) => runWatchList(c));
    return;
  }
  if (sub === "pause") {
    const id = rest[0]?.trim() ?? "";
    await withIpc((c) => runWatchPause(c, id));
    return;
  }
  if (sub === "resume") {
    const id = rest[0]?.trim() ?? "";
    await withIpc((c) => runWatchResume(c, id));
    return;
  }

  throw new Error("Usage: nimbus watch list | pause <id> | resume <id>");
}
