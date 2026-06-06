import { QuorumCoordinator } from "./quorum-coordinator.ts";

class BoundQuorumCoordinator extends QuorumCoordinator {
  private channel: (requestId: string) => void = () => {};
  constructor() {
    super((requestId) => this.channel(requestId));
  }
  setBroadcast(fn: (requestId: string) => void): void {
    this.channel = fn;
  }
}

/** Process-wide quorum aggregator; `setBroadcast` is late-bound after the IPC server exists. */
export const quorumCoordinator = new BoundQuorumCoordinator();
