/**
 * The "consent hop": a FIXED-text OS toast raised when a HITL approval is pending, so an owner
 * who is not looking at the terminal or desktop window learns that Nimbus is blocked on them.
 *
 * Process-wide by necessity: the consent brokers are module singletons (`exec`, `share`,
 * `toolgen`, computer-use, federation) constructed long before `platform/assemble.ts` builds the
 * notification service, so the service is handed in afterwards through
 * {@link setApprovalPendingNotifier} — the same set-once accessor shape as
 * `engine/agent-limits.ts`. Until it is set (and in every test that does not set it) the hop is a
 * no-op.
 *
 * What the toast may carry, stated as what it may NOT: never the prompt, `details`, a code body,
 * a grant/capability set, an argument value, a payload, or any other request-derived text. The
 * ONLY variable is the KIND — a human label for a known broker method, or an executor action-type
 * id (e.g. `slack.message.post`), which names the action class and none of its arguments. Even
 * that id is accepted only in the shape an action-type id has (see {@link ACTION_TYPE_SHAPE});
 * anything else collapses to the generic label, so a future caller that passes the wrong string
 * here cannot smuggle text into a toast.
 *
 * Consent must never break because a toast failed: a notifier that throws synchronously or
 * rejects asynchronously is swallowed here, and the hop is fire-and-forget — the caller does not
 * await it.
 *
 * Deliberately imports nothing from `platform/`: the notifier is a plain function, so
 * `NotificationService.show` (or anything else) can be adapted to it at the wiring site.
 */

/** A toast sink. `NotificationService.show` satisfies it as-is. */
export type ApprovalPendingNotifier = (title: string, body: string) => Promise<void> | void;

export const APPROVAL_PENDING_TITLE = "Nimbus is waiting for your approval";

/** The label used when the kind is unknown, absent, or not shaped like a kind. */
export const GENERIC_APPROVAL_KIND_LABEL = "an action";

/**
 * Human labels for every `ConsentBroker` request method (and the one broker that predates that
 * base class, `federation/consent-broker.ts`; plus the quorum aggregator and the delegated-approval
 * broker, which raise their hop by these method names). `approval-pending.test.ts` enumerates every
 * `extends ConsentBroker` subclass in the tree and fails if one's method is missing here, so a new
 * broker cannot silently fall through to the generic label.
 */
export const BROKER_METHOD_LABELS: Readonly<Record<string, string>> = Object.freeze({
  "exec.approvalRequest": "code execution",
  "computer.envelopeRequest": "a computer-use session",
  "computer.actionRequest": "a computer-use action",
  "toolgen.approvalRequest": "tool creation",
  "toolgen.saveApprovalRequest": "saving a generated tool",
  "share.approvalRequest": "a share",
  "federation.preflightRequest": "a federated preflight",
  "federation.consentRequest": "a federated query",
  // Not ConsentBroker subclasses either: the quorum aggregator and the delegated-approval broker.
  "federation.quorumRequest": "a quorum approval",
  "federation.approvalRequest": "a delegated approval",
});

/**
 * The shape an executor action-type id has (`slack.message.post`, `mcp_foo.bar`, `egress.prune`):
 * dotted identifier segments, bounded length. Anything else is not a kind.
 */
const ACTION_TYPE_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*(\.[A-Za-z0-9_-]+)*$/;
const ACTION_TYPE_MAX_LEN = 96;

export type ApprovalPendingKind =
  | { readonly source: "broker"; readonly method: string }
  | { readonly source: "executor"; readonly actionType: string | undefined };

/** The label for a kind. Total: every input yields a fixed or id-shaped string. */
export function approvalKindLabel(kind: ApprovalPendingKind): string {
  if (kind.source === "broker") {
    return BROKER_METHOD_LABELS[kind.method] ?? GENERIC_APPROVAL_KIND_LABEL;
  }
  const t = kind.actionType;
  if (t === undefined || t.length > ACTION_TYPE_MAX_LEN || !ACTION_TYPE_SHAPE.test(t)) {
    return GENERIC_APPROVAL_KIND_LABEL;
  }
  return t;
}

export function approvalPendingBody(kind: ApprovalPendingKind): string {
  return `Pending: ${approvalKindLabel(kind)}. Open Nimbus to review it.`;
}

let notifier: ApprovalPendingNotifier | undefined;

/** Set (or clear, with `undefined`) the process-wide sink. Called once from wiring. */
export function setApprovalPendingNotifier(fn: ApprovalPendingNotifier | undefined): void {
  notifier = fn;
}

/**
 * Raise the hop for one pending request. Never throws, never rejects, never blocks: the consent
 * seams call it inline and must behave identically whether or not a toast was shown.
 */
export function notifyApprovalPending(kind: ApprovalPendingKind): void {
  const fn = notifier;
  if (fn === undefined) return;
  try {
    const r = fn(APPROVAL_PENDING_TITLE, approvalPendingBody(kind));
    if (r !== undefined) {
      Promise.resolve(r).catch(() => {});
    }
  } catch {
    // A toast failure is not a consent failure.
  }
}
