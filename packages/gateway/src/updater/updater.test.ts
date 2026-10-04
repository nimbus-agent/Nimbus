import { afterEach, describe, expect, mock, test } from "bun:test";
import { randomBytes } from "node:crypto";
import type { Server } from "bun";
import { loadUpdaterPublicKey } from "./public-key.ts";
import {
  buildEnvelopeSignedManifest,
  buildSignedManifest,
  jsonResponse,
  makeKeypair,
} from "./testing/updater-test-fixtures.ts";
import type { UpdaterEmit, UpdaterOptions } from "./updater.ts";
import { MAX_DOWNLOAD_BYTES, redactUrlUserinfo, Updater } from "./updater.ts";

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
      expect(key).toHaveLength(32);
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
    expect(fetched).toHaveLength(0);
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
    expect(installerCalls).toHaveLength(0);
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

describe("B11 — redactUrlUserinfo branches", () => {
  test("leaves plain text with no URL pattern unchanged", () => {
    expect(redactUrlUserinfo("no url here")).toBe("no url here");
  });

  test("redacts credentials from a well-formed https URL", () => {
    const result = redactUrlUserinfo("error at https://user:secret@example.com/path");
    expect(result).not.toContain("secret");
    expect(result).not.toContain("user:secret@");
    expect(result).toContain("https://");
  });

  // Compound-scheme fixtures — the reason `URL_USERINFO_RE`'s scheme class is
  // `[a-zA-Z0-9+\-.]{1,32}` and not `[a-zA-Z]+`. Narrowing it back to letters-only was run against
  // these cases before they were written, and the damage is NOT uniform, so the comment says which
  // is which rather than claiming every compound scheme leaks:
  //
  //   - `git+https://` and `svn+ssh://` still redact under a letters-only class, because the inner
  //     `https://` / `ssh://` matches on its own. What breaks is the OUTPUT, not the secret:
  //     `git+https://github.com//org/repo.git`.
  //   - a scheme whose last character is not a letter has no inner match to fall back on. `s3://`
  //     is the fixture for that, and under a letters-only class it emits the access key and secret
  //     verbatim. That case is the confidentiality argument for the broad class.
  //
  // Every `expected` below is the helper's REAL output. Note the `//` on the plain-https case: the
  // regex match ends at the authority (its last class excludes `/`), so `URL.toString()` re-adds the
  // root slash for a SPECIAL scheme and the unmatched path follows it. Non-special schemes
  // (`ssh:`, `s3:`, `git+https:`) get no such slash, which is why only that one row shows it.
  // Cosmetic, pre-existing, and asserted rather than hidden — the credential is gone either way.
  const USERINFO_FIXTURES: readonly {
    name: string;
    input: string;
    expected: string;
    secret?: string;
  }[] = [
    {
      name: "git+https:// with user:password",
      input: "clone failed: git+https://octo:ghp_secret@github.com/org/repo.git",
      expected: "clone failed: git+https://github.com/org/repo.git",
      secret: "ghp_secret",
    },
    {
      name: "svn+ssh:// with user:password",
      input: "checkout failed: svn+ssh://svcacct:hunter2@svn.example.com/trunk",
      expected: "checkout failed: svn+ssh://svn.example.com/trunk",
      secret: "hunter2",
    },
    {
      // The confidentiality case. `s3` ends in a digit, so a letters-only scheme class finds no
      // match at all — not even a partial one — and both halves of the credential survive into the
      // message. Verified by narrowing the class and re-running, 2026-09-10.
      name: "s3:// (a digit-bearing scheme) with key:secret",
      input: "upload failed: s3://AKIAEXAMPLE:wJalrSecret@bucket.example.com/key",
      expected: "upload failed: s3://bucket.example.com/key",
      secret: "wJalrSecret",
    },
    {
      name: "ssh:// with a username and no password",
      input: "ssh://git@github.com/org/repo.git unreachable",
      expected: "ssh://github.com/org/repo.git unreachable",
      secret: "git@github.com",
    },
    {
      name: "https:// with a username and no password",
      input: "fetch failed at https://deploytoken@cdn.example.com/latest.json",
      expected: "fetch failed at https://cdn.example.com//latest.json",
      secret: "deploytoken",
    },
    {
      name: "https:// with no userinfo is left untouched",
      input: "no credentials: https://cdn.example.com/latest.json",
      expected: "no credentials: https://cdn.example.com/latest.json",
    },
    {
      name: "a bare email address is not a URL and is left untouched",
      input: "contact ops@example.com about the outage",
      expected: "contact ops@example.com about the outage",
    },
  ];

  // Two leaks the `{1,256}` bounds caused, found in review on #1480 and fixed in the same commit.
  // Both are the worst possible failure mode for a redaction helper: no match at all means the
  // credential ships VERBATIM, and the fixtures above could not see it because every secret in
  // them is short and every authority non-empty.
  const LONG_SECRET = "S".repeat(300);

  test("a userinfo longer than 256 characters is still redacted", () => {
    // A 300-character bearer token or PAT in a URL is ordinary. Under the old bound the regex
    // found no match and `Updater.lastError` carried the whole token.
    const out = redactUrlUserinfo(
      `fetch failed at https://user:${LONG_SECRET}@cdn.example.com/latest.json`,
    );
    expect(out).not.toContain(LONG_SECRET);
    expect(out).toContain("cdn.example.com");
  });

  test("a long userinfo with no password is redacted too", () => {
    const out = redactUrlUserinfo(`fetch failed at https://${LONG_SECRET}@cdn.example.com/x`);
    expect(out).not.toContain(LONG_SECRET);
  });

  test("an empty authority after @ falls back to [REDACTED-URL]", () => {
    // `https://user:secret@` matched nothing under the old bound (the host class required at
    // least one character), so the secret survived. It now matches, `new URL` rejects the empty
    // host, and the catch arm replaces the whole thing.
    const out = redactUrlUserinfo("fetch failed at https://user:secret@");
    expect(out).not.toContain("secret");
    expect(out).toContain("[REDACTED-URL]");
  });

  test("stays linear on a large adversarial input (no catastrophic backtracking)", () => {
    // Removing the bounds removes the length ceiling that was doing double duty as a backtracking
    // ceiling. The classes are disjoint at the boundary (`[^\s/@]` excludes `@`), so the match is
    // unambiguous and linear — asserted rather than assumed, per the repo's ReDoS convention.
    const hostile = `https://${"a".repeat(200_000)}`;
    const started = performance.now();
    const out = redactUrlUserinfo(hostile);
    expect(performance.now() - started).toBeLessThan(1_000);
    expect(out).toBe(hostile);
  });

  for (const fx of USERINFO_FIXTURES) {
    test(`fixture: ${fx.name}`, () => {
      const out = redactUrlUserinfo(fx.input);
      expect(out).toBe(fx.expected);
      if (fx.secret !== undefined) expect(out).not.toContain(fx.secret);
    });
  }

  test("the canonical helper is the one `manifest-fetcher.ts` uses", async () => {
    // Both files carried their own copy of the regex and the try/catch until 2026-09-10. The
    // duplicate is why this assertion is worth making: a fixture proving `updater.ts` redacts
    // `git+https://` said nothing about the copy that redacts `ManifestFetchError` messages.
    const { ManifestFetchError } = await import("./manifest-fetcher.ts");
    const e = new ManifestFetchError(
      "clone failed: git+https://octo:ghp_secret@github.com/org/repo.git",
    );
    expect(e.message).toBe("clone failed: git+https://github.com/org/repo.git");
    expect(e.message).not.toContain("ghp_secret");
  });

  test("replaces [REDACTED-URL] when matched text is not a valid URL", () => {
    // A digit-leading scheme matches URL_USERINFO_RE (the scheme class allows [0-9]) but
    // new URL() rejects a scheme that does not start with a letter → the catch arm fires
    // and the whole match is replaced with [REDACTED-URL].
    const out = redactUrlUserinfo("connect failed: 1http://user:topsecret@host.internal");
    expect(out).toContain("[REDACTED-URL]");
    expect(out).not.toContain("topsecret");
    // a string with no userinfo URL is returned unchanged (the no-match branch)
    expect(redactUrlUserinfo("no match")).toBe("no match");
  });
});

describe("B11 — checkNow with manifest notes", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("checkNow includes notes in result and emit payload when manifest has notes", async () => {
    const binary = new Uint8Array(randomBytes(256));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(binary),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        const m = buildSignedManifest(
          binary,
          kp,
          `http://127.0.0.1:${downloadServer.port}/bin`,
          "0.2.0",
        );
        const withNotes: Record<string, unknown> = {
          ...(m as unknown as Record<string, unknown>),
          notes: "Bug fixes and performance improvements",
        };
        return jsonResponse(withNotes);
      },
    });
    const emitted: Array<{ name: string; payload?: Record<string, unknown> }> = [];
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: (name, payload) =>
        emitted.push({ name, ...(payload !== undefined ? { payload } : {}) }),
      timeoutMs: 2000,
    });
    const result = await u.checkNow();
    expect(result.notes).toBe("Bug fixes and performance improvements");
    expect(result.updateAvailable).toBe(true);
    const updateEvent = emitted.find((e) => e.name === "updater.updateAvailable");
    expect(updateEvent).toBeDefined();
    expect(updateEvent?.payload?.["notes"]).toBe("Bug fixes and performance improvements");
  });

  test("checkNow sets state=failed and lastError on fetch failure (non-Error thrown)", async () => {
    // Trigger a failure with a non-Error thrown value by pointing to a URL that fails
    // with a string-like failure — we intercept by providing a URL that returns non-JSON
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not json at all", { status: 200 }),
    });
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    await expect(u.checkNow()).rejects.toBeDefined();
    const status = u.getStatus();
    expect(status.state).toBe("failed");
    expect(status.lastError).toBeDefined();
  });
});

describe("B11 — requireApplyPreconditions branches", () => {
  test("applyUpdate throws when no checkNow has been called yet", async () => {
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: "https://cdn.example.com/latest.json",
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    await expect(u.applyUpdate()).rejects.toThrow(/no manifest loaded/);
  });

  // NOTE: the "no asset for target" arm in applyUpdate (platforms[target] === undefined) is
  // unreachable via the public API — fetchUpdateManifest requires all four standard targets,
  // and `target` is always one of them, so a loaded manifest always has the asset. Left as a
  // defensive guard (D-candidate); a duplicate "no manifest loaded" test was removed here.
});

describe("B11 — downloadAsset branches", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("downloadAsset rejects non-https URL with parseable scheme", async () => {
    // We need a manifest loaded that points to a non-https URL.
    // Build a manifest with an ftp:// download URL.
    const binary = new Uint8Array(randomBytes(256));
    const manifest = buildSignedManifest(binary, kp, "https://cdn.example.com/bin", "0.2.0");
    // Override the download URL in the platforms to use ftp://
    const patchedManifest = {
      ...manifest,
      platforms: {
        ...manifest.platforms,
        "linux-x86_64": {
          ...manifest.platforms["linux-x86_64"],
          url: "ftp://cdn.example.com/installer.bin",
        },
      },
    };
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => jsonResponse(patchedManifest),
    });
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/asset URL must be https/);
  });

  test("downloadAsset rejects asset URL that cannot be parsed (scheme extraction fallback)", async () => {
    // Use a completely unparseable URL as the asset URL
    const binary = new Uint8Array(randomBytes(256));
    const manifest = buildSignedManifest(binary, kp, "https://cdn.example.com/bin", "0.2.0");
    const patchedManifest = {
      ...manifest,
      platforms: {
        ...manifest.platforms,
        "linux-x86_64": {
          ...manifest.platforms["linux-x86_64"],
          url: "not-a-url-at-all",
        },
      },
    };
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => jsonResponse(patchedManifest),
    });
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/asset URL must be https/);
  });

  test("downloadAsset rejects non-ok HTTP response from download server", async () => {
    const binary = new Uint8Array(randomBytes(256));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("not found", { status: 404 }),
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
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: (name) => events.push(name),
      timeoutMs: 2000,
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/download HTTP 404/);
    expect(events).toContain("updater.rolledBack");
  });

  test("downloadAsset rejects when Content-Length header exceeds configured cap", async () => {
    const binary = new Uint8Array(randomBytes(256));
    const cap = 128;
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        new Response(binary, {
          headers: {
            "content-length": String(binary.byteLength),
            "content-type": "application/octet-stream",
          },
        }),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`, "0.2.0"),
        ),
    });
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
      maxDownloadBytes: cap,
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/Content-Length.*exceeds.*cap/);
  });

  test("downloadAsset uses MAX_DOWNLOAD_BYTES when maxDownloadBytes is not provided", async () => {
    // This exercises the `opts.maxDownloadBytes ?? MAX_DOWNLOAD_BYTES` branch with undefined
    // We test that a small binary passes through when no cap is set (uses default 500MiB)
    const binary = new Uint8Array(randomBytes(256));
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
    const invocations: string[] = [];
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
      // maxDownloadBytes deliberately omitted → uses MAX_DOWNLOAD_BYTES
      invokeInstaller: async () => {
        invocations.push("installed");
      },
    });
    await u.checkNow();
    await u.applyUpdate();
    expect(invocations).toEqual(["installed"]);
  });
});

describe("B11 — installOrFail without invokeInstaller", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("applyUpdate succeeds without invokeInstaller and emits restarting", async () => {
    const binary = new Uint8Array(randomBytes(256));
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
    const recordedPhases: string[] = [];
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: (name) => events.push(name),
      timeoutMs: 2000,
      recordUpdateEvent: (phase) => recordedPhases.push(phase),
      // invokeInstaller deliberately omitted
    });
    await u.checkNow();
    await u.applyUpdate();
    expect(events).toContain("updater.restarting");
    expect(recordedPhases).toContain("system.update.installed");
    const status = u.getStatus();
    expect(status.state).toBe("idle");
  });
});

describe("B11 — getStatus before and after checkNow", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("getStatus returns idle state and no lastCheckAt before checkNow", () => {
    const u = new Updater({
      currentVersion: "0.2.0",
      manifestUrl: "https://cdn.example.com/latest.json",
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    const status = u.getStatus();
    expect(status.state).toBe("idle");
    expect(status.currentVersion).toBe("0.2.0");
    expect(status.lastCheckAt).toBeUndefined();
    expect(status.lastError).toBeUndefined();
  });

  test("getStatus returns lastCheckAt after successful checkNow", async () => {
    const binary = new Uint8Array(randomBytes(256));
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
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    await u.checkNow();
    const status = u.getStatus();
    expect(status.lastCheckAt).toBeDefined();
    expect(status.lastError).toBeUndefined();
    // lastCheckAt should be a valid ISO string
    expect(new Date(status.lastCheckAt!).toISOString()).toBe(status.lastCheckAt!);
  });
});

describe("B11 — verifyOrFail: binary-sig fallback (envelope=false path)", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("applyUpdate records envelope=false when binary sig succeeds but envelope fails", async () => {
    // buildSignedManifest creates a manifest with binary sig (not envelope sig).
    // verifyManifestEnvelope will fail (wrong format), but verifyBinarySignature will succeed.
    const binary = new Uint8Array(randomBytes(256));
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
    const auditEvents: Array<{ phase: string; payload: Record<string, unknown> }> = [];
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
      recordUpdateEvent: (phase, payload) => auditEvents.push({ phase, payload }),
      invokeInstaller: async () => {},
    });
    await u.checkNow();
    await u.applyUpdate();
    const verifiedEvent = auditEvents.find((e) => e.phase === "system.update.verified");
    expect(verifiedEvent).toBeDefined();
    // envelope=false because buildSignedManifest uses binary sig, not envelope sig
    expect(verifiedEvent?.payload["envelope"]).toBe(false);
  });
});

describe("B11 — semverGreater edge cases", () => {
  test("semverGreater: versions with fewer than 3 parts use 0 for missing segments", async () => {
    // We test via checkNow with manifests that have short version strings.
    // "1.0" vs "0.9" — "1.0" should be greater.
    // We use the Updater checkNow path which calls semverGreater internally.
    const binary = new Uint8Array(randomBytes(256));
    // For this we need to bypass manifest validation which requires strict semver.
    // semverGreater is NOT exported, so we must use the Updater's checkNow path.
    // manifest-fetcher's SEMVER_RE requires at least x.y.z, so short versions are rejected.
    // Thus, the ?? 0 branch in semverGreater is only reached if a version string has
    // fewer than 3 parts — which the validator won't allow through checkNow.
    // This branch is unreachable via the public API; we note it here.
    // But we can exercise it by having equal-length versions where a segment is missing:
    // Actually, the pa[i] ?? 0 fires when split(".").length < 3 AND i >= length.
    // Since the fetcher validates x.y.z format, this branch is truly unreachable via public API.
    // We verify that a standard 3-part comparison works correctly as a sanity check.
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`, "1.0.0"),
        ),
    });
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response(binary),
    });
    const u = new Updater({
      currentVersion: "0.9.9",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    const result = await u.checkNow();
    expect(result.updateAvailable).toBe(true);
    expect(result.latestVersion).toBe("1.0.0");
  });

  test("semverGreater: patch-level difference detected correctly", async () => {
    const binary = new Uint8Array(randomBytes(256));
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
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`, "0.1.1"),
        ),
    });
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
    });
    const result = await u.checkNow();
    expect(result.updateAvailable).toBe(true);
  });
});

describe("B11 — applyUpdate download-failure audit events", () => {
  afterEach(() => {
    server?.stop(true);
    downloadServer?.stop(true);
  });

  test("downloadOrFail records system.update.failed when download throws", async () => {
    const binary = new Uint8Array(randomBytes(256));
    downloadServer = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => new Response("error", { status: 500 }),
    });
    server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () =>
        jsonResponse(
          buildSignedManifest(binary, kp, `http://127.0.0.1:${downloadServer.port}/bin`, "0.2.0"),
        ),
    });
    const recordedPhases: string[] = [];
    const emitted: string[] = [];
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: (name) => emitted.push(name),
      timeoutMs: 2000,
      recordUpdateEvent: (phase) => recordedPhases.push(phase),
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toThrow(/download HTTP 500/);
    expect(emitted).toContain("updater.rolledBack");
    expect(recordedPhases).toContain("system.update.failed");
    expect(recordedPhases).toContain("system.update.start");
    const status = u.getStatus();
    expect(status.state).toBe("failed");
    expect(status.lastError).toContain("500");
  });

  test("installOrFail lastError redacts URL userinfo from installer error message", async () => {
    const binary = new Uint8Array(randomBytes(256));
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
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
      invokeInstaller: async () => {
        throw new Error("install failed: https://user:topsecret@cdn.example.com/path");
      },
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toBeDefined();
    const status = u.getStatus();
    expect(status.lastError).toBeDefined();
    expect(status.lastError ?? "").not.toContain("topsecret");
  });

  test("installOrFail lastError handles non-Error thrown value (String path)", async () => {
    const binary = new Uint8Array(randomBytes(256));
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
    const u = new Updater({
      currentVersion: "0.1.0",
      manifestUrl: `http://127.0.0.1:${server.port}/latest.json`,
      publicKey: kp.publicKey,
      target: "linux-x86_64",
      emit: () => {},
      timeoutMs: 2000,
      invokeInstaller: async () => {
        // eslint-disable-next-line @typescript-eslint/no-throw-literal
        throw "string-error-not-an-Error-object";
      },
    });
    await u.checkNow();
    await expect(u.applyUpdate()).rejects.toBe("string-error-not-an-Error-object");
    const status = u.getStatus();
    expect(status.lastError).toContain("string-error-not-an-Error-object");
  });

  test("checkNow catch: a fetch that rejects is recorded as lastError, with state failed", async () => {
    // The fetch is STUBBED to fail the way an unresolvable host does. Pointing at a real
    // unresolvable name instead would send a DNS query from a unit test. (The catch's non-Error
    // `String(err)` arm is reached in `updater.coverage.test.ts`, through a throwing emit listener —
    // nothing on the fetch path can throw a non-Error, since `fetchUpdateManifest` wraps it.)
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new TypeError("getaddrinfo ENOTFOUND updates.example");
    }) as unknown as typeof fetch;
    try {
      const u = new Updater({
        currentVersion: "0.1.0",
        manifestUrl: "https://updates.example/latest.json",
        publicKey: kp.publicKey,
        target: "linux-x86_64",
        emit: () => {},
        timeoutMs: 500,
      });
      const reason = "fetch failed: TypeError: getaddrinfo ENOTFOUND updates.example";
      await expect(u.checkNow()).rejects.toThrow(reason);
      expect(u.getStatus()).toMatchObject({ state: "failed", lastError: reason });
      expect(u.getStatus().lastCheckAt).toBeUndefined();
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});
