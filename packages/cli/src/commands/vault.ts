import { confirm, isCancel } from "@clack/prompts";

import type { IPCClient } from "../ipc-client/index.ts";
import {
  assertPipedSecretCanBeApproved,
  defaultSecretInputIo,
  readSecretValue,
  type SecretInputIo,
} from "../lib/secret-input.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

const VAULT_SET_USAGE =
  "Usage: nimbus vault set <key> (the value is read from a hidden prompt, or from stdin when stdin is not a terminal)";

/**
 * Printed when the value arrives as an argument, which still works but is deprecated: there it is
 * kept in shell history and shown in the process list. Never quotes the value.
 */
export const VAULT_SET_ARGV_DEPRECATION =
  "Warning: a value given on the command line is kept in shell history and shown in the process list. Run `nimbus vault set <key>` without it to be prompted (input is hidden), or pipe it on stdin. The value argument will be removed in a future major release.";

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

export async function runVault(
  args: string[],
  io: SecretInputIo = defaultSecretInputIo(),
): Promise<void> {
  const sub = args[0];
  const rest = args.slice(1);
  switch (sub) {
    case "set": {
      const [key, value, extra] = rest;
      if (key === undefined || key.trim() === "" || extra !== undefined) {
        throw new Error(VAULT_SET_USAGE);
      }
      if (value !== undefined) {
        console.warn(VAULT_SET_ARGV_DEPRECATION);
        await withGatewayIpc((c) => runVaultSet(c, key, value));
        return;
      }
      assertPipedSecretCanBeApproved(io);
      await withGatewayIpc(async (c) => runVaultSet(c, key, await readSecretValue(io, key)));
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
