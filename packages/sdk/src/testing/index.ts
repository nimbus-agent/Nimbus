/**
 * `@nimbus-dev/sdk/testing` — utilities for extension authors and the
 * gateway's own connector tests.
 *
 * Exports:
 *   - `MockGateway` — mock Gateway IPC for unit tests (Phase 4).
 *   - `runSandboxContractTests(manifestPath)` — fork the probe binary and
 *     verify the runtime sandbox enforces the manifest's declared
 *     `permissions.network` + `permissions.filesystem` (Phase 5 T2 PR 1).
 */

export { runSandboxContractTests } from "./sandbox-contract";

export class MockGateway {
  // Roadmap Q3: mock Gateway for extension testing
  async callTool(_toolName: string, _input: Record<string, unknown>): Promise<unknown> {
    return {};
  }
}
