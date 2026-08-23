import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { McpListResult } from "@nimbus-dev/sdk/connector-kit";
import { z } from "zod";

import { verifyAuditChain } from "./audit-chain.ts";
import { resetConnectorModeForTests, setConnectorMode } from "./connector-mode.ts";
import { type ConsentServer, createWriteToolRegistrar } from "./consent-kit.ts";

type Registered = { name: string };

/**
 * `capsReadable` models the real SDK: `getClientCapabilities()` returns undefined until the
 * client's `initialize` has been received. A fake that answers synchronously from construction
 * would hide the entire bug this suite exists to prevent.
 */
function fakeServer(opts: {
  elicitation: boolean;
}): ConsentServer & { registered: Registered[]; handshake: () => void } {
  const registered: Registered[] = [];
  let capsReadable = false;
  const srv = {
    registered,
    server: {
      getClientCapabilities: () =>
        capsReadable ? (opts.elicitation ? { elicitation: {} } : {}) : undefined,
      oninitialized: undefined as (() => void) | undefined,
      elicitInput: () => Promise.resolve({ action: "accept" as const, content: { confirm: true } }),
    },
    registerTool: (name: string) => {
      registered.push({ name });
      return { disable: () => undefined };
    },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
    /** Simulate the client's `initialize` completing. */
    handshake: () => {
      capsReadable = true;
      srv.server.oninitialized?.();
    },
  } as unknown as ConsentServer & { registered: Registered[]; handshake: () => void };
  return srv;
}

const schema = z.object({ branch: z.string() });

async function tempAuditPath(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "nimbus-consent-"));
  return join(dir, "audit.jsonl");
}

function ok(): McpListResult {
  return { content: [{ type: "text" as const, text: "{}" }] };
}

function cfgFor() {
  return {
    mutates: "repo.branch.delete",
    recoverable: false,
    capturePreState: () => Promise.resolve({ sha: "abc" }),
    scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
  };
}

describe("write tool registration", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("gateway mode registers the write tool — executor.ts is the gate there", () => {
    setConnectorMode("gateway");
    const srv = fakeServer({ elicitation: false });
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());
    // No handshake needed: the gateway does not consult client capabilities at all.
    expect(srv.registered.map((r) => r.name)).toEqual(["github_branch_delete"]);
  });

  test("standalone WITHOUT elicitation does not register the tool at all", () => {
    setConnectorMode("standalone");
    const srv = fakeServer({ elicitation: false });
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());
    srv.handshake();
    expect(srv.registered).toEqual([]);
  });

  test("standalone WITH elicitation registers it AFTER the handshake", () => {
    setConnectorMode("standalone");
    const srv = fakeServer({ elicitation: true });
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());

    // THE REGRESSION GUARD. Capabilities are unknowable at module scope — verified against the
    // real SDK, where getClientCapabilities() returns undefined before initialize. A registrar
    // that decided here would register nothing, for every client, forever.
    expect(srv.registered).toEqual([]);

    srv.handshake();
    expect(srv.registered.map((r) => r.name)).toEqual(["github_branch_delete"]);
  });

  test("a second initialize does not double-register", () => {
    setConnectorMode("standalone");
    const srv = fakeServer({ elicitation: true });
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    reg("github_branch_delete", cfgFor(), "desc", schema, async () => ok());
    srv.handshake();
    srv.handshake();
    expect(srv.registered).toHaveLength(1);
  });

  test("a config with recoverable:false and NO capturePreState is rejected at registration", () => {
    setConnectorMode("gateway");
    const srv = fakeServer({ elicitation: true });
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "X",
      scopeKinds: ["repo"],
    });
    expect(() =>
      reg(
        "github_branch_delete",
        {
          mutates: "repo.branch.delete",
          recoverable: false,
          // capturePreState deliberately absent — that is what this case asserts.
          scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
        },
        "desc",
        schema,
        async () => ok(),
      ),
    ).toThrow(/capturePreState is required when recoverable is false/);
  });
});

type Elicit = (p: { message: string }) => Promise<{
  action: "accept" | "decline" | "cancel";
  content?: Record<string, unknown>;
}>;

type FakeServer = ConsentServer & {
  captured: ((args: unknown) => Promise<McpListResult>) | undefined;
  onUnregister?: () => void;
  /** Simulate the client's `initialize` completing, which is what flushes the write tools. */
  handshake: () => void;
};

function serverWith(elicit: Elicit): FakeServer {
  let capsReadable = false;
  const srv: FakeServer = {
    captured: undefined,
    server: {
      // Mirrors the real SDK: undefined until initialize.
      getClientCapabilities: () => (capsReadable ? { elicitation: {} } : undefined),
      oninitialized: undefined,
      elicitInput: (p: { message: string }) => elicit(p),
    },
    registerTool: (
      _name: string,
      _config: unknown,
      cb: (args: unknown) => Promise<McpListResult>,
    ) => {
      srv.captured = cb;
      return {
        disable: () => {
          srv.onUnregister?.();
        },
      };
    },
    sendToolListChanged: () => undefined,
    sendLoggingMessage: () => Promise.resolve(),
    handshake: () => {
      capsReadable = true;
      srv.server.oninitialized?.();
    },
  } as unknown as FakeServer;
  return srv;
}

/** Register one write tool and hand back the WRAPPED handler the client would call. */
function registerAndGet(
  srv: FakeServer,
  handler: () => Promise<McpListResult>,
  opts: { scope?: string | undefined; budget?: number; auditLog?: string } = {},
): (args: { branch: string }) => Promise<McpListResult> {
  // `"scope" in opts` distinguishes an OMITTED scope (default to a permissive one, so consent
  // cases are not accidentally testing the scope gate) from an explicitly `undefined` one, which
  // is how the empty-scope case asks for a genuinely unset allow-list.
  const scope = "scope" in opts ? opts.scope : "repo:acme/api";
  process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = scope ?? "";
  process.env["NIMBUS_MCP_WRITE_BUDGET"] = String(opts.budget ?? 10);
  if (opts.auditLog !== undefined) process.env["NIMBUS_MCP_AUDIT_LOG"] = opts.auditLog;
  else delete process.env["NIMBUS_MCP_AUDIT_LOG"];

  const reg = createWriteToolRegistrar(srv, {
    connector: "github",
    scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
    scopeKinds: ["repo"],
  });
  reg(
    "github_branch_delete",
    {
      mutates: "repo.branch.delete",
      recoverable: false,
      capturePreState: () => Promise.resolve({ sha: "abc" }),
      scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
    },
    "Delete a branch.",
    z.object({ branch: z.string() }),
    handler,
  );
  // Standalone write tools are queued at registration and flushed on initialize. Without this the
  // tool is never registered and `captured` stays undefined — which is the bug, not the test.
  srv.handshake();
  const cb = srv.captured;
  if (cb === undefined) throw new Error("tool was not registered");
  return (args) => cb(args);
}

describe("elicitation consent", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("accept with confirm:true runs the handler exactly once", async () => {
    let calls = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    await call({ branch: "acme/api" });
    expect(calls).toBe(1);
  });

  for (const action of ["decline", "cancel"] as const) {
    test(`${action} mutates NOTHING`, async () => {
      let calls = 0;
      const srv = serverWith(() => Promise.resolve({ action }));
      const call = registerAndGet(srv, async () => {
        calls += 1;
        return ok();
      });
      const res = await call({ branch: "acme/api" });
      expect(calls).toBe(0);
      expect(JSON.stringify(res)).toMatch(/not approved/i);
    });
  }

  test("accept with confirm:false is a REFUSAL — the action field alone is not consent", async () => {
    let calls = 0;
    const srv = serverWith(() =>
      Promise.resolve({ action: "accept", content: { confirm: false } }),
    );
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    await call({ branch: "acme/api" });
    expect(calls).toBe(0);
  });

  test("an elicitation that THROWS (timeout, transport) mutates nothing — fail-closed", async () => {
    let calls = 0;
    const srv = serverWith(() => Promise.reject(new Error("timed out")));
    const call = registerAndGet(srv, async () => {
      calls += 1;
      return ok();
    });
    const res = await call({ branch: "acme/api" });
    expect(calls).toBe(0);
    expect(JSON.stringify(res)).toMatch(/not approved/i);
  });

  test("the prompt carries the VERBATIM params, never a digest", async () => {
    let seen = "";
    const srv = serverWith((p) => {
      seen = p.message;
      return Promise.resolve({ action: "decline" });
    });
    const call = registerAndGet(srv, async () => ok());
    await call({ branch: "acme/api" });
    expect(seen).toContain("repo.branch.delete");
    expect(seen).toContain("acme/api");
  });
});

describe("client-independent controls", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("an out-of-scope target refuses BEFORE prompting — no human is asked to allow it", async () => {
    let prompted = 0;
    const srv = serverWith(() => {
      prompted += 1;
      return Promise.resolve({ action: "accept", content: { confirm: true } });
    });
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api" });
    const res = await call({ branch: "acme/other" });
    expect(prompted).toBe(0);
    expect(JSON.stringify(res)).toMatch(/out of scope/i);
  });

  test("an EMPTY scope refuses every mutation — unset is not unrestricted", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const call = registerAndGet(srv, async () => ok(), { scope: undefined });
    expect(JSON.stringify(await call({ branch: "acme/api" }))).toMatch(/out of scope/i);
  });

  test("budget exhaustion unregisters the tool AND still refuses a call that arrives", async () => {
    let unregistered = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    srv.onUnregister = () => {
      unregistered += 1;
    };
    const call = registerAndGet(srv, async () => ok(), { scope: "repo:acme/api", budget: 1 });
    await call({ branch: "acme/api" });
    expect(unregistered).toBe(1);
    // A call already in flight, or a client ignoring list_changed, still reaches the handler.
    expect(JSON.stringify(await call({ branch: "acme/api" }))).toMatch(/budget/i);
  });

  test("capturePreState runs before the mutation and reaches the audit log", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const log = await tempAuditPath();
    const call = registerAndGet(srv, async () => ok(), {
      scope: "repo:acme/api",
      auditLog: log,
    });
    await call({ branch: "acme/api" });
    const text = await readFile(log, "utf8");
    expect(text).toContain('"preState"');
    expect(text).toContain("abc");
    expect(await verifyAuditChain(log)).toMatchObject({ ok: true });
  });

  test("a refusal is audited too — the log records what was NOT allowed", async () => {
    const srv = serverWith(() => Promise.resolve({ action: "decline" }));
    const log = await tempAuditPath();
    const call = registerAndGet(srv, async () => ok(), {
      scope: "repo:acme/api",
      auditLog: log,
    });
    await call({ branch: "acme/api" });
    expect(await readFile(log, "utf8")).toContain('"declined"');
  });
});

describe("empty-scope startup warning", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("warns on STDERR when the scope env is unset — stdout is the JSON-RPC channel", () => {
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "";
      createWriteToolRegistrar(
        serverWith(() => Promise.resolve({ action: "decline" })),
        {
          connector: "github",
          scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
          scopeKinds: ["repo"],
        },
      );
    } finally {
      process.stderr.write = realWrite;
    }
    expect(written.join("")).toMatch(/is unset or empty, so every write tool will refuse/);
  });

  test("does NOT warn when a scope is configured", () => {
    const written: string[] = [];
    const realWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = (chunk: string) => {
      written.push(String(chunk));
      return true;
    };
    try {
      process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "repo:acme/api";
      createWriteToolRegistrar(
        serverWith(() => Promise.resolve({ action: "decline" })),
        {
          connector: "github",
          scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
          scopeKinds: ["repo"],
        },
      );
    } finally {
      process.stderr.write = realWrite;
    }
    expect(written.join("")).toBe("");
  });
});

describe("pre-state capture failure", () => {
  beforeEach(() => {
    resetConnectorModeForTests();
    setConnectorMode("standalone");
  });
  afterEach(() => {
    resetConnectorModeForTests();
  });

  test("a THROWING capturePreState does not block an approved mutation", async () => {
    // Refusing here would turn a transient read error into a blocked action the owner had already
    // approved. The behaviour shipped in Part 1; nothing proved it until now.
    let mutated = 0;
    const srv = serverWith(() => Promise.resolve({ action: "accept", content: { confirm: true } }));
    const log = await tempAuditPath();
    // BEFORE the registrar is constructed: it reads scope and audit-log env once, at startup, so
    // the model can never influence them mid-session. Setting them afterwards is a no-op.
    process.env["NIMBUS_MCP_TEST_WRITE_SCOPE"] = "repo:acme/api";
    process.env["NIMBUS_MCP_AUDIT_LOG"] = log;
    const reg = createWriteToolRegistrar(srv, {
      connector: "github",
      scopeEnv: "NIMBUS_MCP_TEST_WRITE_SCOPE",
      scopeKinds: ["repo"],
    });
    reg(
      "github_branch_delete",
      {
        mutates: "github.branch.delete",
        recoverable: false,
        capturePreState: () => Promise.reject(new Error("ref lookup failed")),
        scopeTargetOf: (a: { branch: string }) => ({ kind: "repo", value: a.branch }),
      },
      "Delete a branch.",
      z.object({ branch: z.string() }),
      async () => {
        mutated += 1;
        return ok();
      },
    );
    srv.handshake();
    const cb = srv.captured;
    if (cb === undefined) throw new Error("tool was not registered");
    await cb({ branch: "acme/api" });

    expect(mutated).toBe(1);
    const text = await readFile(log, "utf8");
    // The failure is RECORDED, so the audit trail says the pre-state is missing rather than
    // silently implying none was needed.
    expect(text).toContain("captureFailed");
    expect(text).toContain("ref lookup failed");
    expect(text).toContain('"executed"');
  });
});
