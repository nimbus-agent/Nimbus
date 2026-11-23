import { whyChangeSubjectDisclosure } from "../brief-disclosures.ts";
import type { WhyBrief, WhyLane } from "../why-types.ts";
import type { RenderOpts } from "./_shared.ts";
import { renderGaps, renderLatency, reserved } from "./_shared.ts";

const WHY_LANE_ORDER: readonly WhyLane[] = Object.freeze([
  "authorship",
  "pull_request",
  "ticket",
  "discussion",
  "driver",
  "downstream",
]);

const WHY_LANE_HEADINGS: Readonly<Record<WhyLane, string>> = Object.freeze({
  authorship: "Authorship",
  pull_request: "Pull request",
  ticket: "Ticket",
  discussion: "Discussion",
  driver: "What drove it",
  downstream: "Downstream",
});

function renderWhySubjectLine(brief: WhyBrief): string {
  // Branch BEFORE the null check: on the prUrl arm `subject` is always null, and
  // the old line would report a resolved pull request as an unresolvable ref.
  if (brief.changeSubject !== undefined) {
    const cs = brief.changeSubject;
    if (cs === null) {
      // Deliberately does NOT say "is not in your index": `resolvePrSubject` collapses
      // several distinct misses into this one `null` (`WhyBrief` carries no reason), and one
      // of them — `not_a_pr` — resolves to an INDEXED item that simply isn't a pull request
      // (e.g. the URL trims to an indexed issue or repo). Asserting absence would be false in
      // that case, so the sentence stays neutral about which miss occurred.
      return `_\`${brief.query.ref}\` did not resolve to a pull request in your index._`;
    }
    const num = cs.number === null ? "" : `#${String(cs.number)}`;
    return [`\`${cs.repo}${num}\` — ${cs.title}`, "", whyChangeSubjectDisclosure().line].join("\n");
  }
  if (brief.subject === null) {
    return `_Could not resolve \`${brief.query.ref}\` to an indexed location._`;
  }
  const lineSuffix = brief.subject.lineNo === null ? "" : `:${String(brief.subject.lineNo)}`;
  return `\`${brief.subject.filePath}${lineSuffix}\` in \`${brief.subject.repoRoot}\``;
}

export function renderWhy(brief: WhyBrief, opts?: RenderOpts): string {
  const lines: string[] = ["# Why"];
  lines.push(renderWhySubjectLine(brief));
  for (const lane of WHY_LANE_ORDER) {
    const rows = brief.findings.filter((f) => f.lane === lane);
    if (rows.length === 0) continue;
    lines.push(`\n## ${WHY_LANE_HEADINGS[lane]}`);
    for (const f of rows) {
      const when =
        f.occurredAt === null ? "" : ` — ${new Date(f.occurredAt).toISOString().slice(0, 10)}`;
      const head = f.url === null ? `**${f.title}**` : `**[${f.title}](${f.url})**`;
      lines.push(`- ${head}${when}\n  ${f.detail}`);
    }
  }
  const gaps = reserved(renderGaps(brief.gaps), opts);
  if (gaps !== "") lines.push(gaps);
  lines.push(renderLatency(brief.latencyMs));
  return lines.join("\n");
}
