/**
 * The initiator half of a v2 pairing (invariant I56, Phase 10 FS2): `Noise_XXpsk0` keyed by the
 * pairing code the owner read off the host (`lan-pair-session.ts`). The code is checked for format
 * BEFORE any network activity (D-FS-16) and never sent. There is deliberately NO fallback to the
 * plaintext v1 `pair` frame: an attacker who can drop the v2 attempt must not be handed the code.
 */
import type { Socket } from "bun";
import type { BoxKeypair } from "./lan-crypto.ts";
import { createPairInitiator } from "./lan-pair-session.ts";
import { assertPairingCodeFormat, derivePairingPsk } from "./lan-pairing.ts";
import {
  DEFAULT_TIMEOUT_MS,
  flushWriter,
  MAX_HANDSHAKE_FRAME,
  makeFrameReader,
  writeFrame,
} from "./lan-wire.ts";

/** The text a wrong or expired code, or a peer that cannot pair over v2, produces (it is silent). */
export const PAIR_NO_REPLY_HINT =
  "lan-client: pairing failed: no reply. The code may be wrong or expired, or the peer may run a Nimbus version without v2 pairing (upgrade it); the code is never sent";

/**
 * Pairs with the host at `host:port` using `code`; resolves with the host's static public key once
 * the host's first transport record (`pair_ok`) opened. The caller persists the host only then.
 */
export async function outboundPairHandshake(
  host: string,
  port: number,
  code: string,
  selfKp: BoxKeypair,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  opts: { generateEphemeral?: (() => BoxKeypair) | undefined } = {},
): Promise<Uint8Array> {
  assertPairingCodeFormat(code);
  const psk = derivePairingPsk(code);
  const initiator = createPairInitiator({
    s: selfKp,
    psk,
    generateEphemeral: opts.generateEphemeral,
  });
  psk.fill(0);
  return await new Promise<Uint8Array>((resolve, reject) => {
    const reader = makeFrameReader(MAX_HANDSHAKE_FRAME);
    /** Set when message 2 opened: the transport session and the host's static key. */
    let established:
      | Pick<ReturnType<typeof initiator.finish>, "session" | "hostStatic">
      | undefined;
    let settled = false;
    let conn: Socket<undefined> | undefined;
    let closed = false;
    const finish = (key: Uint8Array | undefined, err?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // A socket the peer already closed is not ended again (from inside its own close handler).
      if (!closed) conn?.end();
      if (err) reject(err);
      else if (key) resolve(key);
      else reject(new Error(PAIR_NO_REPLY_HINT));
    };
    const timer = setTimeout(
      () => finish(undefined, new Error("lan-client: pairing timeout")),
      timeoutMs,
    );
    const step = (socket: Socket<undefined>, frame: Uint8Array): void => {
      if (established === undefined) {
        const done = initiator.finish(frame);
        established = { session: done.session, hostStatic: done.hostStatic };
        writeFrame(socket, done.message3);
        return;
      }
      const message = established.session.openRecord(frame);
      // A multi-record message (never sent for pair_ok) would be completed by a later record.
      if (message === undefined) return;
      const reply = JSON.parse(new TextDecoder().decode(message)) as { kind?: unknown };
      if (reply.kind !== "pair_ok") throw new Error("lan-client: pairing rejected");
      finish(established.hostStatic);
    };
    Bun.connect<undefined>({
      hostname: host,
      port,
      socket: {
        open(socket) {
          conn = socket;
          if (settled) {
            socket.end();
            return;
          }
          writeFrame(socket, initiator.firstFrameBody);
        },
        data(socket, chunk) {
          if (settled) return;
          reader.push(chunk);
          try {
            for (let frame = reader.next(); frame !== undefined; frame = reader.next()) {
              step(socket, frame);
            }
          } catch (e) {
            finish(undefined, e as Error);
          }
        },
        drain(socket) {
          flushWriter(socket);
        },
        close() {
          closed = true;
          finish(undefined);
        },
        error(_s, e) {
          closed = true;
          finish(undefined, e);
        },
      },
    }).catch((e: unknown) => finish(undefined, e as Error));
  });
}
