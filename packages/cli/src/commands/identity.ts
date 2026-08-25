import { REAL_GATEWAY_CLI_IO, runGatewayCliCommand } from "../lib/run-gateway-cli-command.ts";

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

function parseBindArgs(rest: string[]): IdentityCommand {
  const [email, peerId] = [rest[0], rest[1]];
  if (!email || !peerId) throw new Error("Usage: nimbus identity bind <email> <peerId>");
  return { kind: "bind", email, peerId };
}

function parseUnbindArgs(rest: string[]): IdentityCommand {
  const peerId = rest[0];
  if (!peerId) throw new Error("Usage: nimbus identity unbind <peerId>");
  return { kind: "unbind", peerId };
}

function parseListBindingsArgs(rest: string[]): IdentityCommand {
  const email = rest[0];
  if (!email) throw new Error("Usage: nimbus identity list-bindings <email>");
  return { kind: "listBindings", email };
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
    case "bind":
      return parseBindArgs(rest);
    case "unbind":
      return parseUnbindArgs(rest);
    case "list-bindings":
      return parseListBindingsArgs(rest);
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\nUsage: nimbus identity [login|status|logout|bind|unbind|list-bindings]`,
      );
  }
}

export function awaitLogin(client: IdentityIpc): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    let jobId: string | undefined;
    // A terminal event can race ahead of the call() response that assigns jobId. Buffer events
    // that arrive before jobId is known, then replay them once it is, so login never hangs.
    const backlog: Array<{ method: string; payload: unknown }> = [];

    type LoginEvent = {
      jobId?: string;
      verificationUri?: string;
      userCode?: string;
      message?: string;
    };
    const emitProgress = (p: LoginEvent): void => {
      if (p.verificationUri && p.userCode) {
        process.stdout.write(`Open ${p.verificationUri} and enter code: ${p.userCode}\n`);
      }
    };
    const dispatchEvent = (method: string, p: LoginEvent): void => {
      if (method === "identity.loginProgress") emitProgress(p);
      else if (method === "identity.loginDone") resolve();
      else if (method === "identity.loginError")
        reject(new Error(p.message ?? "identity: login failed"));
    };
    const handle = (method: string, payload: unknown): void => {
      const p = payload as LoginEvent;
      if (typeof p.jobId !== "string") return;
      if (jobId === undefined) {
        backlog.push({ method, payload });
        return;
      }
      if (p.jobId !== jobId) return;
      dispatchEvent(method, p);
    };

    client.onNotification("identity.loginProgress", (n) => handle("identity.loginProgress", n));
    client.onNotification("identity.loginDone", (n) => handle("identity.loginDone", n));
    client.onNotification("identity.loginError", (n) => handle("identity.loginError", n));
    client
      .call<{ jobId: string }>("identity.login", {})
      .then((r) => {
        jobId = r.jobId;
        for (const e of backlog.splice(0)) handle(e.method, e.payload);
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
  await runGatewayCliCommand(argv, {
    parse: parseIdentityArgs,
    dispatch: runIdentityCommand,
    io: REAL_GATEWAY_CLI_IO,
  });
}
