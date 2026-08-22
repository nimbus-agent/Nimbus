/**
 * Is this address a machine rather than a person?
 *
 * F7 — `nimbus people list` was polluted with automated senders:
 *
 *   First Backer            newsletter@first-backer.com     items=1
 *   —                       egovpayments@ecom.gov.il        items=1
 *   LinkedIn                jobs-listings@linkedin.com      items=2
 *   LinkedIn Job Alerts     jobalerts-noreply@linkedin.com  items=5
 *
 * The people graph treated every gmail `From:` as a person. These dilute `nimbus expert` and any
 * involvement weighting that reads the graph — which is F3's signal, so the noise compounds.
 *
 * Local-part patterns only, never domains. A domain block-list would be a policy about which
 * COMPANIES count as people, which is both wrong and unmaintainable; "does this mailbox accept
 * replies" is a property of the address itself and is what actually distinguishes the two.
 * Matching is on the local part alone so `noreply@` is caught wherever it is hosted.
 */

/**
 * Substrings that mark a send-only mailbox.
 *
 * Conservative on purpose. A false positive DROPS a real collaborator from the people graph —
 * silently, since nothing reports a person that was never created — while a false negative leaves
 * one more row in a list that already has some. The asymmetry runs the opposite way to most of
 * this audit's other guards, so this list stays short and unambiguous rather than clever.
 */
const AUTOMATED_LOCAL_PARTS: readonly string[] = [
  "noreply",
  "no-reply",
  "no_reply",
  "donotreply",
  "do-not-reply",
  "newsletter",
  "mailer-daemon",
  "postmaster",
  "bounce",
  "notifications",
  "notification",
  "jobalerts",
  "job-alerts",
  "automated",
  "no-return",
];

/**
 * `true` when the address is a send-only mailbox and should not become a person.
 *
 * Note what is NOT here: `support@`, `sales@`, `info@` and `admin@` are shared human mailboxes —
 * a real person reads and answers them, and treating one as a machine would erase a genuine
 * correspondent from the graph.
 */
export function isAutomatedSenderEmail(email: string | null | undefined): boolean {
  if (email === null || email === undefined) return false;
  const at = email.indexOf("@");
  if (at <= 0) return false;
  const local = email.slice(0, at).toLowerCase();
  return AUTOMATED_LOCAL_PARTS.some((p) => local.includes(p));
}
