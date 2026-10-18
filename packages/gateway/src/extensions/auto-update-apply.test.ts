import { describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  applyDowngradeSwap,
  applyUpgradeSwap,
  downloadTarball,
  verifyTarballSha256,
} from "./auto-update-apply.ts";
import { holdingDir, pendingDir, prevVersionDir, prevVersionsDir } from "./version-store.ts";

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

const ID = "acme/foo";

interface Layout {
  extensionsDir: string;
  installPath: string;
}

/** A FLAT install (`<extensionsDir>/<id>`, as install writes it) plus an optional prev version. */
async function makeExt(root: string, fromVersion: string, prevVersion?: string): Promise<Layout> {
  const extensionsDir = join(root, "extensions");
  const installPath = join(extensionsDir, ID);
  await mkdir(installPath, { recursive: true });
  await writeFile(join(installPath, "nimbus.extension.json"), "{}");
  await writeFile(join(installPath, "marker.txt"), `active=${fromVersion}`);
  if (prevVersion) {
    const prev = prevVersionDir(extensionsDir, ID, prevVersion);
    await mkdir(prev, { recursive: true });
    await writeFile(join(prev, "marker.txt"), `prev=${prevVersion}`);
  }
  return { extensionsDir, installPath };
}

async function makePending(extensionsDir: string, toVersion: string) {
  const dir = pendingDir(extensionsDir, ID, toVersion);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "marker.txt"), `pending=${toVersion}`);
  return dir;
}

const gone = (path: string) =>
  stat(path)
    .then(() => false)
    .catch(() => true);

describe("applyUpgradeSwap", () => {
  it("upgrade swaps a FLAT install dir and keeps the old one under prev/<from>", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-upgrade-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.0.0");
      const pending = await makePending(extensionsDir, "1.1.0");

      await applyUpgradeSwap({
        installPath,
        extensionsDir,
        id: ID,
        pendingExtractedDir: pending,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      });

      expect(await readFile(join(installPath, "marker.txt"), "utf8")).toBe("pending=1.1.0");
      expect(
        await readFile(join(prevVersionDir(extensionsDir, ID, "1.0.0"), "marker.txt"), "utf8"),
      ).toBe("active=1.0.0");
      expect(await gone(holdingDir(extensionsDir, ID))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("retires a pre-existing prev/<older> when a new prev is created", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-upgrade-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.0.0", "0.9.0");
      const pending = await makePending(extensionsDir, "1.1.0");

      await applyUpgradeSwap({
        installPath,
        extensionsDir,
        id: ID,
        pendingExtractedDir: pending,
        fromVersion: "1.0.0",
        toVersion: "1.1.0",
      });

      expect(await readdir(prevVersionsDir(extensionsDir, ID))).toEqual(["1.0.0"]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("upgrade succeeds when prev/<fromVersion> already exists", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-upgrade-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.0.0");
      const swap = (from: string, to: string, pendingExtractedDir: string) =>
        applyUpgradeSwap({
          installPath,
          extensionsDir,
          id: ID,
          pendingExtractedDir,
          fromVersion: from,
          toVersion: to,
        });

      await swap("1.0.0", "1.1.0", await makePending(extensionsDir, "1.1.0"));
      await applyDowngradeSwap({
        installPath,
        extensionsDir,
        id: ID,
        fromVersion: "1.1.0",
        toVersion: "1.0.0",
      });
      // A non-empty prev/1.0.0 left behind by an earlier cycle: it must not block the next swap.
      const stale = prevVersionDir(extensionsDir, ID, "1.0.0");
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, "marker.txt"), "stale");

      await swap("1.0.0", "1.2.0", await makePending(extensionsDir, "1.2.0"));

      expect(await readFile(join(installPath, "marker.txt"), "utf8")).toBe("pending=1.2.0");
      expect(await readFile(join(stale, "marker.txt"), "utf8")).toBe("active=1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("failed rename leaves the original install untouched", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-upgrade-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.0.0");
      const pending = pendingDir(extensionsDir, ID, "1.1.0"); // never created
      await expect(
        applyUpgradeSwap({
          installPath,
          extensionsDir,
          id: ID,
          pendingExtractedDir: pending,
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
        }),
      ).rejects.toThrow();

      expect(await readFile(join(installPath, "marker.txt"), "utf8")).toBe("active=1.0.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("applyDowngradeSwap", () => {
  it("downgrade restores prev into the flat install dir", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-downgrade-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.1.0", "1.0.0");
      await applyDowngradeSwap({
        installPath,
        extensionsDir,
        id: ID,
        fromVersion: "1.1.0",
        toVersion: "1.0.0",
      });

      expect(await readFile(join(installPath, "marker.txt"), "utf8")).toBe("prev=1.0.0");
      expect(
        await readFile(join(prevVersionDir(extensionsDir, ID, "1.1.0"), "marker.txt"), "utf8"),
      ).toBe("active=1.1.0");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects when prev/<to> is missing", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-downgrade-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.1.0");
      await expect(
        applyDowngradeSwap({
          installPath,
          extensionsDir,
          id: ID,
          fromVersion: "1.1.0",
          toVersion: "1.0.0",
        }),
      ).rejects.toThrow(/downgrade_unavailable/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects with swap_failed when buffer -> prev/<from> rename fails (non-empty target dir)", async () => {
    // Pre-create prev/<fromVersion> as a non-empty directory so renaming the buffer onto it fails
    // with ENOTEMPTY/EEXIST/EPERM cross-platform.
    const root = await mkdtemp(join(tmpdir(), "nimbus-auto-downgrade-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.1.0", "1.0.0");
      const swapPrevPath = prevVersionDir(extensionsDir, ID, "1.1.0");
      await mkdir(swapPrevPath, { recursive: true });
      await writeFile(join(swapPrevPath, "blocker.txt"), "blocker");

      await expect(
        applyDowngradeSwap({
          installPath,
          extensionsDir,
          id: ID,
          fromVersion: "1.1.0",
          toVersion: "1.0.0",
        }),
      ).rejects.toThrow(/swap_failed/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("applyUpgradeSwap — rollback paths", () => {
  it("first-rename failure with movedAside: restores the stale prev entries, rejects", async () => {
    // Stale prev/0.9.0 present (triggers the holding move) but the install dir is MISSING, so
    // rename(installPath -> prev/1.0.0) throws ENOENT.
    const root = await mkdtemp(join(tmpdir(), "nimbus-upgrade-roll1-"));
    try {
      const extensionsDir = join(root, "extensions");
      const installPath = join(extensionsDir, ID);
      const stale = prevVersionDir(extensionsDir, ID, "0.9.0");
      await mkdir(stale, { recursive: true });
      await writeFile(join(stale, "marker.txt"), "prev=0.9.0");
      const pending = await makePending(extensionsDir, "1.1.0");

      await expect(
        applyUpgradeSwap({
          installPath,
          extensionsDir,
          id: ID,
          pendingExtractedDir: pending,
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
        }),
      ).rejects.toThrow();

      expect(await readdir(prevVersionsDir(extensionsDir, ID))).toEqual(["0.9.0"]);
      expect(await gone(holdingDir(extensionsDir, ID))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("second-rename failure with movedAside: restores install and holding, then rejects", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-upgrade-roll2-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.0.0", "0.9.0");
      const pending = pendingDir(extensionsDir, ID, "1.1.0"); // never created

      await expect(
        applyUpgradeSwap({
          installPath,
          extensionsDir,
          id: ID,
          pendingExtractedDir: pending,
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
        }),
      ).rejects.toThrow();

      expect(await readFile(join(installPath, "marker.txt"), "utf8")).toBe("active=1.0.0");
      expect(await readdir(prevVersionsDir(extensionsDir, ID))).toContain("0.9.0");
      expect(await gone(holdingDir(extensionsDir, ID))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });

  it("second-rename failure with no stale prev: restores install, never creates holding", async () => {
    const root = await mkdtemp(join(tmpdir(), "nimbus-upgrade-nohld-"));
    try {
      const { extensionsDir, installPath } = await makeExt(root, "1.0.0");
      const pending = pendingDir(extensionsDir, ID, "1.1.0"); // never created

      await expect(
        applyUpgradeSwap({
          installPath,
          extensionsDir,
          id: ID,
          pendingExtractedDir: pending,
          fromVersion: "1.0.0",
          toVersion: "1.1.0",
        }),
      ).rejects.toThrow();

      expect(await readFile(join(installPath, "marker.txt"), "utf8")).toBe("active=1.0.0");
      expect(await gone(holdingDir(extensionsDir, ID))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true }).catch(() => {});
    }
  });
});
