import { ConsentBroker } from "../util/consent-broker.ts";
import type { DraftGrounding } from "./toolgen-grounding.ts";
import type { ToolInputSchema } from "./toolgen-types.ts";

export interface ToolgenApprovalInput {
  readonly toolId: string;
  readonly toolName: string;
  readonly description: string;
  /**
   * The VERBATIM model-authored body -- never a digest. The human is the entire security boundary
   * for this capability, and a prompt reading "register tool blake3:a1b2..." is a rubber stamp with
   * extra steps.
   */
  readonly body: string;
  readonly approvedHosts: readonly string[];
  /** Hosts for which a credential will be attached. "What will be sent, and where." */
  readonly credentialHosts: readonly string[];
  /** The parameters the owner is being asked to approve -- the same object stored in the artifact. */
  readonly inputSchema: ToolInputSchema;
  /** How the draft was grounded -- disclosed so the owner can see whether it is a guess. */
  readonly grounding: DraftGrounding;
  /**
   * Who asked. `"owner"` in PR 1. Present now so the agent-initiated path (PR 2) cannot ship a
   * prompt that looks identical to one the owner started.
   */
  readonly initiator: "owner";
}

/**
 * Owner-approval round-trip for registering a generated tool (I39): broadcasts
 * `toolgen.approvalRequest` and resolves when the owner answers via `toolgen.approvalRespond`
 * (fail-closed on TTL).
 */
export class ToolgenConsentBroker extends ConsentBroker<ToolgenApprovalInput> {
  constructor() {
    super("toolgen.approvalRequest");
  }
}

/** Process singleton shared by the IPC dispatcher and the gate. */
export const toolgenConsent = new ToolgenConsentBroker();

/**
 * Everything the create-time prompt discloses, plus the ONE fact create never offered: that the
 * owner is now being asked to let this exact body run in EVERY future session, unattended, without
 * being asked again. `persistence` is a literal `true` rather than a plain `boolean` so the type
 * itself says what this input is for — there is no `false` variant of a save-approval prompt,
 * because a `saveGeneratedTool` call that does not need to ask (already saved, or a digest-matching
 * repair) never constructs one at all (spec § 6.1).
 */
export interface ToolgenSaveApprovalInput extends ToolgenApprovalInput {
  readonly persistence: true;
}

/**
 * Owner-approval round-trip for PERSISTING a generated tool (I40 / spec § 6.1) — a SEPARATE broker
 * and broadcast method from {@link ToolgenConsentBroker}, deliberately never a reused instance or
 * method name.
 *
 * The create approval and the save approval are consenting to two DIFFERENT facts about the same
 * bytes: create is "run this now, in this session, on the gateway I am sitting in front of"; save
 * is "run this in every future session, without being asked again." Re-using
 * `toolgen.approvalRequest` for both would let a client render the save prompt with the create
 * prompt's copy — under-disclosing a standing grant as though it were the one-off the owner already
 * said yes to once. A distinct method name is what makes that impossible rather than merely
 * unlikely: a client MUST implement `toolgen.saveApprovalRequest` deliberately, on purpose, to
 * support persistence at all.
 */
export class ToolgenSaveConsentBroker extends ConsentBroker<ToolgenSaveApprovalInput> {
  constructor() {
    super("toolgen.saveApprovalRequest");
  }
}

/** Process singleton shared by the IPC dispatcher and the save gate. */
export const toolgenSaveConsent = new ToolgenSaveConsentBroker();
