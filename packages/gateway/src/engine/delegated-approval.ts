export type RemoteApprovalOutcome =
  | { readonly kind: "answered"; readonly peerId: string; readonly approved: boolean }
  | { readonly kind: "timeout" };

export interface DelegatedApprovalDeps {
  /** True iff `peerId` holds a live, in-scope delegation for this action (DelegationStore). */
  readonly isActiveDelegate: (peerId: string) => boolean;
  /** I18: the answering delegate's operator identity must be valid. */
  readonly isOperatorValid: () => boolean;
  /** Route the approval request to the delegate over federation; resolve with their answer. */
  readonly requestRemote: () => Promise<RemoteApprovalOutcome>;
}

export type DelegatedApprovalResult = "approved" | "rejected" | "fallback_to_owner";

/**
 * I20 — a remote approval is honored ONLY when the answering peer is a live in-scope delegate
 * AND identity-valid. Anything else (forged peer, invalid identity, timeout/offline) falls back
 * to a local owner prompt (D10). The wire is never trusted.
 */
export async function resolveDelegatedApproval(
  deps: DelegatedApprovalDeps,
): Promise<DelegatedApprovalResult> {
  const outcome = await deps.requestRemote();
  if (outcome.kind === "timeout") return "fallback_to_owner";
  if (!deps.isActiveDelegate(outcome.peerId)) return "fallback_to_owner";
  if (!deps.isOperatorValid()) return "fallback_to_owner";
  return outcome.approved ? "approved" : "rejected";
}
