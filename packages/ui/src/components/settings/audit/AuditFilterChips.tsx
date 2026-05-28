import type { ReactNode } from "react";
import type { AuditFilter, AuditOutcomeFilter } from "../../../store/slices/audit";

interface Props {
  readonly filter: AuditFilter;
  readonly availableServices: ReadonlyArray<string>;
  readonly onChange: (patch: Partial<AuditFilter>) => void;
  readonly onReset: () => void;
  readonly disabled?: boolean;
}

function dateInputToMs(value: string): number | null {
  if (value === "") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function msToDateInput(ms: number | null): string {
  if (ms === null) return "";
  const d = new Date(ms);
  const yyyy = d.getFullYear().toString().padStart(4, "0");
  const mm = (d.getMonth() + 1).toString().padStart(2, "0");
  const dd = d.getDate().toString().padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

const OUTCOMES: ReadonlyArray<AuditOutcomeFilter> = ["all", "approved", "rejected", "not_required"];

export function AuditFilterChips({
  filter,
  availableServices,
  onChange,
  onReset,
  disabled,
}: Props): ReactNode {
  return (
    <div className="flex flex-wrap items-center gap-2 mb-3">
      <label className="text-xs flex items-center gap-1">
        <span>Service</span>
        <select
          aria-label="Service filter"
          value={filter.service}
          disabled={disabled}
          onChange={(e) => onChange({ service: e.target.value })}
          className="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-1 py-0.5"
        >
          <option value="">all</option>
          {availableServices.map((s) => (
            <option key={s} value={s}>
              {s}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs flex items-center gap-1">
        <span>Outcome</span>
        <select
          aria-label="Outcome filter"
          value={filter.outcome}
          disabled={disabled}
          onChange={(e) => onChange({ outcome: e.target.value as AuditOutcomeFilter })}
          className="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-1 py-0.5"
        >
          {OUTCOMES.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </select>
      </label>

      <label className="text-xs flex items-center gap-1">
        <span>Since</span>
        <input
          type="date"
          aria-label="Since (date filter)"
          value={msToDateInput(filter.sinceMs)}
          disabled={disabled}
          onChange={(e) => onChange({ sinceMs: dateInputToMs(e.target.value) })}
          className="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-1 py-0.5"
        />
      </label>

      <label className="text-xs flex items-center gap-1">
        <span>Until</span>
        <input
          type="date"
          aria-label="Until (date filter)"
          value={msToDateInput(filter.untilMs)}
          disabled={disabled}
          onChange={(e) => onChange({ untilMs: dateInputToMs(e.target.value) })}
          className="border border-[var(--color-border)] bg-[var(--color-bg)] rounded px-1 py-0.5"
        />
      </label>

      <button
        type="button"
        onClick={onReset}
        disabled={disabled}
        className="text-xs underline text-[var(--color-text-muted)] hover:text-[var(--color-text)] disabled:opacity-50"
      >
        Reset
      </button>
    </div>
  );
}
