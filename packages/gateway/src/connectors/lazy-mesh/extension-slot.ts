import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import { ExtensionRunGrantError } from "../../extensions/run-grant-error.ts";
import { getConnectorHealth, transitionHealth } from "../health.ts";
import type { ExtensionSlotSource } from "./extension-slot-source.ts";
import { extensionMeshKey } from "./keys.ts";
import { extensionServerKey } from "./server-key.ts";
import type { ServerSpec } from "./slot.ts";
import type { LazyMeshToolMap } from "./tool-map.ts";

/** Re-exported so existing importers are unchanged; the definition lives in `server-key.ts`. */
export { extensionServerKey };

/** Builds the MCP client for one extension slot. Production: `new MCPClient(...)`; tests: a fake. */
export type CreateExtensionClient = (id: string, servers: Record<string, ServerSpec>) => MCPClient;

export const defaultCreateExtensionClient: CreateExtensionClient = (id, servers) =>
  new MCPClient({ id, servers });

/** The mesh internals an extension slot drives. */
export interface ExtensionSlotHost {
  getLazyClient(key: string): MCPClient | undefined;
  setLazyClient(key: string, client: MCPClient): void;
  clearLazyIdle(key: string): void;
  bumpToolsEpoch(): void;
  scheduleLazyDisconnect(key: string): void;
  /** Clears and disconnects the slot's client (the mesh's own stop path). */
  stopLazyClient(key: string): Promise<void>;
}

export interface ExtensionSlotsOptions {
  readonly source: ExtensionSlotSource | undefined;
  readonly spawnGate: Promise<void> | undefined;
  readonly healthDb: import("bun:sqlite").Database | undefined;
  readonly createClient: CreateExtensionClient;
}

/**
 * The `mesh:ext:<serviceId>` slots of approved extensions. Every spawn goes through the source's
 * `prepareSpawn`, which re-verifies the extension; a live client is reused until it is stopped or
 * idles out, so a changed tree takes effect only at the next spawn. Concurrent first listings share
 * ONE in-flight preparation, and the extension-id → service-id record that `stopExtensionClient`
 * needs is dropped on every disconnect path (stop, idle timer, mesh shutdown).
 */
export class ExtensionSlots {
  private readonly serviceIdByExtensionId = new Map<string, string>();
  private readonly pendingSpawns = new Map<string, Promise<boolean>>();
  /**
   * Stop generations. A stop knows only the extension id and an in-flight preparation learns it
   * only when `prepareSpawn` resolves, so each stop stamps the extension id with a fresh value of
   * one monotonic counter (`stopAll` stamps every id at once); a preparation captures the counter
   * before it starts and creates no client if its extension was stamped later.
   */
  private generation = 0;
  private readonly stoppedAt = new Map<string, number>();
  private allStoppedAt = 0;
  /**
   * Per service id: the disconnect of a previous child that is still finishing. A new spawn of the
   * same extension awaits it BEFORE `prepareSpawn` (and so before the run stages a fresh copy in
   * the extension's leaf), whichever path began the stop — an explicit stop, auto-update, or the
   * un-awaited idle teardown.
   */
  private readonly stopping = new Map<string, Promise<void>>();
  /**
   * The extension id each service id last ran as. Unlike `serviceIdByExtensionId` it survives a
   * disconnect, so a spawn that waited for the previous child can tell — before `prepareSpawn` —
   * whether that extension was stopped during the wait. A stale entry only makes the early check
   * miss; the post-preparation check still decides.
   */
  private readonly lastExtensionIdByServiceId = new Map<string, string>();

  constructor(
    private readonly host: ExtensionSlotHost,
    private readonly options: ExtensionSlotsOptions,
  ) {}

  /**
   * Ensures a live client for `serviceId`. Resolves `false` when the id is not (or, after the
   * preparation, no longer) listed and its extension is not merely disabled. Rejects with an
   * `ExtensionRunGrantError` on a refusal (recorded as the service's `persistent_error` when it came
   * from the preparation or the org policy), on an approved-but-disabled extension
   * (`ERR_EXTENSION_RUN_DISABLED`), and on a spawn that lost a race with a stop
   * (`ERR_EXTENSION_RUN_STOPPED`) — each of which would otherwise read as "not registered".
   */
  async ensureRunning(serviceId: string): Promise<boolean> {
    const source = this.options.source;
    if (source === undefined) return false;
    if (!source.listServiceIds().includes(serviceId)) return this.notListed(source, serviceId);
    await this.options.spawnGate;
    const key = extensionMeshKey(serviceId);
    if (this.host.getLazyClient(key) !== undefined) {
      // A live client is reused, but the org policy is re-read on every listing: a tightened
      // connector allowlist stops the running child rather than waiting for its idle-out.
      if (!source.isAllowed(serviceId)) {
        await this.host.stopLazyClient(key);
        throw this.recordRefusal(
          serviceId,
          new ExtensionRunGrantError(
            "ERR_EXTENSION_RUN_POLICY",
            `organization policy does not allow ${serviceId}; its running child was stopped`,
          ),
        );
      }
      this.host.clearLazyIdle(key);
      this.host.scheduleLazyDisconnect(key);
      return true;
    }
    let pending = this.pendingSpawns.get(serviceId);
    if (pending === undefined) {
      pending = this.connectSlot(source, serviceId).finally(() =>
        this.pendingSpawns.delete(serviceId),
      );
      this.pendingSpawns.set(serviceId, pending);
    }
    return pending;
  }

  /**
   * The tools of `serviceId`'s child, spawning it first if needed. `undefined` when not listed.
   * Uses `listToolsWithErrors` because `listTools` swallows a per-server connect failure into an
   * empty map: a child that failed to start (a sandbox refusal, a crash at import) would list
   * nothing while `runState` read `running`. Such a failure is recorded, its client is stopped,
   * and the listing rejects `ERR_EXTENSION_RUN_START_FAILED`.
   */
  async listTools(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    const all = await this.listToolsUnfiltered(serviceId);
    if (all === undefined) return undefined;
    // The reserved `__nimbus_*` tools (the sync entry point) are the gateway's, never listed. The
    // key is `<serverKey>_<tool>`, so the test is on the UNPREFIXED name: a raw-key test would
    // miss `ext_x___nimbus_sync` only by accident of where the underscores fall.
    const prefixLen = extensionServerKey(serviceId).length + 1;
    const visible: Record<string, LazyMeshToolMap[string]> = {};
    for (const [key, tool] of Object.entries(all)) {
      if (!isReservedExtensionToolName(key.slice(prefixLen))) visible[key] = tool;
    }
    return visible as LazyMeshToolMap;
  }

  /** {@link listTools} without the reserved-name filter. For the gateway's own sync host ONLY. */
  async listToolsUnfiltered(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    if (!(await this.ensureRunning(serviceId))) return undefined;
    const key = extensionMeshKey(serviceId);
    const client = this.host.getLazyClient(key);
    if (client === undefined) throw stoppedWhileStarting(serviceId);
    const { tools, errors } = await client.listToolsWithErrors();
    const failure = Object.values(errors)[0];
    if (failure !== undefined) {
      await this.host.stopLazyClient(key);
      throw this.recordRefusal(
        serviceId,
        new ExtensionRunGrantError(
          "ERR_EXTENSION_RUN_START_FAILED",
          `${serviceId} did not start: ${failure}`,
        ),
      );
    }
    return tools as LazyMeshToolMap;
  }

  /** Records `err` as the service's `persistent_error` (when a health DB is wired) and returns it. */
  private recordRefusal(serviceId: string, err: ExtensionRunGrantError): ExtensionRunGrantError {
    if (this.options.healthDb !== undefined) {
      transitionHealth(this.options.healthDb, serviceId, {
        type: "persistent_error",
        error: err.code,
      });
    }
    return err;
  }

  /** An unlisted id: refused as disabled when its extension is approved but disabled, else `false`. */
  private notListed(source: ExtensionSlotSource, serviceId: string): false {
    const disabled = source.disabledExtensionIdFor(serviceId);
    if (disabled !== undefined) {
      throw new ExtensionRunGrantError(
        "ERR_EXTENSION_RUN_DISABLED",
        `${disabled} is approved to run but disabled; enable it with \`nimbus extension enable ${disabled}\``,
      );
    }
    return false;
  }

  /** A spawn that will not create a client: withdrawn (see {@link notListed}) or stopped. */
  private abandoned(source: ExtensionSlotSource, serviceId: string): false {
    if (!source.listServiceIds().includes(serviceId)) return this.notListed(source, serviceId);
    throw stoppedWhileStarting(serviceId);
  }

  /** The service id a running extension's slot is keyed by, if it is running. */
  serviceIdFor(extensionId: string): string | undefined {
    return this.serviceIdByExtensionId.get(extensionId);
  }

  isRunning(extensionId: string): boolean {
    const serviceId = this.serviceIdByExtensionId.get(extensionId);
    return (
      serviceId !== undefined && this.host.getLazyClient(extensionMeshKey(serviceId)) !== undefined
    );
  }

  /** Marks `extensionId` stopped: a preparation already in flight for it creates no client. */
  markStopped(extensionId: string): void {
    this.generation += 1;
    this.stoppedAt.set(extensionId, this.generation);
  }

  /** Marks every extension stopped (mesh shutdown). */
  markAllStopped(): void {
    this.generation += 1;
    this.allStoppedAt = this.generation;
  }

  private stoppedSince(extensionId: string, startedAt: number): boolean {
    return this.allStoppedAt > startedAt || (this.stoppedAt.get(extensionId) ?? 0) > startedAt;
  }

  /** Called by the mesh when it starts disconnecting `serviceId`'s child; `done` never rejects. */
  trackStopping(serviceId: string, done: Promise<void>): void {
    const prior = this.stopping.get(serviceId);
    const all = prior === undefined ? done : Promise.all([prior, done]).then(() => undefined);
    this.stopping.set(serviceId, all);
    void all.then(() => {
      if (this.stopping.get(serviceId) === all) this.stopping.delete(serviceId);
    });
  }

  /** Resolves once no previous child of `serviceId` is still disconnecting. */
  private async previousChildGone(serviceId: string): Promise<void> {
    // Sequential by design: each wait re-reads the map, since a stop that began while we waited
    // replaces the entry and must be waited out too. There is nothing to run concurrently.
    for (let p = this.stopping.get(serviceId); p !== undefined; p = this.stopping.get(serviceId)) {
      await p; // NOSONAR S9382: each wait re-reads the map; a stop begun meanwhile must be waited out too
    }
  }

  private stoppedDuringWait(
    source: ExtensionSlotSource,
    serviceId: string,
    startedAt: number,
  ): boolean {
    if (!source.listServiceIds().includes(serviceId)) return true;
    if (this.allStoppedAt > startedAt) return true;
    const known = this.lastExtensionIdByServiceId.get(serviceId);
    return known !== undefined && this.stoppedSince(known, startedAt);
  }

  /** Called by the mesh whenever an extension slot's client is cleared. */
  forgetService(serviceId: string): void {
    for (const [extensionId, sid] of this.serviceIdByExtensionId) {
      if (sid === serviceId) this.serviceIdByExtensionId.delete(extensionId);
    }
  }

  private async connectSlot(source: ExtensionSlotSource, serviceId: string): Promise<boolean> {
    const startedAt = this.generation;
    // The previous child of this extension must have been disconnected and signalled before this
    // spawn verifies and stages its code (I43). Captured `startedAt` stays BEFORE the wait, so a stop
    // landing during it still wins — checked here as far as it is knowable before the preparation
    // (withdrawal, mesh shutdown, a stop of the extension this service id last ran as), so such a
    // stop does not stage a copy only to discard it.
    await this.previousChildGone(serviceId);
    if (this.stoppedDuringWait(source, serviceId, startedAt)) {
      return this.abandoned(source, serviceId);
    }
    let prepared: Awaited<ReturnType<ExtensionSlotSource["prepareSpawn"]>>;
    try {
      prepared = await source.prepareSpawn(serviceId);
    } catch (err) {
      if (err instanceof ExtensionRunGrantError) throw this.recordRefusal(serviceId, err);
      throw err;
    }
    // A disable or revoke that landed while the preparation was in flight has nothing to stop yet
    // (no client, no running record), so the listing is re-read here and a withdrawn id spawns nothing.
    // Either abandonment discards the stage the preparation made: a remove or revoke may already
    // have deleted the stage root before this copy landed in it.
    if (!source.listServiceIds().includes(serviceId)) {
      prepared.discard();
      return this.notListed(source, serviceId);
    }
    // A stop that did NOT withdraw the id (auto-update swaps the tree and stops with the id still
    // listed) or a mesh shutdown that landed mid-preparation wins too: the next listing re-prepares.
    if (this.stoppedSince(prepared.extensionId, startedAt)) {
      prepared.discard();
      throw stoppedWhileStarting(serviceId);
    }
    const key = extensionMeshKey(serviceId);
    const serverKey = extensionServerKey(serviceId);
    const client = this.options.createClient(`nimbus-extension-${serviceId}-${randomUUID()}`, {
      [serverKey]: prepared.spec,
    });
    this.host.setLazyClient(key, client);
    this.serviceIdByExtensionId.set(prepared.extensionId, serviceId);
    this.lastExtensionIdByServiceId.set(serviceId, prepared.extensionId);
    this.host.bumpToolsEpoch();
    this.host.scheduleLazyDisconnect(key);
    this.recordRecovered(serviceId);
    return true;
  }

  /** A spawn after a recorded refusal clears it, with the event a successful sync records. */
  private recordRecovered(serviceId: string): void {
    const db = this.options.healthDb;
    if (db === undefined) return;
    const state = getConnectorHealth(db, serviceId).state;
    // `not_configured` is what a never-observed id reads: there is nothing to recover from.
    if (state !== "healthy" && state !== "not_configured") {
      transitionHealth(db, serviceId, { type: "sync_success" });
    }
  }
}

/** Tool names starting `__nimbus_` belong to the gateway (the sync entry point). */
export const RESERVED_EXTENSION_TOOL_PREFIX = "__nimbus_";

export function isReservedExtensionToolName(unprefixedName: string): boolean {
  return unprefixedName.startsWith(RESERVED_EXTENSION_TOOL_PREFIX);
}

function stoppedWhileStarting(serviceId: string): ExtensionRunGrantError {
  return new ExtensionRunGrantError(
    "ERR_EXTENSION_RUN_STOPPED",
    `${serviceId} was stopped while it was starting; retry`,
  );
}
