#!/usr/bin/env bun

/**
 * audit:bypass-attestation — the sweep's half of the P6 bypass-actor gate.
 *
 * Runs with NO credential: it re-runs the same pure diff offline against the
 * committed attestation, and checks that the attestation is fresh, covers every
 * declared repo, and still agrees with declared intent.
 *
 * The gated property is NOT "the org is clean" — it is "a green attestation was
 * committed recently and still agrees with declared intent". The attestation is a
 * committed file and can be hand-edited; the real control is that it is PR-visible
 * and diff-reviewed. See the design's "What this does not prove".
 *
 * Deliberately sweep-only, never the preflight FAST tier: its red depends on the
 * OWNER's re-attestation cadence, so a stale attestation must never block an
 * external contributor's unrelated PR.
 */

import { ATTESTATION_PATH, parseAttestation, readAttestation } from "./_bypass-attestation.ts";
import type { AuditResult, BypassActor } from "./check-bypass-actors.ts";
import {
  diffBypassActors,
  loadDeclaredBypass,
  validateDeclaredBypass,
} from "./check-bypass-actors.ts";

/** Forward clock skew we absorb rather than treat as a hand edit. */
export const FUTURE_TOLERANCE_MS = 60 * 60 * 1000;

const DAY_MS = 86_400_000;

export interface AttestationCheckInput {
  /** Raw file contents, or `null` when the file is absent. */
  raw: string | null;
  declaredRepos: string[];
  declaredBypass: Record<string, BypassActor[]>;
  /** From `bypass.attestation_grace_days` — NEVER the attestation's own field. */
  graceDays: number;
  /** Injected so freshness is testable without touching the system clock. */
  nowMs: number;
}

export function evaluateAttestation(input: AttestationCheckInput): AuditResult {
  const { raw, declaredRepos, declaredBypass, graceDays, nowMs } = input;

  if (raw === null) {
    return {
      ok: false,
      errors: [
        `no attestation file at ${ATTESTATION_PATH} — run \`bun run audit:bypass-actors --attest\``,
      ],
    };
  }

  const parsed = parseAttestation(raw);
  if (parsed === "unparseable") {
    return { ok: false, errors: [`${ATTESTATION_PATH} is not valid JSON (or is not an object)`] };
  }

  const errors: string[] = [];

  // The SECOND NaN fail-open, one level up from `attested_at`. A missing
  // `attestation_grace_days` makes `graceDays * DAY_MS` NaN, and `elapsed > NaN`
  // is false — so deleting one config line would silently disable the freshness
  // check while the gate stayed green. Guarded here as well as in the CLI, since
  // this pure function is what the tests exercise.
  const graceValid = Number.isFinite(graceDays) && graceDays > 0;
  if (!graceValid) {
    errors.push(
      `grace window is not a positive number (${String(graceDays)}) — check bypass.attestation_grace_days`,
    );
  }

  const attestedAtMs = Date.parse(parsed.attested_at);
  if (Number.isNaN(attestedAtMs)) {
    // Every comparison with NaN is false, so a naive staleness check would PASS.
    errors.push(`attested_at "${parsed.attested_at}" is not a parseable timestamp`);
  } else {
    const elapsed = nowMs - attestedAtMs;
    if (elapsed < -FUTURE_TOLERANCE_MS) {
      errors.push(
        `attested_at is ${Math.round(-elapsed / 60_000)} minutes in the future — clock skew or a hand-edited file`,
      );
    } else if (graceValid && elapsed > graceDays * DAY_MS) {
      errors.push(
        `attestation is ${Math.floor(elapsed / DAY_MS)}d old (grace ${graceDays}d) — re-run \`bun run audit:bypass-actors --attest\``,
      );
    }
  }

  const attestedRepos = [...parsed.repos].sort();
  const declared = [...declaredRepos].sort();
  if (JSON.stringify(attestedRepos) !== JSON.stringify(declared)) {
    errors.push(
      `attested repos ${JSON.stringify(attestedRepos)} do not match declared repos ${JSON.stringify(declared)} — re-attest to cover the change`,
    );
  }

  const diff = diffBypassActors(declaredRepos, declaredBypass, parsed.observed);
  for (const err of diff.errors) {
    errors.push(`attested snapshot drifts from declared intent — ${err}`);
  }

  return { ok: errors.length === 0, errors };
}

if (import.meta.main) {
  const label = "audit:bypass-attestation";
  const file = loadDeclaredBypass(process.cwd());

  // Validate the declared config BEFORE consuming its grace window. Gate 1 does
  // this too; skipping it here would let a missing `attestation_grace_days`
  // reach the comparison as NaN and silently disable the freshness check.
  const configErrors = validateDeclaredBypass(file);
  if (configErrors.length > 0) {
    for (const err of configErrors) console.error(`${label}: ${err}`);
    process.exit(1);
  }

  const result = evaluateAttestation({
    raw: readAttestation(process.cwd()),
    declaredRepos: file.repos,
    declaredBypass: file.bypass.by_repo,
    graceDays: file.bypass.attestation_grace_days,
    nowMs: Date.now(),
  });

  if (!result.ok) {
    for (const err of result.errors) console.error(`${label}: ${err}`);
    // This gate takes no `--strict` branch, unlike every other sweep gate. Those
    // fail SOFT locally because they need `gh` auth an external contributor lacks.
    // This one reads two committed files and nothing else, so there is no
    // environment where it cannot run — an unreadable, stale or disagreeing
    // attestation is always a real finding. The workflow still passes `--strict`
    // for consistency; it is simply a no-op here.
    process.exit(1);
  }

  console.log(
    `${label}: OK (${file.repos.length} repos, grace ${file.bypass.attestation_grace_days}d)`,
  );
}
