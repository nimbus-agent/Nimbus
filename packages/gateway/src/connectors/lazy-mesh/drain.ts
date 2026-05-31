export class LazyDrainTracker {
  private inFlight = 0;
  private resolveDrained: (() => void) | undefined;
  private drained: Promise<void> | undefined;

  bump(): void {
    this.inFlight += 1;
    this.drained ??= new Promise<void>((r) => {
      this.resolveDrained = r;
    });
  }

  drop(): void {
    if (this.inFlight > 0) this.inFlight -= 1;
    if (this.inFlight === 0 && this.resolveDrained !== undefined) {
      this.resolveDrained();
      this.drained = undefined;
      this.resolveDrained = undefined;
    }
  }

  awaitDrain(): Promise<void> {
    return this.drained ?? Promise.resolve();
  }

  get count(): number {
    return this.inFlight;
  }
}
