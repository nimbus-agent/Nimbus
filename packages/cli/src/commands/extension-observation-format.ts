import { displayName } from "./extension-audit.ts";

/** What an extension reached beyond what it declared, as `extension.audit` reports it. */
export type ObservationFindingSummary = {
  id: string;
  version: string;
  kind: "refused-undeclared" | "unmatched";
  count: number;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * The per-extension findings out of an `extension.audit` result. Anything malformed, and any entry
 * without a positive finding count, is dropped: observation is advisory and never throws.
 */
export function parseObservationFindings(raw: unknown): ObservationFindingSummary[] {
  if (!isRecord(raw) || !Array.isArray(raw["extensions"])) return [];
  const out: ObservationFindingSummary[] = [];
  for (const e of raw["extensions"] as unknown[]) {
    if (!isRecord(e) || typeof e["id"] !== "string" || typeof e["version"] !== "string") continue;
    const f = e["findings"];
    if (!isRecord(f)) continue;
    const kind = f["kind"];
    const count = f["count"];
    if (kind !== "refused-undeclared" && kind !== "unmatched") continue;
    if (typeof count !== "number" || !Number.isFinite(count) || count < 1) continue;
    out.push({ id: e["id"], version: e["version"], kind, count });
  }
  return out;
}

function who(f: ObservationFindingSummary): string {
  return `${displayName(f.id)}@${displayName(f.version)}`;
}

/** `[warn]` lines for `nimbus doctor`: counts only, never a name. */
export function doctorObservationLines(raw: unknown): { lines: string[]; exit: number } {
  const lines = parseObservationFindings(raw).map((f) => {
    const id = displayName(f.id);
    const head = `[warn] Extensions: ${id} ${displayName(f.version)}:`;
    const tail = `(run nimbus extension audit ${id})`;
    return f.kind === "refused-undeclared"
      ? `${head} ${f.count} undeclared name(s) looked up and refused ${tail}`
      : `${head} ${f.count} address(es) not matched to a declared host ${tail}`;
  });
  return { lines, exit: lines.length > 0 ? 1 : 0 };
}

/** The tag text of one `nimbus extension list` line. */
export function listObservationTag(f: ObservationFindingSummary): string {
  return f.kind === "refused-undeclared"
    ? `[network: ${f.count} undeclared name(s) refused]`
    : `[network: ${f.count} unmatched address(es)]`;
}

/** One tag line per extension with findings. */
export function listObservationLines(findings: readonly ObservationFindingSummary[]): string[] {
  return findings.map((f) => `  ${who(f)} ${listObservationTag(f)}`);
}
