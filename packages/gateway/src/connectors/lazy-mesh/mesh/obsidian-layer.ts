import { realpathSync } from "node:fs";
import { homedir } from "node:os";

import {
  type AppContainerGrantRevoker,
  appContainerGrantRevokerFor,
} from "../../../platform/sandbox/win32-grant-revoke.ts";
import { discoverVaultsForWriteGrant } from "../../obsidian-discovery.ts";
import { manifestForFirstParty } from "../first-party-manifests.ts";
import { LAZY_MESH } from "../keys.ts";
import {
  type DailyNoteGrantDeps,
  type DailyNoteSkip,
  dailyNotePattern,
  utcDay,
} from "../obsidian-daily-note-grant.ts";
import {
  fileObsidianGrantLedger,
  type ObsidianGrantLedgerStore,
  obsidianGrantLedgerFile,
} from "../obsidian-grant-ledger.ts";
import { type ObsidianGrantSkip, obsidianWriteGrantPaths } from "../obsidian-write-grant.ts";
import type { MeshCtorArgs } from "./ctor-args.ts";
import { MeshEnsureRunners } from "./ensure-runners.ts";
import { userMcpProtectedRootsFor } from "./roots.ts";

/**
 * The third layer of the mesh's class chain: the Obsidian daily-note write grant (I15): the spawn
 * decision's pre-spawn revoke (fail closed on Windows), the UTC-day rollover, the serial queue and
 * the restart after the owner's opt-in changes. Moved verbatim out of `mesh.ts`.
 */
export abstract class MeshObsidian extends MeshEnsureRunners {
  /** The configured `[[filesystem.roots]]` the Obsidian connector reads (each vault's daily note it may write). */
  protected readonly obsidianRoots: readonly string[];
  protected readonly obsidianGrantDeps: DailyNoteGrantDeps;
  private readonly obsidianNow: () => Date;
  /** The UTC date the live Obsidian client's daily-note grant is for; undefined without a grant. */
  private obsidianGrantDay: string | undefined;
  /** Windows only: the fail-closed revoke of the Obsidian profile's ACEs before each grant. */
  private readonly obsidianRevoker: AppContainerGrantRevoker;
  /** Windows only: every path ever handed a write grant and not yet revoked, persisted. */
  private readonly obsidianLedger: ObsidianGrantLedgerStore;
  private obsidianRevokeFailing = false;
  /** Tail of the Obsidian spawn/restart queue (see {@link runObsidianSerial}). */
  private obsidianTail: Promise<void> = Promise.resolve();

  constructor(args: MeshCtorArgs) {
    super(args);
    const { paths, options, platform } = args;
    this.obsidianRoots = options?.obsidianVaultPaths ?? [];
    this.obsidianNow = options?.now ?? (() => new Date());
    this.obsidianGrantDeps = options?.obsidianWriteGrantDeps ?? {
      now: () => this.obsidianNow(),
      discoverVaults: (roots) => discoverVaultsForWriteGrant(roots),
      realpath: (p) => realpathSync.native(p),
      homeDir: homedir(),
      // The extension-grant rule: Nimbus's data, config and sandbox dirs plus the extensions dir.
      protectedRoots: [...userMcpProtectedRootsFor(paths), paths.extensionsDir],
      platform,
    };
    this.obsidianRevoker =
      options?.obsidianGrantRevoker ??
      appContainerGrantRevokerFor(platform, manifestForFirstParty("obsidian").id);
    this.obsidianLedger =
      options?.obsidianGrantLedger ??
      fileObsidianGrantLedger(obsidianGrantLedgerFile(paths.configDir));
  }

  /**
   * One at a time: every Obsidian spawn decision and every {@link restartObsidian}. A grant read
   * inside one step therefore never produces a client after a later restart's stop.
   */
  protected runObsidianSerial<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.obsidianTail.then(fn);
    this.obsidianTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * The paths a Windows revoke must cover: every ledger entry (each file some earlier spawn, in this
   * process or before a restart, was handed a write grant on) and `extra` (this spawn's files).
   * The ledger is written before any grant, so it names every file that can hold a write ACE; no
   * folder is ever granted write (the grant is one daily-note file per vault). Deduplicated.
   */
  private obsidianRevokePaths(
    ledger: readonly string[],
    extra: readonly string[],
  ): readonly string[] {
    return [...new Set([...ledger, ...extra])];
  }

  /**
   * At the start of every Obsidian spawn decision: a live client whose grant names an earlier UTC
   * day's daily note is detached (in-flight calls drain in the background), so this decision spawns
   * one for today. Without the restart the old child's appends to today's note would be refused by
   * the sandbox (it holds only yesterday's file): fail closed, but unusable until the slot idles out.
   */
  protected refreshStaleObsidian(): void {
    const day = this.obsidianGrantDay;
    if (day === undefined || day === utcDay(this.obsidianNow())) return;
    this.obsidianGrantDay = undefined;
    void this.detachLazyClient(LAZY_MESH.obsidian);
  }

  /**
   * The Windows revoke of everything the ledger and the current tree name, then the ledger
   * replaced by `next`. Throws on a failed revoke or ledger write, leaving the ledger as it was.
   * With an empty ledger and nothing to grant it does nothing at all (no discovery, no helper run).
   */
  private async revokeObsidianGrants(next: readonly string[]): Promise<void> {
    const ledger = this.obsidianLedger.load();
    if (ledger.length === 0 && next.length === 0) return;
    await this.obsidianRevoker.revoke(this.obsidianRevokePaths(ledger, next));
    // Written BEFORE the spawn that grants `next`; an old entry leaves only after its revoke.
    this.obsidianLedger.save(next);
  }

  /**
   * The Obsidian pre-spawn hook. On Windows an ACE outlives its child and a grant merges rights, so
   * a spawn after a disable would keep writing: every earlier write ACE is revoked first, the new
   * write list is recorded in the ledger, and any failure refuses the spawn, logged once per failing
   * streak. Elsewhere a bind or a profile lives only as long as its child: nothing to do.
   */
  protected async obsidianPreSpawn(plan: {
    readonly roots: readonly string[];
    readonly writePaths: readonly string[];
    readonly day?: string;
  }): Promise<void> {
    this.obsidianGrantDay = plan.writePaths.length > 0 ? plan.day : undefined;
    if (!this.obsidianRevoker.active) return;
    try {
      await this.revokeObsidianGrants(plan.writePaths);
    } catch (err) {
      if (!this.obsidianRevokeFailing) {
        this.logger?.warn(
          { err },
          "obsidian sandbox grants could not be revoked; the Obsidian connector is not started",
        );
      }
      this.obsidianRevokeFailing = true;
      throw err;
    }
    this.obsidianRevokeFailing = false;
  }

  /**
   * Called after the owner's Obsidian opt-in changes (enable approved, or disable). Returns
   * promptly, never waiting on an in-flight call:
   *  1. the `mesh:obsidian` slot is DETACHED at once: its client is cleared and its generation and
   *     the tools epoch bumped, so no new call reaches the old child and the next call spawns under
   *     the new grant;
   *  2. on Windows the profile's write ACEs are revoked NOW, inside the same serial step, so a
   *     disable withdraws the write from the old child too (every child of the profile shares its
   *     SID) rather than after its drain;
   *  3. the old child's in-flight calls drain and it is disconnected in the background.
   * Never rejects; a failed revoke is logged, the ledger keeps its entries, and the next spawn
   * revokes again. Stated bound (Linux, macOS): an old child keeps the write it was spawned with
   * until its in-flight calls finish (at most the 10-minute drain), but no new call reaches it.
   */
  async restartObsidian(): Promise<void> {
    try {
      await this.runObsidianSerial(async () => {
        this.obsidianGrantDay = undefined;
        void this.detachLazyClient(LAZY_MESH.obsidian);
        if (this.obsidianRevoker.active) await this.revokeObsidianGrants([]);
      });
    } catch (err) {
      this.logger?.warn({ err }, "obsidian sandbox grants not revoked after the opt-in changed");
    }
  }

  /**
   * What approving the Obsidian append would let its sandbox write: the configured roots (as
   * configured), for each vault the grant keeps its daily-note file PATTERN
   * (`<vault>/<daily folder>/<format>.md`: one file a day, the date in UTC), and each vault, or
   * vault's note, that can never be granted, with the reason. For the `connector.writes.enable
   * obsidian` prompt; reads the filesystem, creates nothing, grants nothing.
   */
  obsidianWriteScope(): {
    readonly roots: readonly string[];
    readonly notes: readonly string[];
    readonly skipped: readonly {
      readonly path: string;
      readonly reason: ObsidianGrantSkip | DailyNoteSkip;
    }[];
  } {
    const g = obsidianWriteGrantPaths(this.obsidianRoots, this.obsidianGrantDeps);
    const notes: string[] = [];
    const skipped: { path: string; reason: ObsidianGrantSkip | DailyNoteSkip }[] = [...g.skipped];
    for (const vault of g.paths) {
      const r = dailyNotePattern(vault, this.obsidianGrantDeps.platform);
      if ("pattern" in r) notes.push(r.pattern);
      else skipped.push(r);
    }
    return { roots: [...this.obsidianRoots], notes, skipped };
  }
}
