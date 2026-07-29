import { describe, expect, it } from "bun:test";

import {
  describeKeychainFailure,
  ERR_SEC_AUTH_FAILED,
  ERR_SEC_INTERACTION_NOT_ALLOWED,
  ERR_SEC_ITEM_NOT_FOUND,
  ERR_SEC_NO_SUCH_KEYCHAIN,
  isInteractionBlockedStatus,
} from "./darwin-keychain-status.ts";

describe("OSStatus constants", () => {
  it("match Apple's SecBase.h values", () => {
    // Wrong values here would silently turn the actionable message back into a
    // generic one, which is the whole defect being fixed.
    expect(ERR_SEC_ITEM_NOT_FOUND).toBe(-25300);
    expect(ERR_SEC_INTERACTION_NOT_ALLOWED).toBe(-25308);
    expect(ERR_SEC_AUTH_FAILED).toBe(-25293);
    expect(ERR_SEC_NO_SUCH_KEYCHAIN).toBe(-25294);
  });
});

describe("isInteractionBlockedStatus", () => {
  it("is true for errSecInteractionNotAllowed", () => {
    expect(isInteractionBlockedStatus(ERR_SEC_INTERACTION_NOT_ALLOWED)).toBe(true);
  });

  it("is true for errSecAuthFailed", () => {
    // A locked keychain that cannot prompt surfaces as an auth failure on some
    // macOS versions rather than errSecInteractionNotAllowed.
    expect(isInteractionBlockedStatus(ERR_SEC_AUTH_FAILED)).toBe(true);
  });

  it("is false for success and for unrelated failures", () => {
    expect(isInteractionBlockedStatus(0)).toBe(false);
    expect(isInteractionBlockedStatus(ERR_SEC_ITEM_NOT_FOUND)).toBe(false);
    expect(isInteractionBlockedStatus(-1)).toBe(false);
  });
});

describe("describeKeychainFailure", () => {
  it("explains the headless cause and gives a runnable remedy when interaction is blocked", () => {
    const msg = describeKeychainFailure("store", ERR_SEC_INTERACTION_NOT_ALLOWED);

    // The three things a stuck first-run user needs: what failed, why it cannot
    // simply prompt, and a command to run.
    expect(msg).toContain("Vault store failed");
    expect(msg).toContain("-25308");
    expect(msg).toContain("security unlock-keychain");
    expect(msg).toContain("security create-keychain");
    // Names the situations that actually trigger it.
    expect(msg).toMatch(/headless|SSH|CI/i);
  });

  it("states plainly that Nimbus will not prompt, so the absence of a dialog is not a bug", () => {
    const msg = describeKeychainFailure("store", ERR_SEC_INTERACTION_NOT_ALLOWED);
    expect(msg).toMatch(/never prompts|does not prompt|cannot prompt/i);
  });

  it("uses the operation name so the message fits read and delete too", () => {
    expect(describeKeychainFailure("read", ERR_SEC_INTERACTION_NOT_ALLOWED)).toContain(
      "Vault read failed",
    );
    expect(describeKeychainFailure("delete", ERR_SEC_INTERACTION_NOT_ALLOWED)).toContain(
      "Vault delete failed",
    );
  });

  it("stays terse for an unrelated failure and still reports the raw status", () => {
    const msg = describeKeychainFailure("store", -1);
    expect(msg).toContain("Vault store failed");
    expect(msg).toContain("-1");
    // No keychain-unlock advice when the keychain is not what went wrong.
    expect(msg).not.toContain("security unlock-keychain");
  });

  it("contains the exact phrases the macOS CI proof greps for", () => {
    // COUPLING: the "Locked keychain fails fast, never hangs" step in
    // .github/workflows/install-smoke.yml greps the gateway output for these two
    // literals to prove the fix is live on a real locked keychain. Rewording
    // them without updating that step turns the proof into a false red; deleting
    // them silently would make it unprovable. Keep the three in sync.
    const msg = describeKeychainFailure("store", ERR_SEC_INTERACTION_NOT_ALLOWED);
    expect(msg).toContain("security unlock-keychain");
    expect(msg).toContain("Nimbus never prompts");
  });

  it("never embeds a secret value — it only ever receives an op and a status", () => {
    // Guards the Vault non-negotiable: the signature has nowhere to put a value.
    const msg = describeKeychainFailure("store", ERR_SEC_INTERACTION_NOT_ALLOWED);
    expect(msg).not.toMatch(/password|secret value/i);
  });
});
