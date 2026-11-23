import type { MCPClient } from "@mastra/mcp";

import type { PlatformPaths } from "../../../platform/paths.ts";
import type { NimbusVault } from "../../../vault/nimbus-vault.ts";
import type { UserMcpConnectorRow } from "../../user-mcp-store.ts";
import { LazyDrainTracker } from "../drain.ts";
import type { ExtensionSlots } from "../extension-slot.ts";
import { EXT_MESH_PREFIX } from "../keys.ts";
import type { LazyMcpSlot, MeshLogger } from "../slot.ts";
import type { LazyMeshToolMap } from "../tool-map.ts";
import type { MeshCtorArgs } from "./ctor-args.ts";
import { wrapMergedToolsWithRefcount } from "./tool-merge.ts";

/**
 * The bottom layer of the mesh's class chain: the slot registry (the lazy slots, their idle timers,
 * generations and the tools epoch) and what every layer above reads. Moved verbatim out of
 * `mesh.ts`; the layers above are `ensure-runners.ts`, `obsidian-layer.ts`, `user-mcp-layer.ts`
 * and `extension-layer.ts`, and `mesh.ts` holds the final class.
 */
export abstract class MeshCore {
  protected readonly vault: NimbusVault;
  protected readonly paths: PlatformPaths;
  protected readonly lazySlots = new Map<string, LazyMcpSlot>();
  protected readonly listUserMcpConnectors: () => readonly UserMcpConnectorRow[];
  protected readonly inactivityMs: number;
  protected readonly healthDb: import("bun:sqlite").Database | undefined;
  protected readonly logger: MeshLogger | undefined;
  protected readonly filesystemSpawnGate: Promise<void> | undefined;
  protected toolsEpoch = 0;
  /**
   * Per-SLOT generation: bumped whenever that slot's client is set (spawned) or stopped. Unlike the
   * global {@link toolsEpoch}, unrelated activity (another slot spawning, idling out, an extension
   * slot) never changes a slot's generation, so the connector-write door can tell "this server
   * restarted since its tools were listed" from "something else moved".
   */
  protected readonly slotGenerations = new Map<string, number>();
  protected abstract readonly extensionSlots: ExtensionSlots;

  constructor(args: MeshCtorArgs) {
    const { paths, vault, options } = args;
    this.vault = vault;
    this.paths = paths;
    // Only stored here; `collectBuiltInToolMaps` and `listUserMcpTools` await it (undefined means
    // no gate).
    this.filesystemSpawnGate = options?.filesystemSpawnGate;
    this.inactivityMs = options?.inactivityMs ?? 300_000;
    this.listUserMcpConnectors = options?.listUserMcpConnectors ?? (() => []);
    this.healthDb = options?.healthDb;
    this.logger = options?.logger;
  }

  getToolsEpoch(): number {
    return this.toolsEpoch;
  }

  protected bumpToolsEpoch(): void {
    this.toolsEpoch += 1;
  }

  protected bumpSlotGeneration(key: string): void {
    this.slotGenerations.set(key, (this.slotGenerations.get(key) ?? 0) + 1);
  }

  protected lazySlot(key: string): LazyMcpSlot {
    let s = this.lazySlots.get(key);
    if (s === undefined) {
      s = { client: undefined, idleTimer: undefined, drain: new LazyDrainTracker() };
      this.lazySlots.set(key, s);
    }
    return s;
  }

  protected getLazyClient(key: string): MCPClient | undefined {
    return this.lazySlots.get(key)?.client ?? undefined;
  }

  protected setLazyClient(key: string, client: MCPClient): void {
    this.lazySlot(key).client = client;
    this.bumpSlotGeneration(key);
  }

  protected clearLazyIdle(key: string): void {
    const s = this.lazySlots.get(key);
    if (s?.idleTimer !== undefined) {
      clearTimeout(s.idleTimer);
      s.idleTimer = undefined;
    }
  }

  protected scheduleLazyDisconnect(key: string): void {
    this.clearLazyIdle(key);
    const slot = this.lazySlot(key);
    slot.idleTimer = setTimeout(() => {
      slot.idleTimer = undefined;
      void this.stopLazyClient(key);
    }, this.inactivityMs);
  }

  protected async stopLazyClient(key: string): Promise<void> {
    this.clearLazyIdle(key);
    const slot = this.lazySlots.get(key);
    if (slot === undefined) {
      this.forgetExtensionSlot(key);
      return;
    }
    if (slot.drain.count > 0) {
      await Promise.race([
        slot.drain.awaitDrain(),
        new Promise<void>((r) => setTimeout(r, 10 * 60_000)),
      ]);
    }
    const c = slot.client;
    slot.client = undefined;
    let disconnected: Promise<void> | undefined;
    if (c !== undefined) {
      this.bumpToolsEpoch();
      this.bumpSlotGeneration(key);
      disconnected = c.disconnect().then(
        () => undefined,
        () => undefined,
      );
      // From the moment the client is cleared, a listing would start a new spawn. For an extension
      // that spawn must wait until THIS child's disconnect has finished (I43): the next run stages a
      // fresh copy in the same leaf, so the previous child must be disconnected and signalled before it is made. This
      // covers the un-awaited idle teardown too. Other slot kinds are unaffected.
      if (key.startsWith(EXT_MESH_PREFIX)) {
        this.extensionSlots.trackStopping(key.slice(EXT_MESH_PREFIX.length), disconnected);
      }
    }
    this.forgetExtensionSlot(key);
    if (slot.idleTimer === undefined) {
      this.lazySlots.delete(key);
    }
    if (disconnected !== undefined) await disconnected;
  }

  /** Drops the running record of the extension whose slot `key` names (no-op for any other key). */
  protected forgetExtensionSlot(key: string): void {
    if (key.startsWith(EXT_MESH_PREFIX)) {
      this.extensionSlots.forgetService(key.slice(EXT_MESH_PREFIX.length));
    }
  }

  /**
   * Detach the slot `key` NOW: its client is cleared, the slot generation and the tools epoch are
   * bumped and the slot record is dropped (a new client gets a fresh drain tracker), so nothing new
   * reaches the old client. Its in-flight calls drain (at most 10 minutes) and it is disconnected in
   * the background; the returned promise settles then and never rejects.
   */
  protected detachLazyClient(key: string): Promise<void> {
    this.clearLazyIdle(key);
    const slot = this.lazySlots.get(key);
    this.lazySlots.delete(key);
    const c = slot?.client;
    if (slot === undefined || c === undefined) return Promise.resolve();
    slot.client = undefined;
    this.bumpToolsEpoch();
    this.bumpSlotGeneration(key);
    const drained =
      slot.drain.count > 0
        ? Promise.race([
            slot.drain.awaitDrain(),
            new Promise<void>((r) => setTimeout(r, 10 * 60_000)),
          ])
        : Promise.resolve();
    return drained.then(() => disconnectQuietly(c));
  }

  /** Wraps one slot's tool listing in that slot's drain refcount, so a stop waits for its calls. */
  protected wrapSlotToolsWithDrain(
    key: string,
    tools: LazyMeshToolMap | undefined,
  ): LazyMeshToolMap | undefined {
    if (tools === undefined) {
      return undefined;
    }
    const drain = this.lazySlots.get(key)?.drain;
    const wrapped: LazyMeshToolMap = { ...tools };
    if (drain !== undefined) {
      wrapMergedToolsWithRefcount(
        wrapped,
        new Map(Object.keys(wrapped).map((key) => [key, drain])),
      );
    }
    return wrapped;
  }
}

/** Disconnects a client; a failure is ignored (the slot is already detached). */
async function disconnectQuietly(client: { disconnect(): Promise<unknown> }): Promise<void> {
  try {
    await client.disconnect();
  } catch {
    // ignored: the client is gone either way
  }
}
