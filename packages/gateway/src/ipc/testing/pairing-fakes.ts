import type { PairingService } from "../lan-wire.ts";

/**
 * A `PairingService` for tests: no window is open, no PSK exists and nothing is consumed. A test
 * overrides what it exercises. Required members mean a fake that forgets `currentPsk` or
 * `consumeOpen` is a type error, not a pairing path that silently has no PSK.
 */
export function fakePairing(overrides: Partial<PairingService> = {}): PairingService {
  return {
    isOpen: () => false,
    consume: () => false,
    currentPsk: () => undefined,
    consumeOpen: () => false,
    open: () => {},
    close: () => {},
    getExpiresAt: () => undefined,
    ...overrides,
  };
}
