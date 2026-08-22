import { ConsentBroker } from "../util/consent-broker.ts";

export interface ExecApprovalInput {
  readonly executionId: string;
  readonly runtime: string;
  /**
   * The VERBATIM body the owner is consenting to -- never a digest.
   *
   * The human is the entire security boundary for this capability, and a prompt reading
   * "run script sha256:a1b2..." is a rubber stamp with extra steps.
   */
  readonly codeBody: string;
  /** The RESOLVED capability set: absolute paths, and an always-empty network list. */
  readonly grants: {
    readonly fsRead: readonly string[];
    readonly fsWrite: readonly string[];
    readonly network: readonly string[];
  };
  readonly wallClockMs: number;
  readonly cwd: string;
}

/**
 * Owner-approval round-trip for a sandboxed code execution (I33): broadcasts
 * `exec.approvalRequest` and resolves when the owner answers via `exec.approvalRespond`
 * (fail-closed on TTL).
 *
 * Third thin binding over the shared {@link ConsentBroker}, after `share/share-consent-broker.ts`
 * and `federation/preflight-consent-broker.ts`. Concurrent approvals therefore need no extra
 * machinery here: the base keys each pending request by a random `requestId` and gives it its own
 * timer, so two terminals can hold prompts open at once and each settles independently.
 */
export class ExecConsentBroker extends ConsentBroker<ExecApprovalInput> {
  constructor() {
    super("exec.approvalRequest");
  }
}

/** Process singleton shared by the IPC dispatcher and the exec-gate path. */
export const execConsent = new ExecConsentBroker();
