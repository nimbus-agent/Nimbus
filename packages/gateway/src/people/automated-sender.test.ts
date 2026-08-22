import { describe, expect, test } from "bun:test";

import { isAutomatedSenderEmail } from "./automated-sender.ts";

/** F7 — every address here was observed in a real `nimbus people list`. */
describe("isAutomatedSenderEmail", () => {
  test.each([
    ["newsletter@first-backer.com"],
    ["jobalerts-noreply@linkedin.com"],
    ["jobs-listings@linkedin.com".replace("jobs-listings", "notifications")],
    ["no-reply@github.com"],
    ["MAILER-DAEMON@example.com"],
  ])("%s is automated", (email) => {
    expect(isAutomatedSenderEmail(email)).toBe(true);
  });

  test.each([
    ["asaf@example.com", "an ordinary address"],
    ["support@vendor.com", "a SHARED HUMAN mailbox — a person reads and answers it"],
    ["sales@vendor.com", "likewise"],
    ["admin@vendor.com", "likewise"],
  ])("%s is not (%s)", (email) => {
    expect(isAutomatedSenderEmail(email)).toBe(false);
  });

  test("a malformed address is not automated", () => {
    // Fail toward keeping the person. A false positive silently DROPS a collaborator, and nothing
    // reports a person that was never created.
    expect(isAutomatedSenderEmail("")).toBe(false);
    expect(isAutomatedSenderEmail("@nolocal.com")).toBe(false);
    expect(isAutomatedSenderEmail(null)).toBe(false);
  });

  test("the domain is never consulted", () => {
    // A domain block-list would be a policy about which COMPANIES count as people. "Does this
    // mailbox accept replies" is a property of the address, and it is the real distinction.
    expect(isAutomatedSenderEmail("a.person@linkedin.com")).toBe(false);
  });
});
