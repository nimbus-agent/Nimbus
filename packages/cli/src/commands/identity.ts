import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

export type IdentityCommand =
  | { kind: "login" }
  | { kind: "status" }
  | { kind: "logout" }
  | { kind: "bind"; email: string; peerId: string }
  | { kind: "unbind"; peerId: string }
  | { kind: "listBindings"; email: string };

/** Minimal client surface used by the identity dispatcher — satisfied by IPCClient. */
export interface IdentityIpc {
  call<T>(method: string, params?: unknown): Promise<T>;
  onNotification(method: string, handler: (params: unknown) => void): void;
  disconnect(): Promise<void>;
}

export function parseIdentityArgs(argv: string[]): IdentityCommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case undefined:
    case "login":
      return { kind: "login" };
    case "status":
      return { kind: "status" };
    case "logout":
      return { kind: "logout" };
    case "bind": {
      const [email, peerId] = [rest[0], rest[1]];
      if (!email || !peerId) throw new Error("Usage: nimbus identity bind <email> <peerId>");
      return { kind: "bind", email, peerId };
    }
    case "unbind": {
      const peerId = rest[0];
      if (!peerId) throw new Error("Usage: nimbus identity unbind <peerId>");
      return { kind: "unbind", peerId };
    }
    case "list-bindings": {
      const email = rest[0];
      if (!email) throw new Error("Usage: nimbus identity list-bindings <email>");
      return { kind: "listBindings", email };
    }
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\nUsage: nimbus identity [login|status|logout|bind|unbind|list-bindings]`,
      );
  }
}

export function awaitLogin(client: IdentityIpc): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let jobId: string | undefined;
    client.onNotification("identity.loginProgress", (n: unknown) => {
      const p = n as { jobId: string; verificationUri?: string; userCode?: string };
      if (jobId === undefined || p.jobId !== jobId) return;
      if (p.verificationUri && p.userCode) {
        process.stdout.write(`Open ${p.verificationUri} and enter code: ${p.userCode}\n`);
      }
    });
    client.onNotification("identity.loginDone", (n: unknown) => {
      if ((n as { jobId: string }).jobId === jobId) resolve();
    });
    client.onNotification("identity.loginError", (n: unknown) => {
      const p = n as { jobId: string; message: string };
      if (p.jobId === jobId) reject(new Error(p.message));
    });
    client
      .call<{ jobId: string }>("identity.login", {})
      .then((r) => {
        jobId = r.jobId;
      })
      .catch(reject);
  });
}

export async function runIdentityCommand(client: IdentityIpc, cmd: IdentityCommand): Promise<void> {
  switch (cmd.kind) {
    case "login":
      await awaitLogin(client);
      process.stdout.write("Logged in.\n");
      break;
    case "status": {
      const r = await client.call<unknown>("identity.status", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "logout":
      await client.call("identity.logout", {});
      process.stdout.write("Logged out.\n");
      break;
    case "bind":
      await client.call("identity.bind", { email: cmd.email, peerId: cmd.peerId });
      process.stdout.write(`Bound ${cmd.email} → ${cmd.peerId}\n`);
      break;
    case "unbind":
      await client.call("identity.unbind", { peerId: cmd.peerId });
      process.stdout.write(`Unbound ${cmd.peerId}\n`);
      break;
    case "listBindings": {
      const r = await client.call<unknown>("identity.listBindings", { email: cmd.email });
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
  }
}

export async function runIdentity(argv: string[]): Promise<void> {
  let cmd: IdentityCommand;
  try {
    cmd = parseIdentityArgs(argv);
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
    await runIdentityCommand(client, cmd);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
