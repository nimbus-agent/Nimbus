import type { HealthRow } from "./check-secret-health";
import {
  CREDENTIAL_REGISTRY,
  type CredentialEntry,
  HARD_DEADLINE_CRITICAL_DAYS,
  HARD_DEADLINE_LEAD_DAYS,
  LAST_MANUAL_AUDIT,
  MANUAL_AUDIT_MAX_AGE_DAYS,
  type SecretProduct,
} from "./credential-registry";

/** One secret as the GitHub API reports it: name and timestamps only, never a value. */
export interface LiveSecret {
  readonly name: string;
  readonly scope: "org" | "repo";
  readonly repo?: string;
  readonly product: SecretProduct;
  readonly updatedAt: string;
  /** Org-scoped secrets only. */
  readonly visibility?: "all" | "selected";
}

/**
 * `deadline-approaching` and `deadline-critical` are deliberately two statuses,
 * not one. They are the *same fact* (a date in `credential-registry.ts`) at two
 * different distances, and only the second one means "act now" — collapsing them
 * into a single warning meant a blown deadline never escalated, while
 * collapsing them into a single failure meant 90 days of standing red on a
 * credential that still works. Neither is the same class of finding as `dead`,
 * which comes from a provider rejecting the credential in a live probe.
 */
export type InventoryStatus =
  | "ok"
  | "missing"
  | "present"
  | "undocumented"
  | "stale"
  | "deadline-approaching"
  | "deadline-critical"
  | "visibility-drift"
  | "audit-overdue"
  | "indeterminate";

export function daysBetween(from: Date, to: Date): number {
  return Math.floor((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * A credential's identity is scope + repo + product + name. Name alone is not
 * unique: the same name can legitimately exist in two repos, and GitHub keys
 * Actions and Dependabot secrets in separate namespaces.
 */
function keyOfEntry(e: CredentialEntry): string {
  return `${e.location.scope}:${e.location.repo ?? "-"}:${e.product}:${e.name}`;
}

function keyOfLive(s: LiveSecret): string {
  return `${s.scope}:${s.repo ?? "-"}:${s.product}:${s.name}`;
}

/**
 * The Map key includes `product` so an Actions secret and a Dependabot secret
 * of the same name are never confused for one credential — but the label must
 * carry that same distinction, or two opposite verdicts render as identical
 * row names with no way to tell them apart. Actions is the overwhelming
 * default, so only the `dependabot` exception is tagged.
 */
function label(repo: string | undefined, name: string, product: SecretProduct): string {
  const base = repo ? `${repo}/${name}` : `org/${name}`;
  return product === "dependabot" ? `${base} (dependabot)` : base;
}

function row(name: string, status: InventoryStatus, detail: string): HealthRow {
  return { name, kind: "inventory", status, detail };
}

/**
 * Diff the manifest against live state.
 *
 * `orphaned` is deliberately absent from the status set. A manifest entry whose
 * credential no longer exists is either `missing` (required — a workflow will
 * break) or `ok` (optional/forbidden — correctly absent). Deliberate deletion is
 * recorded by flipping `state` to `forbidden`, not by a separate verdict, so
 * there is no case where the system has to guess at intent.
 */
export function auditCredentials(
  entries: readonly CredentialEntry[] = CREDENTIAL_REGISTRY,
  live: readonly LiveSecret[],
  now: Date = new Date(),
): HealthRow[] {
  const rows: HealthRow[] = [];
  const liveByKey = new Map(live.map((s) => [keyOfLive(s), s]));
  const seen = new Set<string>();

  for (const e of entries) {
    const key = keyOfEntry(e);
    seen.add(key);
    const found = liveByKey.get(key);
    const name = label(e.location.repo, e.name, e.product);

    if (!found) {
      rows.push(
        e.state === "required"
          ? row(
              name,
              "missing",
              `declared required but absent; consumed by ${e.consumedBy.join(", ") || "nothing recorded"}`,
            )
          : row(name, "ok", e.state === "forbidden" ? "correctly absent" : "optional, unset"),
      );
      continue;
    }

    if (e.state === "forbidden") {
      rows.push(row(name, "present", `must not exist — ${e.note}`));
      continue;
    }

    // The comparison is `!==`, so BOTH directions fire — narrower-than-declared
    // is just as much a drift as wider-than-declared; the name says "differs
    // from declared" precisely so it does not overclaim a single direction.
    // `found.visibility` is optional (org secrets only) and the live API can
    // omit it entirely; when omitted this check is skipped, not treated as a
    // mismatch.
    if (e.expectedVisibility && found.visibility && found.visibility !== e.expectedVisibility) {
      rows.push(
        row(
          name,
          "visibility-drift",
          `visibility is "${found.visibility}", declared "${e.expectedVisibility}"`,
        ),
      );
      continue;
    }

    if (e.hardDeadline) {
      const remaining = daysBetween(now, new Date(`${e.hardDeadline}T00:00:00Z`));
      if (remaining <= HARD_DEADLINE_LEAD_DAYS) {
        // A blown deadline is categorically worse than an approaching one and
        // must never be phrased as negative time ("in -200d" reads like a
        // countdown that hasn't happened yet).
        const when = remaining < 0 ? `overdue by ${Math.abs(remaining)}d` : `in ${remaining}d`;
        // Both details assert, in words, that this is a CALENDAR finding. A
        // reader skimming a 45-row table must not be able to mistake it for the
        // row above it that says a provider rejected a token — the detail
        // carries that distinction even if the status column is truncated or the
        // row is quoted out of the table into a chat message.
        const provenance =
          "this is a scheduled expiry recorded in credential-registry.ts, not a rejected credential";
        rows.push(
          remaining <= HARD_DEADLINE_CRITICAL_DAYS
            ? row(
                name,
                "deadline-critical",
                `hard deadline ${e.hardDeadline} ${when} — the replacement runway is gone, act now (${provenance}) — ${e.note}`,
              )
            : row(
                name,
                "deadline-approaching",
                `hard deadline ${e.hardDeadline} ${when} — still working, nothing is broken yet; escalates to a hard failure at ${HARD_DEADLINE_CRITICAL_DAYS}d (${provenance}) — ${e.note}`,
              ),
        );
        continue;
      }
    }

    // Computed once, ahead of both the age-based staleness check and the
    // default "ok" row below, so an unparseable `updatedAt` can never leak
    // through either path as a false "ok" (`daysBetween` would silently
    // yield NaN, and `NaN > maxAgeDays` is always false — the staleness gate
    // fails OPEN unless this is caught first).
    const age = daysBetween(new Date(found.updatedAt), now);
    if (Number.isNaN(age)) {
      rows.push(row(name, "indeterminate", `secret updatedAt "${found.updatedAt}" is unparseable`));
      continue;
    }

    if (e.maxAgeDays !== null && age > e.maxAgeDays) {
      // Wording is load-bearing: updated_at is when the SECRET was last set,
      // not when the credential was issued. Claiming the latter would be a
      // stronger assertion than the data supports.
      rows.push(row(name, "stale", `secret last set ${age}d ago, policy ${e.maxAgeDays}d`));
      continue;
    }

    rows.push(row(name, "ok", `secret last set ${age}d ago`));
  }

  for (const s of live) {
    if (seen.has(keyOfLive(s))) continue;
    rows.push(
      row(
        label(s.repo, s.name, s.product),
        "undocumented",
        `${s.product} secret in ${s.repo ?? "org"} is absent from credential-registry.ts — add it or delete it`,
      ),
    );
  }

  const auditAge = daysBetween(new Date(`${LAST_MANUAL_AUDIT}T00:00:00Z`), now);
  rows.push(
    auditAge > MANUAL_AUDIT_MAX_AGE_DAYS
      ? row(
          "manual audit",
          "audit-overdue",
          `docs/credential-hygiene.md last walked ${auditAge}d ago, policy ${MANUAL_AUDIT_MAX_AGE_DAYS}d`,
        )
      : row("manual audit", "ok", `last walked ${auditAge}d ago`),
  );

  return rows;
}
