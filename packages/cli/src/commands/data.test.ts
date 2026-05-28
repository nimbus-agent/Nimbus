import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import "../../test/helpers/cli-mocks.ts";
import { clearFixture, setFixture } from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const dataMod = await import("./data.ts");
const { runData } = dataMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runData (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("is callable", () => {
    expect(typeof runData).toBe("function");
  });

  it("throws on unknown subcommand", async () => {
    await expect(runData(["unknown"])).rejects.toThrow("Usage: nimbus data");
  });

  it("throws when gateway is not running (export)", async () => {
    setFixture({});
    await expect(
      runData(["export", "--output", "/tmp/x.tar.gz", "--passphrase", "pw"]),
    ).rejects.toThrow("Gateway is not running. Start with: nimbus start");
  });
});

describe("runData export", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("rejects when --output is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runData(["export", "--passphrase", "pw"])).rejects.toThrow(
      "Usage: nimbus data export",
    );
  });

  it("rejects when --passphrase is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runData(["export", "--output", "/tmp/x.tar.gz"])).rejects.toThrow(
      "Usage: nimbus data export",
    );
  });

  it("calls data.export and prints output path when invoked successfully", async () => {
    const ipc = createMockIpcClient([
      { outputPath: "/tmp/out.tar.gz", recoverySeed: "", recoverySeedGenerated: false },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runData(["export", "--output", "/tmp/out.tar.gz", "--passphrase", "pw", "--yes"]);
    expect(ipc.calls[0]).toEqual({
      method: "data.export",
      params: { output: "/tmp/out.tar.gz", passphrase: "pw", includeIndex: true },
    });
    expect(out.stdout).toContain("[ok] wrote bundle to /tmp/out.tar.gz");
  });

  it("respects --no-index and reveals the recovery seed when one was generated", async () => {
    const ipc = createMockIpcClient([
      {
        outputPath: "/tmp/o.tar.gz",
        recoverySeed: "abandon abandon ability",
        recoverySeedGenerated: true,
      },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runData([
      "export",
      "--output",
      "/tmp/o.tar.gz",
      "--passphrase",
      "pw",
      "--no-index",
      "--yes",
    ]);
    const params = ipc.calls[0]?.params as { includeIndex: boolean };
    expect(params.includeIndex).toBe(false);
    expect(out.stdout).toContain("Recovery seed");
    expect(out.stdout).toContain("abandon abandon ability");
  });
});

describe("runData import", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("rejects when the bundle path is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runData(["import"])).rejects.toThrow("Usage: nimbus data import");
  });

  it("rejects when neither --passphrase nor --recovery-seed is given", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runData(["import", "/tmp/bundle.tar.gz"])).rejects.toThrow(
      "Provide either --passphrase or --recovery-seed",
    );
  });

  it("calls data.import with passphrase and prints credential count", async () => {
    const ipc = createMockIpcClient([{ credentialsRestored: 5, oauthEntriesFlagged: 0 }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runData(["import", "/tmp/bundle.tar.gz", "--passphrase", "pw", "--yes"]);
    expect(ipc.calls[0]?.method).toBe("data.import");
    expect(out.stdout).toContain("[ok] restored 5 credentials");
  });

  it("prints the warn line when oauthEntriesFlagged > 0", async () => {
    const ipc = createMockIpcClient([{ credentialsRestored: 1, oauthEntriesFlagged: 2 }]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runData(["import", "/tmp/b.tar.gz", "--passphrase", "pw", "--yes"]);
    expect(out.stdout).toContain("[warn]");
    expect(out.stdout).toContain("OAuth entries may require re-auth");
  });
});

describe("runData delete", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("rejects when --service is missing", async () => {
    setFixture({ gatewayState: { socketPath: "/tmp/fake.sock" } });
    await expect(runData(["delete"])).rejects.toThrow("Usage: nimbus data delete");
  });

  it("dry-run path prints preflight counts and does NOT call delete a second time", async () => {
    const ipc = createMockIpcClient([
      {
        preflight: { itemsToDelete: 42, vaultEntriesToDelete: 3 },
        deleted: false,
      },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runData(["delete", "--service", "github", "--dry-run"]);
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0]).toEqual({
      method: "data.delete",
      params: { service: "github", dryRun: true },
    });
    expect(out.stdout).toContain("Service: github");
    expect(out.stdout).toContain("Items to delete: 42");
    expect(out.stdout).toContain("Vault entries to delete: 3");
  });

  it("non-dry-run path issues two data.delete calls when --yes is given", async () => {
    const ipc = createMockIpcClient([
      {
        preflight: { itemsToDelete: 1, vaultEntriesToDelete: 0 },
        deleted: false,
      },
      { deleted: true },
    ]);
    setFixture({
      gatewayState: { socketPath: "/tmp/fake.sock" },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runData(["delete", "--service", "linear", "--yes"]);
    expect(ipc.calls).toHaveLength(2);
    expect(ipc.calls[1]).toEqual({
      method: "data.delete",
      params: { service: "linear", dryRun: false },
    });
    expect(out.stdout).toContain("[ok] deletion complete");
  });
});
