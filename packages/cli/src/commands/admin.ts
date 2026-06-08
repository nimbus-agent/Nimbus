import { IPCClient } from "../ipc-client/index.ts";
import { readGatewayState } from "../lib/gateway-process.ts";
import { getCliPlatformPaths } from "../paths.ts";

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
export async function runAdminCommand(client: AdminIpc, cmd: AdminCommand): Promise<void> {
  switch (cmd.kind) {
    case "status": {
      const r = await client.call<unknown>("admin.status", {});
      process.stdout.write(`${JSON.stringify(r, null, 2)}\n`);
      break;
    }
    case "console": {
      process.stdout.write(
        `Admin console: ${readSurfaceBaseUrl()}/admin#token=$(nimbus vault get ${ADMIN_TOKEN_VAULT_KEY})\n` +
          `Resolve the bearer with: nimbus vault get ${ADMIN_TOKEN_VAULT_KEY}\n` +
          `then open ${readSurfaceBaseUrl()}/admin#token=<bearer> in a browser.\n`,
      );
      break;
    }
    case "token": {
      process.stdout.write(
        `The read-surface bearer is the Vault value ${ADMIN_TOKEN_VAULT_KEY}.\n` +
          `Print it with: nimbus vault get ${ADMIN_TOKEN_VAULT_KEY}\n`,
      );
      break;
    }
  }
}

export async function runAdmin(argv: string[]): Promise<void> {
  let cmd: AdminCommand;
  try {
    cmd = parseAdminArgs(argv);
  } catch (e) {
    process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
  // `console`/`token` are local-only (no gateway round-trip needed); short-circuit before connecting.
  if (cmd.kind === "console" || cmd.kind === "token") {
    await runAdminCommand({ call: () => Promise.reject(new Error("unused")) }, cmd);
    return;
  }
  const state = await readGatewayState(getCliPlatformPaths());
  if (state === undefined) {
    process.stderr.write("Gateway is not running. Start with: nimbus start\n");
    process.exit(1);
  }
  const client = new IPCClient(state.socketPath);
  await client.connect();
  try {
    await runAdminCommand(client, cmd);
  } finally {
    await client.disconnect().catch(() => {});
  }
}
