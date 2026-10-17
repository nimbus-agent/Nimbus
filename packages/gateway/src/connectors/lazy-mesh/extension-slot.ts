import { randomUUID } from "node:crypto";

import { MCPClient } from "@mastra/mcp";

import { ExtensionRunGrantError } from "../../extensions/run-grant-error.ts";
import { getConnectorHealth, transitionHealth } from "../health.ts";
import type { ExtensionSlotSource } from "./extension-slot-source.ts";
import { extensionMeshKey } from "./keys.ts";
import type { ServerSpec } from "./slot.ts";

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

  constructor(
    private readonly host: ExtensionSlotHost,
    private readonly options: ExtensionSlotsOptions,
  ) {}

  /**
   * Ensures a live client for `serviceId`. Resolves `false` when the id is not (or, after the
   * preparation, no longer) listed. Rejects with the source's `ExtensionRunGrantError` on a refusal,
   * after recording it as the service's `persistent_error`.
   */
  async ensureRunning(serviceId: string): Promise<boolean> {
    const source = this.options.source;
    if (source === undefined || !source.listServiceIds().includes(serviceId)) return false;
    await this.options.spawnGate;
    const key = extensionMeshKey(serviceId);
    if (this.host.getLazyClient(key) !== undefined) {
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
    for (let p = this.stopping.get(serviceId); p !== undefined; p = this.stopping.get(serviceId)) {
      await p;
    }
  }

  /** Called by the mesh whenever an extension slot's client is cleared. */
  forgetService(serviceId: string): void {
    for (const [extensionId, sid] of this.serviceIdByExtensionId) {
      if (sid === serviceId) this.serviceIdByExtensionId.delete(extensionId);
    }
  }

  private async connectSlot(source: ExtensionSlotSource, serviceId: string): Promise<boolean> {
    const startedAt = this.generation;
    // The previous child of this extension must have exited before this spawn verifies and stages
    // its code (I43). Captured `startedAt` stays BEFORE the wait, so a stop landing during it still
    // wins.
    await this.previousChildGone(serviceId);
    let prepared: Awaited<ReturnType<ExtensionSlotSource["prepareSpawn"]>>;
    try {
      prepared = await source.prepareSpawn(serviceId);
    } catch (err) {
      if (err instanceof ExtensionRunGrantError && this.options.healthDb !== undefined) {
        transitionHealth(this.options.healthDb, serviceId, {
          type: "persistent_error",
          error: err.code,
        });
      }
      throw err;
    }
    // A disable or revoke that landed while the preparation was in flight has nothing to stop yet
    // (no client, no running record), so the listing is re-read here and a withdrawn id spawns nothing.
    if (!source.listServiceIds().includes(serviceId)) return false;
    // A stop that did NOT withdraw the id (auto-update swaps the tree and stops with the id still
    // listed) or a mesh shutdown that landed mid-preparation wins too: the next listing re-prepares.
    if (this.stoppedSince(prepared.extensionId, startedAt)) return false;
    const key = extensionMeshKey(serviceId);
    const serverKey = serviceId.replaceAll(/[^a-zA-Z0-9_-]/g, "_");
    const client = this.options.createClient(`nimbus-extension-${serviceId}-${randomUUID()}`, {
      [serverKey]: prepared.spec,
    });
    this.host.setLazyClient(key, client);
    this.serviceIdByExtensionId.set(prepared.extensionId, serviceId);
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
