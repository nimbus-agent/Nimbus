import { type IPCClientOptions, IPCClient as UpstreamIPCClient } from "@nimbus-dev/client";

import { assertSocketOwnedByCurrentUser } from "./socket-owner.ts";

export { MockClient, NimbusClient } from "@nimbus-dev/client";
export { ForeignSocketOwnerError } from "./socket-owner.ts";

/**
 * The published IPC client, with one check before every connection: the socket must be owned by
 * the user running the CLI (`assertSocketOwnedByCurrentUser`). Every CLI command builds its client
 * from this module, so the check cannot be skipped by a command that forgets it.
 */
export class IPCClient extends UpstreamIPCClient {
  private readonly ownedSocketPath: string;

  constructor(socketPath: string, opts?: IPCClientOptions) {
    super(socketPath, opts);
    this.ownedSocketPath = socketPath;
  }

  override async connect(): Promise<void> {
    assertSocketOwnedByCurrentUser(this.ownedSocketPath);
    return super.connect();
  }
}
