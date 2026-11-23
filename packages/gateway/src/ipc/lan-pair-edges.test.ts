/**
 * FS2: the edges of the pairing exchange the main suite (`lan-pair.test.ts`) does not reach: the
 * responder's refusals after message 3 and the initiator's connection failures.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { generateBoxKeypair } from "./lan-crypto.ts";
import { outboundPairHandshake, PAIR_NO_REPLY_HINT } from "./lan-pair-client.ts";
import { createPairInitiator } from "./lan-pair-session.ts";
import { derivePairingPsk, generatePairingCode } from "./lan-pairing.ts";
import type { LanServerOptions } from "./lan-server.ts";
import { startPairingHarness } from "./testing/lan-pairing.test-helpers.ts";
import { connectRaw } from "./testing/lan-v2.test-helpers.ts";

const stoppers: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const stop of stoppers.splice(0)) await stop();
});

async function startHarness(opts: Partial<LanServerOptions> = {}) {
  const h = await startPairingHarness(opts);
  stoppers.push(() => h.stop());
  return h;
}

const failureOf = (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => "resolved",
    (e: unknown) => (e as Error).message,
  );

describe("XXpsk0 pairing: the responder's late refusals", () => {
  test("a window that closed between message 1 and message 3 pairs nothing (the race loser)", async () => {
    const h = await startHarness();
    const code = generatePairingCode();
    h.window.open(code);
    const psk = derivePairingPsk(code);
    const i = createPairInitiator({ s: generateBoxKeypair(), psk });
    const raw = await connectRaw(h.port);
    raw.writeFrame(i.firstFrameBody);
    const message2 = await raw.nextFrame(1_000);
    const done = i.finish(message2 as Uint8Array);
    h.window.close(); // another initiator (or the owner) closed it first
    raw.writeFrame(done.message3);
    expect(await raw.closed(500)).toBe(true);
    expect(h.registered).toHaveLength(0);
    expect(h.failures).toHaveLength(1);
  });

  test("a registerPeer that throws sends no pair_ok and the initiator is told nothing", async () => {
    const h = await startHarness({
      registerPeer: () => {
        throw new Error("disk full");
      },
    });
    const code = generatePairingCode();
    h.window.open(code);
    expect(
      await failureOf(
        outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair(), 1_000),
      ),
    ).toContain(PAIR_NO_REPLY_HINT);
  });
});

describe("XXpsk0 pairing: the initiator's connection edges", () => {
  test("a connection refused is reported as the connect error, not as a missing reply", async () => {
    const closed = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open() {}, data() {}, close() {}, error() {} },
    });
    const port = closed.port;
    closed.stop(true);
    const message = await failureOf(
      outboundPairHandshake("127.0.0.1", port, generatePairingCode(), generateBoxKeypair(), 1_000),
    );
    expect(message).not.toBe("resolved");
    expect(message).not.toContain("pairing timeout");
  });

  test("a timeout that fires before the socket opens still ends the exchange once", async () => {
    const silent = Bun.listen({
      hostname: "127.0.0.1",
      port: 0,
      socket: { open() {}, data() {}, close() {}, error() {} },
    });
    stoppers.push(() => silent.stop(true));
    expect(
      await failureOf(
        outboundPairHandshake(
          "127.0.0.1",
          silent.port,
          generatePairingCode(),
          generateBoxKeypair(),
          1,
        ),
      ),
    ).toBe("lan-client: pairing timeout");
  });
});
