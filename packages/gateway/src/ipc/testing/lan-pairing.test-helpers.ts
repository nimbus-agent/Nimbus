/**
 * Test-only scenarios for the pairing half of invariant I56 (Phase 10 FS2), shared by
 * `lan-pair.test.ts` and the invariant block in `security-invariants/i56-lan-noise-session.test.ts`
 * so the two run the SAME code. Each builds its own `LanServer` with a real `PairingWindow`.
 */
import { generateBoxKeypair } from "../lan-crypto.ts";
import { x25519PublicKey } from "../lan-noise.ts";
import { outboundPairHandshake } from "../lan-pair-client.ts";
import { createPairInitiator } from "../lan-pair-session.ts";
import { derivePairingPsk, generatePairingCode, PairingWindow } from "../lan-pairing.ts";
import { LanServer, type LanServerOptions } from "../lan-server.ts";
import { startRecordingProxy } from "./lan-forward-secrecy.test-helpers.ts";
import { connectRaw } from "./lan-v2.test-helpers.ts";
import { fakePairing } from "./pairing-fakes.ts";

export interface PairingHarness {
  port: number;
  host: ReturnType<typeof generateBoxKeypair>;
  window: PairingWindow;
  failures: string[];
  successes: string[];
  registered: Array<{ pubkey: Uint8Array; protoVersion: 1 | 2 | undefined }>;
  stop(): Promise<void>;
}

/** A `LanServer` whose pairing service is a real `PairingWindow`; `registerPeer` and the limiter are spies. */
export async function startPairingHarness(
  opts: Partial<LanServerOptions> = {},
): Promise<PairingHarness> {
  const window = new PairingWindow(60_000);
  const host = generateBoxKeypair();
  const failures: string[] = [];
  const successes: string[] = [];
  const registered: PairingHarness["registered"] = [];
  const server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: host,
    onMessage: async () => ({}),
    isKnownPeer: () => null,
    registerPeer: (pubkey, _ip, protoVersion) => {
      registered.push({ pubkey, protoVersion });
      return "peer:test";
    },
    rateLimit: {
      checkAllowed: () => true,
      recordFailure: (ip) => failures.push(ip),
      recordSuccess: (ip) => successes.push(ip),
    },
    pairing: fakePairing({
      isOpen: () => window.isOpen(),
      currentPsk: () => window.currentPsk(),
      consumeOpen: () => window.consumeOpen(),
    }),
    ...opts,
  });
  await server.start();
  const addr = server.listenAddr();
  if (!addr) throw new Error("no addr");
  return {
    port: addr.port,
    host,
    window,
    failures,
    successes,
    registered,
    stop: async () => {
      // Let sockets the test already closed finish closing before their listener is stopped.
      await new Promise((r) => setTimeout(r, 25));
      await server.stop();
    },
  };
}

const contains = (haystack: Uint8Array, needle: Uint8Array): boolean =>
  Buffer.from(haystack).includes(Buffer.from(needle));

export interface RecordedPairing {
  /** The code, the PSK and either static public key appear in the recorded bytes (all must be false). */
  wireHasCode: boolean;
  wireHasPsk: boolean;
  wireHasInitiatorStatic: boolean;
  wireHasHostStatic: boolean;
  /** How many of the attacker's tries (both static secrets, the PSK, a fresh ephemeral) opened message 2. */
  attackerOpened: number;
  /** The positive control: the same routine given the initiator's real ephemeral secret opens message 2 and the `pair_ok` record. */
  controlOpened: boolean;
}

/**
 * FS-A1 for pairing: record a real pairing through a proxy, then hand an attacker both static
 * secrets, the PSK and the whole transcript. It must not open anything; given the initiator's
 * ephemeral secret (the control) the same routine opens everything, so a bug in it cannot pass.
 */
export async function recordPairingScenario(): Promise<RecordedPairing> {
  const h = await startPairingHarness();
  const proxy = startRecordingProxy(h.port);
  try {
    const code = generatePairingCode();
    h.window.open(code);
    const initiator = generateBoxKeypair();
    const secret = crypto.getRandomValues(new Uint8Array(32));
    const ephemeral = () => ({ publicKey: x25519PublicKey(secret), secretKey: secret.slice() });
    await outboundPairHandshake("127.0.0.1", proxy.port, code, initiator, 5_000, {
      generateEphemeral: ephemeral,
    });
    const rec = proxy.connections[0];
    const frames = [...(rec?.c2s ?? []), ...(rec?.s2c ?? [])];
    const wire = new Uint8Array(Buffer.concat(frames));
    const message2 = rec?.s2c[0] as Uint8Array;
    const pairOk = rec?.s2c[1] as Uint8Array;
    const psk = derivePairingPsk(code);

    let attackerOpened = 0;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        createPairInitiator({ s: initiator, psk: psk.slice() }).finish(message2);
        attackerOpened += 1;
      } catch {
        // expected
      }
    }
    let controlOpened = false;
    try {
      const control = createPairInitiator({
        s: initiator,
        psk: psk.slice(),
        generateEphemeral: ephemeral,
      });
      const session = control.finish(message2).session;
      controlOpened = session.openRecord(pairOk) !== undefined;
    } catch {
      controlOpened = false;
    }
    return {
      wireHasCode: contains(wire, new TextEncoder().encode(code)),
      wireHasPsk: contains(wire, psk),
      wireHasInitiatorStatic: contains(wire, initiator.publicKey),
      wireHasHostStatic: contains(wire, h.host.publicKey),
      attackerOpened,
      controlOpened,
    };
  } finally {
    proxy.stop();
    await h.stop();
  }
}

export interface WrongCodeOutcome {
  bytesReceived: number;
  closed: boolean;
  failures: number;
  windowStillOpen: boolean;
  rightCodeThenPaired: boolean;
}

/** A wrong code fails at MESSAGE 1: no reply, one counted failure, the window stays open for the right code. */
export async function wrongCodeScenario(): Promise<WrongCodeOutcome> {
  const h = await startPairingHarness();
  try {
    const code = generatePairingCode();
    h.window.open(code);
    const raw = await connectRaw(h.port);
    const wrong = createPairInitiator({
      s: generateBoxKeypair(),
      psk: derivePairingPsk(generatePairingCode()),
    });
    raw.writeFrame(wrong.firstFrameBody);
    const closed = await raw.closed(1_000);
    const bytesReceived = raw.received().length;
    const failures = h.failures.length;
    const windowStillOpen = h.window.isOpen();
    await outboundPairHandshake("127.0.0.1", h.port, code, generateBoxKeypair());
    return {
      bytesReceived,
      closed,
      failures,
      windowStillOpen,
      rightCodeThenPaired: h.registered.length === 1 && h.registered[0]?.protoVersion === 2,
    };
  } finally {
    await h.stop();
  }
}

export interface OldPairOutcome {
  closed: boolean;
  bytesReceived: number;
  windowStillOpen: boolean;
  registered: number;
}

/** The removed plaintext `pair` frame (FS3) gets no reply, consumes nothing and registers nothing. */
export async function oldPairFrameScenario(): Promise<OldPairOutcome> {
  const h = await startPairingHarness();
  try {
    const code = generatePairingCode();
    h.window.open(code);
    const raw = await connectRaw(h.port);
    const frame = new TextEncoder().encode(
      JSON.stringify({
        kind: "pair",
        client_pubkey: Buffer.from(generateBoxKeypair().publicKey).toString("base64"),
        pairing_code: code,
      }),
    );
    raw.writeFrame(frame);
    const closed = await raw.closed(1_000);
    return {
      closed,
      bytesReceived: raw.received().length,
      windowStillOpen: h.window.isOpen(),
      registered: h.registered.length,
    };
  } finally {
    await h.stop();
  }
}
