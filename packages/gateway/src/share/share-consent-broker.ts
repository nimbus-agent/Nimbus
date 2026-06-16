import { ConsentBroker } from "../util/consent-broker.ts";

export interface ShareApprovalInput {
  readonly sessionId: string;
  readonly kind: string;
  readonly preview: unknown;
  readonly redactionSet: readonly string[];
  readonly sink: string;
}

/**
 * Owner-approval round-trip for an outbound share publish (I27): broadcasts `share.approvalRequest`
 * and resolves when the owner answers via `share.approvalRespond` → `respond` (fail-closed on TTL).
 * Thin binding over the shared {@link ConsentBroker}; mirrors `federation/preflight-consent-broker.ts`.
 */
export class ShareConsentBroker extends ConsentBroker<ShareApprovalInput> {
  constructor() {
    super("share.approvalRequest");
  }
}

/** Process singleton shared by the local dispatcher and the share-gate path. */
export const shareConsent = new ShareConsentBroker();
