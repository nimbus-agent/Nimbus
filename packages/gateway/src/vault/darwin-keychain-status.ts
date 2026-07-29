/**
 * macOS keychain `OSStatus` values and the operator-facing messages for them.
 *
 * Kept separate from `darwin.ts` on purpose: that module `dlopen`s
 * Security.framework at import time, so it can only be loaded on macOS. This
 * module is pure, which is what makes the message wording testable on every
 * platform instead of only on the macOS CI leg.
 *
 * Values are from Apple's `SecBase.h`.
 */

/** `errSecSuccess` — the operation completed. */
export const ERR_SEC_SUCCESS = 0;
/** `errSecItemNotFound` — no such keychain item. A normal, expected miss. */
export const ERR_SEC_ITEM_NOT_FOUND = -25300;
/**
 * `errSecInteractionNotAllowed` — the operation needed the keychain UI but user
 * interaction is disabled for this process. This is the status the fix for the
 * indefinite first-run hang deliberately provokes instead of blocking.
 */
export const ERR_SEC_INTERACTION_NOT_ALLOWED = -25308;
/**
 * `errSecAuthFailed` — authorization failed. A locked keychain that cannot
 * prompt reports this on some macOS versions rather than
 * `errSecInteractionNotAllowed`, so both map to the same remedy.
 */
export const ERR_SEC_AUTH_FAILED = -25293;
/** `errSecNoSuchKeychain` — the referenced keychain does not exist. */
export const ERR_SEC_NO_SUCH_KEYCHAIN = -25294;

/** The Vault operation being attempted, used only to word the message. */
export type KeychainOp = "store" | "read" | "delete";

/**
 * True when `status` means "this needed a GUI authorization dialog".
 *
 * Both codes are treated the same because the remedy is identical: the keychain
 * has to be unlocked before Nimbus can use it.
 */
export function isInteractionBlockedStatus(status: number): boolean {
  return status === ERR_SEC_INTERACTION_NOT_ALLOWED || status === ERR_SEC_AUTH_FAILED;
}

/**
 * What to do about a keychain that will not answer without a dialog.
 *
 * Deliberately long. This is the first command a new macOS user runs, and
 * before this existed the failure mode was an indefinite hang with no output at
 * all — so the message has to carry the whole diagnosis and a runnable fix.
 */
const INTERACTION_REMEDY = [
  "Nimbus keeps credentials in the macOS keychain, and the keychain wants an",
  "authorization dialog that a background service cannot answer.",
  "Nimbus never prompts, so it fails here rather than hanging forever waiting",
  "for a dialog nobody can see. This is expected over SSH, in CI, and in any",
  "headless or non-GUI session — and on a desktop Mac whose keychain is locked.",
  "",
  "On your own Mac, unlock the login keychain and retry:",
  "  security unlock-keychain ~/Library/Keychains/login.keychain-db",
  "",
  "For SSH, CI or a headless machine, give Nimbus its own unlocked keychain:",
  '  security create-keychain -p "" nimbus.keychain',
  "  security default-keychain -s nimbus.keychain",
  '  security unlock-keychain -p "" nimbus.keychain',
].join("\n");

/**
 * The error text for a failed keychain call.
 *
 * Takes only an operation name and an `OSStatus` — there is deliberately no
 * parameter a secret value could be passed through, so no Vault value can reach
 * an error message by way of this function.
 */
export function describeKeychainFailure(op: KeychainOp, status: number): string {
  const headline = `Vault ${op} failed (OSStatus ${String(status)})`;
  if (!isInteractionBlockedStatus(status)) {
    return headline;
  }
  return `${headline}: the macOS keychain requires interactive authorization.\n\n${INTERACTION_REMEDY}`;
}
