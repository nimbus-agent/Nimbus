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

export const missingDependencyRegistry = new MissingDependencyRegistry();

export function _resetMissingDependencyRegistry(): void {
  missingDependencyRegistry.reset();
}
