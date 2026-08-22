import { isAbsolute } from "node:path";
import type { SandboxPolicy } from "../platform/sandbox/sandbox-policy.ts";

export class ExecPolicyError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ExecPolicyError";
  }
}

export interface ExecGrants {
  readonly fsRead: readonly string[];
  readonly fsWrite: readonly string[];
  /** Present only so that a request for network can be REJECTED rather than ignored. */
  readonly network?: readonly string[];
}

function requireAbsolute(paths: readonly string[], what: string): string[] {
  for (const p of paths) {
    if (!isAbsolute(p)) {
      // Deliberately NOT resolved here. The gateway's cwd is not the CLI's cwd, so resolving would
      // grant a real directory that is not the one the user named -- wrong, and invisible from this
      // side. The CLI resolves before the IPC hop; this side refuses anything it did not.
      throw new ExecPolicyError(
        "ERR_EXEC_RELATIVE_PATH",
        `${what} grant must be an absolute path: ${p}`,
      );
    }
  }
  // Copy: the policy crosses into the sandbox runners, and a caller that mutates its own array
  // afterwards must not be able to widen a policy the owner already approved.
  return [...paths];
}

/**
 * The single grants -> policy derivation for a one-shot execution (I33).
 *
 * `permissions.network` is empty by CONSTRUCTION, not by a caller remembering to omit it, and a
 * caller that asks for network is refused outright. Slice 1 has no network path at all; the
 * refusal is what keeps that claim true rather than merely customary -- and it is what makes
 * "no network" mean no LOOPBACK either, which is where the Gateway's own IPC socket and HTTP API
 * live. An empty network set is what drives `--unshare-net` on Linux, the absent `(allow network*)`
 * block on macOS, and the absent `internetClient` capability on Windows.
 */
export function buildExecPolicy(executionId: string, grants: ExecGrants): SandboxPolicy {
  if (grants.network !== undefined && grants.network.length > 0) {
    throw new ExecPolicyError(
      "ERR_EXEC_NETWORK_UNSUPPORTED",
      "network access is not available to sandboxed executions in this release",
    );
  }
  return {
    id: `exec-${executionId}`,
    permissions: {
      network: [],
      filesystem: {
        read: requireAbsolute(grants.fsRead, "read"),
        write: requireAbsolute(grants.fsWrite, "write"),
      },
    },
  };
}
