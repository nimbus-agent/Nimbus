import { confirm, isCancel } from "@clack/prompts";

import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

/**
 * Test entry point — invoked by the dispatcher `runVault(args)` and the
 * colocated `vault.test.ts`. Do not call from other command files.
 */
export async function runVaultSet(client: IPCClient, key: string, value: string): Promise<void> {
  await client.call("vault.set", { key, value });
  console.log("Stored.");
}

/**
 * Test entry point — invoked by the dispatcher `runVault(args)` and the
 * colocated `vault.test.ts`. Do not call from other command files.
 */
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

/**
 * Test entry point — invoked by the dispatcher `runVault(args)` and the
 * colocated `vault.test.ts`. Do not call from other command files.
 */
export async function runVaultDelete(client: IPCClient, key: string): Promise<void> {
  await client.call("vault.delete", { key });
  console.log("Deleted (if it existed).");
}

/**
 * Test entry point — invoked by the dispatcher `runVault(args)` and the
 * colocated `vault.test.ts`. Do not call from other command files.
 */
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

export async function runVault(args: string[]): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "set": {
      const [key, value] = rest;
      if (key === undefined || value === undefined) {
        throw new Error("Usage: nimbus vault set <key> <value>");
      }
      await withIpc((c) => runVaultSet(c, key, value));
      return;
    }
    case "get": {
      const [key] = rest;
      if (key === undefined) {
        throw new Error("Usage: nimbus vault get <key>");
      }
      await withIpc((c) => runVaultGet(c, key));
      return;
    }
    case "delete": {
      const [key] = rest;
      if (key === undefined) {
        throw new Error("Usage: nimbus vault delete <key>");
      }
      await withIpc((c) => runVaultDelete(c, key));
      return;
    }
    case "list": {
      const [prefix] = rest;
      await withIpc((c) => runVaultList(c, prefix));
      return;
    }
    default:
      throw new Error(`Unknown vault subcommand: ${sub ?? "(none)"}`);
  }
}
