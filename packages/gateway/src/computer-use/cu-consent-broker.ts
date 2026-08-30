import { ConsentBroker } from "../util/consent-broker.ts";
import type { CuActionClass, CuEnvelope } from "./cu-types.ts";

export interface CuEnvelopeApprovalInput {
  readonly sessionId: string;
  readonly lane: string;
  /** The FULL origin lists — never elided, never summarised as "3 origins". */
  readonly navigateOrigins: readonly string[];
  readonly scriptOrigins: readonly string[];
  readonly maxActions: number;
  readonly maxWallClockMs: number;
}

export interface CuActionApprovalInput {
  readonly sessionId: string;
  readonly seq: number;
  readonly kind: string;
  /** What the GATEWAY observed, and why it classified this way. A fact. */
  readonly observedTarget: string;
  readonly classification: CuActionClass;
  readonly why: string;
  readonly actionsUsed: number;
  readonly maxActions: number;
  /**
   * What the MODEL said it is doing. UNTRUSTED, and labelled as such in the prompt.
   *
   * Separating this from `observedTarget` is not cosmetic: the whole design rests on the human
   * understanding that one of those lines is a fact and the other is a claim.
   */
  readonly modelDescription: string | null;
}

/** Fourth thin binding over the shared ConsentBroker, after share, federation-preflight and exec. */
export class CuEnvelopeConsentBroker extends ConsentBroker<CuEnvelopeApprovalInput> {
  constructor() {
    super("computer.envelopeRequest");
  }
}

export class CuActionConsentBroker extends ConsentBroker<CuActionApprovalInput> {
  constructor() {
    super("computer.actionRequest");
  }
}

/** Process singletons shared by the IPC dispatcher and the gate. */
export const cuEnvelopeConsent = new CuEnvelopeConsentBroker();
export const cuActionConsent = new CuActionConsentBroker();

export type { CuEnvelope };
