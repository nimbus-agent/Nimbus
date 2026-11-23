// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-grant-ledger.ts
// The Windows persisted-grants ledger and the chain that serialises the helper's DACL rewrites
// (invariant I15; static D43(d)). Split out of `iac-runner.ts` with no behaviour change.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { PlatformPaths } from "../../../platform/paths.ts";
import {
  type AppContainerGrantRevoker,
  appContainerGrantRevokerFor,
} from "../../../platform/sandbox/win32-grant-revoke.ts";

/** One profile id and every path its spawn was handed a grant on. */
export interface IacLedgerEntry {
  readonly id: string;
  readonly paths: readonly string[];
}

export interface IacGrantLedger {
  /** The recorded entries. Missing: `[]`. Unreadable or malformed: THROWS (fail closed). */
  load(): readonly IacLedgerEntry[];
  save(entries: readonly IacLedgerEntry[]): void;
}

export function iacGrantLedgerFile(configDir: string): string {
  return join(configDir, "sandbox-grants", "iac-ledger.json");
}

export function fileIacGrantLedger(file: string): IacGrantLedger {
  return {
    load: () => {
      let raw: string;
      try {
        raw = readFileSync(file, "utf8");
      } catch (err) {
        if ((err as { code?: unknown }).code === "ENOENT") return [];
        throw err;
      }
      const parsed: unknown = JSON.parse(raw);
      if (
        !Array.isArray(parsed) ||
        !parsed.every(
          (e) =>
            typeof e === "object" &&
            e !== null &&
            typeof (e as IacLedgerEntry).id === "string" &&
            Array.isArray((e as IacLedgerEntry).paths) &&
            (e as IacLedgerEntry).paths.every((p) => typeof p === "string"),
        )
      ) {
        throw new Error(`the iac grant ledger is malformed: ${file}`);
      }
      return parsed as IacLedgerEntry[];
    },
    save: (entries) => {
      mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
      const tmp = `${file}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      renameSync(tmp, file);
    },
  };
}

/** What {@link IacWindowsGrants} reads of the runner's dependencies. */
export interface IacWindowsGrantsDeps {
  readonly paths: Pick<PlatformPaths, "configDir">;
  readonly platform: NodeJS.Platform;
  /** Windows only. Production: the helper-backed revoker. */
  readonly revokerFor?: (profileId: string) => AppContainerGrantRevoker;
  readonly ledger?: IacGrantLedger;
}

export class IacWindowsGrants {
  private ledgerTail: Promise<void> = Promise.resolve();
  /** Profile ids whose child THIS process started and has not yet seen exit and release. */
  private readonly runningProfiles = new Set<string>();

  constructor(private readonly deps: IacWindowsGrantsDeps) {}

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.ledgerTail.then(fn, fn);
    this.ledgerTail = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private revoker(profileId: string): AppContainerGrantRevoker {
    return (this.deps.revokerFor ?? ((id) => appContainerGrantRevokerFor(this.deps.platform, id)))(
      profileId,
    );
  }

  /**
   * Windows only. The ledger holds ONE entry per profile id. Entries whose child this process is
   * not running (a crash, an earlier boot, a release that failed) are revoked FIRST (an ACE outlives
   * its child; a failure refuses the spawn, fail closed, and the stale entry stays); an entry of a
   * child that is still running is left alone, so a sibling mid-apply keeps its grants. Then this
   * spawn's paths are recorded BEFORE it can be granted anything. The helper's DACL rewrites are
   * serialised behind this one chain.
   */
  prepareGrants(profileId: string, paths: readonly string[]): Promise<void> {
    if (!this.revoker(profileId).active) return Promise.resolve();
    const ledger =
      this.deps.ledger ?? fileIacGrantLedger(iacGrantLedgerFile(this.deps.paths.configDir));
    return this.serial(async () => {
      const entries = ledger.load();
      const keep: IacLedgerEntry[] = [];
      for (const e of entries) {
        if (this.runningProfiles.has(e.id)) {
          keep.push(e);
          continue;
        }
        await this.revoker(e.id).revoke(e.paths); // ACL revocations run one at a time, in ledger order, under the serial lock
      }
      ledger.save([...keep, { id: profileId, paths }]);
      this.runningProfiles.add(profileId);
    });
  }

  /** After the child is gone: release this profile's ACEs and drop its ledger entry on success. */
  afterExit(profileId: string, paths: readonly string[]): Promise<void> {
    const revoker = this.revoker(profileId);
    if (!revoker.active) return Promise.resolve();
    const ledger =
      this.deps.ledger ?? fileIacGrantLedger(iacGrantLedgerFile(this.deps.paths.configDir));
    return this.serial(async () => {
      // The child is gone whether or not the release below succeeds: a kept entry is retried by the
      // next spawn, which treats any entry it is not running as stale.
      this.runningProfiles.delete(profileId);
      try {
        await revoker.revoke(paths);
        ledger.save(ledger.load().filter((e) => e.id !== profileId));
      } catch {
        // The entry stays; the next spawn revokes it first (fail closed there).
      }
    });
  }
}
