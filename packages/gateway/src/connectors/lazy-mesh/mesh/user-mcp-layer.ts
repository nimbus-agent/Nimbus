import { existsSync, rmSync } from "node:fs";

import { processEnvGet } from "../../../platform/env-access.ts";
import { sandboxCwdFor } from "../../../platform/sandbox/sandbox-cwd.ts";
import type { SandboxPolicy } from "../../../platform/sandbox/sandbox-policy.ts";
import {
  type AppContainerGrantRevoker,
  appContainerGrantRevokerFor,
} from "../../../platform/sandbox/win32-grant-revoke.ts";
import { EMPTY_IAC_GRANTS } from "../../connector-writes/iac-grants.ts";
import { transitionHealth } from "../../health.ts";
import type { UserMcpConnectorRow } from "../../user-mcp-store.ts";
import type { WriteDirDeps } from "../../write-dir-rules.ts";
import { USER_MESH_PREFIX, userMcpMeshKey } from "../keys.ts";
import { type LazyMeshToolMap, listLazyMeshClientTools } from "../tool-map.ts";
import { ensureUserMcpClient, parseStringArrayColumn } from "../user-mcp.ts";
import { productionWriteDirDeps, registeredWriteDirsOf } from "../user-mcp-write-deps.ts";
import {
  fileUserMcpGrantLedger,
  ledgerServiceIds,
  NO_USER_MCP_WRITE_GRANT,
  type PreparedUserMcpWriteGrant,
  prepareUserMcpWriteGrant,
  releaseUserMcpGrants,
  type UserMcpGrantLedgerStore,
  userMcpGrantLedgerFile,
  userMcpPolicyId,
} from "../user-mcp-write-grant.ts";
import type { MeshCtorArgs } from "./ctor-args.ts";
import { MeshObsidian } from "./obsidian-layer.ts";
import { userMcpProtectedRootsFor } from "./roots.ts";

/**
 * The gateway's own deadline on listing one user-MCP server's tools for the agent door. Before it,
 * the only bound was the MCP client's: its connect and its `tools/list` request each default to
 * 60 s (`DEFAULT_REQUEST_TIMEOUT_MSEC`, never configured in `lazy-mesh/`), so a server that starts
 * and never answers held a caller for up to about two minutes. 45 s covers a cold start of a
 * sandboxed server (the Windows AppContainer profile included) and is shorter than that worst case.
 * On expiry the listing reads as "could not be listed" (`undefined`).
 */
export const USER_MCP_LISTING_DEADLINE_MS = 45_000;

/**
 * The fourth layer of the mesh's class chain: user MCP servers (`mcp_*`, I42, I15 AD5b-2): the write
 * grant's preparation behind every spawn decision (`prepareUserMcpSpawn`), the Windows ledger, the
 * sandbox leaf, and the listings. Moved verbatim out of `mesh.ts`.
 */
export abstract class MeshUserMcp extends MeshObsidian {
  private readonly userMcpListingDeadlineMs: number;
  private readonly removeSandboxDir: (dir: string) => void;
  private readonly sandboxDirExists: (dir: string) => boolean;
  /** The user MCP write-grant seams (I15, AD5b): the rule's facts, the sandbox's answer, the Windows ledger. */
  private readonly userMcpWriteDir: WriteDirDeps;
  private readonly userMcpCanConfine: (policy: SandboxPolicy) => string | null;
  private readonly userMcpLedger: UserMcpGrantLedgerStore;
  private readonly userMcpRevokerFor: (policyId: string) => AppContainerGrantRevoker;
  /** Tail of the user MCP spawn-preparation queue: one ledger read-modify-write at a time. */
  private userMcpPrepareTail: Promise<void> = Promise.resolve();
  /** Ledger entries of ids with no row are revoked once, before the first spawn decision. */
  private userMcpOrphansSettled = false;
  /** Servers whose write grant is being refused, so the refusal is logged once per streak. */
  private readonly userMcpWriteRefused = new Set<string>();

  constructor(args: MeshCtorArgs) {
    super(args);
    const { paths, options, platform } = args;
    this.removeSandboxDir =
      options?.removeSandboxDir ?? ((dir) => rmSync(dir, { recursive: true, force: true }));
    this.sandboxDirExists = options?.sandboxDirExists ?? existsSync;
    this.userMcpListingDeadlineMs =
      options?.userMcpListingDeadlineMs ?? USER_MCP_LISTING_DEADLINE_MS;
    const iacGrantsNow = options?.iacGrants ?? (() => EMPTY_IAC_GRANTS);
    this.userMcpWriteDir = {
      ...productionWriteDirDeps({
        paths,
        platform,
        listRows: () => this.listUserMcpConnectors(),
        iacWorkdirs: () => iacGrantsNow().workdirs,
        envVar: processEnvGet,
      }),
      ...options?.userMcpWriteDirDeps,
    };
    this.userMcpCanConfine =
      options?.userMcpCanConfine ??
      (() => "this gateway has no sandbox runner to confine a write directory");
    this.userMcpLedger =
      options?.userMcpGrantLedger ??
      fileUserMcpGrantLedger(userMcpGrantLedgerFile(paths.configDir));
    this.userMcpRevokerFor =
      options?.userMcpGrantRevokerFor ??
      ((policyId) => appContainerGrantRevokerFor(platform, policyId));
  }

  protected async stopUserMcpClient(serviceId: string): Promise<void> {
    await this.stopLazyClient(userMcpMeshKey(serviceId));
  }

  /** Directories no user MCP may be granted a read of: Nimbus's own data, config and sandbox root. */
  userMcpProtectedRoots(): readonly string[] {
    return userMcpProtectedRootsFor(this.paths);
  }

  /**
   * Stops a removed user MCP and deletes its sandbox leaf. Best-effort and NEVER throws: a Windows
   * child releases its cwd handle a moment after it exits, so the delete is tried up to three times
   * 100 ms apart, and a leaf that still will not go is logged, not raised — `connector.remove` must
   * not fail on a locked directory.
   */
  async removeUserMcpSandbox(serviceId: string): Promise<void> {
    try {
      await this.stopUserMcpClient(serviceId);
    } catch (err) {
      this.logger?.warn({ serviceId, err }, "user MCP client not stopped before sandbox removal");
    }
    // After the stop, never under a running child: on Windows every path the profile was granted
    // (read and write) is revoked from the ledger. A failed revoke keeps the entry as a debt that
    // the next registration of this id, or the boot step, settles; removal itself still succeeds.
    if (!(await this.releaseUserMcpGrants(serviceId))) {
      this.logger?.warn({ serviceId }, "user MCP sandbox grants not revoked; kept in the ledger");
    }
    this.userMcpWriteRefused.delete(serviceId);
    const leaf = this.userMcpSandboxLeaf(serviceId);
    const lastErr = await this.deleteSandboxLeaf(leaf);
    if (lastErr !== undefined) {
      this.logger?.warn({ serviceId, err: lastErr }, "user MCP sandbox directory not removed");
    }
  }

  /** The facts the user MCP write-directory rule reads, live (I15, AD5b). */
  userMcpWriteDirDeps(): WriteDirDeps {
    return this.userMcpWriteDir;
  }

  /** The sandbox's answer for a write-directory policy: `null` when it can confine it. */
  userMcpWriteCanConfine(policy: SandboxPolicy): string | null {
    return this.userMcpCanConfine(policy);
  }

  /** The write directories of every registered user MCP server but `exceptServiceId`. */
  userMcpRegisteredWriteDirs(exceptServiceId?: string): readonly string[] {
    return registeredWriteDirsOf(this.listUserMcpConnectors(), exceptServiceId);
  }

  /** One at a time: every user MCP spawn preparation and every release of a ledger entry. */
  private runUserMcpPrepareSerial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.userMcpPrepareTail.then(fn);
    this.userMcpPrepareTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * Windows: revokes every path the ledger records for `serviceId` and drops the entry. `false`
   * when it could not (the entry stays). A no-op elsewhere. Never throws.
   */
  releaseUserMcpGrants(serviceId: string): Promise<boolean> {
    return this.runUserMcpPrepareSerial(() =>
      releaseUserMcpGrants(serviceId, {
        ledger: this.userMcpLedger,
        revokerFor: this.userMcpRevokerFor,
      }),
    );
  }

  /**
   * Before a registration stores its row: the Windows permissions an EARLIER registration of this
   * id left are revoked. On the same serial chain as every spawn preparation, and only while no
   * row holds the id: a second add of an id that was registered meanwhile answers `registered`
   * and revokes nothing, so it can never cut the grants of the live registration it lost to.
   */
  releaseUserMcpGrantsUnlessRegistered(serviceId: string): Promise<boolean | "registered"> {
    return this.runUserMcpPrepareSerial(async () => {
      if (this.listUserMcpConnectors().some((r) => r.service_id === serviceId)) {
        return "registered" as const;
      }
      return releaseUserMcpGrants(serviceId, {
        ledger: this.userMcpLedger,
        revokerFor: this.userMcpRevokerFor,
      });
    });
  }

  /** Once, before the first spawn decision: ledger entries whose id has no row are revoked. */
  private async settleOrphanUserMcpGrants(): Promise<void> {
    if (this.userMcpOrphansSettled) return;
    this.userMcpOrphansSettled = true;
    if (!this.userMcpRevokerFor(userMcpPolicyId("mcp_probe")).active) return;
    const recorded = ledgerServiceIds(this.userMcpLedger);
    if (recorded === undefined) return;
    const live = new Set(this.listUserMcpConnectors().map((r) => r.service_id));
    for (const id of recorded) {
      if (live.has(id)) continue;
      const released = await releaseUserMcpGrants(id, {
        ledger: this.userMcpLedger,
        revokerFor: this.userMcpRevokerFor,
      });
      if (!released) {
        this.logger?.warn({ serviceId: id }, "orphaned user MCP sandbox grants not revoked");
      }
    }
  }

  /**
   * The write grant ONE spawn decision of `row` may carry (I15, AD5b), or `undefined` when the
   * spawn is refused. A slot that already has a client is left alone (a revoke under a running
   * child would cut its grant). A refusal records a persistent error, logs once per failing
   * streak, and NEVER falls back to a spawn without the grant.
   */
  private prepareUserMcpSpawn(
    row: UserMcpConnectorRow,
  ): Promise<PreparedUserMcpWriteGrant | undefined> {
    return this.runUserMcpPrepareSerial(async () => {
      if (this.spawnContext.getLazyClient(userMcpMeshKey(row.service_id)) !== undefined) {
        return NO_USER_MCP_WRITE_GRANT;
      }
      await this.settleOrphanUserMcpGrants();
      const read = parseStringArrayColumn(row.read_paths_json);
      const net = parseStringArrayColumn(row.net_hosts_json);
      // A malformed read or host column is the client builder's refusal, with its own record.
      if (!read.ok || !net.ok) return NO_USER_MCP_WRITE_GRANT;
      const result = await prepareUserMcpWriteGrant(row, read.value, net.value, {
        writeDir: this.userMcpWriteDir,
        canConfine: this.userMcpCanConfine,
        ledger: this.userMcpLedger,
        revokerFor: this.userMcpRevokerFor,
      });
      if (result.ok) {
        this.userMcpWriteRefused.delete(row.service_id);
        return result.grant;
      }
      if (!this.userMcpWriteRefused.has(row.service_id)) {
        this.userMcpWriteRefused.add(row.service_id);
        this.logger?.warn(
          { serviceId: row.service_id, reason: result.reason },
          "user MCP not started: its write directory may not be granted now",
        );
      }
      if (this.healthDb !== undefined) {
        transitionHealth(this.healthDb, row.service_id, {
          type: "persistent_error",
          error: `write directory refused: ${result.reason}`,
        });
      }
      return undefined;
    });
  }

  /** The deterministic sandbox leaf a user MCP server with this id spawns in. */
  userMcpSandboxLeaf(serviceId: string): string {
    return sandboxCwdFor(this.paths.sandboxDir, `user.${serviceId}`);
  }

  /**
   * Ensures no sandbox leaf is left over for `serviceId` before it is (re-)registered. The leaf is
   * deterministic and `removeUserMcpSandbox` is best-effort, so a removed registration whose leaf a
   * Windows lock kept alive would otherwise hand its files to the NEXT server registered under the
   * same id — the sandbox wrapper's recursive mkdir keeps whatever is there. Deletes a leftover leaf
   * with the same retry policy as removal; returns `false` when the leaf still exists afterwards,
   * and the caller must then refuse the registration. Never throws.
   */
  async ensureUserMcpSandboxClean(serviceId: string): Promise<boolean> {
    const leaf = this.userMcpSandboxLeaf(serviceId);
    if (!this.sandboxDirExists(leaf)) return true;
    const lastErr = await this.deleteSandboxLeaf(leaf);
    if (lastErr === undefined && !this.sandboxDirExists(leaf)) return true;
    this.logger?.warn(
      { serviceId, err: lastErr },
      "stale user MCP sandbox directory not cleared before registration",
    );
    return false;
  }

  /**
   * Deletes a sandbox leaf, tried up to three times 100 ms apart (a Windows child releases its cwd
   * handle a moment after it exits). Returns the last error when every attempt failed, else
   * `undefined`. Never throws.
   */
  protected async deleteSandboxLeaf(leaf: string): Promise<unknown> {
    let lastErr: unknown;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        this.removeSandboxDir(leaf);
        return undefined;
      } catch (err) {
        lastErr = err ?? new Error("sandbox directory delete failed");
        if (attempt < 3) await Bun.sleep(100); // NOSONAR S9382: a retry backoff is sequential by definition
      }
    }
    return lastErr;
  }

  /**
   * Nothing here awaits — `ensureUserMcpClient` is synchronous — but callers hold this as an
   * ensure-running hook and await it. `Promise.try` runs the body immediately and turns a throw
   * (from the row lookup or the client registration) into a rejection, as `async` did.
   */
  ensureUserMcpRunning(serviceId: string): Promise<void> {
    return Promise.try(async () => {
      const rows = this.listUserMcpConnectors();
      const row = rows.find((r) => r.service_id === serviceId);
      if (row === undefined) {
        return;
      }
      const prepared = await this.prepareUserMcpSpawn(row);
      if (prepared === undefined) return;
      ensureUserMcpClient(this.spawnContext, row, prepared);
    });
  }

  /**
   * The tools of ONE registered user MCP server — its own slot only, never the merged dispatcher
   * map, so `connector.userMcpTools` cannot be used to enumerate another server's (or a built-in
   * connector's) tools. `undefined` when no `user_mcp_connector` row names the id. Keys are as the
   * slot's `MCPClient` lists them: `<serviceId>_<tool>`.
   */
  async listUserMcpTools(
    serviceId: string,
    expired?: AbortSignal,
  ): Promise<LazyMeshToolMap | undefined> {
    const registered = this.listUserMcpConnectors().some((r) => r.service_id === serviceId);
    if (!registered) {
      return undefined;
    }
    // The same boot-revoke gate every merged listing waits on (`collectBuiltInToolMaps`): a user
    // MCP's first listing spawns it through the Windows helper, whose grants rewrite DACLs under
    // the directory the revoke is rewriting. The per-server dispatch path no longer goes through the
    // merged listing, so it waits here instead.
    await this.filesystemSpawnGate;
    // An attempt whose caller already gave up (the agent door's deadline passed while the gate was
    // awaited) starts nothing: no client is ensured and no tool is requested.
    if (expired?.aborted === true) {
      return undefined;
    }
    await this.ensureUserMcpRunning(serviceId);
    return listLazyMeshClientTools(this.getLazyClient(userMcpMeshKey(serviceId)));
  }

  /**
   * ONE registered user-MCP server's tool DEFINITIONS for the agent door (AD5a), stripped to
   * `description` and `inputSchema`. {@link listUserMcpTools} returns callable tools; their
   * `execute` would call the sandboxed server outside the executor's HITL and egress chokepoint, so
   * it never leaves here (the shape {@link listFirstPartyServerTools} keeps for a first-party
   * server). `undefined` when no `user_mcp_connector` row names the id, or when the server lists
   * nothing (it cannot be started, or lists no tool: the MCP client swallows a failed start and
   * lists none). Keys are the slot's `<serviceId>_<tool>`; a key that does not start with
   * `<serviceId>_` is dropped, so a listing can never speak for another server. Only THIS server's
   * slot is ensured, and the call may start it: the caller is the door's definition check, reached
   * only for a tool the owner approved for agents by name. A throw is the listing's own. The whole
   * listing (the wait for the spawn gate, the start and the request) is bounded by
   * {@link USER_MCP_LISTING_DEADLINE_MS} here, in the ONE place every caller goes through: on expiry
   * the result is `undefined` ("could not be listed"), an attempt still waiting for the spawn gate
   * starts nothing when the gate opens (the expiry is checked after the wait and before the client
   * is ensured), and the abandoned promise is given a no-op rejection handler, so it can neither
   * reject unhandled nor affect a later listing. A start or a tool request already in flight when
   * the deadline fires cannot be cancelled: it runs to its own end and its result is discarded.
   */
  async listUserMcpToolDefinitions(
    serviceId: string,
  ): Promise<Readonly<Record<string, { description: unknown; inputSchema: unknown }>> | undefined> {
    const giveUp = new AbortController();
    const pending = this.listUserMcpTools(serviceId, giveUp.signal);
    pending.catch(() => undefined);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => {
        giveUp.abort();
        resolve("expired");
      }, this.userMcpListingDeadlineMs);
    });
    let tools: LazyMeshToolMap | undefined | "expired";
    try {
      tools = await Promise.race([pending, expired]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
    if (tools === undefined || tools === "expired") return undefined;
    const prefix = `${serviceId}_`;
    const out: Record<string, { description: unknown; inputSchema: unknown }> = {};
    for (const key of Object.keys(tools)) {
      if (!key.startsWith(prefix)) continue;
      const listed: unknown = tools[key];
      const rec =
        typeof listed === "object" && listed !== null ? (listed as Record<string, unknown>) : {};
      out[key] = { description: rec["description"], inputSchema: rec["inputSchema"] };
    }
    return Object.keys(out).length === 0 ? undefined : out;
  }

  /**
   * {@link listUserMcpTools} for the connector dispatcher: the same ONE-slot listing, with each tool
   * wrapped in that slot's drain refcount exactly as {@link listToolsForDispatcher} wraps it, so a
   * slot stop still waits for an in-flight user-MCP call. Running a user-MCP action therefore
   * spawns only its own server, never every connector the merged listing would start.
   */
  async listUserMcpToolsForDispatcher(serviceId: string): Promise<LazyMeshToolMap | undefined> {
    return this.wrapSlotToolsWithDrain(
      userMcpMeshKey(serviceId),
      await this.listUserMcpTools(serviceId),
    );
  }

  // `mesh:user:` slots only, here and in `collectUserMcpToolMap`: extension (`mesh:ext:`) tools are
  // not offered to the model until a later PR, so they never enter the merged dispatcher map, and
  // `buildSlotForToolMap` never lists an extension slot either.
  protected async ensureUserMcpConnectorsRunning(): Promise<void> {
    const rows = this.listUserMcpConnectors();
    const active = new Set(rows.map((r) => r.service_id));
    // Stale slots are torn down concurrently: the stops are independent of one another, never
    // reject, and may each wait up to ten minutes for in-flight calls to drain — sequentially, one
    // draining slot held back every stop after it. The keys are snapshotted before any stop runs.
    const staleIds = Array.from(this.lazySlots.keys())
      .filter((key) => key.startsWith(USER_MESH_PREFIX))
      .map((key) => key.slice(USER_MESH_PREFIX.length))
      .filter((id) => !active.has(id));
    await Promise.all(staleIds.map((id) => this.stopUserMcpClient(id)));
    for (const row of rows) {
      const prepared = await this.prepareUserMcpSpawn(row);
      if (prepared !== undefined) ensureUserMcpClient(this.spawnContext, row, prepared);
    }
  }
}
