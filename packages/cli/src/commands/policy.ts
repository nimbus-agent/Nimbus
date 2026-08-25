import { readFile } from "node:fs/promises";

import { REAL_GATEWAY_CLI_IO, runGatewayCliCommand } from "../lib/run-gateway-cli-command.ts";

export type PolicyCommand =
  | { kind: "show" }
  | { kind: "verify" }
  | { kind: "sign"; file: string }
  | { kind: "trust"; pubkey: string }
  | { kind: "refetch" };

/** Minimal client surface used by the policy dispatcher — satisfied by IPCClient. */
export interface PolicyIpc {
  call<T>(method: string, params?: unknown): Promise<T>;
}

export function parsePolicyArgs(argv: string[]): PolicyCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "show":
      return { kind: "show" };
    case "verify":
      return { kind: "verify" };
    case "sign":
    case "push": {
      const file = rest[0];
      if (!file) throw new Error(`Usage: nimbus policy ${sub} <file.toml>`);
      return { kind: "sign", file };
    }
    case "trust": {
      const pubkey = rest[0];
      if (!pubkey) throw new Error("Usage: nimbus policy trust <pubkeyBase64>");
      return { kind: "trust", pubkey };
    }
    case "refetch":
      return { kind: "refetch" };
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\nUsage: nimbus policy [show|verify|sign <file>|push <file>|trust <pubkey>|refetch]`,
      );
  }
}

/** Execute a parsed policy subcommand over an injected client (test entry point + runtime path). */
export async function runPolicyCommand(client: PolicyIpc, cmd: PolicyCommand): Promise<void> {
  switch (cmd.kind) {
    case "show": {
      const r = await client.call<unknown>("policy.show", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "verify": {
      const r = await client.call<unknown>("policy.verify", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "sign": {
      const toml = await readFile(cmd.file, "utf8");
      const r = await client.call<unknown>("policy.sign", { toml });
      process.stdout.write(`Signed + applied policy:\n${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "trust": {
      await client.call("policy.trust", { pubkey: cmd.pubkey });
      process.stdout.write(`Pinned org policy anchor pubkey ${cmd.pubkey}\n`);
      break;
    }
    case "refetch": {
      const r = await client.call<unknown>("policy.refetch", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
  }
}

export async function runPolicy(argv: string[]): Promise<void> {
  await runGatewayCliCommand(argv, {
    parse: parsePolicyArgs,
    dispatch: runPolicyCommand,
    io: REAL_GATEWAY_CLI_IO,
  });
}
