import { describe, expect, test } from "bun:test";

import { GCP_PROJECT_ID } from "./local-auth-types.ts";

describe("GCP_PROJECT_ID", () => {
  test.each([
    // Bare id, the common case.
    "acme-prod",
    "my-project-123",
    // The legacy domain-scoped form — still a real, live GCP project id, not a deprecated one.
    // See `detect-gcloud.ts`/`adopt-local-auth.ts` review round 2: the regex used to refuse this
    // and the detector's reason then guessed "it may be a project number", which is simply wrong
    // for an owner on this form.
    "example.com:my-proj",
    "sub.example.co.uk:another-id",
  ])("accepts %s", (value) => {
    expect(GCP_PROJECT_ID.test(value)).toBe(true);
  });

  test.each([
    // A project NUMBER, not an id — `gcloud config set project` accepts either.
    "123456789012",
    // Capital letters — GCP project ids are lowercase only.
    "Acme-Prod",
    // Spaces and punctuation.
    "Not A Project!",
    // Too short (bare-id rule needs 6-30 chars).
    "ab",
    // Leading/trailing hyphen.
    "-acme-prod",
    "acme-prod-",
    // A domain prefix with an invalid id after the colon — the domain being well-formed does not
    // rescue an id part that still fails the bare-id rule.
    "example.com:123456789012",
    "example.com:Not-Valid!",
    // A colon with no domain before it.
    ":my-proj",
  ])("rejects %s", (value) => {
    expect(GCP_PROJECT_ID.test(value)).toBe(false);
  });
});
