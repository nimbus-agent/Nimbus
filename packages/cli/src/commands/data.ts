import type { IPCClient } from "../ipc-client/index.ts";
import { assertDestructiveDeleteAllowed, parseScriptConsentSource } from "../lib/data-helpers.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { selectConsentHandler } from "../lib/interactive-ipc-handlers.ts";
import { BATCH_RPC_TIMEOUT_MS, createIpcClient } from "../lib/rpc-timeouts.ts";
import { getCliPlatformPaths } from "../paths.ts";

export { assertDestructiveDeleteAllowed, parseScriptConsentSource } from "../lib/data-helpers.ts";

export async function runData(args: string[]): Promise<void> {
  const [sub, ...rest] = args;
  switch (sub) {
    case "export":
      return runDataExportCli(rest);
    case "import":
      return runDataImportCli(rest);
    case "delete":
      return runDataDeleteCli(rest);
    default:
      throw new Error("Usage: nimbus data <export|import|delete> ...");
  }
}

interface WithClientOptions {
  readonly yes: boolean;
  readonly scriptConsentSource?: string;
}

async function withClient<T>(
  opts: WithClientOptions,
  fn: (c: IPCClient) => Promise<T>,
): Promise<T> {
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state === undefined) throw new Error("Gateway is not running. Start with: nimbus start");
  // Every `withClient` caller issues a HITL-gated bundle export/import that the
  // Gateway awaits end to end, and whose consent prompt is answered from inside the
  // pending call — so the batch budget applies to the whole helper rather than being
  // opted into per call site.
  const client = createIpcClient(state.socketPath, BATCH_RPC_TIMEOUT_MS);
  await client.connect();
  selectConsentHandler(client, opts);
  try {
    return await fn(client);
  } finally {
    await client.disconnect();
  }
}

async function runDataExportCli(args: string[]): Promise<void> {
  const outIdx = args.indexOf("--output");
  const noIndex = args.includes("--no-index");
  const passIdx = args.indexOf("--passphrase");
  const yes = args.includes("--yes");
  const scriptConsentSource = parseScriptConsentSource(args);
  if (outIdx < 0 || passIdx < 0) {
    throw new Error(
      "Usage: nimbus data export --output <path.tar.gz> --passphrase <pw> [--no-index] [--yes]",
    );
  }
  const output = args[outIdx + 1];
  const passphrase = args[passIdx + 1];
  await withClient(
    { yes, ...(scriptConsentSource === undefined ? {} : { scriptConsentSource }) },
    async (client) => {
      const result = await client.call<{
        outputPath: string;
        recoverySeed: string;
        recoverySeedGenerated: boolean;
      }>("data.export", { output, passphrase, includeIndex: !noIndex });
      console.log(`[ok] wrote bundle to ${result.outputPath}`);
      if (result.recoverySeedGenerated) {
        console.log("");
        console.log("Recovery seed (store offline — shown only once):");
        console.log(`  ${result.recoverySeed}`);
      }
    },
  );
}

async function runDataImportCli(args: string[]): Promise<void> {
  const bundlePath = args[0];
  if (bundlePath === undefined) {
    throw new Error(
      "Usage: nimbus data import <path.tar.gz> [--passphrase <pw> | --recovery-seed <mnemonic>] [--yes]",
    );
  }
  const passIdx = args.indexOf("--passphrase");
  const seedIdx = args.indexOf("--recovery-seed");
  const passphrase = passIdx >= 0 ? args[passIdx + 1] : undefined;
  const recoverySeed = seedIdx >= 0 ? args[seedIdx + 1] : undefined;
  const yes = args.includes("--yes");
  const scriptConsentSource = parseScriptConsentSource(args);
  if (passphrase === undefined && recoverySeed === undefined) {
    throw new Error("Provide either --passphrase or --recovery-seed");
  }
  await withClient(
    { yes, ...(scriptConsentSource === undefined ? {} : { scriptConsentSource }) },
    async (client) => {
      const result = await client.call<{
        credentialsRestored: number;
        oauthEntriesFlagged: number;
      }>("data.import", { bundlePath, passphrase, recoverySeed });
      console.log(`[ok] restored ${String(result.credentialsRestored)} credentials`);
      if (result.oauthEntriesFlagged > 0) {
        console.log(
          `[warn] ${String(result.oauthEntriesFlagged)} OAuth entries may require re-auth on next sync`, // NOSONAR — count only, no credential values
        );
      }
    },
  );
}

async function runDataDeleteCli(args: string[]): Promise<void> {
  const svcIdx = args.indexOf("--service");
  if (svcIdx < 0) throw new Error("Usage: nimbus data delete --service <name> [--dry-run] [--yes]");
  const service = args[svcIdx + 1];
  const dryRun = args.includes("--dry-run");
  const yes = args.includes("--yes");
  const scriptConsentSource = parseScriptConsentSource(args);
  await withClient(
    { yes, ...(scriptConsentSource === undefined ? {} : { scriptConsentSource }) },
    async (client) => {
      const pre = await client.call<{
        preflight: { itemsToDelete: number; vaultEntriesToDelete: number };
        deleted: boolean;
      }>("data.delete", { service, dryRun: true });
      console.log(`Service: ${service}`);
      console.log(`  Items to delete: ${String(pre.preflight.itemsToDelete)}`);
      console.log(`  Vault entries to delete: ${String(pre.preflight.vaultEntriesToDelete)}`);
      if (dryRun) return;
      assertDestructiveDeleteAllowed({ yes, scriptConsentSource });
      const result = await client.call<{ deleted: boolean }>("data.delete", {
        service,
        dryRun: false,
      });
      console.log(result.deleted ? "[ok] deletion complete" : "[fail] deletion did not run");
    },
  );
}
