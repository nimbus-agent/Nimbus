import type { AvailableUpdate } from "./auto-update-types.ts";

export class AutoUpdateCache {
  private readonly entries = new Map<string, AvailableUpdate>();

  get(id: string): AvailableUpdate | undefined {
    return this.entries.get(id);
  }

  list(): AvailableUpdate[] {
    return Array.from(this.entries.values());
  }

  upsert(update: AvailableUpdate): void {
    this.entries.set(update.id, update);
  }

  isNewDetection(update: AvailableUpdate): boolean {
    const cur = this.entries.get(update.id);
    return cur === undefined || cur.toVersion !== update.toVersion;
  }

  remove(id: string): void {
    this.entries.delete(id);
  }

  clear(): void {
    this.entries.clear();
  }
}
