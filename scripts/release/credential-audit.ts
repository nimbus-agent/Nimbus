import type { HealthRow } from "./check-secret-health";
import {
  CREDENTIAL_REGISTRY,
  type CredentialEntry,
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

export type InventoryStatus =
  | "ok"
  | "missing"
  | "present"
  | "undocumented"
  | "stale"
  | "deadline"
  | "visibility-drift"
  | "audit-overdue";

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

function label(scopeRepo: string | undefined, name: string): string {
  return scopeRepo ? `${scopeRepo}/${name}` : `org/${name}`;
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
  live: readonly LiveSecret[] = [],
  now: Date = new Date(),
): HealthRow[] {
  const rows: HealthRow[] = [];
  const liveByKey = new Map(live.map((s) => [keyOfLive(s), s]));
  const seen = new Set<string>();

  for (const e of entries) {
    const key = keyOfEntry(e);
    seen.add(key);
    const found = liveByKey.get(key);
    const name = label(e.location.repo, e.name);

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
        rows.push(
          row(name, "deadline", `hard deadline ${e.hardDeadline} in ${remaining}d — ${e.note}`),
        );
        continue;
      }
    }

    if (e.maxAgeDays !== null) {
      const age = daysBetween(new Date(found.updatedAt), now);
      if (age > e.maxAgeDays) {
        // Wording is load-bearing: updated_at is when the SECRET was last set,
        // not when the credential was issued. Claiming the latter would be a
        // stronger assertion than the data supports.
        rows.push(row(name, "stale", `secret last set ${age}d ago, policy ${e.maxAgeDays}d`));
        continue;
      }
    }

    rows.push(
      row(name, "ok", `secret last set ${daysBetween(new Date(found.updatedAt), now)}d ago`),
    );
  }

  for (const s of live) {
    if (seen.has(keyOfLive(s))) continue;
    rows.push(
      row(
        label(s.repo, s.name),
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
