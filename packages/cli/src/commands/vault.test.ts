import { afterAll, afterEach, beforeEach, describe, expect, it } from "bun:test";

import {
  CLACK_CANCEL,
  clearFixture,
  FAKE_SOCKET_PATH,
  setFixture,
} from "../../test/helpers/cli-mocks.ts";
import { captureOutput } from "../../test/helpers/cli-output.ts";
import { createMockIpcClient } from "../../test/helpers/mock-ipc-client.ts";

const vaultMod = await import("./vault.ts");
const { runVault, runVaultDelete, runVaultGet, runVaultList, runVaultSet } = vaultMod;

const out = captureOutput();

afterAll(() => {
  out.restore();
});

describe("runVaultSet", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls vault.set with the right key/value and prints Stored.", async () => {
    const { client, calls } = createMockIpcClient([null]);
    await runVaultSet(client, "github.pat", "ghp_test");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual({
      method: "vault.set",
      params: { key: "github.pat", value: "ghp_test" },
    });
    expect(out.stdout).toBe("Stored.\n");
  });

  it("propagates the IPC error when vault.set throws", async () => {
    const { client } = createMockIpcClient([new Error("vault locked")]);
    await expect(runVaultSet(client, "key", "value")).rejects.toThrow("vault locked");
  });
});

describe("runVaultGet", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, clackAnswer: true });
  });
  afterEach(() => {
    clearFixture();
  });

  it("prints the value when confirm returns true", async () => {
    const { client, calls } = createMockIpcClient(["ghp_test"]);
    await runVaultGet(client, "github.pat");
    expect(calls[0]).toEqual({ method: "vault.get", params: { key: "github.pat" } });
    expect(out.stdout).toBe("ghp_test\n");
  });

  it("prints (not set) when value is null", async () => {
    const { client } = createMockIpcClient([null]);
    await runVaultGet(client, "missing.key");
    expect(out.stdout).toBe("(not set)\n");
  });

  it("returns silently without calling vault.get when confirm is cancelled", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, clackAnswer: CLACK_CANCEL });
    const { client, calls } = createMockIpcClient([]);
    await runVaultGet(client, "github.pat");
    expect(calls).toHaveLength(0);
    expect(out.stdout).toBe("");
  });

  it("returns silently when confirm returns false", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH }, clackAnswer: false });
    const { client, calls } = createMockIpcClient([]);
    await runVaultGet(client, "github.pat");
    expect(calls).toHaveLength(0);
  });
});

describe("runVaultDelete", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls vault.delete and prints the confirmation message", async () => {
    const { client, calls } = createMockIpcClient([null]);
    await runVaultDelete(client, "github.pat");
    expect(calls[0]).toEqual({ method: "vault.delete", params: { key: "github.pat" } });
    expect(out.stdout).toBe("Deleted (if it existed).\n");
  });
});

describe("runVaultList", () => {
  beforeEach(() => {
    out.reset();
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
  });
  afterEach(() => {
    clearFixture();
  });

  it("calls vault.listKeys with no prefix and prints each key", async () => {
    const { client, calls } = createMockIpcClient([["github.pat", "openai.api_key"]]);
    await runVaultList(client);
    expect(calls[0]).toEqual({ method: "vault.listKeys", params: {} });
    expect(out.stdout).toBe("github.pat\nopenai.api_key\n");
  });

  it("passes the prefix when provided", async () => {
    const { client, calls } = createMockIpcClient([["github.pat"]]);
    await runVaultList(client, "github.");
    expect(calls[0]).toEqual({ method: "vault.listKeys", params: { prefix: "github." } });
    expect(out.stdout).toBe("github.pat\n");
  });

  it("produces empty output when no keys are returned", async () => {
    const { client } = createMockIpcClient([[]]);
    await runVaultList(client, "missing.");
    expect(out.stdout).toBe("");
  });
});

describe("runVault (dispatcher)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  it("throws when the gateway is not running", async () => {
    setFixture({});
    await expect(runVault(["set", "key", "value"])).rejects.toThrow(
      "Gateway is not running. Start with: nimbus start",
    );
  });

  it("rejects unknown subcommands", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runVault(["bogus"])).rejects.toThrow("Unknown vault subcommand: bogus");
  });

  it("reports an explicit '(none)' subcommand name when no subcommand is given", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runVault([])).rejects.toThrow("Unknown vault subcommand: (none)");
  });

  it("rejects vault set with missing args", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runVault(["set", "key"])).rejects.toThrow("Usage: nimbus vault set");
  });

  it("rejects vault get with missing key", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runVault(["get"])).rejects.toThrow("Usage: nimbus vault get");
  });

  it("rejects vault delete with missing key", async () => {
    setFixture({ gatewayState: { socketPath: FAKE_SOCKET_PATH } });
    await expect(runVault(["delete"])).rejects.toThrow("Usage: nimbus vault delete");
  });

  it("routes 'set' through withIpc and exercises the IPC client lifecycle", async () => {
    const ipc = createMockIpcClient([null]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runVault(["set", "github.pat", "ghp_test"]);
    expect(ipc.calls).toHaveLength(1);
    expect(ipc.calls[0]).toEqual({
      method: "vault.set",
      params: { key: "github.pat", value: "ghp_test" },
    });
    expect(out.stdout).toBe("Stored.\n");
  });

  it("routes 'get' through withIpc", async () => {
    const ipc = createMockIpcClient(["secret-value"]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      clackAnswer: true,
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runVault(["get", "github.pat"]);
    expect(ipc.calls[0]).toEqual({ method: "vault.get", params: { key: "github.pat" } });
    expect(out.stdout).toBe("secret-value\n");
  });

  it("routes 'delete' through withIpc", async () => {
    const ipc = createMockIpcClient([null]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runVault(["delete", "github.pat"]);
    expect(ipc.calls[0]).toEqual({ method: "vault.delete", params: { key: "github.pat" } });
    expect(out.stdout).toBe("Deleted (if it existed).\n");
  });

  it("routes 'list' through withIpc with no prefix", async () => {
    const ipc = createMockIpcClient([["a", "b"]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runVault(["list"]);
    expect(ipc.calls[0]).toEqual({ method: "vault.listKeys", params: {} });
    expect(out.stdout).toBe("a\nb\n");
  });

  it("routes 'list' through withIpc with a prefix", async () => {
    const ipc = createMockIpcClient([["a.x"]]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: { call: ipc.client.call, connect: () => {}, disconnect: () => {} },
    });
    await runVault(["list", "a."]);
    expect(ipc.calls[0]).toEqual({ method: "vault.listKeys", params: { prefix: "a." } });
  });
});

describe("runVault — the Gateway's HITL gate (F16)", () => {
  beforeEach(() => {
    out.reset();
  });
  afterEach(() => {
    clearFixture();
  });

  /**
   * A fake Gateway that behaves like the real one for `vault.set` / `vault.delete`: both are in
   * the HITL frozen set (`engine/executor.ts`, invariant I2) and `ipc/server/vault-dispatch.ts`
   * runs them through `toolExecutor.gate()` first, so the call does not resolve until the
   * `consent.request` it pushes has been answered with `consent.respond`. `ipc/consent.ts` has
   * no timer at all — `requestConsent` settles on a response or on client disconnect and on
   * nothing else.
   *
   * That is the seam the injected-client tests above cannot reach. They call `runVaultSet(client,
   * …)` with a client a test constructed, so they prove the CLI half against a fake and never
   * observe that nothing on the real connection can answer the gate. In production the result
   * was a flat 30s `IPC request timed out after 30000ms: vault.set` and nothing stored.
   */
  function consentAwareGateway(gatedMethods: readonly string[]): {
    readonly calls: Array<{ method: string; params: unknown }>;
    readonly fixtureClient: {
      call: (method: string, params: unknown) => Promise<unknown>;
      connect: () => void;
      disconnect: () => void;
      onNotification: (event: string, handler: (params: unknown) => void | Promise<void>) => void;
    };
  } {
    const calls: Array<{ method: string; params: unknown }> = [];
    let consentHandler: ((params: unknown) => void | Promise<void>) | undefined;
    return {
      calls,
      fixtureClient: {
        connect: (): void => {},
        disconnect: (): void => {},
        onNotification: (event, handler): void => {
          if (event === "consent.request") consentHandler = handler;
        },
        call: async (method, params): Promise<unknown> => {
          calls.push({ method, params });
          if (method === "consent.respond") return { ok: true };
          if (gatedMethods.includes(method)) {
            if (consentHandler === undefined) {
              throw new Error(
                `gateway is blocked on consent.request: the CLI registered no consent.request handler for ${method}`,
              );
            }
            await consentHandler({ requestId: `req-${method}`, prompt: `Approve ${method}?` });
          }
          return { ok: true };
        },
      },
    };
  }

  it("answers the consent.request that vault.set blocks on, and stores the secret", async () => {
    const gw = consentAwareGateway(["vault.set"]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: gw.fixtureClient,
      clackAnswer: true,
    });

    await runVault(["set", "azure.tenant_id", "6875a760"]);

    expect(gw.calls.map((c) => c.method)).toEqual(["vault.set", "consent.respond"]);
    expect(gw.calls[1]?.params).toEqual({ requestId: "req-vault.set", approved: true });
    expect(out.stdout).toBe("Stored.\n");
  });

  it("answers the consent.request that vault.delete blocks on", async () => {
    const gw = consentAwareGateway(["vault.delete"]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: gw.fixtureClient,
      clackAnswer: true,
    });

    await runVault(["delete", "azure.tenant_id"]);

    expect(gw.calls.map((c) => c.method)).toEqual(["vault.delete", "consent.respond"]);
    expect(out.stdout).toBe("Deleted (if it existed).\n");
  });

  it("relays the owner's REFUSAL rather than approving on their behalf", async () => {
    // The default handler must not be an auto-approver wearing a prompt's clothes: a HITL gate
    // that always answers yes is worse than one that hangs, because it silently performs the
    // mutation the owner declined.
    const gw = consentAwareGateway(["vault.set"]);
    setFixture({
      gatewayState: { socketPath: FAKE_SOCKET_PATH },
      ipcClient: gw.fixtureClient,
      clackAnswer: false,
    });

    await runVault(["set", "azure.tenant_id", "6875a760"]);

    expect(gw.calls[1]?.params).toEqual({ requestId: "req-vault.set", approved: false });
  });
});
