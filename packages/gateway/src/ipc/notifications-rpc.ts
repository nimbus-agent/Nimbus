/**
 * `notifications.*` — the OS-notification (toast) surface behind `nimbus notifications` and the
 * `nimbus doctor` notifications line (pre-S3 item E).
 *
 *   - `notifications.status` → `NotificationsStatus` (awaits the backend probe, which never rejects).
 *   - `notifications.test`   → `NotificationsTestResult`: `{ delivered: true, status }` or
 *     `{ delivered: false, reason, status }`. A toast that could not be shown is an ANSWER, not a
 *     JSON-RPC error — the caller asked "do notifications work here?". The toast is fixed text and
 *     goes through the real service, rate limit and `content = "title_only"` included.
 *
 * CLI-only: the whole namespace is LAN-forbidden (I5, `ipc/lan-rpc.ts` — `checkLanMethodAllowed` is a
 * DENYLIST, so it had to be added) and absent from the Tauri allowlist (I7). A LAN peer has no
 * business raising toasts on this machine's desktop, nor learning whether its owner can see them.
 * Neither method takes parameters; anything passed is ignored.
 */
import type { NotificationsRuntime } from "../platform/notifications/notifications-runtime.ts";
import { dispatchByMethod, type RpcMissOrHit } from "./_lib/dispatch-by-method.ts";

export interface NotificationsRpcCtx {
  readonly runtime: Pick<NotificationsRuntime, "ready" | "test">;
}

export async function dispatchNotificationsRpc(
  method: string,
  params: unknown,
  ctx: NotificationsRpcCtx,
): Promise<RpcMissOrHit> {
  return dispatchByMethod<NotificationsRpcCtx, unknown>(method, params, ctx, {
    "notifications.status": (_p, c) => c.runtime.ready(),
    "notifications.test": (_p, c) => c.runtime.test(),
  });
}
