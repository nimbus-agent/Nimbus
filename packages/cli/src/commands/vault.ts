import { confirm, isCancel } from "@clack/prompts";

import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export async function runVaultSet(client: IPCClient, key: string, value: string): Promise<void> {
  await client.call("vault.set", { key, value });
  console.log("Stored.");
}

export async function runVaultGet(client: IPCClient, key: string): Promise<void> {
  const ok = await confirm({
    message: "Secrets echo to this terminal. Continue?",
  });
  if (isCancel(ok) || ok !== true) {
    return;
  }
  const v = await client.call<string | null>("vault.get", { key });
  console.log(v ?? "(not set)");
}

export async function runVaultDelete(client: IPCClient, key: string): Promise<void> {
  await client.call("vault.delete", { key });
  console.log("Deleted (if it existed).");
}

export async function runVaultList(client: IPCClient, prefix?: string): Promise<void> {
  const listKeysParams: { prefix?: string } = {};
  if (prefix !== undefined) {
    listKeysParams.prefix = prefix;
  }
  const keys = await client.call<string[]>("vault.listKeys", listKeysParams);
  for (const k of keys) {
    console.log(k);
  }
}

export async function runVault(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "set": {
      const [key, value] = rest;
      if (key === undefined || value === undefined) {
        throw new Error("Usage: nimbus vault set <key> <value>");
      }
      await withGatewayIpc((c) => runVaultSet(c, key, value));
      return;
    }
    case "get": {
      const [key] = rest;
      if (key === undefined) {
        throw new Error("Usage: nimbus vault get <key>");
      }
      await withGatewayIpc((c) => runVaultGet(c, key));
      return;
    }
    case "delete": {
      const [key] = rest;
      if (key === undefined) {
        throw new Error("Usage: nimbus vault delete <key>");
      }
      await withGatewayIpc((c) => runVaultDelete(c, key));
      return;
    }
    case "list": {
      const [prefix] = rest;
      await withGatewayIpc((c) => runVaultList(c, prefix));
      return;
    }
    default:
      throw new Error(`Unknown vault subcommand: ${sub ?? "(none)"}`);
  }
}
