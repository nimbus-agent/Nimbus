import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import type { Server } from "bun";
import { buildSignedManifest, jsonResponse, makeKeypair } from "./testing/updater-test-fixtures.ts";
import { Updater } from "./updater.ts";

/**
 * The STREAMING half of the download size cap (`Updater.readBodyUnderCap`).
 *
 * A body whose Content-Length is over the cap is refused by the header check before a byte is read
 * — that is the path the S6-F3 case in `updater.test.ts` reaches, because Bun sets Content-Length on
 * a buffered body. Only a body with NO Content-Length (a stream) gets as far as the read loop, so
 * these cases serve one: the refusal must come from the loop, no progress may be reported past the
 * cap, and a body exactly AT the cap must be accepted whole and in order.
 *
 * Chunk boundaries are the transport's to choose (a slow runner may coalesce two writes into one
 * read), so nothing here pins how many reads happen — only what the cap guarantees for any of them.
 */

const kp = makeKeypair();
const CHUNK = 512;
const CAP = 2 * CHUNK;

let downloadServer: Server<undefined> | undefined;
let manifestServer: Server<undefined> | undefined;

afterEach(async () => {
  await downloadServer?.stop(true);
  await manifestServer?.stop(true);
  downloadServer = undefined;
  manifestServer = undefined;
});

/** Chunk `n` (1-based) is CHUNK bytes of the value `n`, so a dropped or reordered chunk is visible. */
function chunkBytes(n: number): Uint8Array {
  return new Uint8Array(CHUNK).fill(n);
}

function concatChunks(count: number): Uint8Array {
  const out = new Uint8Array(count * CHUNK);
  for (let n = 1; n <= count; n++) out.set(chunkBytes(n), (n - 1) * CHUNK);
  return out;
}

/**
 * Serves `count` chunks as a stream — no Content-Length, so the header check passes and only the
 * read loop can stop it — plus a manifest signed over exactly those bytes. Returns the manifest URL.
 */
function startStreamingRelease(count: number): string {
  const assets = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      let sent = 0;
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          if (sent >= count) {
            controller.close();
            return;
          }
          sent += 1;
          controller.enqueue(chunkBytes(sent));
          await Bun.sleep(2);
        },
      });
      return new Response(body, { headers: { "content-type": "application/octet-stream" } });
    },
  });
  downloadServer = assets;
  const manifest = buildSignedManifest(
    concatChunks(count),
    kp,
    `http://127.0.0.1:${String(assets.port)}/bin`,
    "0.2.0",
  );
  const manifests = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => jsonResponse(manifest),
  });
  manifestServer = manifests;
  return `http://127.0.0.1:${String(manifests.port)}/latest.json`;
}

type Emitted = { name: string; payload: Record<string, unknown> | undefined };

function streamingUpdater(
  manifestUrl: string,
  emitted: Emitted[],
  onInstall: (bytes: Uint8Array) => void = () => {},
): Updater {
  return new Updater({
    currentVersion: "0.1.0",
    manifestUrl,
    publicKey: kp.publicKey,
    target: "linux-x86_64",
    emit: (name, payload) => {
      emitted.push({ name, payload });
    },
    invokeInstaller: (binaryPath) => {
      onInstall(new Uint8Array(readFileSync(binaryPath)));
      return Promise.resolve();
    },
    timeoutMs: 2000,
    maxDownloadBytes: CAP,
  });
}

function progressBytes(emitted: readonly Emitted[]): number[] {
  return emitted
    .filter((e) => e.name === "updater.downloadProgress")
    .map((e) => Number(e.payload?.["bytes"]));
}

describe("Updater download cap — streamed body with no Content-Length", () => {
  test("a stream over the cap is refused by the read loop, with no progress reported past the cap", async () => {
    const emitted: Emitted[] = [];
    let installed = false;
    const u = streamingUpdater(startStreamingRelease(4), emitted, () => {
      installed = true;
    });
    await u.checkNow();

    // "Download body …" is the read loop's refusal; the header check words it differently.
    await expect(u.applyUpdate()).rejects.toThrow(
      /^Download body exceeds size cap of 1024 bytes \(read \d+\)$/,
    );
    const read = Number(/\(read (\d+)\)/.exec(u.getStatus().lastError ?? "")?.[1]);
    expect(read).toBeGreaterThan(CAP);
    expect(read).toBeLessThanOrEqual(4 * CHUNK);

    // The over-cap read is neither kept nor reported, and nothing was installed.
    for (const bytes of progressBytes(emitted)) expect(bytes).toBeLessThanOrEqual(CAP);
    expect(emitted.map((e) => e.name)).toContain("updater.rolledBack");
    expect(emitted.map((e) => e.name)).not.toContain("updater.restarting");
    expect(installed).toBe(false);
    expect(u.getStatus().state).toBe("failed");
  });

  test("a stream exactly AT the cap is accepted and arrives whole, in order", async () => {
    const emitted: Emitted[] = [];
    let installedBytes: Uint8Array | undefined;
    const u = streamingUpdater(startStreamingRelease(2), emitted, (bytes) => {
      installedBytes = bytes;
    });
    await u.checkNow();
    await u.applyUpdate();

    expect(installedBytes).toEqual(concatChunks(2));
    expect(progressBytes(emitted).at(-1)).toBe(CAP);
    expect(emitted.map((e) => e.name)).toContain("updater.restarting");
  });
});
