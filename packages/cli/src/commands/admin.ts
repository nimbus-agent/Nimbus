import { IPCClient } from "../ipc-client/index.ts";
import { gatewayNotRunningMessage } from "../lib/gateway-not-running.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { type CliPlatformPaths, getCliPlatformPaths } from "../paths.ts";

export type AdminCommand = { kind: "status" } | { kind: "console" } | { kind: "token" };

/** Minimal client surface used by the admin dispatcher — satisfied by IPCClient. */
export interface AdminIpc {
  call<T>(method: string, params?: unknown): Promise<T>;
}

/** The Vault key holding the read-surface bearer (shared with the I13 HTTP write surface). */
export const ADMIN_TOKEN_VAULT_KEY = "http_api.deployment_token";

export function parseAdminArgs(argv: string[]): AdminCommand {
  const [sub] = argv;
  switch (sub) {
    case undefined:
    case "status":
      return { kind: "status" };
    case "console":
      return { kind: "console" };
    case "token":
      return { kind: "token" };
    default:
      throw new Error(`Unknown subcommand: ${sub}\nUsage: nimbus admin [status|console|token]`);
  }
}

/** Read-surface base URL: the local read-only HTTP server (NIMBUS_HTTP_PORT-driven). */
function readSurfaceBaseUrl(): string {
  const port = (process.env["NIMBUS_HTTP_PORT"] ?? "").trim();
  return `http://127.0.0.1:${port === "" ? "<NIMBUS_HTTP_PORT>" : port}`;
}

/**
 * The read-surface bearer is a Vault credential (`http_api.deployment_token`). The CLI talks to the
 * gateway IPC-only and never holds the Vault, so the token is fetched via `nimbus vault get` rather
 * than echoed over a dedicated (credential-exposing) IPC method. `admin token` prints the resolver
 * command; `admin console` prints the URL with the token in the FRAGMENT (never the query string —
 * fragments are not sent to servers / logged in access logs).
 */
/** The demo gateway's Vault is an `EphemeralVault` — nothing to resolve `nimbus vault get` for. */
const DEMO_VAULT_HINT = "The demo root's vault is in-memory; it holds no admin token.\n";

export async function runAdminCommand(
  client: AdminIpc,
  cmd: AdminCommand,
  demo = false,
): Promise<void> {
  switch (cmd.kind) {
    case "status": {
      const r = await client.call<unknown>("admin.status", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "console": {
      if (demo) {
        process.stdout.write(DEMO_VAULT_HINT);
        break;
      }
      process.stdout.write(
        `Admin console: ${readSurfaceBaseUrl()}/admin#token=$(nimbus vault get ${ADMIN_TOKEN_VAULT_KEY})\n` +
          `Resolve the bearer with: nimbus vault get ${ADMIN_TOKEN_VAULT_KEY}\n` +
          `then open ${readSurfaceBaseUrl()}/admin#token=<bearer> in a browser.\n`,
      );
      break;
    }
    case "token": {
      if (demo) {
        process.stdout.write(DEMO_VAULT_HINT);
        break;
      }
      process.stdout.write(
        `The read-surface bearer is the Vault value ${ADMIN_TOKEN_VAULT_KEY}.\n` +
          `Print it with: nimbus vault get ${ADMIN_TOKEN_VAULT_KEY}\n`,
      );
      break;
    }
  }
}

/** A gateway client for `runAdmin`: the calls `runAdminCommand` makes, plus the connection. */
export interface AdminConnection extends AdminIpc {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
}

/**
 * The outside world `runAdmin` touches. Injected so every branch — a bad subcommand, the
 * local-only subcommands, no gateway, a live round trip — is testable with no gateway and no real
 * `process.exit`. The defaults are the real thing; production callers pass nothing.
 */
export interface RunAdminDeps {
  readonly getPaths: () => CliPlatformPaths;
  readonly readGatewayState: (
    paths: CliPlatformPaths,
  ) => Promise<{ readonly socketPath: string } | undefined>;
  readonly makeClient: (socketPath: string) => AdminConnection;
  readonly writeErr: (s: string) => void;
  readonly exit: (code: number) => never;
}

const defaultRunAdminDeps: RunAdminDeps = {
  getPaths: getCliPlatformPaths,
  readGatewayState,
  makeClient: (socketPath) => new IPCClient(socketPath),
  writeErr: (s) => void process.stderr.write(s),
  exit: (code) => process.exit(code),
};

export async function runAdmin(
  argv: string[],
  deps: RunAdminDeps = defaultRunAdminDeps,
): Promise<void> {
  let cmd: AdminCommand;
  try {
    cmd = parseAdminArgs(argv);
  } catch (e) {
    deps.writeErr(`${e instanceof Error ? e.message : String(e)}\n`);
    deps.exit(1);
  }
  const paths = deps.getPaths();
  const demo = paths.demo === true;
  // `console`/`token` are local-only (no gateway round-trip needed); short-circuit before connecting.
  if (cmd.kind === "console" || cmd.kind === "token") {
    await runAdminCommand({ call: () => Promise.reject(new Error("unused")) }, cmd, demo);
    return;
  }
  const state = await deps.readGatewayState(paths);
  if (state === undefined) {
    deps.writeErr(`${gatewayNotRunningMessage(demo)}\n`);
    deps.exit(1);
  }
  const client = deps.makeClient(state.socketPath);
  await client.connect();
  try {
    await runAdminCommand(client, cmd, demo);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
