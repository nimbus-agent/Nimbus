/**
 * The committed bypass-actor attestation: shape, parse, read, write.
 *
 * Shared by the owner-run gate (which writes it) and the sweep gate (which reads
 * it). No network and no `gh` — deliberately, since the sweep job must run with
 * no credential at all.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isRecord } from "./_gh-audit.ts";
import type { BypassActor } from "./check-bypass-actors.ts";

export const ATTESTATION_PATH = "docs/structure-audit/bypass-actors-attestation.json";

export interface Attestation {
  /** ISO-8601 UTC, from `new Date().toISOString()`. */
  attested_at: string;
  /** `gh api user` login, or "unknown" — diagnostic only, never a gating input. */
  attested_by: string;
  /** Denormalized for diagnostics ONLY; the gate reads grace from the config. */
  grace_days: number;
  /** Derived from the repos actually observed, never copied from config. */
  repos: string[];
  observed: Record<string, BypassActor[]>;
}

/** Parse a raw attestation blob. Anything that is not a JSON object is `unparseable`. */
export function parseAttestation(raw: string): Attestation | "unparseable" {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return "unparseable";
  }
  // Legal JSON can be a scalar, null or an array; none is a usable attestation.
  return isRecord(parsed) ? (parsed as unknown as Attestation) : "unparseable";
}

/** Read the attestation file, or `null` when it does not exist. */
export function readAttestation(repoRoot: string): string | null {
  try {
    return readFileSync(join(repoRoot, ATTESTATION_PATH), "utf8");
  } catch {
    return null;
  }
}

export function writeAttestation(repoRoot: string, attestation: Attestation): void {
  writeFileSync(join(repoRoot, ATTESTATION_PATH), `${JSON.stringify(attestation, null, 2)}\n`);
}

export interface AttestWriteInput {
  /** Whether the diff was clean. */
  ok: boolean;
  /** How many repos were read successfully. */
  queried: number;
  /** How many repos were declared. */
  total: number;
  unreachable: string[];
}

/**
 * Whether `--attest` may write.
 *
 * TWO conditions, and the second is not redundant: `decideExit` returns exit 0
 * for a partial read with no drift (correct for a reporting gate, wrong for an
 * attesting one). Writing there would produce an attestation whose `repos` field
 * claims full coverage on partial evidence, which the sweep gate would then
 * accept for the whole grace window. Attesting is interactive and re-runnable,
 * so refusing costs nothing.
 */
export function decideAttestWrite(input: AttestWriteInput): { write: boolean; reason?: string } {
  if (!input.ok) {
    return { write: false, reason: "refusing to attest: bypass-actor drift was found" };
  }
  if (input.unreachable.length > 0 || input.queried !== input.total) {
    return {
      write: false,
      reason: `cannot attest: ${input.unreachable.join(", ")} unreachable (read ${input.queried} of ${input.total})`,
    };
  }
  return { write: true };
}
