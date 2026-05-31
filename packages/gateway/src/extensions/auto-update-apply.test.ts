import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDowngradeSwap,
  applyUpgradeSwap,
  downloadTarball,
  verifyTarballSha256,
} from "./auto-update-apply.ts";

describe("verifyTarballSha256", () => {
  it("returns true when the buffer matches the expected hex hash", async () => {
    const bytes = new TextEncoder().encode("hello");
    const expected = "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
    expect(await verifyTarballSha256(bytes, expected)).toBe(true);
  });

  it("returns false on hash mismatch", async () => {
    const bytes = new TextEncoder().encode("hello");
    expect(await verifyTarballSha256(bytes, "0".repeat(64))).toBe(false);
  });

  it("is case-insensitive on the expected hex string", async () => {
    const bytes = new TextEncoder().encode("hello");
    const upper = "2CF24DBA5FB0A30E26E83B2AC5B9E29E1B161E5C1FA7425E73043362938B9824";
    expect(await verifyTarballSha256(bytes, upper)).toBe(true);
  });
});

describe("downloadTarball", () => {
  it("returns the response bytes for a successful fetch", async () => {
    const payload = new TextEncoder().encode("tarball");
    const fakeFetch = async () =>
      new Response(payload, { status: 200, headers: { "content-length": "7" } });
    const bytes = await downloadTarball("https://r/x", {
      fetcher: fakeFetch,
      maxBytes: 1024,
      signal: new AbortController().signal,
    });
    expect(bytes).toEqual(payload);
  });

  it("throws on non-2xx", async () => {
    const fakeFetch = async () => new Response("nope", { status: 404 });
    await expect(
      downloadTarball("https://r/x", {
        fetcher: fakeFetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/404/);
  });

  it("rejects when content-length exceeds maxBytes", async () => {
    const fakeFetch = async () =>
      new Response(new Uint8Array(0), { status: 200, headers: { "content-length": "9999" } });
    await expect(
      downloadTarball("https://r/x", {
        fetcher: fakeFetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/too large/i);
  });

  it("rejects when streamed body exceeds maxBytes (no content-length)", async () => {
    const big = new Uint8Array(2048);
    const fakeFetch = async () => new Response(big, { status: 200 });
    await expect(
      downloadTarball("https://r/x", {
        fetcher: fakeFetch,
        maxBytes: 1024,
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/too large/i);
  });
});

async function makeExt(root: string, fromVersion: string, prevVersion?: string) {
  const extRoot = join(root, "com.example.x");
  await mkdir(join(extRoot, "active"), { recursive: true });
  await writeFile(join(extRoot, "active", "marker.txt"), `active=${fromVersion}`);
  if (prevVersion) {
    await mkdir(join(extRoot, "_prev", prevVersion), { recursive: true });
    await writeFile(join(extRoot, "_prev", prevVersion, "marker.txt"), `prev=${prevVersion}`);
  }
  return extRoot;
}

async function makePending(root: string, id: string, toVersion: string) {
  const pendingDir = join(root, "_pending", `${id}-${toVersion}`);
  await mkdir(pendingDir, { recursive: true });
  await writeFile(join(pendingDir, "marker.txt"), `pending=${toVersion}`);
  return pendingDir;
}

describe("applyUpgradeSwap", () => {
  it("moves active → _prev/<from> and _pending/<to> → active (no pre-existing _prev)", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-upgrade-"));
    try {
      const extRoot = await makeExt(root, "1.0.0");
      const pendingDir = await makePending(root, "com.example.x", "1.1.0");

      await applyUpgradeSwap({
        extRoot,
        pendingExtractedDir: pendingDir,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      });

      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("pending=1.1.0");
      expect(await readFile(join(extRoot, "_prev", "1.0.0", "marker.txt"), "utf8")).toBe(
        "active=1.0.0",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retires a pre-existing _prev/<older> when a new _prev is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-upgrade-"));
    try {
      const extRoot = await makeExt(root, "1.0.0", "0.9.0");
      const pendingDir = await makePending(root, "com.example.x", "1.1.0");

      await applyUpgradeSwap({
        extRoot,
        pendingExtractedDir: pendingDir,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      });

      const prevEntries = await readdir(join(extRoot, "_prev"));
      expect(prevEntries).toEqual(["1.0.0"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reverts on rename failure mid-swap", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-upgrade-"));
    try {
      const extRoot = await makeExt(root, "1.0.0");
      const pendingDir = join(root, "_pending", "com.example.x-1.1.0");
      await expect(
        applyUpgradeSwap({
          extRoot,
          pendingExtractedDir: pendingDir,
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
        }),
      ).rejects.toThrow();

      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("active=1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("applyDowngradeSwap", () => {
  it("swaps active and _prev/<to>", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-downgrade-"));
    try {
      const extRoot = await makeExt(root, "1.1.0", "1.0.0");
      await applyDowngradeSwap({
        extRoot,
        fromVersion: "1.1.0",
        toVersion: "1.0.0",
      });

      expect(await readFile(join(extRoot, "active", "marker.txt"), "utf8")).toBe("prev=1.0.0");
      expect(await readFile(join(extRoot, "_prev", "1.1.0", "marker.txt"), "utf8")).toBe(
        "active=1.1.0",
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects when _prev/<to> is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-downgrade-"));
    try {
      const extRoot = await makeExt(root, "1.1.0");
      await expect(
        applyDowngradeSwap({
          extRoot,
          fromVersion: "1.1.0",
          toVersion: "1.0.0",
        }),
      ).rejects.toThrow(/downgrade_unavailable/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
