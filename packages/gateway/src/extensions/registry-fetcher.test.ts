import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRegistryFetcher } from "./registry-fetcher.ts";

let extRoot: string;

beforeAll(async () => {
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

  it("fetchManifest falls through to remote when requested version does not match installed version", async () => {
    let remoteFetchCalled = false;
    const fetcher = createRegistryFetcher({
      installed: new Map([["com.shared.utils", "1.5.0"]]),
      extensionDir: (id) => join(extRoot, id, "active"),
      remoteListVersions: async () => [],
      remoteFetchManifest: async (id, version) => {
        remoteFetchCalled = true;
        return { id, version };
      },
    });
    const m = await fetcher.fetchManifest("com.shared.utils", "2.0.0");
    expect(m.version).toBe("2.0.0");
    expect(remoteFetchCalled).toBe(true);
  });

  it("fetchManifest falls through to remote when id is not in installed map at all", async () => {
    let remoteFetchCalled = false;
    const fetcher = createRegistryFetcher({
      installed: new Map(),
      extensionDir: () => extRoot,
      remoteListVersions: async () => [],
      remoteFetchManifest: async (id, version) => {
        remoteFetchCalled = true;
        return { id, version };
      },
    });
    const m = await fetcher.fetchManifest("com.never.installed", "1.0.0");
    expect(m.id).toBe("com.never.installed");
    expect(remoteFetchCalled).toBe(true);
  });

  it("fetchManifest throws on genuinely malformed JSON on disk", async () => {
    const malformedRoot = await mkdtemp(join(tmpdir(), "nimbus-test-malformed-"));
    await mkdir(join(malformedRoot, "com.malformed", "active"), { recursive: true });
    await writeFile(
      join(malformedRoot, "com.malformed", "active", "nimbus.extension.json"),
      "{ not: valid json at all",
      "utf8",
    );
    const fetcher = createRegistryFetcher({
      installed: new Map([["com.malformed", "1.0.0"]]),
      extensionDir: (id) => join(malformedRoot, id, "active"),
      remoteListVersions: async () => [],
      remoteFetchManifest: async () => {
        throw new Error("should not be called");
      },
    });
    await expect(fetcher.fetchManifest("com.malformed", "1.0.0")).rejects.toThrow(
      "extension manifest is not valid JSON",
    );
    await rm(malformedRoot, { recursive: true, force: true });
  });

  it("tampered on-disk manifest fails parseExtensionManifestJson (review-fix #3)", async () => {
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
