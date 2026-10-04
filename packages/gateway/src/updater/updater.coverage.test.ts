/**
 * `Updater` refusals `updater.test.ts` does not reach: a release that publishes no asset for this
 * target, a binary whose hash matches but whose signature does not, failures that surface as
 * non-Error values (from an emit listener), a download response with no body, and the short
 * current-version forms `semverGreater` pads.
 *
 * Releases are served from loopback `Bun.serve` instances. Two cases need a response shape no real
 * server produces (a null body; an empty read), and stub `globalThis.fetch` for that one test only.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Server } from "bun";
import { requestUrlString } from "../testing/bun-test-support.ts";
import { buildSignedManifest, jsonResponse, makeKeypair } from "./testing/updater-test-fixtures.ts";
import type { PlatformTarget, UpdateManifest } from "./types.ts";
import { type UpdateEventPhase, Updater, type UpdaterOptions } from "./updater.ts";

const kp = makeKeypair();
const servers: Array<Server<undefined>> = [];

afterEach(async () => {
  for (const s of servers.splice(0)) await s.stop(true);
});

/** Serves `bytes` and counts how many times it was asked for them. */
function serveBytes(bytes: Uint8Array): { url: string; hits: () => number } {
  let hits = 0;
  const s = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => {
      hits += 1;
      return new Response(bytes);
    },
  });
  servers.push(s);
  return { url: `http://127.0.0.1:${s.port}/bin`, hits: () => hits };
}

function serveManifest(m: UpdateManifest): string {
  const s = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => jsonResponse(m) });
  servers.push(s);
  return `http://127.0.0.1:${s.port}/latest.json`;
}

type Recorder = {
  events: Array<[string, Record<string, unknown> | undefined]>;
  phases: Array<[UpdateEventPhase, Record<string, unknown>]>;
  installs: string[];
};

function makeUpdater(
  manifestUrl: string,
  overrides: Partial<UpdaterOptions> = {},
): { u: Updater; rec: Recorder } {
  const rec: Recorder = { events: [], phases: [], installs: [] };
  const u = new Updater({
    currentVersion: "0.1.0",
    manifestUrl,
    publicKey: kp.publicKey,
    target: "linux-x86_64",
    timeoutMs: 5_000,
    emit: (name, payload) => {
      rec.events.push([name, payload]);
    },
    recordUpdateEvent: (phase, payload) => {
      rec.phases.push([phase, payload]);
    },
    invokeInstaller: async (path) => {
      rec.installs.push(path);
    },
    ...overrides,
  });
  return { u, rec };
}

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (err) {
    return err;
  }
  throw new Error("expected a rejection");
}

describe("Updater — refusals before or during verification", () => {
  test("a release with no asset for this target is refused before any download or audit phase", async () => {
    const binary = new Uint8Array(randomBytes(64));
    const asset = serveBytes(binary);
    const { u, rec } = makeUpdater(serveManifest(buildSignedManifest(binary, kp, asset.url)), {
      target: "freebsd-x86_64" as PlatformTarget,
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow("no asset for target freebsd-x86_64");
    expect(asset.hits()).toBe(0);
    expect(rec.phases).toEqual([]);
    expect(rec.installs).toEqual([]);
    expect(rec.events.map(([name]) => name)).toEqual(["updater.updateAvailable"]);
  });

  test("a correct hash signed by an untrusted key is refused as signature_invalid", async () => {
    const binary = new Uint8Array(randomBytes(256));
    const asset = serveBytes(binary);
    const stranger = makeKeypair();
    const { u, rec } = makeUpdater(
      serveManifest(buildSignedManifest(binary, stranger, asset.url, "0.2.0")),
    );
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow("Ed25519 signature verification failed");
    expect(rec.installs).toEqual([]);
    expect(rec.events.filter(([name]) => name !== "updater.downloadProgress")).toEqual([
      ["updater.updateAvailable", { version: "0.2.0" }],
      ["updater.verifyFailed", { reason: "signature_invalid" }],
      ["updater.rolledBack", { reason: "signature_invalid" }],
    ]);
    expect(rec.phases.map(([phase]) => phase)).toEqual([
      "system.update.start",
      "system.update.failed",
    ]);
    expect(rec.phases[1]?.[1]).toEqual({ toVersion: "0.2.0", reason: "signature_invalid" });
    expect(u.getStatus().state).toBe("rolled_back");
  });
});

describe("Updater — non-Error failures", () => {
  test("an updateAvailable listener that throws a non-Error fails the check, recorded as its string", async () => {
    const binary = new Uint8Array(randomBytes(32));
    const { u } = makeUpdater(
      serveManifest(buildSignedManifest(binary, kp, "https://example/bin", "0.2.0")),
      {
        emit: (name) => {
          if (name === "updater.updateAvailable") throw "listener exploded";
        },
      },
    );
    expect(await rejection(u.checkNow())).toBe("listener exploded");
    const status = u.getStatus();
    expect(status.state).toBe("failed");
    expect(status.lastError).toBe("listener exploded");
  });

  test("a non-Error raised while downloading is a download_failed, recorded as its string", async () => {
    const binary = new Uint8Array(randomBytes(128));
    const asset = serveBytes(binary);
    const events: string[] = [];
    const phases: Array<[UpdateEventPhase, Record<string, unknown>]> = [];
    const { u } = makeUpdater(serveManifest(buildSignedManifest(binary, kp, asset.url, "0.2.0")), {
      emit: (name, payload) => {
        events.push(
          `${name}${payload?.["reason"] === undefined ? "" : `:${String(payload["reason"])}`}`,
        );
        if (name === "updater.downloadProgress") throw "progress sink closed";
      },
      recordUpdateEvent: (phase, payload) => {
        phases.push([phase, payload]);
      },
    });
    await u.checkNow();
    expect(await rejection(u.applyUpdate())).toBe("progress sink closed");
    expect(u.getStatus()).toMatchObject({ state: "failed", lastError: "progress sink closed" });
    expect(events).toContain("updater.rolledBack:download_failed");
    expect(phases).toEqual([
      [
        "system.update.start",
        expect.objectContaining({ fromVersion: "0.1.0", toVersion: "0.2.0" }),
      ],
      ["system.update.failed", { toVersion: "0.2.0", reason: "download_failed" }],
    ]);
  });
});

describe("Updater — download bodies a real server never produces", () => {
  /** Stubs global fetch for one test: the manifest is served, the asset answered by `asset`. */
  async function withStubbedFetch(
    manifest: UpdateManifest,
    asset: () => Response,
    run: () => Promise<void>,
  ): Promise<void> {
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: string | URL | Request) =>
      requestUrlString(input).endsWith("/latest.json")
        ? jsonResponse(manifest)
        : asset()) as unknown as typeof fetch;
    try {
      await run();
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("a 2xx response with no body is refused as a download failure", async () => {
    const binary = new Uint8Array(randomBytes(16));
    const manifest = buildSignedManifest(binary, kp, "http://127.0.0.1:9/bin", "0.2.0");
    await withStubbedFetch(
      manifest,
      () => new Response(null, { status: 200 }),
      async () => {
        const { u, rec } = makeUpdater("http://127.0.0.1:9/latest.json");
        await u.checkNow();
        await expect(u.applyUpdate()).rejects.toThrow("No response body from download");
        expect(rec.installs).toEqual([]);
        expect(rec.events).toContainEqual(["updater.rolledBack", { reason: "download_failed" }]);
        expect(u.getStatus().lastError).toBe("No response body from download");
      },
    );
  });

  test("an empty read in the body stream is skipped, not counted as progress", async () => {
    const binary = new Uint8Array([1, 2, 3, 4]);
    const manifest = buildSignedManifest(binary, kp, "http://127.0.0.1:9/bin", "0.2.0");
    const reads: Array<{ done: boolean; value: Uint8Array | undefined }> = [
      { done: false, value: undefined },
      { done: false, value: binary.slice(0, 2) },
      { done: false, value: undefined },
      { done: false, value: binary.slice(2) },
      { done: true, value: undefined },
    ];
    const fakeResponse = {
      ok: true,
      status: 200,
      headers: new Headers({ "content-length": "4" }),
      body: {
        getReader: () => ({
          read: async () => reads.shift() ?? { done: true, value: undefined },
          cancel: async () => {},
        }),
      },
    } as unknown as Response;
    await withStubbedFetch(
      manifest,
      () => fakeResponse,
      async () => {
        const { u, rec } = makeUpdater("http://127.0.0.1:9/latest.json");
        await u.checkNow();
        await u.applyUpdate();
        expect(rec.installs).toHaveLength(1);
        expect(rec.events.filter(([name]) => name === "updater.downloadProgress")).toEqual([
          ["updater.downloadProgress", { bytes: 2, total: 4 }],
          ["updater.downloadProgress", { bytes: 4, total: 4 }],
        ]);
      },
    );
  });
});

describe("Updater — short current versions", () => {
  test("a two-part current version is padded with a zero patch", async () => {
    const binary = new Uint8Array(randomBytes(16));
    const newer = makeUpdater(
      serveManifest(buildSignedManifest(binary, kp, "https://example/bin", "0.1.1")),
      { currentVersion: "0.1" },
    );
    expect((await newer.u.checkNow()).updateAvailable).toBe(true);

    const same = makeUpdater(
      serveManifest(buildSignedManifest(binary, kp, "https://example/bin", "0.2.0")),
      { currentVersion: "0.2" },
    );
    const result = await same.u.checkNow();
    expect(result.updateAvailable).toBe(false);
    expect(same.rec.events).toEqual([]);
    await expect(same.u.applyUpdate()).rejects.toThrow(
      "Manifest version 0.2.0 is not newer than current version 0.2; aborting download",
    );
  });
});
