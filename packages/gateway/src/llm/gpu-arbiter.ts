type ReleaseCallback = () => void;
type QueueEntry = () => void;

export class GpuArbiter {
  private locked = false;
  private _currentProvider: string | null = null;
  private readonly queue: QueueEntry[] = [];
  private readonly timeoutMs: number;
  private lastActivityAt = 0;
  private readonly onForceRelease: ((providerId: string) => void) | undefined;

  constructor(timeoutMs = 30_000, onForceRelease?: (providerId: string) => void) {
    this.timeoutMs = timeoutMs;
    this.onForceRelease = onForceRelease;
  }

  get isLocked(): boolean {
    return this.locked;
  }

  get currentProvider(): string | null {
    return this._currentProvider;
  }

  touch(): void {
    this.lastActivityAt = Date.now();
  }

  async acquire(providerId: string): Promise<ReleaseCallback> {
    if (this.locked && Date.now() - this.lastActivityAt > this.timeoutMs) {
      this.forceRelease();
    }

    if (!this.locked) {
      return this.claimSlot(providerId);
    }

    return new Promise<ReleaseCallback>((resolve) => {
      this.queue.push(() => {
        resolve(this.claimSlot(providerId));
      });
    });
  }

  private claimSlot(providerId: string): ReleaseCallback {
    this.locked = true;
    this._currentProvider = providerId;
    this.lastActivityAt = Date.now();
    return this.makeRelease();
  }

  private makeRelease(): ReleaseCallback {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.freeSlot();
    };
  }

  private freeSlot(): void {
    const next = this.queue.shift();
    if (next === undefined) {
      this.locked = false;
      this._currentProvider = null;
    } else {
      next();
    }
  }

  private forceRelease(): void {
    const evicted = this._currentProvider;
    this.locked = false;
    this._currentProvider = null;
    this.queue.length = 0;
    if (evicted !== null) {
      this.onForceRelease?.(evicted);
    }
  }
}
