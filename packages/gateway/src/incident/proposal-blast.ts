// packages/gateway/src/incident/proposal-blast.ts
// Phase 17 one-tap rollback: the blast radius an engine-proposed action's prompt may show, from the proposal's
// stored evidence. Moved out of `remediation.ts` (its size is locked by `audit:file-size`), which re-exports it.
import { BLAST_MAX_DEPENDENTS, BLAST_NAME_RE } from "../engine/incident-link.ts";
import type { EngineProposalBlast } from "../engine/types.ts";

/**
 * The blast radius a prompt may show, from a proposal's evidence (Phase 17 one-tap rollback). No blast in the
 * evidence gives `undefined` (the prompt says it was not recorded). A blast whose names are not all
 * configuration ids ({@link BLAST_NAME_RE}), or that is malformed, gives the `unverified` form, so the prompt
 * says it is not shown rather than implying there is none. Never throws.
 */
export function blastForPrompt(
  evidence: unknown,
  recorded: boolean,
): EngineProposalBlast | undefined {
  if (evidence === null || typeof evidence !== "object") return undefined;
  if (!Object.hasOwn(evidence, "blast")) return undefined;
  const unverified = { unverified: true, recorded } as const;
  const b = (evidence as { blast?: unknown }).blast;
  if (b === null || typeof b !== "object") return unverified;
  const { service, environment, dependents, dependentsTruncated } = b as Record<string, unknown>;
  const name = (x: unknown): x is string => typeof x === "string" && BLAST_NAME_RE.test(x);
  if (service !== null && !name(service)) return unverified;
  if (environment !== null && environment !== undefined && !name(environment)) return unverified;
  if (!Array.isArray(dependents) || dependents.length > BLAST_MAX_DEPENDENTS) return unverified;
  if (!dependents.every(name)) return unverified;
  if (typeof dependentsTruncated !== "boolean") return unverified;
  return {
    service,
    environment: environment ?? null,
    dependents: [...dependents],
    dependentsTruncated,
    recorded,
  };
}
