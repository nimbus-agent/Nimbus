import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

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

export async function runWatch(args: string[]): Promise<void> {
  const sub = args[0]?.trim() ?? "";
  const rest = args.slice(1);

  if (sub === "list" || sub === "") {
    await withGatewayIpc((c) => runWatchList(c));
    return;
  }
  if (sub === "pause") {
    const id = rest[0]?.trim() ?? "";
    await withGatewayIpc((c) => runWatchPause(c, id));
    return;
  }
  if (sub === "resume") {
    const id = rest[0]?.trim() ?? "";
    await withGatewayIpc((c) => runWatchResume(c, id));
    return;
  }

  throw new Error("Usage: nimbus watch list | pause <id> | resume <id>");
}
