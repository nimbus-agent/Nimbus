import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createRpcFixture, type RpcFixture } from "../../../test/helpers/rpc-harness.ts";
import type { ConnectorRpcError } from "../connector-rpc-shared.ts";
import type { ConnectorRpcHandlerContext } from "./context.ts";
import { handleConnectorSync } from "./lifecycle.ts";

let fixture: RpcFixture;

beforeEach(() => {
  fixture = createRpcFixture();
  fixture.localIndex.ensureConnectorSchedulerRegistration("github", 60_000, 1_700_000_000_000);
});

afterEach(() => {
  fixture.cleanup();
});

type StubScheduler = ConnectorRpcHandlerContext["syncScheduler"];

function makeStubScheduler(): {
  stub: StubScheduler;
  calls: { forced: string[] };
} {
  const calls = { forced: [] as string[] };
  const stub = {
    async forceSync(id: string): Promise<void> {
      calls.forced.push(id);
    },
  } as unknown as StubScheduler;
  return { stub, calls };
}

function buildCtx(
  rec: Record<string, unknown> | undefined,
  scheduler?: StubScheduler,
): ConnectorRpcHandlerContext {
  return {
    rec,
    vault: fixture.vault,
    localIndex: fixture.localIndex,
    openUrl: async () => {},
    syncScheduler: scheduler,
    connectorMesh: undefined,
    notify: fixture.notify,
  };
}

describe("handleConnectorSync", () => {
  test("undefined syncScheduler -> -32603", async () => {
    try {
      await handleConnectorSync(buildCtx({ serviceId: "github" }));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32603);
      expect((e as ConnectorRpcError).message).toContain("not available");
    }
  });

  test("unknown service -> -32602 (via requireRegisteredSchedulerServiceId)", async () => {
    const { stub: scheduler } = makeStubScheduler();
    try {
      await handleConnectorSync(buildCtx({ serviceId: "slack" }, scheduler));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
    }
  });

  test("happy path calls scheduler.forceSync", async () => {
    const { stub: scheduler, calls } = makeStubScheduler();
    const r = await handleConnectorSync(buildCtx({ serviceId: "github" }, scheduler));
    expect(r.kind).toBe("hit");
    expect(calls.forced).toEqual(["github"]);
  });

  test("full: true triggers clearConnectorSyncCursor before scheduling", async () => {
    const { stub: scheduler, calls } = makeStubScheduler();
    let cleared = false;
    const origClear = fixture.localIndex.clearConnectorSyncCursor.bind(fixture.localIndex);
    fixture.localIndex.clearConnectorSyncCursor = (id: string): void => {
      cleared = true;
      origClear(id);
    };
    const r = await handleConnectorSync(buildCtx({ serviceId: "github", full: true }, scheduler));
    expect(r.kind).toBe("hit");
    expect(cleared).toBe(true);
    expect(calls.forced).toEqual(["github"]);
  });

  test("full: false does not clear the cursor", async () => {
    const { stub: scheduler } = makeStubScheduler();
    let cleared = false;
    fixture.localIndex.clearConnectorSyncCursor = (): void => {
      cleared = true;
    };
    await handleConnectorSync(buildCtx({ serviceId: "github", full: false }, scheduler));
    expect(cleared).toBe(false);
  });
});

describe("handleConnectorSync — gateway-side syncables", () => {
  // Regression: these four are registered with the scheduler by assemble.ts but
  // have no catalog entry, so the validator rejected every one of them with
  // "Invalid serviceId". That broke `nimbus connector sync filesystem` — the
  // command `nimbus init` and the README both hand a first-time user — and left
  // `init` unable to print a real file:line. Caught only by running the funnel
  // against a real gateway; the unit tests injected a fake sync.
  for (const id of ["filesystem", "blame", "openapi", "obsidian"]) {
    test(`${id} is accepted once registered, and reaches forceSync`, async () => {
      fixture.localIndex.ensureConnectorSchedulerRegistration(id, 600_000, 1_700_000_000_000);
      const { stub: scheduler, calls } = makeStubScheduler();
      await handleConnectorSync(buildCtx({ serviceId: id }, scheduler));
      expect(calls.forced).toEqual([id]);
    });
  }

  test("a gateway-syncable id that is NOT registered is still rejected", async () => {
    // Being on the allowlist widens which NAMES are addressable; it must not
    // authorise a sync of something this machine never registered.
    const { stub: scheduler, calls } = makeStubScheduler();
    try {
      await handleConnectorSync(buildCtx({ serviceId: "obsidian" }, scheduler));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("Unknown connector");
    }
    expect(calls.forced).toEqual([]);
  });

  test("junk that merely looks local is still Invalid serviceId", async () => {
    const { stub: scheduler } = makeStubScheduler();
    try {
      await handleConnectorSync(buildCtx({ serviceId: "filesystem-v2" }, scheduler));
      throw new Error("expected throw");
    } catch (e) {
      expect((e as ConnectorRpcError).rpcCode).toBe(-32602);
      expect((e as ConnectorRpcError).message).toContain("Invalid serviceId");
    }
  });
});
