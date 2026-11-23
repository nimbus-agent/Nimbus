// packages/gateway/src/connectors/lazy-mesh/iac-runner/iac-live-children.ts
// The record of the children a gateway process started, and the boot sweep that reads it (invariant
// I15; static D43(d)). Split out of `iac-runner.ts` with no behaviour change: a child a crashed
// gateway left may still be alive, so its run directories are kept and a run on its workdir is
// refused; a record that cannot be read refuses every run (fail closed).
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { IAC_PREFLIGHT_REFUSALS } from "../../connector-writes/iac-limits.ts";

export class IacLiveChildren {
  private swept = false;
  /** Children a previous gateway process recorded and that are still alive at boot (see sweep). */
  orphans: Array<{ pid: number; workdir?: string }> = [];
  /** The live-children record existed but could not be read: no run starts until it can be. */
  private liveRecordUnreadable = false;

  constructor(
    private readonly iacRoot: string,
    private readonly removeTree: (p: string) => void,
    private readonly isPidAlive: ((pid: number) => boolean) | undefined,
  ) {}

  private liveFile(): string {
    return join(this.iacRoot, "live-children.json");
  }

  pidAlive(pid: number): boolean {
    if (this.isPidAlive !== undefined) return this.isPidAlive(pid);
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as { code?: unknown }).code === "EPERM";
    }
  }

  /** The children recorded as started; `undefined` when the record exists but cannot be read. */
  private readLive(): Array<{ pid: number; workdir?: string }> | undefined {
    let raw: string;
    try {
      raw = readFileSync(this.liveFile(), "utf8");
    } catch (e) {
      return (e as { code?: unknown }).code === "ENOENT" ? [] : undefined;
    }
    try {
      const parsed: unknown = JSON.parse(raw);
      if (!Array.isArray(parsed)) return undefined;
      const out: Array<{ pid: number; workdir?: string }> = [];
      for (const e of parsed as unknown[]) {
        const rec = e as { pid?: unknown; workdir?: unknown };
        if (typeof rec.pid !== "number" || !Number.isInteger(rec.pid)) return undefined;
        out.push(
          typeof rec.workdir === "string"
            ? { pid: rec.pid, workdir: rec.workdir }
            : { pid: rec.pid },
        );
      }
      return out;
    } catch {
      return undefined;
    }
  }

  private writeLive(entries: ReadonlyArray<{ pid: number; workdir?: string }>): void {
    try {
      mkdirSync(this.iacRoot, { recursive: true, mode: 0o700 });
      // Atomic: a crash mid-write leaves the previous record, never a truncated one.
      const tmp = `${this.liveFile()}.tmp`;
      writeFileSync(tmp, JSON.stringify(entries), { mode: 0o600 });
      renameSync(tmp, this.liveFile());
    } catch {
      // best effort: the record only narrows what a later boot deletes
    }
  }

  // An unreadable record is never overwritten: it is the only evidence of what may still be running.
  recordLive(pid: number, workdir: string | undefined): void {
    const cur = this.readLive();
    if (cur === undefined) return;
    this.writeLive([
      ...cur.filter((e) => e.pid !== pid),
      workdir === undefined ? { pid } : { pid, workdir },
    ]);
  }

  forgetLive(pid: number): void {
    const cur = this.readLive();
    if (cur === undefined) return;
    this.writeLive(cur.filter((e) => e.pid !== pid));
  }

  /**
   * Boot sweep, once: nothing a crashed gateway left under the iac root is worth keeping, EXCEPT
   * while a child it recorded may still be alive (a macOS child can outlive the gateway; a Linux
   * child dies with it by `--die-with-parent`, a Windows child by its job object): then the run
   * directories are left for a later boot, and a run on that child's workdir is refused. A record
   * that cannot be read fails closed: it is kept as it is, nothing is deleted, and every run is
   * refused until a later read of it succeeds ({@link liveRecordRefusal}).
   */
  sweep(): void {
    if (this.swept) return;
    this.swept = true;
    const recorded = this.readLive();
    if (recorded === undefined) {
      this.liveRecordUnreadable = true;
      return;
    }
    const alive = recorded.filter((e) => this.pidAlive(e.pid));
    this.orphans = alive;
    this.writeLive(alive);
    if (alive.length > 0) return;
    for (const d of ["staging", "approved", "scratch", "cwd", "kube"]) {
      try {
        this.removeTree(join(this.iacRoot, d));
      } catch {
        // best effort
      }
    }
  }

  /**
   * While the live-children record is unreadable, re-read it: once it parses, its live children
   * become the orphans a run must not overlap (their directories are still not deleted this boot).
   */
  liveRecordRefusal(): string | undefined {
    if (!this.liveRecordUnreadable) return undefined;
    const recorded = this.readLive();
    if (recorded === undefined) return IAC_PREFLIGHT_REFUSALS.liveRecordUnreadable;
    this.liveRecordUnreadable = false;
    this.orphans = recorded.filter((e) => this.pidAlive(e.pid));
    this.writeLive(this.orphans);
    return undefined;
  }
}
