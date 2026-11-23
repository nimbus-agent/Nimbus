import { ConsentBroker } from "../util/consent-broker.ts";

export interface ScheduleApprovalInput {
  readonly peerId: string;
  readonly fromMs: number;
  readonly toMs: number;
}

/** Who answered: the connection's DECLARED kind (the server's, never a param) and its reported source. */
export interface ScheduleAnswerFrom {
  readonly kind: string;
  readonly answerSource: string | undefined;
}

/**
 * Owner-approval round-trip for an inbound free/busy request (I17 (b), OR-S4-SCHED): broadcasts
 * `federation.scheduleRequest` and resolves when the owner answers through `scheduling.respond`.
 * Unlike the older brokers it approves ONLY for a person: the answering connection must have
 * declared `cli` or `ui` and report `answerSource: "human"`; any other approval is turned into a
 * decline (a script, `--yes` or an older client cannot approve). Fail closed on TTL.
 */
export class ScheduleConsentBroker extends ConsentBroker<ScheduleApprovalInput> {
  constructor() {
    super("federation.scheduleRequest");
  }

  /** Returns true when a pending request matched; an approval from a non-person resolves as a decline. */
  respondFrom(requestId: string, approved: boolean, from: ScheduleAnswerFrom): boolean {
    const person = (from.kind === "cli" || from.kind === "ui") && from.answerSource === "human";
    return this.respond(requestId, approved && person);
  }
}

/** Process singleton shared by the LAN answering path and the local `scheduling.respond` handler. */
export const scheduleConsent = new ScheduleConsentBroker();
