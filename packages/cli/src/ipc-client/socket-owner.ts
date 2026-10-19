import { lstatSync } from "node:fs";

/** Thrown before any byte is sent when the gateway socket belongs to another user. */
export class ForeignSocketOwnerError extends Error {
  constructor(
    readonly socketPath: string,
    readonly ownerUid: number,
    readonly ourUid: number,
  ) {
    super(
      `ERR_GATEWAY_SOCKET_FOREIGN_OWNER: the Gateway socket ${socketPath} is owned by uid ` +
        `${String(ownerUid)}, not by you (uid ${String(ourUid)}). Nimbus will not connect to it, ` +
        "because a listener another user created there would receive everything this command " +
        "sends, secrets included. Stop whatever owns it, or set XDG_RUNTIME_DIR (or " +
        "NIMBUS_GATEWAY_SOCKET) to a directory only you can write.",
    );
    this.name = "ForeignSocketOwnerError";
  }
}

type LstatLike = (path: string) => { uid: number; isSocket(): boolean };

/**
 * Refuse a Unix socket that another user owns.
 *
 * With `XDG_RUNTIME_DIR` unset (a headless box, `su` without a login session) the default socket
 * is `/tmp/nimbus-gateway.sock`, a path every local account can create first. A gateway can only
 * create its socket as itself, so a socket owned by anyone else was not made by your gateway, and
 * `nimbus vault set` or `connector auth --token` would hand that user the secret. The check costs
 * one `lstat` and runs before the connection opens.
 *
 * A missing path, or one that is not a socket, is left for the connect to report as it always
 * has. Windows has no uid; named pipes are a separate gap (see `docs/audits/2026-10-19-code-audit.md`
 * S4).
 */
export function assertSocketOwnedByCurrentUser(
  socketPath: string,
  deps: { platform?: NodeJS.Platform; getuid?: () => number; lstat?: LstatLike } = {},
): void {
  const platform = deps.platform ?? process.platform;
  if (platform === "win32") return;
  const getuid = deps.getuid ?? process.getuid?.bind(process);
  if (getuid === undefined) return;
  let st: { uid: number; isSocket(): boolean };
  try {
    st = (deps.lstat ?? lstatSync)(socketPath);
  } catch {
    return;
  }
  if (!st.isSocket()) return;
  const ours = getuid();
  if (st.uid !== ours) throw new ForeignSocketOwnerError(socketPath, st.uid, ours);
}
