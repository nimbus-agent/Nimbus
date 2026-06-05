import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type ScimCommand =
  | { kind: "status" }
  | { kind: "setToken"; token: string }
  | { kind: "listUsers" }
  | { kind: "deprovision"; email: string };

export function parseScimArgs(argv: string[]): ScimCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "status":
      return { kind: "status" };
    case "set-token": {
      const token = rest[0];
      if (!token) throw new Error("Usage: nimbus scim set-token <token>");
      return { kind: "setToken", token };
    }
    case "list-users":
      return { kind: "listUsers" };
    case "deprovision": {
      const email = rest[0];
      if (!email) throw new Error("Usage: nimbus scim deprovision <email>");
      return { kind: "deprovision", email };
    }
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\nUsage: nimbus scim [status|set-token|list-users|deprovision]`,
      );
  }
}

export async function runScim(argv: string[]): Promise<void> {
  let cmd: ScimCommand;
  try {
    cmd = parseScimArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    switch (cmd.kind) {
      case "status": {
        const r = await client.call<unknown>("scim.status", {});
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "setToken":
        await client.call("scim.setToken", { token: cmd.token });
        process.stdout.write("SCIM bearer token stored.\n");
        break;
      case "listUsers": {
        const r = await client.call<unknown>("scim.listUsers", {});
        process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
        break;
      }
      case "deprovision":
        await client.call("scim.deprovision", { email: cmd.email });
        process.stdout.write(`Deprovisioned ${cmd.email}\n`);
        break;
    }
  } finally {
    await client.disconnect().catch(() => {});
  }
}
