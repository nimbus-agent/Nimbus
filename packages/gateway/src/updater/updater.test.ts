import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Server } from "bun";
import { loadUpdaterPublicKey } from "./public-key.ts";
import type { UpdaterEmit, UpdaterOptions } from "./updater.ts";
import { MAX_DOWNLOAD_BYTES, Updater } from "./updater.ts";
import {
  buildEnvelopeSignedManifest,
  buildSignedManifest,
  jsonResponse,
  makeKeypair,
} from "./updater-test-fixtures.ts";

const kp = makeKeypair();

let server: Server<undefined>;
let downloadServer: Server<undefined>;

function makeUpdater(overrides?: Partial<UpdaterOptions>): Updater {
  return new Updater({
    currentVersion: "0.1.0",
    manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
    publicKey: kp.publicKey,
    target: "linux-x86_64",
    emit: () => {},
    timeoutMs: 2000,
    ...overrides,
  });
}

type ManifestBuilder = (
  binary: Uint8Array,
  downloadUrl: string,
) => ReturnType<typeof buildSignedManifest>;

function startManifestAndDownloadServers(
  binary: Uint8Array,
  build: ManifestBuilder = (b, url) => buildSignedManifest(b, kp, url, "0.2.0"),
): void {
  downloadServer = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => new Response(binary),
  });
  const downloadUrl = `http://127.0.0.1:${downloadServer.port}/bin`;
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: () => jsonResponse(build(binary, downloadUrl)),
  });
}

describe("Updater state machine", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("checkNow emits updateAvailable when manifest newer", async () => {
    const binary = new Uint8Array(randomBytes(512));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(binary),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`, "0.2.0"),
        ),
    });
    const events: string[] = [];
    const status = await makeUpdater({ emit: (name) => events.push(name) }).checkNow();
    expect(status.updateAvailable).toBe(true);
    expect(events).toContain("updater.updateAvailable");
  });

  test("checkNow does not emit when versions equal", async () => {
    const binary = new Uint8Array(randomBytes(512));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(binary),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`, "0.1.0"),
        ),
    });
    const events: string[] = [];
    const status = await makeUpdater({ emit: (name) => events.push(name) }).checkNow();
    expect(status.updateAvailable).toBe(false);
    expect(events).not.toContain("updater.updateAvailable");
  });

  test("applyUpdate verifies signature before invoking installer", async () => {
    const binary = new Uint8Array(randomBytes(512));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(binary),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`),
        ),
    });
    const invocations: string[] = [];
    const u = makeUpdater({
      invokeInstaller: async () => {
        invocations.push("install");
      },
    });
    await u.checkNow();
    await u.applyUpdate();
    expect(invocations).toEqual(["install"]);
  });

  test("applyUpdate rejects tampered binary and does not invoke installer", async () => {
    const binary = new Uint8Array(randomBytes(512));
    const tamperedBinary = new Uint8Array(randomBytes(512));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(tamperedBinary),
    });
    const manifest = buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`);
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => jsonResponse(manifest) });
    const invocations: string[] = [];
    const events: string[] = [];
    const u = makeUpdater({
      emit: (name) => events.push(name),
      invokeInstaller: async () => {
        invocations.push("install");
      },
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/signature|hash/i);
    expect(invocations).toEqual([]);
    expect(events).toContain("updater.rolledBack");
  });

  test("applyUpdate emits downloadProgress events during streaming fetch", async () => {
    const progressEvents: Array<{ bytes: number; total: number }> = [];
    const emit = mock((name: Parameters<UpdaterEmit>[0], payload?: Record<string, unknown>) => {
      if (name === "updater.downloadProgress") {
        progressEvents.push(payload as { bytes: number; total: number });
      }
    }) as UpdaterEmit;

    const chunk = new Uint8Array(256);
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        const stream = new ReadableStream({
          start(c) {
            c.enqueue(chunk);
            c.enqueue(chunk);
            c.close();
          },
        });
        return new Response(stream, {
          headers: { "content-length": "512", "content-type": "application/octet-stream" },
        });
      },
    });

    const binary = new Uint8Array(randomBytes(512));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`),
        ),
    });

    const u = makeUpdater({ emit });
    await u.checkNow();

    await u.applyUpdate().catch(() => {});

    expect(progressEvents.length).toBeGreaterThanOrEqual(1);
    expect(typeof progressEvents[0]?.total).toBe("number");
    const last = progressEvents.at(-1)!;
    expect(last.bytes).toBe(512);
  });
});

describe("G5 — production key guard + semver re-check", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("loadUpdaterPublicKey throws in production when NIMBUS_DEV_UPDATER_PUBLIC_KEY is set", () => {
    const prevEnv = process.env["NODE_ENV"];
    const prevKey = process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"];
    process.env["NODE_ENV"] = "production";
    process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = "aHCEta3sioGdbjyRtS0TdSowop//jqaBr3MqDVb7nSc=";
    try {
      expect(() => loadUpdaterPublicKey()).toThrow(/not permitted in production/);
    } finally {
      if (prevEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prevEnv;
      if (prevKey === undefined) delete process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"];
      else process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = prevKey;
    }
  });

  test("loadUpdaterPublicKey works in development when NIMBUS_DEV_UPDATER_PUBLIC_KEY is set", () => {
    const prevEnv = process.env["NODE_ENV"];
    const prevKey = process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"];
    process.env["NODE_ENV"] = "development";
    process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = "aHCEta3sioGdbjyRtS0TdSowop//jqaBr3MqDVb7nSc=";
    try {
      const key = loadUpdaterPublicKey();
      expect(key.length).toBe(32);
    } finally {
      if (prevEnv === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prevEnv;
      if (prevKey === undefined) delete process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"];
      else process.env["NIMBUS_DEV_UPDATER_PUBLIC_KEY"] = prevKey;
    }
  });

  test("applyUpdate throws before download when manifest version equals current", async () => {
    const binary = new Uint8Array(randomBytes(512));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(binary),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`, "0.1.0"),
        ),
    });
    const fetched: string[] = [];
    const updater = makeUpdater({
      currentVersion: "0.1.0",
      invokeInstaller: async () => {
        fetched.push("install");
      },
    });
    await updater.checkNow();
    await expect(updater.applyUpdate()).rejects.toThrow(/not newer than/);
    expect(fetched.length).toBe(0);
  });

  test("applyUpdate throws before download when manifest version is older than current", async () => {
    const binary = new Uint8Array(randomBytes(512));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(binary),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`, "0.1.0"),
        ),
    });
    const installerCalls: string[] = [];
    const updater2 = makeUpdater({
      currentVersion: "0.2.0",
      invokeInstaller: async () => {
        installerCalls.push("install");
      },
    });
    await updater2.checkNow();
    await expect(updater2.applyUpdate()).rejects.toThrow(/not newer than/);
    expect(installerCalls.length).toBe(0);
  });
});

describe("G6 — updater hardening", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("downloadAsset rejects body that exceeds the configured cap (S6-F3)", async () => {
    const binary = new Uint8Array(randomBytes(8 * 1024));
    startManifestAndDownloadServers(binary);
    const u = makeUpdater({ maxDownloadBytes: 1024 });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/exceeds.*size cap/);
  });

  test("MAX_DOWNLOAD_BYTES is the documented 500 MiB ceiling", () => {
    expect(MAX_DOWNLOAD_BYTES).toBe(500 * 1024 * 1024);
  });

  test("manifest-fetcher rejects http://example.com (S6-F4)", async () => {
    const { fetchUpdateManifest } = await import("./manifest-fetcher.ts");
    await expect(
      fetchUpdateManifest("http://example.com/m.json", { timeoutMs: 1000 }),
    ).rejects.toThrow(/https/i);
  });

  test("manifest-fetcher permits http://127.0.0.1 in tests (S6-F4)", async () => {
    const binary = new Uint8Array(randomBytes(64));
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(buildSignedManifest(binary, kp, "https://example.invalid/bin", "0.2.0")),
    });
    const { fetchUpdateManifest } = await import("./manifest-fetcher.ts");
    const m = await fetchUpdateManifest(`http://127.0.0.1:${server.port}/m.json`, {
      timeoutMs: 1000,
    });
    expect(m.version).toBe("0.2.0");
  });

  test("manifest-fetcher rejects http://127.0.0.1 when NODE_ENV=production (S6-F4)", async () => {
    const prev = process.env["NODE_ENV"];
    process.env["NODE_ENV"] = "production";
    try {
      const { fetchUpdateManifest } = await import("./manifest-fetcher.ts");
      await expect(
        fetchUpdateManifest("http://127.0.0.1:65000/m.json", { timeoutMs: 500 }),
      ).rejects.toThrow(/https/i);
    } finally {
      if (prev === undefined) delete process.env["NODE_ENV"];
      else process.env["NODE_ENV"] = prev;
    }
  });

  test("manifest-fetcher rejects malformed semver (S6-F4)", async () => {
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse({
          version: "v0.2",
          pub_date: "2026-05-01T00:00:00Z",
          platforms: {
            "darwin-x86_64": { url: "https://x", sha256: "x".repeat(64), signature: "AA==" },
            "darwin-aarch64": { url: "https://x", sha256: "x".repeat(64), signature: "AA==" },
            "linux-x86_64": { url: "https://x", sha256: "x".repeat(64), signature: "AA==" },
            "windows-x86_64": { url: "https://x", sha256: "x".repeat(64), signature: "AA==" },
          },
        }),
    });
    const { fetchUpdateManifest } = await import("./manifest-fetcher.ts");
    await expect(
      fetchUpdateManifest(`http://127.0.0.1:${server.port}/m.json`, { timeoutMs: 1000 }),
    ).rejects.toThrow(/semver/i);
  });

  test("applyUpdate accepts envelope-signed manifest (S6-F6)", async () => {
    const binary = new Uint8Array(randomBytes(512));
    startManifestAndDownloadServers(binary, (b, url) =>
      buildEnvelopeSignedManifest(b, kp, url, "0.2.0"),
    );
    const events: Array<{ phase: string; envelope?: unknown }> = [];
    const u = makeUpdater({
      recordUpdateEvent: (phase, payload) => events.push({ phase, envelope: payload["envelope"] }),
      invokeInstaller: async () => {},
    });
    await u.checkNow();
    await u.applyUpdate();
    const verified = events.find((e) => e.phase === "system.update.verified");
    expect(verified).toBeDefined();
    expect(verified?.envelope).toBe(true);
  });

  test("applyUpdate emits start + verified + installed audit phases (S6-F7)", async () => {
    const binary = new Uint8Array(randomBytes(512));
    startManifestAndDownloadServers(binary);
    const events: string[] = [];
    const u = makeUpdater({
      recordUpdateEvent: (phase) => events.push(phase),
      invokeInstaller: async () => {},
    });
    await u.checkNow();
    await u.applyUpdate();
    expect(events).toContain("system.update.start");
    expect(events).toContain("system.update.verified");
    expect(events).toContain("system.update.installed");
    expect(events.indexOf("system.update.start")).toBeLessThan(
      events.indexOf("system.update.verified"),
    );
  });

  test("applyUpdate emits failed audit phase when installer throws (S6-F7)", async () => {
    const binary = new Uint8Array(randomBytes(512));
    startManifestAndDownloadServers(binary);
    const events: string[] = [];
    const u = makeUpdater({
      recordUpdateEvent: (phase) => events.push(phase),
      invokeInstaller: async () => {
        throw new Error("simulated installer failure");
      },
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/simulated/);
    expect(events).toContain("system.update.start");
    expect(events).toContain("system.update.failed");
  });
});

describe("G6 — updater polish (S6-F8 / S6-F9 / S6-F10 / S6-F11)", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  for (const variant of ["success", "failure"] as const) {
    test(`S6-F8 — temp directory is removed after applyUpdate ${variant}`, async () => {
      const binary = new Uint8Array(randomBytes(256));
      startManifestAndDownloadServers(binary);
      let installerPath = "";
      const u = makeUpdater({
        invokeInstaller: async (p: string) => {
          installerPath = p;
          if (variant === "failure") throw new Error("simulated install failure");
        },
      });
      await u.checkNow();
      if (variant === "failure") {
        await expect(u.applyUpdate()).rejects.toThrow(/simulated/);
      } else {
        await u.applyUpdate();
      }
      const { existsSync } = await import("node:fs");
      const { dirname } = await import("node:path");
      expect(installerPath).not.toBe("");
      expect(existsSync(dirname(installerPath))).toBe(false);
    });
  }

  test("S6-F9 — getStatus.lastError strips URL userinfo from a fetch error", async () => {
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: "https://user:supersecret@cdn.example.com/latest.json",
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    await expect(u.checkNow()).rejects.toBeDefined();
    const status = u.getStatus();
    expect(status.lastError).toBeDefined();
    expect(status.lastError ?? "").not.toContain("supersecret");
    expect(status.lastError ?? "").not.toContain("user:supersecret@");
  });

  test("S6-F10 — sha256HexEqualConstantTime is used (mismatch still rejected)", async () => {
    const binary = new Uint8Array(randomBytes(512));
    const tampered = new Uint8Array(randomBytes(512));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(tampered),
    });
    const manifest = buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`);
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => jsonResponse(manifest),
    });
    const u = makeUpdater();
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/hash|signature/i);
  });
});

describe("G6 — manifest-fetcher (S6-F11)", () => {
  afterEach(() => {
    server?.stop(true);
  });

  test("rejects malformed pub_date", async () => {
    const binary = new Uint8Array(randomBytes(512));
    const goodManifest = buildSignedManifest(binary, kp, "https://cdn.example.com/bin");
    const tampered: Record<string, unknown> = {
      ...(goodManifest as unknown as Record<string, unknown>),
      pub_date: "yesterday",
    };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => jsonResponse(tampered) });
    const u = makeUpdater();
    await expect(u.checkNow()).rejects.toThrow(/pub_date.*ISO-8601/i);
  });

  test("accepts ISO-date-only pub_date (no time component)", async () => {
    const binary = new Uint8Array(randomBytes(512));
    const goodManifest = buildSignedManifest(binary, kp, "https://cdn.example.com/bin");
    const variant: Record<string, unknown> = {
      ...(goodManifest as unknown as Record<string, unknown>),
      pub_date: "2026-04-26",
    };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => jsonResponse(variant) });
    const u = makeUpdater();
    const out = await u.checkNow();
    expect(out.latestVersion).toBeDefined();
  });

  test("accepts full ISO-8601 datetime with TZ offset", async () => {
    const binary = new Uint8Array(randomBytes(512));
    const goodManifest = buildSignedManifest(binary, kp, "https://cdn.example.com/bin");
    const variant: Record<string, unknown> = {
      ...(goodManifest as unknown as Record<string, unknown>),
      pub_date: "2026-04-26T14:30:00+02:00",
    };
    server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => jsonResponse(variant) });
    const u = makeUpdater();
    const out = await u.checkNow();
    expect(out.latestVersion).toBeDefined();
  });

  test("ManifestFetchError redacts URL userinfo from constructed messages", async () => {
    const { ManifestFetchError } = await import("./manifest-fetcher.ts");
    const e = new ManifestFetchError(
      "fetch failed at https://user:topsecret@cdn.example.com/latest.json",
    );
    expect(e.message).not.toContain("topsecret");
    expect(e.message).not.toContain("user:topsecret@");
  });
});
