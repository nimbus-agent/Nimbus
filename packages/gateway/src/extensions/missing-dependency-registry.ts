/**
 * Task 13 / spec §4.4 part 2 — startup completeness guard registry.
 *
 * Tracks extensions that are effectively disabled because one or more of their
 * declared dependencies is missing from the installed set, hard-disabled by a
 * prior pipeline stage (pre-T2 or signature-verify), or installed at a version
 * that no longer satisfies the declared semver range.
 *
 * Parallels {@link signatureDisabledRegistry} and {@link preT2DisabledRegistry}
 * in `hard-disable.ts` — module-level singleton, rebuilt on every
 * `verifyExtensionsBestEffort` run by the completeness guard pass.
 *
 * The connector spawn site (which would refuse to spawn an extension whose id
 * appears here) is **deferred** — see Task 13 report. The registry itself and
 * its population are what Task 13 delivers.
 */

export type MissingDependencyReason = "dependency_missing" | "dependency_unsatisfied";

export interface MissingDependencyEntry {
  readonly extensionId: string;
  readonly reason: MissingDependencyReason;
  readonly missingDepId: string;
  readonly requiredRange: string;
  readonly observedVersion?: string;
}

class MissingDependencyRegistry {
  private readonly entries = new Map<string, MissingDependencyEntry>();

  reset(): void {
    this.entries.clear();
  }

  mark(entry: MissingDependencyEntry): void {
    this.entries.set(entry.extensionId, entry);
  }

  clear(extensionId: string): void {
    this.entries.delete(extensionId);
  }

  has(extensionId: string): boolean {
    return this.entries.has(extensionId);
  }

  reasonFor(extensionId: string): MissingDependencyEntry | undefined {
    return this.entries.get(extensionId);
  }

  all(): readonly MissingDependencyEntry[] {
    return [...this.entries.values()].sort((a, b) => a.extensionId.localeCompare(b.extensionId));
  }

  count(): number {
    return this.entries.size;
  }
}

/** Module singleton — parallels `preT2DisabledRegistry` and `signatureDisabledRegistry`. */
export const missingDependencyRegistry = new MissingDependencyRegistry();

/** Test-only reset helper. Production code should call `missingDependencyRegistry.reset()` directly inside the startup pass. */
export function _resetMissingDependencyRegistry(): void {
  missingDependencyRegistry.reset();
}
