import { EphemeralVault } from "./ephemeral.ts";
import type { NimbusVault } from "./nimbus-vault.ts";

/** Test double. Same behaviour as the production `EphemeralVault`, kept as a name tests import. */
export class MockVault extends EphemeralVault {}

export function createMockVault(): NimbusVault {
  return new MockVault();
}
