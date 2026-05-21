import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryFetcher } from "./registry-fetcher.ts";

let extRoot: string;

beforeAll(async () => {
  // Use mkdtemp for the atomic random-suffix temp dir — Date.now() in tmpdir is
  // a predictable path (TOCTOU-able: an attacker with /tmp write access could
  // pre-create a symlink at the predicted name before we mkdir). CodeQL flags
  // the `tmpdir() + Date.now()` pattern as "insecure temporary file".
  extRoot = await mkdtemp(join(tmpdir(), "nimbus-test-"));
  await mkdir(join(extRoot, "com.shared.utils", "active"), { recursive: true });
  await writeFile(
    join(extRoot, "com.shared.utils", "active", "nimbus.extension.json"),
    JSON.stringify({
      id: "com.shared.utils",
      version: "1.5.0",
      dependsOn: { "com.lower": "^0.1.0" },
    }),
    "utf8",
  );
});
afterAll(async () => {
  await rm(extRoot, { recursive: true, force: true });
});

describe("createRegistryFetcher (local-first)", () => {
  it("listVersions for installed id returns only installedVersion, no remote call", async () => {
    let remoteCalled = false;
    const fetcher = createRegistryFetcher({
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      extensionDir: (id) => join(extRoot, id, "active"),
      remoteListVersions: async () => {
        remoteCalled = true;
        return ["9.9.9"];
      },
      remoteFetchManifest: async () => {
        remoteCalled = true;
        throw new Error("unreachable");
      },
    });
    const versions = await fetcher.listVersions("com.shared.utils");
    expect(versions).toEqual(["1.5.0"]);
    expect(remoteCalled).toBe(false);
  });

  it("fetchManifest for installed id reads on-disk manifest, no remote call", async () => {
    let remoteCalled = false;
    const fetcher = createRegistryFetcher({
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      extensionDir: (id) => join(extRoot, id, "active"),
      remoteListVersions: async () => {
        remoteCalled = true;
        return [];
      },
      remoteFetchManifest: async () => {
        remoteCalled = true;
        throw new Error("unreachable");
      },
    });
    const m = await fetcher.fetchManifest("com.shared.utils", "1.5.0");
    expect(m.dependsOn?.["com.lower"]).toBe("^0.1.0");
    expect(remoteCalled).toBe(false);
  });

  it("unknown id falls through to remote", async () => {
    let remoteListCalled = false;
    const fetcher = createRegistryFetcher({
      installed: new Map(),
      extensionDir: () => extRoot,
      remoteListVersions: async () => {
        remoteListCalled = true;
        return ["1.0.0"];
      },
      remoteFetchManifest: async (id, version) => ({ id, version }),
    });
    expect(await fetcher.listVersions("com.unknown")).toEqual(["1.0.0"]);
    expect(remoteListCalled).toBe(true);
  });

  it("tampered on-disk manifest fails parseExtensionManifestJson (review-fix #3)", async () => {
    // Setup: a manifest with garbage in a typed field that the parser will reject.
    // mkdtemp here for the same reason as the beforeAll above — predictable
    // `tmpdir() + Date.now()` paths trip CodeQL's "insecure temporary file" rule.
    const tamperedRoot = await mkdtemp(join(tmpdir(), "nimbus-test-tampered-"));
    await mkdir(join(tamperedRoot, "com.tampered", "active"), { recursive: true });
    await writeFile(
      join(tamperedRoot, "com.tampered", "active", "nimbus.extension.json"),
      JSON.stringify({ id: 42, version: "1.0.0" }), // id must be string per schema
      "utf8",
    );
    const fetcher = createRegistryFetcher({
      installed: new Map([["com.tampered", "1.0.0"]]),
      extensionDir: (id) => join(tamperedRoot, id, "active"),
      remoteListVersions: async () => [],
      remoteFetchManifest: async () => {
        throw new Error("should not be called");
      },
    });
    await expect(fetcher.fetchManifest("com.tampered", "1.0.0")).rejects.toThrow();
    await rm(tamperedRoot, { recursive: true, force: true });
  });
});
