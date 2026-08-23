import type { McpListResult, ZodObjectSchema } from "@nimbus-dev/sdk/connector-kit";

import { type AuditOutcome, appendAuditEntry } from "./audit-chain.ts";
import { getConnectorMode } from "./connector-mode.ts";
import { parseWriteScope, scopeAllows } from "./write-scope.ts";

/** Mutations allowed per process lifetime when NIMBUS_MCP_WRITE_BUDGET is unset. */
const DEFAULT_BUDGET = 10;

/** The subset of the SDK's `RegisteredTool` this kit needs. */
export type ToolHandle = { disable(): void };

/**
 * The structural subset of `McpServer` the consent kit uses.
 *
 * Narrowed deliberately so tests can supply a fake without a transport, and so the kit's real
 * dependencies are visible in one place.
 */
export type ConsentServer = {
  readonly server: {
    getClientCapabilities(): { elicitation?: unknown } | undefined;
    /** Fired after the client's `initialize` — the FIRST moment capabilities are knowable. */
    oninitialized?: (() => void) | undefined;
    /**
     * `requestedSchema` is typed to the restricted JSON-Schema subset the MCP spec allows, not
     * `Record<string, unknown>`. The loose form does not satisfy the real `McpServer.elicitInput`,
     * which is only discoverable by passing a real server — a hand-written fake accepts anything.
     */
    elicitInput(
      params: {
        mode: "form";
        message: string;
        requestedSchema: {
          type: "object";
          properties: Record<
            string,
            { type: "boolean"; title?: string; description?: string; default?: boolean }
          >;
          required?: string[];
        };
      },
      options?: { timeout?: number },
    ): Promise<{
      action: "accept" | "decline" | "cancel";
      content?: Record<string, unknown> | undefined;
    }>;
  };
  /**
   * `inputSchema` is `unknown` on purpose. The real signature wants the SDK's
   * `ZodRawShapeCompat | AnySchema`, and the connector kit's `ZodObjectSchema["shape"]` is
   * `Record<string, unknown>` — neither is assignable to the other, so a concrete type here makes
   * a real `McpServer` fail to satisfy this interface. The value is passed straight through and
   * never inspected by this kit.
   */
  registerTool(
    name: string,
    config: { description?: string; inputSchema?: unknown },
    cb: (args: unknown) => Promise<McpListResult>,
  ): ToolHandle;
  sendToolListChanged(): void;
  sendLoggingMessage(params: { level: "info" | "warning"; data: unknown }): Promise<void>;
};

export type WriteToolConfig<T> = {
  /** Action type this tool performs, e.g. "repo.branch.delete". Machine-readable, not prose. */
  readonly mutates: string;
  /** False when the mutation cannot be undone — which is when pre-state capture is mandatory. */
  readonly recoverable: boolean;
  /** Required when `recoverable` is false. Runs BEFORE the mutation; result is audited verbatim. */
  readonly capturePreState?: (args: T) => Promise<Record<string, unknown>>;
  /** The scope target this invocation would touch, checked against the allow-list. */
  readonly scopeTargetOf: (args: T) => { kind: string; value: string };
};

export type WriteToolRegistrar = <T>(
  name: string,
  cfg: WriteToolConfig<T>,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
) => void;

function refused(why: string): McpListResult {
  return { content: [{ type: "text", text: JSON.stringify({ ok: false, error: why }) }] };
}

/**
 * Ask the human, through the client, and report whether they said yes.
 *
 * The prompt carries the VERBATIM operation and resolved parameters, never a digest — a digest is
 * a rubber stamp with extra steps, and the human is the entire trust boundary here.
 */
async function consented(
  server: ConsentServer,
  mutates: string,
  params: unknown,
): Promise<boolean> {
  let res: { action: string; content?: Record<string, unknown> | undefined };
  try {
    res = await server.server.elicitInput({
      mode: "form",
      message:
        `Nimbus is about to perform ${mutates} with:\n` +
        `${JSON.stringify(params, null, 2)}\n\nApprove?`,
      requestedSchema: {
        type: "object",
        properties: {
          confirm: { type: "boolean", title: "Approve this action", description: mutates },
        },
        required: ["confirm"],
      },
    });
  } catch {
    // Timeout, transport failure, or a client that rejects the request: fail CLOSED.
    return false;
  }
  // `action: "accept"` alone is not consent — the form's own answer must also be true, so a client
  // that auto-accepts without answering the question does not clear the gate.
  return res.action === "accept" && res.content?.["confirm"] === true;
}

function registerOn<T>(
  server: ConsentServer,
  name: string,
  description: string,
  schema: ZodObjectSchema<T>,
  handler: (args: T) => Promise<McpListResult>,
  handles: ToolHandle[],
): void {
  const handle = server.registerTool(
    name,
    { description, inputSchema: schema.shape },
    async (args: unknown): Promise<McpListResult> => {
      const parsed = schema.safeParse(args);
      if (!parsed.success) {
        throw new Error(parsed.error.message);
      }
      return handler(parsed.data);
    },
  );
  // Collected so budget exhaustion can disable every write tool at once.
  handles.push(handle);
}

/**
 * Build a connector's write-tool registrar.
 *
 * In `"gateway"` mode the raw handler is registered immediately: `executor.ts` (I2) is the gate
 * there, client capabilities are irrelevant, and the connector adds nothing.
 *
 * In `"standalone"` mode registration is QUEUED and flushed on `oninitialized`, because client
 * capabilities are not knowable at module scope — verified against the real SDK, where
 * `getClientCapabilities()` returns `undefined` before `initialize`. Deciding at registration time
 * would register nothing, for every client, forever.
 */
export function createWriteToolRegistrar(
  server: ConsentServer,
  cfg: {
    readonly connector: string;
    readonly scopeEnv: string;
    /**
     * Scope kinds this connector accepts. Declared once per connector rather than per tool: the
     * allow-list is parsed at registrar construction, before any tool has registered, so a
     * per-tool declaration would arrive too late to validate the env value.
     */
    readonly scopeKinds: readonly string[];
  },
): WriteToolRegistrar {
  const handles: ToolHandle[] = [];
  const pending: Array<() => void> = [];
  let flushed = false;

  const scope = parseWriteScope(process.env[cfg.scopeEnv], cfg.scopeKinds);
  const auditLog = process.env["NIMBUS_MCP_AUDIT_LOG"];
  let remaining = Number(process.env["NIMBUS_MCP_WRITE_BUDGET"] ?? DEFAULT_BUDGET);

  async function record(
    tool: string,
    outcome: AuditOutcome,
    detail: Record<string, unknown>,
  ): Promise<void> {
    // Client-visible channel: any MCP client can display or persist this.
    await server.sendLoggingMessage({
      level: outcome === "executed" ? "info" : "warning",
      data: { connector: cfg.connector, tool, outcome },
    });
    // Durable channel: only when the operator configured a path.
    if (auditLog !== undefined && auditLog !== "") {
      await appendAuditEntry(auditLog, {
        ts: new Date().toISOString(),
        connector: cfg.connector,
        tool,
        outcome,
        detail,
      });
    }
  }

  /**
   * Decide the write surface, once, at the first moment client capabilities are knowable.
   *
   * Default-DENY: if the client cannot prompt a human, the queued tools are dropped and never
   * appear in `tools/list` at all. Refusing at call time instead would still advertise a tool the
   * model must not use.
   */
  function flushWriteTools(): void {
    if (flushed) return;
    flushed = true;
    const caps = server.server.getClientCapabilities();
    if (caps?.elicitation === undefined) {
      pending.length = 0;
      return;
    }
    for (const register of pending) register();
    pending.length = 0;
    // The tool list changed after `initialize`, so the client must be told to re-read it.
    if (handles.length > 0) server.sendToolListChanged();
  }

  if (getConnectorMode() === "standalone") {
    // An empty scope denies every mutation, which is the correct default but looks identical to a
    // broken connector from the outside. Say so on stderr — safe for a stdio server, whose
    // PROTOCOL channel is stdout; writing this to stdout would corrupt the JSON-RPC stream.
    if (scope.length === 0) {
      process.stderr.write(
        `nimbus-mcp ${cfg.connector}: ${cfg.scopeEnv} is unset or empty, so every write tool ` +
          `will refuse. Set it to a comma-separated list of ${cfg.scopeKinds.join("|")}:value ` +
          "terms to enable writes.\n",
      );
    }
    // Chain rather than overwrite: another module may already own this hook, and clobbering it
    // would silently disable whatever it did.
    const prev = server.server.oninitialized;
    server.server.oninitialized = (): void => {
      prev?.();
      flushWriteTools();
    };
  }

  return <T>(
    name: string,
    toolCfg: WriteToolConfig<T>,
    description: string,
    schema: ZodObjectSchema<T>,
    handler: (args: T) => Promise<McpListResult>,
  ): void => {
    // Checked at REGISTRATION, not on first call: a missing capture on a destructive tool is a
    // programming error, and it must surface at boot rather than on the one call that needed it.
    if (!toolCfg.recoverable && toolCfg.capturePreState === undefined) {
      throw new Error(
        `${name}: capturePreState is required when recoverable is false — an unrecoverable ` +
          "mutation must record enough pre-state to be undone",
      );
    }

    if (getConnectorMode() === "gateway") {
      registerOn(server, name, description, schema, handler, handles);
      return;
    }

    const guarded = async (args: T): Promise<McpListResult> => {
      const target = toolCfg.scopeTargetOf(args);

      // 1. SCOPE FIRST — before prompting. Asking a human to approve something the operator
      //    already forbade cannot change the outcome, and training people to click through
      //    prompts that do not matter is how you make the prompts that do matter ineffective.
      if (!scopeAllows(scope, target.kind, target.value)) {
        await record(name, "refused", { reason: "out of scope", target });
        return refused(`out of scope: ${target.kind}:${target.value} is not in ${cfg.scopeEnv}`);
      }

      // 2. BUDGET — same reasoning: a refusal that consent cannot lift comes before consent.
      if (remaining <= 0) {
        await record(name, "refused", { reason: "budget exhausted", target });
        return refused("write budget exhausted for this session");
      }

      // 3. CONSENT.
      await record(name, "requested", { target, params: args });
      if (!(await consented(server, toolCfg.mutates, args))) {
        await record(name, "declined", { target });
        return refused("not approved: the operation was declined, cancelled, or timed out");
      }
      await record(name, "accepted", { target });

      // 4. PRE-STATE — after approval, before the mutation, so an unrecoverable action leaves a
      //    record of what it destroyed. Capture failure is NOT fatal: refusing here would turn a
      //    transient read error into a blocked action the owner already approved.
      let preState: Record<string, unknown> = {};
      if (toolCfg.capturePreState !== undefined) {
        try {
          preState = await toolCfg.capturePreState(args);
        } catch (e) {
          preState = { captureFailed: e instanceof Error ? e.message : String(e) };
        }
      }

      // 5. MUTATE. Decrement BEFORE the call so a throwing mutation still consumes budget —
      //    otherwise a failing destructive tool could be retried without limit.
      remaining -= 1;
      if (remaining <= 0) {
        for (const h of handles) h.disable();
        server.sendToolListChanged();
      }
      try {
        const result = await handler(args);
        await record(name, "executed", { target, preState });
        return result;
      } catch (e) {
        await record(name, "failed", {
          target,
          preState,
          error: e instanceof Error ? e.message : String(e),
        });
        throw e;
      }
    };

    pending.push(() => {
      registerOn(server, name, description, schema, guarded, handles);
    });
  };
}
