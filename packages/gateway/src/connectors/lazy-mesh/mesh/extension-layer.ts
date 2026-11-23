import { EXTENSION_SERVICE_ID_PATTERN } from "../../../extensions/extension-service-id.ts";
import { extensionStageRootFor, sandboxCwdFor } from "../../../platform/sandbox/sandbox-cwd.ts";
import { extractMcpToolText, MCP_TOOL_RESULT_MAX_BYTES } from "../../_lib/mcp-tool-result.ts";
import type { ExtensionSyncRequest } from "../../extension-sync/sync-response.ts";
import { extensionServerKey } from "../extension-slot.ts";
import { extensionMeshKey } from "../keys.ts";
import { type LazyMeshToolMap, mcpClientToolKey } from "../tool-map.ts";
import { MeshUserMcp } from "./user-mcp-layer.ts";

/**
 * The fifth layer of the mesh's class chain: the extension (`ext_*`) slots' lifecycle and listings
 * and the reserved `__nimbus_sync` call (I43). Moved verbatim out of `mesh.ts`.
 */
export abstract class MeshExtensions extends MeshUserMcp {
  /**
   * Stops an extension's client (disable, revoke, a failed startup verify). Keyed by the manifest
   * id the callers hold; the slot is found through the running record, which outlives the grant
   * row, so a stop after the grant is deleted still stops the child.
   */
  public async stopExtensionClient(extensionId: string): Promise<void> {
    // First, synchronously: a preparation already in flight for this extension must not connect.
    this.extensionSlots.markStopped(extensionId);
    await this.stopUserMcpClient(extensionId);
    await this.stopLazyClient(extensionId);
    const serviceId = this.extensionSlots.serviceIdFor(extensionId);
    if (serviceId !== undefined) {
      await this.stopLazyClient(extensionMeshKey(serviceId));
    }
  }

  /** True while the extension has a live client in its `mesh:ext:` slot. */
  isExtensionRunning(extensionId: string): boolean {
    return this.extensionSlots.isRunning(extensionId);
  }

  /**
   * Stops an extension's slot and deletes its stage root and its old sandbox leaf. Same best-effort,
   * never-throws, three-attempt contract as {@link removeUserMcpSandbox}.
   */
  async removeExtensionSandbox(serviceId: string): Promise<void> {
    try {
      await this.stopLazyClient(extensionMeshKey(serviceId));
    } catch (err) {
      this.logger?.warn({ serviceId, err }, "extension client not stopped before sandbox removal");
    }
    // Both: the stage root every spawn now runs in, and the `ext.<serviceId>` per-policy leaf that
    // earlier builds of this branch staged into (harmless when absent).
    // Two disjoint directories, each with its own never-throwing retry loop: deleted concurrently.
    const dirs = [
      extensionStageRootFor(this.paths.sandboxDir, serviceId),
      sandboxCwdFor(this.paths.sandboxDir, `ext.${serviceId}`),
    ];
    const lastErrs = await Promise.all(dirs.map((dir) => this.deleteSandboxLeaf(dir)));
    dirs.forEach((dir, i) => {
      const lastErr = lastErrs[i];
      if (lastErr !== undefined) {
        this.logger?.warn(
          { serviceId, dir, err: lastErr },
          "extension sandbox directory not removed",
        );
      }
    });
  }

  /**
   * The tools of ONE approved extension — its own slot only. `undefined` when no source is wired
   * or it does not list the id. A first listing (or the first after a stop / idle-out) re-verifies
   * and spawns through `prepareSpawn`; a refusal rejects with its `ExtensionRunGrantError`.
   */
  async listExtensionTools(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return this.extensionSlots.listTools(serviceId);
  }

  /** {@link listExtensionTools}, drain-refcount wrapped like {@link listUserMcpToolsForDispatcher}. */
  async listExtensionToolsForDispatcher(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return this.wrapSlotToolsWithDrain(
      extensionMeshKey(serviceId),
      await this.listExtensionTools(serviceId),
    );
  }

  /**
   * Calls an extension's reserved `__nimbus_sync` tool once and returns the parsed JSON body.
   * Takes the slot's UNFILTERED tool map and executes the tool directly, so the 4 MiB result cap is
   * enforced HERE — a direct execute bypasses the dispatcher's own cap. The slot's drain refcount
   * is held for the BOUNDED race, not for the underlying call: an idle-out or stop waits for the
   * call, but a call that outlives its timeout (an extension that ignores the abort) releases the
   * drain when the timeout rejects, so a stop never waits on an abandoned call. One `timeoutMs`
   * budget covers tool discovery (which may start the child) AND the call, so a slow start cannot
   * buy the call a second window. A timeout rejects; the child is left to the slot's normal
   * stop/idle path.
   */
  async callExtensionSyncTool(
    codeServerId: string,
    req: ExtensionSyncRequest,
    timeoutMs: number,
  ): Promise<unknown> {
    const key = extensionMeshKey(codeServerId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const timeout = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        abort.abort();
        reject(new Error(`${codeServerId} sync call exceeded ${String(timeoutMs)}ms`));
      }, timeoutMs);
    });
    let drain: { bump(): void; drop(): void } | undefined;
    let result: unknown;
    try {
      const tools = await Promise.race([
        this.extensionSlots.listToolsUnfiltered(codeServerId),
        timeout,
      ]);
      if (tools === undefined) {
        throw new Error(`${codeServerId} is not an approved extension`);
      }
      const toolKey = mcpClientToolKey(extensionServerKey(codeServerId), "__nimbus_sync");
      const tool = Object.hasOwn(tools, toolKey) ? tools[toolKey] : undefined;
      const execute = tool?.execute;
      if (execute === undefined) {
        throw new Error(`${codeServerId} does not expose the sync tool`);
      }
      // The same tracker `wrapSlotToolsWithDrain` would use, looked up the same way; held only
      // once discovery succeeded, so `finally` drops exactly what was bumped.
      drain = this.lazySlots.get(key)?.drain;
      drain?.bump();
      // try/finally rather than `.finally`: an execute that throws synchronously still drops.
      result = await Promise.race([execute(req, { abortSignal: abort.signal }), timeout]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
      drain?.drop();
    }
    return JSON.parse(extractMcpToolText(result, MCP_TOOL_RESULT_MAX_BYTES));
  }

  /** One owner code server's tools: an extension (`ext_*`) or a user MCP server (anything else). */
  listOwnerCodeServerTools(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return EXTENSION_SERVICE_ID_PATTERN.test(serviceId)
      ? this.listExtensionTools(serviceId)
      : this.listUserMcpTools(serviceId);
  }

  /** {@link listOwnerCodeServerTools} for the connector dispatcher (drain-refcount wrapped). */
  listOwnerCodeServerToolsForDispatcher(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return EXTENSION_SERVICE_ID_PATTERN.test(serviceId)
      ? this.listExtensionToolsForDispatcher(serviceId)
      : this.listUserMcpToolsForDispatcher(serviceId);
  }
}
