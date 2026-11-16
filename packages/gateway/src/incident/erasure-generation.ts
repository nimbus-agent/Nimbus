/**
 * A process-wide counter that an owner erasure bumps (Phase 10 IC3 review). An assembly reads evidence, awaits
 * the deterministic render, then writes; if an erasure committed in between, the evidence it holds may include
 * what was just erased. `assembleOne` reads the counter before it gathers evidence and again, synchronously,
 * right before it writes, and starts over once if it moved. No imports: both sides depend on this and on nothing.
 */
let generation = 0;

export function erasureGeneration(): number {
  return generation;
}

/** Called by the erasers, inside their transaction, before any delete. */
export function noteErasure(): void {
  generation += 1;
}
