import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import {
  formatNotificationsStatus,
  formatNotificationsTest,
  parseNotificationsStatus,
  parseNotificationsTest,
} from "./notifications-format.ts";

const USAGE = "usage: nimbus notifications status|test [--json]";

/** Registered in COMMAND_HANDLERS; matches the `(args: string[])` CommandHandler signature. */
export async function runNotificationsCmd(args: string[]): Promise<void> {
  const sub = args[0];
  if (sub !== "status" && sub !== "test") {
    throw new Error(USAGE);
  }
  await withGatewayIpc((c) => runNotifications(c, args));
}

/**
 * `nimbus notifications status` — backend, config and probe result (`notifications.status`).
 * `nimbus notifications test`   — raise one fixed-text toast (`notifications.test`). An undelivered
 * toast is printed with its reason and sets exit code 1; it is not a gateway error.
 *
 * Exported separately so unit tests drive it with a fake `IPCClient` (DI, never `mock.module`).
 */
export async function runNotifications(client: IPCClient, args: string[]): Promise<void> {
  const sub = args[0];
  const json = args.includes("--json");
  if (sub === "status") {
    const status = parseNotificationsStatus(await client.call<unknown>("notifications.status", {}));
    process.stdout.write(
      json ? `${JSON.stringify(status, undefined, 2)}\n` : formatNotificationsStatus(status),
    );
    return;
  }
  if (sub === "test") {
    const result = parseNotificationsTest(await client.call<unknown>("notifications.test", {}));
    process.stdout.write(
      json ? `${JSON.stringify(result, undefined, 2)}\n` : formatNotificationsTest(result),
    );
    if (!result.delivered) process.exitCode = 1;
    return;
  }
  throw new Error(USAGE);
}
