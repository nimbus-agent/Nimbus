import type { IPCClient } from "../../ipc-client/index.ts";
import { registerConsentFor } from "../../lib/interactive-ipc-handlers.ts";
import { hasFlag, stripFlags, takeFlagValue } from "./flags.ts";
import {
  type AutoUpdateIpcCaller,
  detailPart,
  reportKeptDependencies,
  type UpdateApplyResultCli,
} from "./update.ts";

export interface ExtensionInfoForDowngrade {
  readonly extension?: {
    id: string;
    version: string;
  };
}

export interface RunExtensionDowngradeOpts {
  args: string[];
  caller: AutoUpdateIpcCaller;
  fetchInfo: (id: string) => Promise<ExtensionInfoForDowngrade>;
  writeStdout: (s: string) => void;
  writeStderr: (s: string) => void;
}

export async function runExtensionDowngradeWithCaller(
  opts: RunExtensionDowngradeOpts,
): Promise<number> {
  const args = opts.args;
  const isJson = hasFlag(args, "--json");
  const toVersion = takeFlagValue(args, "--to");
  const id = stripFlags(args).find((a) => !a.startsWith("--"));
  if (id === undefined) {
    opts.writeStderr("usage: nimbus extension downgrade <id> --to <version> [--json]\n");
    return 1;
  }
  if (toVersion === undefined) {
    opts.writeStderr(
      `downgrade requires --to <version> (a previous version kept under extension-versions/<slug>/prev/<version>/)\n`,
    );
    return 1;
  }
  const res = (await opts.caller("extension.update", {
    id,
    toVersion,
  })) as UpdateApplyResultCli;

  if (isJson) {
    opts.writeStdout(`${JSON.stringify(res, undefined, 2)}\n`);
    return res.applied ? 0 : 1;
  }
  if (res.applied) {
    opts.writeStdout(`downgraded ${id} to ${toVersion}\n`);
    reportKeptDependencies(opts.writeStderr, res, id);
    return 0;
  }
  const hintPart = res.hint === undefined ? "" : `\n  hint: ${res.hint}`;
  opts.writeStderr(`downgrade failed: ${res.reason ?? "unknown"}${hintPart}${detailPart(res)}\n`);
  return 1;
}

export async function runExtensionDowngrade(client: IPCClient, args: string[]): Promise<number> {
  registerConsentFor(client, { kind: "prompt" });
  return runExtensionDowngradeWithCaller({
    args: args.slice(1),
    caller: async (method, params) => client.call<unknown>(method, params),
    fetchInfo: async (id) => client.call<ExtensionInfoForDowngrade>("extension.info", { id }),
    writeStdout: (s) => process.stdout.write(s),
    writeStderr: (s) => process.stderr.write(s),
  });
}
