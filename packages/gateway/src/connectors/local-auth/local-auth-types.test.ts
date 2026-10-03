import { describe, expect, test } from "bun:test";

import { isGcpProjectId } from "./local-auth-types.ts";

describe("isGcpProjectId", () => {
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
    // Bare-id length bounds: 6 and 30 characters.
    "abcdef",
    "a".repeat(30),
    // A domain label may carry inner hyphens, consecutive ones included.
    "a--b.com:my-proj",
  ])("accepts %s", (value) => {
    expect(isGcpProjectId(value)).toBe(true);
  });

  test.each([
    // A project NUMBER, not an id — `gcloud config set project` accepts either.
    "123456789012",
    // Capital letters — GCP project ids are lowercase only.
    "Acme-Prod",
    // Spaces and punctuation.
    "Not A Project!",
    // Too short / too long (bare-id rule needs 6-30 chars).
    "ab",
    "abcde",
    "a".repeat(31),
    // Leading/trailing hyphen.
    "-acme-prod",
    "acme-prod-",
    // A domain prefix with an invalid id after the colon — the domain being well-formed does not
    // rescue an id part that still fails the bare-id rule.
    "example.com:123456789012",
    "example.com:Not-Valid!",
    // A colon with no domain before it.
    ":my-proj",
    // Malformed domain prefixes: an empty label (leading, trailing or doubled dot), or a label
    // that starts or ends with a hyphen.
    ".example.com:my-proj",
    "example.com.:my-proj",
    "a..b:my-proj",
    "-a.com:my-proj",
    "a-.com:my-proj",
    // More than one colon — the part after the first colon is held to the bare-id rule.
    "a:b:my-project",
    // A trailing newline is not ignored.
    "my-project\n",
  ])("rejects %s", (value) => {
    expect(isGcpProjectId(value)).toBe(false);
  });
});
