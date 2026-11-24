import type { Logger } from "pino";
import { createGatewayPinoLogger } from "../gateway-log-file.ts";

/** At most one log line per peer address per this long, so a retrying old peer cannot fill the log. */
export const OLD_WIRE_NOTICE_INTERVAL_MS = 3_600_000;

export interface OldWireNotices {
  /** `LanServer`'s `onOldWireRefused`: names the address of a peer that opened the removed v1 wire. */
  refused: (peerIp: string) => void;
}

/**
 * The owner-facing text for the removed v1 LAN wire (LAN forward secrecy, slice FS3). The server
 * cannot answer such a peer (a reply would tell a prober which side said no), so the gateway log is
 * where the owner learns which machine to upgrade. Built lazily: no log file is opened until a notice
 * is due.
 *
 * `ignoredMinProtocol` is true when `nimbus.toml` still says `[lan] min_protocol = 1`; that value
 * asked for the old wire, which no longer exists, so it is ignored and named once here.
 */
export function oldWireNotices(
  logDir: string,
  ignoredMinProtocol: boolean,
  deps: { logger?: () => Pick<Logger, "warn">; nowMs?: () => number } = {},
): OldWireNotices {
  let logger: Pick<Logger, "warn"> | undefined;
  const log = (): Pick<Logger, "warn"> => {
    logger ??= (deps.logger ?? (() => createGatewayPinoLogger(logDir)))();
    return logger;
  };
  const now = deps.nowMs ?? (() => Date.now());
  if (ignoredMinProtocol) {
    log().warn(
      "[lan] min_protocol = 1 is ignored: the old v1 LAN wire was removed, so only protocol 2 exists. Delete the line.",
    );
  }
  const lastByIp = new Map<string, number>();
  return {
    refused: (peerIp) => {
      const t = now();
      const last = lastByIp.get(peerIp);
      if (last !== undefined && t - last < OLD_WIRE_NOTICE_INTERVAL_MS) return;
      lastByIp.set(peerIp, t);
      log().warn(
        `LAN: refused a connection from ${peerIp} that speaks the removed v1 wire (a paired machine on a version from before LAN forward secrecy). Upgrade that machine to this release or newer; until then it cannot federate with this one.`,
      );
    },
  };
}
