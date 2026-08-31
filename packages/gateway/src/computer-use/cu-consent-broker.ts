import { ConsentBroker } from "../util/consent-broker.ts";
import type { CuActionClass, CuEnvelope } from "./cu-types.ts";

/**
 * The DISCRIMINANT that routes an approval request to its broker.
 *
 * `platform/assemble.ts` used to pick a broker by probing `"seq" in input` — a structural property
 * standing in for a tagged union. It was sound only by coincidence: `seq` happens to exist on the
 * per-action shape and not on the envelope shape today. Adding a `seq` to the envelope input (a
 * sequence number for a multi-step approval, say) would silently route every envelope prompt to
 * the ACTION broker, whose CLI renderer draws a completely different prompt — the owner would be
 * asked to "approve this browser action" for a session-open request, with the origin lists and
 * budgets they are actually granting nowhere on screen. TypeScript would report nothing (both
 * shapes structurally satisfy the union) and no test covers the routing.
 *
 * A literal discriminant makes that a compile error instead: the router switches on `promptKind`,
 * and a third member added without a branch fails exhaustiveness.
 *
 * Named `promptKind`, NOT `kind`: `CuActionApprovalInput` already carries a `kind` — the ACTION
 * kind (`click`/`type`/`navigate`/…) that the CLI renders on the prompt's first line. Reusing that
 * name would have collided with a field the owner reads, which is a worse outcome than a slightly
 * longer discriminant.
 */
export type CuApprovalPromptKind = "envelope" | "action";

export interface CuEnvelopeApprovalInput {
  readonly promptKind: "envelope";
  readonly sessionId: string;
  readonly lane: string;
  /** The FULL origin lists — never elided, never summarised as "3 origins". */
  readonly navigateOrigins: readonly string[];
  readonly scriptOrigins: readonly string[];
  readonly maxActions: number;
  readonly maxWallClockMs: number;
}

export interface CuActionApprovalInput {
  readonly promptKind: "action";
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
