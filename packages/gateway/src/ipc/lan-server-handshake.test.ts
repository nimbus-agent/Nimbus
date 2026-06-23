import { afterEach, describe, expect, test } from "bun:test";
import { type BoxKeypair, generateBoxKeypair } from "./lan-crypto.ts";
import { LanServer, type LanServerOptions } from "./lan-server.ts";

let server: LanServer | undefined;

afterEach(async () => {
  await server?.stop();
  server = undefined;
});

type RateLimitCalls = { failures: string[]; allowed: boolean };

function makeRateLimit(calls: RateLimitCalls): LanServerOptions["rateLimit"] {
  return {
    checkAllowed: () => calls.allowed,
    recordFailure: (ip) => calls.failures.push(ip),
    recordSuccess: () => {},
  };
}

async function startServer(
  rate: LanServerOptions["rateLimit"],
  hostKp: BoxKeypair,
  isKnown: LanServerOptions["isKnownPeer"] = () => null,
): Promise<{ port: number }> {
  server = new LanServer({
    bind: "127.0.0.1",
    port: 0,
    hostKeypair: hostKp,
    onMessage: async () => ({}),
    isKnownPeer: isKnown,
    rateLimit: rate,
    pairing: {
      isOpen: () => false,
      consume: () => false,
      open: () => {},
      close: () => {},
      getExpiresAt: () => undefined,
    },
    registerPeer: () => "peer-id",
  });
  await server.start();
  const addr = server.listenAddr();
  if (!addr) throw new Error("server.start did not produce a listen address");
  return { port: addr.port };
}

function sendHandshake(
  port: number,
  kind: "hello" | "pair",
  clientPubkey: Uint8Array,
): Promise<{ kind?: string } | null> {
  const msg = JSON.stringify({
    kind,
    client_pubkey: Buffer.from(clientPubkey).toString("base64"),
  });
  const bytes = new TextEncoder().encode(msg);
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, bytes.length, false);

  return new Promise((resolve) => {
    let received: Uint8Array = new Uint8Array(0);
    const conn = Bun.connect({
      hostname: "127.0.0.1",
      port,
      socket: {
        open(socket) {
          socket.write(header);
          socket.write(bytes);
        },
        data(_socket, chunk) {
          const merged = new Uint8Array(received.length + chunk.length);
          merged.set(received, 0);
          merged.set(chunk, received.length);
          received = merged;
        },
        close() {
          if (received.length < 4) {
            resolve(null);
            return;
          }
          const view = new DataView(received.buffer, received.byteOffset, received.byteLength);
          const len = view.getUint32(0, false);
          const body = received.slice(4, 4 + len);
          try {
            const parsed = JSON.parse(new TextDecoder().decode(body)) as { kind?: string };
            resolve(parsed);
          } catch {
            resolve(null);
          }
        },
      },
    });
    setTimeout(() => {
      try {
        conn.then((s) => s.end()).catch(() => {});
      } catch {
        /* ignore */
      }
      resolve(null);
    }, 2_000);
  });
}

describe("LanServer.handleHandshake — S3-F4 / S3-F6", () => {
  test("S3-F4 — hello with unknown pubkey records a rate-limit failure and replies hello_err", async () => {
    const calls: RateLimitCalls = { failures: [], allowed: true };
    const hostKp = generateBoxKeypair();
    const { port } = await startServer(makeRateLimit(calls), hostKp);
    const reply = await sendHandshake(port, "hello", new Uint8Array(32).fill(7));
    expect(reply?.kind).toBe("hello_err");
    expect(calls.failures).toHaveLength(1);
    expect(calls.failures[0]).toBe("127.0.0.1");
  });

  test("S3-F6 — locked-out hello receives hello_err (not pair_err)", async () => {
    const calls: RateLimitCalls = { failures: [], allowed: false };
    const hostKp = generateBoxKeypair();
    const { port } = await startServer(makeRateLimit(calls), hostKp);
    const reply = await sendHandshake(port, "hello", new Uint8Array(32).fill(7));
    expect(reply?.kind).toBe("hello_err");
    expect(calls.failures).toHaveLength(0);
  });

  test("S3-F6 — locked-out pair receives pair_err (not hello_err)", async () => {
    const calls: RateLimitCalls = { failures: [], allowed: false };
    const hostKp = generateBoxKeypair();
    const { port } = await startServer(makeRateLimit(calls), hostKp);
    const reply = await sendHandshake(port, "pair", new Uint8Array(32).fill(7));
    expect(reply?.kind).toBe("pair_err");
  });
});
