import { type FundingEntry, isFundingUrl } from "@nimbus-dev/registry-format";
import { stripControlChars as clean } from "../lib/strip-control-chars.ts";

/** What `extension.info` and `registry.info` carry about an author's declared funding and license. */
export interface AuthorMetadataView {
  funding?: unknown;
  fundingInvalid?: unknown;
  license?: unknown;
  licenseInvalid?: unknown;
}

/**
 * Numbered funding lines `  <n>. <label> <url>`. An entry whose url fails `isFundingUrl` is
 * dropped (the gateway checked it, but this is text from a manifest), and numbering runs over the
 * entries kept. Every string passes through `clean`.
 */
export function fundingEntryLines(entries: readonly FundingEntry[]): string[] {
  const kept = entries.filter((e) => isFundingUrl((e as { url?: unknown }).url));
  return kept.map((e, i) => {
    const label = typeof e.label === "string" && e.label !== "" ? `${clean(e.label)} ` : "";
    return `  ${i + 1}. ${label}${clean(e.url)}`;
  });
}

function asEntries(raw: unknown): FundingEntry[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (e): e is FundingEntry => typeof e === "object" && e !== null && !Array.isArray(e),
  );
}

/** The `License:` and `Funding:` lines of an extension info view. */
export function authorMetadataLines(view: AuthorMetadataView): string[] {
  const lines: string[] = [];
  if (view.licenseInvalid === true) lines.push("License: (invalid, ignored)");
  else if (typeof view.license === "string" && view.license !== "") {
    lines.push(`License: ${clean(view.license)}`);
  } else lines.push("License: not declared");
  if (view.fundingInvalid === true) {
    lines.push("Funding: (invalid, ignored)");
    return lines;
  }
  const entries = fundingEntryLines(asEntries(view.funding));
  if (entries.length === 0) lines.push("Funding: none");
  else lines.push("Funding:", ...entries);
  return lines;
}
