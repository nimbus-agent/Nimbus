import type { ReactNode } from "react";
import { PageHeader } from "../components/chrome/PageHeader";
import { isRecord, safeText, stamp } from "../components/incidents/safe";
import { useIpcQuery } from "../hooks/useIpcQuery";
import type { IacDriftFinding, IacDriftLatestResult } from "../ipc/iac-types";
import { withContentKeys } from "../lib/content-keys";

const STATUSES = new Set(["drift", "clean", "failed", "busy"]);

/** Shallow: the gateway's own tests pin the full shape. `null` = not this shape (yet). */
export function asIacDriftLatest(v: unknown): IacDriftLatestResult | null {
  if (!isRecord(v) || !Array.isArray(v["findings"])) return null;
  const findings = v["findings"].filter(
    (f): f is IacDriftFinding =>
      isRecord(f) &&
      typeof f["workdir"] === "string" &&
      typeof f["checkedAt"] === "number" &&
      typeof f["status"] === "string" &&
      STATUSES.has(f["status"]) &&
      Array.isArray(f["lines"]),
  );
  return { findings };
}

function headline(f: IacDriftFinding): string {
  switch (f.status) {
    case "drift":
      return `Drift: ${String(f.driftCount ?? "?")} object(s) changed outside Terraform`;
    case "clean":
      return "Clean: no drift found";
    case "busy":
      return "Busy: another run held this directory";
    default:
      return "Failed: the check could not read a drift report";
  }
}

function FindingRow({ f }: { readonly f: IacDriftFinding }): ReactNode {
  return (
    <li className="space-y-1">
      <div className="text-sm">{safeText(f.workdir, 300)}</div>
      <div className="text-xs">
        {`${headline(f)} - checked ${stamp(f.checkedAt)} (${f.startedBy === "schedule" ? "scheduled" : "from the CLI"})`}
      </div>
      {f.status === "drift" && f.plannedChanges !== null && (
        <div className="text-xs text-[var(--color-fg-muted)]">
          {`An apply would make ${String(f.plannedChanges)} change(s) now (counted, never applied).`}
        </div>
      )}
      {(f.status === "failed" || f.status === "busy") && f.reason !== undefined && (
        <div className="text-xs text-[var(--color-fg-muted)]">{safeText(f.reason, 300)}</div>
      )}
      {f.lines.length > 0 && (
        <ul className="text-xs font-mono">
          {/* the gateway's escaped drift lines (names, never values); they carry no id */}
          {withContentKeys(f.lines.slice(0, 100), (line) => line).map(({ key, item: line }) => (
            <li key={key}>{safeText(line, 300)}</li>
          ))}
        </ul>
      )}
    </li>
  );
}

function FindingsBody({
  error,
  res,
}: {
  readonly error: string | null;
  readonly res: IacDriftLatestResult | null;
}): ReactNode {
  if (res === null) {
    if (error !== null) {
      return (
        <p role="alert" className="text-sm">
          {`Could not load the drift findings: ${safeText(error)}. From a terminal: nimbus iac drift --latest`}
        </p>
      );
    }
    return <p className="text-sm text-[var(--color-fg-muted)]">Loading...</p>;
  }
  if (res.findings.length === 0) {
    return (
      <p className="text-sm">
        No drift check has run yet. Approve a directory with nimbus connector writes enable iac,
        then run nimbus iac drift.
      </p>
    );
  }
  return (
    <ul className="space-y-3">
      {res.findings.map((f) => (
        <FindingRow key={f.workdir} f={f} />
      ))}
    </ul>
  );
}

/**
 * Read-only (IaC drift, desktop view): the latest drift finding per approved Terraform directory,
 * from `iac.driftLatest` only. The check itself runs a Terraform plan child and stays a
 * terminal command; nothing here starts it, changes a grant or applies anything.
 */
export function Infrastructure(): ReactNode {
  const { data, error } = useIpcQuery<unknown>("iac.driftLatest", 60_000);
  const res = asIacDriftLatest(data);
  return (
    <>
      <PageHeader title="Infrastructure" />
      <div className="p-6 space-y-4">
        <p className="text-xs text-[var(--color-fg-muted)]">
          Terraform drift in the directories you approved. To check now, run: nimbus iac drift
        </p>
        <FindingsBody error={error} res={res} />
      </div>
    </>
  );
}
