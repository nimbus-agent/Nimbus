import { randomBytes } from "node:crypto";
import pino from "pino";
import { isBeforeReadActionType } from "../engine/before-state.ts";
import type { BoundWriteCapabilities } from "../engine/bound-write-capabilities.ts";
import { nodeSettleFs, settleCfnChangeSet, settleTerraformPlan } from "../engine/iac-settle.ts";
import {
  isPrepareActionType,
  PREPARE_REFUSALS,
  PrepareRefusedError,
} from "../engine/prepare-step.ts";
import { serviceOf } from "../engine/service-of.ts";
import { extractToolInput } from "../engine/tool-input.ts";
import type { ConnectorDispatcher, PlannedAction } from "../engine/types.ts";
import type { PlatformPaths } from "../platform/paths.ts";
import { isReadOnlyToolId } from "../share/read-tool-registry.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";
import { MCP_TOOL_RESULT_MAX_BYTES } from "./_lib/mcp-tool-result.ts";
import { isConnectorWriteToolId } from "./connector-write-registry.ts";
import {
  IAC_DISCARD,
  IAC_TOOL_TIMEOUTS_MS,
  type IacDispatchTiming,
  iacDispatchTimeoutMs,
} from "./connector-writes/iac-limits.ts";
import { CONNECTOR_WRITE_ROWS } from "./connector-writes/index.ts";
import { isPrepareToolId, PREPARE_TOOL_IDS } from "./connector-writes/prepare-tools.ts";
import type { IacHost } from "./lazy-mesh/iac-runner.ts";
import { createLazyConnectorMesh, type LazyConnectorMesh } from "./lazy-mesh/index.ts";
import { mcpClientToolKey, meshServerForToolKey, resolveServerTool } from "./lazy-mesh/tool-map.ts";
import {
  isOwnerCodeServerToolKey,
  ownerCodeServerToolKeyForActionType,
} from "./owner-code-server.ts";

const registryLog = pino({
  name: "connector-registry",
  level: process.env["NIMBUS_LOG_LEVEL"] ?? "info",
});

export { createLazyConnectorMesh, LazyConnectorMesh } from "./lazy-mesh/index.ts";

export { extractToolInput };

/**
 * Filesystem MCP (always) + lazy Google bundle (Drive, Gmail, Photos) when any Google OAuth vault key exists +
 * audit-ignore-next-line D11-vault-key (JSDoc reference, not vault-key construction)
 * lazy Microsoft bundle (OneDrive, Outlook, Teams) when `microsoft.oauth` exists.
 */
export async function buildConnectorMesh(
  paths: PlatformPaths,
  vault: NimbusVault,
): Promise<LazyConnectorMesh> {
  return createLazyConnectorMesh(paths, vault);
}

export type McpToolListingClient = {
  listTools(): Promise<
    Record<
      string,
      {
        execute?: (input: unknown, context?: unknown) => Promise<unknown>;
      }
    >
  >;
  getToolsEpoch?: () => number;
  /**
   * The tools of ONE registered user MCP server (`undefined` when no such server is registered).
   * When present, a user-MCP action (`mcp_<id>.<tool>`) is resolved against this listing ALONE, so
   * running one user tool never lists — and so never spawns — every connector in the mesh.
   */
  listUserMcpTools?: (
    serviceId: string,
  ) => Promise<
    | Record<string, { execute?: (input: unknown, context?: unknown) => Promise<unknown> }>
    | undefined
  >;
  /**
   * ONE first-party server's raw tools (schemas kept), or `undefined` when org policy, the
   * service's own credential, or the listing map refuses it. Never spawns an unrelated slot.
   */
  listFirstPartyServerTools?: (
    service: string,
  ) => Promise<Readonly<Record<string, unknown>> | undefined>;
  /**
   * The iac runner (D2): when present the dispatcher carries the bound-write capabilities of the
   * plan-bound iac rows. Only this module turns it into {@link BoundWriteCapabilities} (D42(h)).
   */
  iacHost?: () => IacHost | undefined;
};

/**
 * The runtime capabilities of a bound IaC row (I54), built here and nowhere else (static D42(h)):
 * the preflight is the runner's (approved directory, cloud credential, one run per directory), and
 * the settle is the batch-1 settlers over the run's own staging and approved directories. A row
 * whose tag the host cannot serve is refused with a fixed reason, never skipped.
 */
export function buildBoundWriteCapabilities(host: IacHost): BoundWriteCapabilities {
  return {
    preflight: (rowToolId, input) => host.preflight(rowToolId, input),
    async settle(rowToolId, ctx) {
      if (ctx.settle === "iac-cfn") {
        return settleCfnChangeSet({ input: ctx.input, reply: ctx.reply });
      }
      const dirs =
        ctx.workingDirectory === undefined
          ? undefined
          : host.terraformRunDirs(ctx.workingDirectory);
      if (dirs === undefined || ctx.workingDirectory === undefined || ctx.showPlan === undefined) {
        throw new PrepareRefusedError(PREPARE_REFUSALS.unbound);
      }
      return settleTerraformPlan(
        {
          fs: nodeSettleFs(),
          show: ctx.showPlan,
          randomHex: (n) => randomBytes(n).toString("hex"),
        },
        {
          destroy: rowToolId.endsWith("_destroy"),
          workingDirectory: ctx.workingDirectory,
          reply: ctx.reply,
          stagingDir: dirs.stagingDir,
          approvedRoot: dirs.approvedRoot,
        },
      );
    },
  };
}

type DispatcherToolMap = Record<
  string,
  { execute?: (a: unknown, b?: unknown) => Promise<unknown> }
>;

/**
 * The dispatcher client every production mesh dispatcher uses: the whole merged map for a
 * first-party action, the action's OWN server for an owner code server (user MCP or extension).
 */
export function meshDispatcherClient(mesh: {
  listToolsForDispatcher(): Promise<DispatcherToolMap>;
  getToolsEpoch(): number;
  listOwnerCodeServerToolsForDispatcher(serviceId: string): Promise<DispatcherToolMap | undefined>;
  iacHost?(): IacHost | undefined;
}): McpToolListingClient {
  return {
    listTools: () => mesh.listToolsForDispatcher(),
    getToolsEpoch: () => mesh.getToolsEpoch(),
    listUserMcpTools: (serviceId) => mesh.listOwnerCodeServerToolsForDispatcher(serviceId),
    iacHost: () => mesh.iacHost?.(),
  };
}

export const DEFAULT_TOOL_TIMEOUT_MS = 60_000;

/**
 * The race for the tool the dispatcher resolved: a longer one for the iac tools (a plan or an apply
 * outlives the generic 60 s), otherwise the default. It is the runner's budget PLUS its escalation
 * grace and a margin ({@link iacDispatchTimeoutMs}), so the runner settles first and its message
 * reaches the caller. Matched on the resolved mesh key itself, never on the payload, and only for
 * the `iac` server.
 */
export function iacToolTimeoutMs(
  resolvedKey: string,
  timing?: IacDispatchTiming,
): number | undefined {
  for (const id of Object.keys(timing?.budgetsMs ?? IAC_TOOL_TIMEOUTS_MS)) {
    if (resolvedKey === id || resolvedKey === mcpClientToolKey("iac", id)) {
      return iacDispatchTimeoutMs(id, timing);
    }
  }
  return undefined;
}
export const MAX_TOOL_RESULT_BYTES = MCP_TOOL_RESULT_MAX_BYTES;

export function createConnectorDispatcher(
  client: McpToolListingClient,
  options?: {
    toolTimeoutMs?: number;
    maxResultBytes?: number;
    /** Test seam for the declared prepare tools; static rule D42(c) forbids production code to pass it. */
    prepareToolIds?: ReadonlySet<string>;
    /** Test seam: the runner's injected budgets and graces, so the race stays above them. */
    iacTiming?: IacDispatchTiming;
  },
): ConnectorDispatcher {
  const prepareToolIds = options?.prepareToolIds ?? PREPARE_TOOL_IDS;
  const toolTimeoutFor = (resolvedKey: string): number =>
    options?.toolTimeoutMs ??
    iacToolTimeoutMs(resolvedKey, options?.iacTiming) ??
    DEFAULT_TOOL_TIMEOUT_MS;
  const maxResultBytes = options?.maxResultBytes ?? MAX_TOOL_RESULT_BYTES;
  let toolsPromise: ReturnType<McpToolListingClient["listTools"]> | undefined;
  let cachedEpoch = -1;

  async function tools(): Promise<DispatcherToolMap> {
    const epoch = client.getToolsEpoch?.() ?? 0;
    if (toolsPromise === undefined || epoch !== cachedEpoch) {
      cachedEpoch = epoch;
      toolsPromise = client.listTools();
    }
    return toolsPromise;
  }

  /**
   * A user-MCP action lists its OWN server only, when the client offers that listing. The I42
   * pairing is checked on the INPUT first: the per-server map holds only `<serviceId>_*` keys, so a
   * smuggled key from another server would otherwise surface as "Tool not found" instead of the
   * mismatch refusal the whole-mesh listing gave. The post-resolution check below still runs.
   */
  async function toolsFor(action: PlannedAction, toolId: string): Promise<DispatcherToolMap> {
    const expected = ownerCodeServerToolKeyForActionType(action.type);
    const listOne = client.listUserMcpTools;
    if (expected === undefined || listOne === undefined) {
      return tools();
    }
    const serviceId = serviceOf(action.type);
    if (toolId !== expected && mcpClientToolKey(serviceId, toolId) !== expected) {
      assertUserMcpKeyMatchesActionType(action.type, toolId);
    }
    return (await listOne(serviceId)) ?? {};
  }

  const iacHost = client.iacHost?.();
  return {
    ...(iacHost === undefined
      ? {}
      : { boundWriteCapabilities: buildBoundWriteCapabilities(iacHost) }),
    async dispatch(action: PlannedAction): Promise<unknown> {
      const fromPayload = action.payload?.["mcpToolId"];
      const toolId =
        typeof fromPayload === "string" && fromPayload.length > 0 ? fromPayload : action.type;
      const map = await toolsFor(action, toolId);
      // The mesh lists every tool as `<server>_<tool>`, so a bare id (the tribal KB capture's
      // `mcpToolId`) is resolved on the server of the action type the HITL gate approved (I3:
      // the gate consults action.type), never on another connector's server. An exact mesh key
      // is answered as it always was.
      const tool = resolveServerTool(map, serviceOf(action.type), toolId);
      if (tool === undefined) {
        const available = Object.keys(map).sort((a, b) => a.localeCompare(b));
        registryLog.warn(
          { toolId, availableToolCount: available.length, availableTools: available },
          "Unknown MCP tool",
        );
        throw new Error("Tool not found");
      }
      const resolvedKey = Object.hasOwn(map, toolId)
        ? toolId
        : mcpClientToolKey(serviceOf(action.type), toolId);
      assertUserMcpKeyMatchesActionType(action.type, resolvedKey);
      assertBeforeReadIsOwnRead(action.type, resolvedKey);
      assertPrepareIsOwnPrepare(action.type, resolvedKey, prepareToolIds);
      assertWriteKeyMatchesActionType(action.type, resolvedKey);
      assertDiscardIsOwnDiscard(action.type, resolvedKey);
      const execute = tool.execute;
      if (execute === undefined) {
        throw new Error(`MCP tool "${toolId}" has no execute implementation`);
      }
      const input = extractToolInput(action);
      const toolTimeoutMs = toolTimeoutFor(resolvedKey);

      let timer: ReturnType<typeof setTimeout> | undefined;
      const result = await Promise.race([
        execute(input, {}),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Tool ${toolId} exceeded ${toolTimeoutMs}ms timeout`));
          }, toolTimeoutMs);
        }),
      ]).finally(() => {
        if (timer !== undefined) clearTimeout(timer);
      });

      const serialized = JSON.stringify(result);
      if (serialized !== undefined && serialized.length > maxResultBytes) {
        throw new Error(
          `Tool ${toolId} result size ${serialized.length} bytes exceeds cap ${maxResultBytes}`,
        );
      }
      return result;
    },
  };
}

/**
 * Spec § 5.4 at the dispatcher: a before-state read (`<service>.before.read`, built only by
 * `engine/before-state.ts` on the model door's executor) runs no approval of its own, so the key it
 * resolves to must be a READ of that SAME service: a tool key `meshServerForToolKey` attributes to
 * `serviceOf(type)` (so it can never call another connector or misattribute its I29 egress row),
 * that `isReadOnlyToolId` accepts and `isConnectorWriteToolId` rejects. Checked on the key the
 * dispatcher actually resolved, before the tool is called; any other type is untouched.
 */
function assertBeforeReadIsOwnRead(actionType: string, resolvedKey: string): void {
  if (!isBeforeReadActionType(actionType)) return;
  const shown = `action type ${JSON.stringify(actionType)} may not dispatch tool ${JSON.stringify(resolvedKey)}`;
  if (meshServerForToolKey(resolvedKey) !== serviceOf(actionType)) {
    throw new Error(`ERR_BEFORE_READ_SERVICE_MISMATCH: ${shown}`);
  }
  if (!isReadOnlyToolId(resolvedKey) || isConnectorWriteToolId(resolvedKey)) {
    throw new Error(`ERR_BEFORE_READ_NOT_A_READ: ${shown}`);
  }
}

/**
 * I54 at the dispatcher: a prepare tool (a member of `PREPARE_TOOL_IDS`) runs only inside the
 * executor's prepare step, and that step's `<service>.write.prepare` type resolves only to a
 * prepare tool of that SAME service. Checked on the key the dispatcher actually resolved, before
 * the tool is called: a prepare tool under any other action type is `ERR_PREPARE_OUTSIDE_STEP`;
 * a prepare type that resolves to another connector's tool is `ERR_PREPARE_SERVICE_MISMATCH`
 * (so its I29 egress row can never be misattributed), and one that resolves to anything that is
 * not a declared prepare tool, or to a connector write, is `ERR_PREPARE_NOT_A_PREPARE_TOOL`.
 */
function assertPrepareIsOwnPrepare(
  actionType: string,
  resolvedKey: string,
  prepareToolIds: ReadonlySet<string>,
): void {
  const isPrepare = isPrepareToolId(resolvedKey, prepareToolIds);
  const shown = `action type ${JSON.stringify(actionType)} may not dispatch tool ${JSON.stringify(resolvedKey)}`;
  if (!isPrepareActionType(actionType)) {
    if (isPrepare) throw new Error(`ERR_PREPARE_OUTSIDE_STEP: ${shown}`);
    return;
  }
  if (meshServerForToolKey(resolvedKey) !== serviceOf(actionType)) {
    throw new Error(`ERR_PREPARE_SERVICE_MISMATCH: ${shown}`);
  }
  if (!isPrepare || isConnectorWriteToolId(resolvedKey)) {
    throw new Error(`ERR_PREPARE_NOT_A_PREPARE_TOOL: ${shown}`);
  }
}

/**
 * Static D43 at the dispatcher: the change-set discard type (the one HITL type the gateway's own
 * cleanup runs without a prompt) resolves ONLY to the iac server's discard tool, so that
 * exemption can never be spent on a read, a prepare, another write or another connector's tool.
 * Checked on the key the dispatcher actually resolved, before the tool is called; the reverse
 * direction (the discard tool under another type) is {@link assertWriteKeyMatchesActionType}.
 */
function assertDiscardIsOwnDiscard(actionType: string, resolvedKey: string): void {
  if (actionType !== IAC_DISCARD.actionType) return;
  if (
    resolvedKey === IAC_DISCARD.toolId ||
    resolvedKey === mcpClientToolKey("iac", IAC_DISCARD.toolId)
  ) {
    return;
  }
  throw new Error(
    `ERR_DISCARD_NOT_OWN_DISCARD: action type ${JSON.stringify(actionType)} may not dispatch tool ${JSON.stringify(resolvedKey)}`,
  );
}

/**
 * I53 at the dispatcher: a connector-write tool (a row's `toolId`, bare or as the tail of the mesh
 * key `<server>_<tool>`) runs only under its row's OWN action type. The gate decides approval and
 * the type-to-confirm text from the type (I3), so a Wave 4 tool riding a plain-approval type
 * would skip the typed text; checked on the key the dispatcher actually resolved, beside
 * {@link assertUserMcpKeyMatchesActionType}. The longest row id that ends the key wins.
 */
function assertWriteKeyMatchesActionType(actionType: string, resolvedKey: string): void {
  // A user-MCP or extension tool is pinned to its own type by assertUserMcpKeyMatchesActionType; its
  // own name may legitimately end in a first-party row id.
  if (isOwnerCodeServerToolKey(resolvedKey)) return;
  let named: (typeof CONNECTOR_WRITE_ROWS)[number] | undefined;
  for (const r of CONNECTOR_WRITE_ROWS) {
    const matches = resolvedKey === r.toolId || resolvedKey.endsWith(`_${r.toolId}`);
    if (matches && (named === undefined || r.toolId.length > named.toolId.length)) named = r;
  }
  if (named === undefined || named.actionType === actionType) return;
  throw new Error(
    `ERR_WRITE_TOOL_ACTION_MISMATCH: action type ${JSON.stringify(actionType)} may not dispatch tool ${JSON.stringify(resolvedKey)}`,
  );
}

/**
 * I42 at the dispatcher: a user-registered MCP server’s tool runs only under its OWN action type
 * (`mcp_<id>.<tool>` <-> key `mcp_<id>_<tool>`), and a user-MCP action type runs only that key.
 * The executor gate decides owner approval from `action.type` alone (I3) and never reads the
 * payload, so without this a payload `mcpToolId` naming a user-MCP key could ride an action of any
 * other type — one a delegate approved (I20), or one needing no approval — past I42. The check
 * stays HERE, on the key the dispatcher actually resolved, so the gate keeps reading the type only.
 * Exact equality refuses a user-MCP key under a first-party or different action type, and a
 * first-party key under a user-MCP type, in both directions. It does NOT by itself separate
 * `mcp_a.b_tool` from server `mcp_a_b`’s `tool` (both map to key `mcp_a_b_tool`); that ambiguity
 * cannot arise because registration (`resolveUserMcpRegistration`,
 * `connectors/user-mcp-registration.ts`) refuses a user-MCP id that extends another registered id
 * by `_` (or is extended by one), so `mcp_a` and `mcp_a_b` are never both registered.
 */
function assertUserMcpKeyMatchesActionType(actionType: string, resolvedKey: string): void {
  const expected = ownerCodeServerToolKeyForActionType(actionType);
  if (expected === undefined && !isOwnerCodeServerToolKey(resolvedKey)) return;
  if (expected === resolvedKey) return;
  throw new Error(
    `ERR_USER_MCP_ACTION_MISMATCH: action type ${JSON.stringify(actionType)} may not dispatch tool ${JSON.stringify(resolvedKey)}`,
  );
}
