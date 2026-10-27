/**
 * The Markdown lines `trust-check` and `trust-sign` write for a feed plan: every block, verified or
 * un-verified publisher and carried statement, then every skipped file. Source strings are the
 * pull request's, so each one is rendered as a code span (`code`).
 */
import {
  type FeedPlan,
  type FeedSkip,
  publisherKeyFingerprint,
  trustStatementId,
} from "../../../registry-format/src/index.ts";
import { code } from "./report.ts";

function blockLine(b: FeedPlan["blocks"][number]): string {
  const r = b.request;
  if (r.kind === "key.revoke") {
    return `- **revoke** key ${code(r.keyFingerprint)} of publisher ${code(r.publisherId)} — ${code(r.reason)} (${code(b.path)})`;
  }
  const versions = r.versions === "*" ? "all versions" : r.versions.join(", ");
  return `- **take down** ${code(r.extensionId)} (${code(versions)}) of publisher ${code(r.publisherId ?? "?")} — ${code(r.reason)} (${code(b.path)})`;
}

export function planLines(plan: FeedPlan, skipped: readonly FeedSkip[]): string[] {
  const lines: string[] = [];
  for (const b of plan.blocks) lines.push(blockLine(b));
  for (const v of plan.verified) {
    lines.push(
      `- **verify** publisher ${code(v.publisherId)} as GitHub ${code(`@${v.github}`)} (${v.change}), keys ${v.keys.map((k) => code(publisherKeyFingerprint(k))).join(", ")}`,
    );
  }
  for (const id of plan.unverified) lines.push(`- **un-verify** publisher ${code(id)}`);
  for (const s of plan.admitted) {
    lines.push(
      `- **carry** ${code(s.kind)} of publisher ${code(s.publisherId)} (${code(trustStatementId(s))})`,
    );
  }
  if (lines.length === 0) lines.push("Nothing to sign.");
  const skips = [...skipped, ...plan.skipped];
  if (skips.length > 0) {
    lines.push("", "**Skipped** (not signed):", "");
    for (const s of skips) lines.push(`- ${code(s.path)}: ${code(s.reason)}`);
  }
  return lines;
}
