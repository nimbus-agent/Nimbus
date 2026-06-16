import { ConsentBroker } from "../util/consent-broker.ts";

export interface PreflightApprovalInput {
  readonly peerId: string;
  readonly namespace: string;
  readonly ref: string;
  readonly purpose: string;
}

/**
 * Owner-approval round-trip for an inbound preflight request (I24): broadcasts
 * `federation.preflightRequest` and resolves when the owner answers via `federation.preflightRespond`
 * → `respond` (fail-closed on TTL). Thin binding over the shared {@link ConsentBroker}.
 */
export class PreflightConsentBroker extends ConsentBroker<PreflightApprovalInput> {
  constructor() {
    super("federation.preflightRequest");
  }
}

/** Process singleton shared by the local dispatcher and the LAN onMessage path. */
export const preflightConsent = new PreflightConsentBroker();
