import { afterEach, describe, expect, it } from "bun:test";

import {
  type ConfirmPrompt,
  dispatchTeamCommand,
  handleConsentNotification,
  registerConsentListener,
  renderAuditTable,
  runConsentListener,
  runTeamFederationRpc,
  runTeamWithIo,
  type TeamClient,
  type TeamRpcClient,
} from "./team.ts";

function fakeClient(result: unknown = { ok: true }): {
  client: TeamRpcClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client: TeamRpcClient = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return result as never;
    },
  };
  return { client, calls };
}

function throwingClient(): TeamRpcClient {
  return {
    call: async () => {
      throw new Error("rpc down");
    },
  };
}

/** A full {@link TeamClient} (call + lifecycle + notifications) recording its interactions, so the
 *  connect → dispatch → disconnect orchestration and the consent-listener registration are testable
 *  without a live gateway. */
function fakeTeamClient(result: unknown = { ok: true }): {
  client: TeamClient;
  calls: Array<{ method: string; params: unknown }>;
  notifications: Array<{ method: string; handler: (params: unknown) => void }>;
  connects: number;
  disconnects: number;
  state: { connects: number; disconnects: number };
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const notifications: Array<{ method: string; handler: (params: unknown) => void }> = [];
  const state = { connects: 0, disconnects: 0 };
  const client: TeamClient = {
    call: async (method: string, params?: unknown) => {
      calls.push({ method, params });
      return result as never;
    },
    connect: async () => {
      state.connects += 1;
    },
    disconnect: async () => {
      state.disconnects += 1;
    },
    onNotification: (method, handler) => {
      notifications.push({ method, handler });
    },
  };
  return {
    client,
    calls,
    notifications,
    get connects() {
      return state.connects;
    },
    get disconnects() {
      return state.disconnects;
    },
    state,
  };
}

/** Sentinel thrown by the injected `exit` seam so a test can assert the exit code without killing
 *  the runner. */
class TestExit extends Error {
  constructor(readonly code: number) {
    super(`exit(${code})`);
  }
}

function fakeExit(code: number): never {
  throw new TestExit(code);
}

// respondToConsent (consent case) + the consent-error arm set process.exitCode; reset per the
// bun-test-exit-code-leak lesson (explicitly = 0, never restore undefined).
afterEach(() => {
  process.exitCode = 0;
});

describe("runTeamFederationRpc", () => {
  it("discover calls federation.discover", async () => {
    const { client, calls } = fakeClient({ peers: [] });
    await runTeamFederationRpc(client, { kind: "discover" });
    expect(calls[0]).toEqual({ method: "federation.discover", params: {} });
  });

  it("namespacePublish calls federation.namespace.publish with name+filters", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, {
      kind: "namespacePublish",
      name: "project:zurich",
      filters: [{ kind: "type", value: "issue" }],
    });
    expect(calls[0]).toEqual({
      method: "federation.namespace.publish",
      params: { name: "project:zurich", filters: [{ kind: "type", value: "issue" }] },
    });
  });

  it("namespaceGrant maps standing → standingConsent", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, {
      kind: "namespaceGrant",
      namespace: "ns",
      peerId: "peer:abc",
      role: "viewer",
      standing: true,
    });
    expect(calls[0]).toEqual({
      method: "federation.namespace.grant",
      params: { namespace: "ns", peerId: "peer:abc", role: "viewer", standingConsent: true },
    });
  });

  it("namespaceRevoke calls federation.namespace.revoke", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, {
      kind: "namespaceRevoke",
      namespace: "ns",
      peerId: "peer:abc",
    });
    expect(calls[0]).toEqual({
      method: "federation.namespace.revoke",
      params: { namespace: "ns", peerId: "peer:abc" },
    });
  });

  it("query calls federation.ask", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, {
      kind: "query",
      namespace: "ns",
      peerId: "peer:abc",
      purpose: "find auth bugs",
    });
    expect(calls[0]).toEqual({
      method: "federation.ask",
      params: { peerId: "peer:abc", namespace: "ns", purpose: "find auth bugs" },
    });
  });

  it("whoKnows calls federation.askExpertise with who-knows purpose", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, {
      kind: "whoKnows",
      peerId: "peer:abc",
      query: "kafka tuning",
    });
    expect(calls[0]).toEqual({
      method: "federation.askExpertise",
      params: { peerId: "peer:abc", query: "kafka tuning", purpose: "who-knows" },
    });
  });

  it("pair calls federation.pair", async () => {
    const { client, calls } = fakeClient();
    await runTeamFederationRpc(client, { kind: "pair", host: "h.test", code: "CODE" });
    expect(calls[0]).toEqual({
      method: "federation.pair",
      params: { host: "h.test", code: "CODE" },
    });
  });

  it("consent (matched) submits federation.consentRespond and leaves exitCode 0", async () => {
    const { client, calls } = fakeClient({ matched: true });
    await runTeamFederationRpc(client, { kind: "consent", requestId: "r1", approved: true });
    expect(calls[0]).toEqual({
      method: "federation.consentRespond",
      params: { requestId: "r1", approved: true },
    });
    expect(process.exitCode).not.toBe(1);
  });

  it("consent (unmatched) sets exitCode 1", async () => {
    const { client } = fakeClient({ matched: false });
    await runTeamFederationRpc(client, { kind: "consent", requestId: "r1", approved: false });
    expect(process.exitCode).toBe(1);
  });

  it("consent (rpc error) sets exitCode 1", async () => {
    await runTeamFederationRpc(throwingClient(), {
      kind: "consent",
      requestId: "r1",
      approved: true,
    });
    expect(process.exitCode).toBe(1);
  });

  it("audit (rows) calls team.auditMerged", async () => {
    const { client, calls } = fakeClient({ entries: [{ peerId: "p", timestamp: 1735790645000 }] });
    await runTeamFederationRpc(client, {
      kind: "audit",
      namespace: "ns",
      purpose: "why",
      sinceMs: 0,
    });
    expect(calls[0]).toEqual({
      method: "team.auditMerged",
      params: { namespace: "ns", purpose: "why", sinceMs: 0 },
    });
  });

  it("audit (no entries array) takes the empty branch without throwing", async () => {
    const { client } = fakeClient({}); // r.entries undefined → Array.isArray false → []
    await expect(
      runTeamFederationRpc(client, {
        kind: "audit",
        namespace: "ns",
        purpose: "why",
        sinceMs: 5,
      }),
    ).resolves.toBeUndefined();
  });
});

describe("renderAuditTable / cellText", () => {
  it("renders only a header for an empty timeline", () => {
    const out = renderAuditTable([]);
    expect(out).toContain("TIMESTAMP");
    expect(out).toContain("HASH");
    expect(out.split("\n")).toHaveLength(1);
  });

  it("formats numeric timestamps as ISO, coerces primitives, blanks objects, truncates hash", () => {
    const out = renderAuditTable([
      {
        timestamp: 1735790645000,
        peerId: "peer:abc",
        actionType: "github.issue.create",
        hitlStatus: "approved",
        hash: "abcdef1234567890",
      },
      // Untyped JSON: exercise cellText's number/boolean arms and the object→"" else-arm.
      { timestamp: "n/a", peerId: 7, actionType: true, hitlStatus: { x: 1 }, hash: undefined },
    ]);
    expect(out).toContain(new Date(1735790645000).toISOString());
    expect(out).toContain("peer:abc");
    expect(out).toContain("github.issue.create");
    expect(out).toContain("abcdef123456"); // 12-char hash slice
    expect(out).toContain("n/a");
    expect(out).toContain("true"); // boolean coerced
  });
});

describe("handleConsentNotification", () => {
  const approve: ConfirmPrompt = async () => true;
  const deny: ConfirmPrompt = async () => false;
  const notCancelled = (_v: unknown): boolean => false;
  // clack's real isCancel only matches its module-private CANCEL_SYMBOL (verified: it returns false
  // for Symbol.for/Symbol), so the cancel branch is reachable ONLY by injecting the predicate.
  const CANCEL = Symbol("test-cancel");
  const cancelPrompt: ConfirmPrompt = async () => CANCEL;
  const isCancelled = (v: unknown): boolean => v === CANCEL;

  it("approve → consentRespond(approved:true)", async () => {
    const { client, calls } = fakeClient();
    await handleConsentNotification(
      client,
      { requestId: "r1", peerId: "p", namespace: "ns", purpose: "why" },
      approve,
      notCancelled,
    );
    expect(calls[0]).toEqual({
      method: "federation.consentRespond",
      params: { requestId: "r1", approved: true },
    });
  });

  it("deny → consentRespond(approved:false)", async () => {
    const { client, calls } = fakeClient();
    await handleConsentNotification(client, { requestId: "r1" }, deny, notCancelled);
    expect(calls[0]).toEqual({
      method: "federation.consentRespond",
      params: { requestId: "r1", approved: false },
    });
  });

  it("cancel → no consentRespond call (left to time out)", async () => {
    const { client, calls } = fakeClient();
    await handleConsentNotification(client, { requestId: "r1" }, cancelPrompt, isCancelled);
    expect(calls).toHaveLength(0);
  });

  it("non-string requestId → no call", async () => {
    const { client, calls } = fakeClient();
    await handleConsentNotification(client, { requestId: 123 }, approve, notCancelled);
    expect(calls).toHaveLength(0);
  });

  it("null params → no call (does not throw on property access)", async () => {
    const { client, calls } = fakeClient();
    await expect(
      handleConsentNotification(client, null, approve, notCancelled),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("non-object params (a number) → no call", async () => {
    const { client, calls } = fakeClient();
    await expect(
      handleConsentNotification(client, 42, approve, notCancelled),
    ).resolves.toBeUndefined();
    expect(calls).toHaveLength(0);
  });

  it("swallows an rpc error and writes it to stderr (no throw)", async () => {
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        handleConsentNotification(throwingClient(), { requestId: "r1" }, approve, notCancelled),
      ).resolves.toBeUndefined();
    } finally {
      process.stderr.write = origWrite;
    }
    expect(captured).toContain("Error sending consent decision");
  });
});

describe("runTeamWithIo", () => {
  it("prints the parse error and exits 1 on an invalid subcommand", async () => {
    const { client } = fakeTeamClient();
    let readGatewayStateCalls = 0;
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        runTeamWithIo(["not-a-subcommand"], {
          readGatewayState: async () => {
            readGatewayStateCalls += 1;
            return { pid: 1, socketPath: "/sock" };
          },
          makeClient: () => client,
          exit: fakeExit,
        }),
      ).rejects.toBeInstanceOf(TestExit);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(captured.length).toBeGreaterThan(0);
    // Parse failed before any gateway state was read.
    expect(readGatewayStateCalls).toBe(0);
  });

  it("exits 1 when the gateway is not running", async () => {
    const origWrite = process.stderr.write.bind(process.stderr);
    let captured = "";
    process.stderr.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(
        runTeamWithIo(["discover"], {
          readGatewayState: async () => undefined,
          makeClient: () => {
            throw new Error("makeClient should not run when gateway is down");
          },
          exit: fakeExit,
        }),
      ).rejects.toBeInstanceOf(TestExit);
    } finally {
      process.stderr.write = origWrite;
    }
    expect(captured).toContain("Gateway is not running");
  });

  it("connects, dispatches a federation subcommand, and disconnects", async () => {
    const fake = fakeTeamClient({ peers: [] });
    await runTeamWithIo(["discover"], {
      readGatewayState: async () => ({ pid: 1, socketPath: "/sock" }),
      makeClient: (socketPath) => {
        expect(socketPath).toBe("/sock");
        return fake.client;
      },
      exit: fakeExit,
    });
    expect(fake.connects).toBe(1);
    expect(fake.calls[0]).toEqual({ method: "federation.discover", params: {} });
    expect(fake.disconnects).toBe(1);
  });
});

describe("dispatchTeamCommand", () => {
  const neverListen = async (): Promise<void> => {
    throw new Error("listen should not be invoked for this command");
  };

  it("returns after a team-vault subcommand handles it (no federation fall-through)", async () => {
    const fake = fakeTeamClient();
    await dispatchTeamCommand(fake.client, { kind: "vaultList" }, neverListen);
    expect(fake.calls[0]?.method).toBe("teamvault.list");
    expect(fake.disconnects).toBe(1);
  });

  it("invokes the injected listen seam for the listen subcommand", async () => {
    const fake = fakeTeamClient();
    let listened: TeamClient | undefined;
    await dispatchTeamCommand(fake.client, { kind: "listen" }, async (c) => {
      listened = c;
    });
    expect(listened).toBe(fake.client);
    expect(fake.disconnects).toBe(1);
  });

  it("falls through to the federation dispatch, then disconnects", async () => {
    const fake = fakeTeamClient({ peers: [] });
    await dispatchTeamCommand(fake.client, { kind: "discover" }, neverListen);
    expect(fake.calls[0]?.method).toBe("federation.discover");
    expect(fake.disconnects).toBe(1);
  });

  it("disconnects even when the dispatch throws", async () => {
    const fake = fakeTeamClient();
    fake.client.call = async () => {
      throw new Error("rpc down");
    };
    await expect(
      dispatchTeamCommand(fake.client, { kind: "discover" }, neverListen),
    ).rejects.toThrow("rpc down");
    expect(fake.disconnects).toBe(1);
  });
});

describe("registerConsentListener", () => {
  it("writes the banner and registers a consent-request handler", () => {
    const fake = fakeTeamClient();
    const origWrite = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      captured += typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8");
      return true;
    }) as typeof process.stdout.write;
    try {
      registerConsentListener(fake.client);
    } finally {
      process.stdout.write = origWrite;
    }
    expect(captured).toContain("Listening for federation consent requests");
    expect(fake.notifications[0]?.method).toBe("federation.consentRequest");
  });

  it("the registered handler dispatches to handleConsentNotification (no-op on a payload without requestId)", () => {
    const fake = fakeTeamClient();
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      registerConsentListener(fake.client);
    } finally {
      process.stdout.write = origWrite;
    }
    // Invoke with a payload lacking requestId so the real clack `confirm` is never reached.
    expect(() => fake.notifications[0]?.handler({})).not.toThrow();
  });
});

describe("runConsentListener", () => {
  it("registers the listener then waits (never resolving)", async () => {
    const fake = fakeTeamClient();
    const origWrite = process.stdout.write.bind(process.stdout);
    process.stdout.write = (() => true) as typeof process.stdout.write;
    try {
      // Fire-and-forget: the listener runs until interrupted, so we never await it.
      void runConsentListener(fake.client);
      // The synchronous registration prefix has run by the next microtask.
      await Promise.resolve();
    } finally {
      process.stdout.write = origWrite;
    }
    expect(fake.notifications[0]?.method).toBe("federation.consentRequest");
  });
});
