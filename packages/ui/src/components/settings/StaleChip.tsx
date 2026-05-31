export interface StaleChipProps {
  readonly offlineSinceIso?: string;
}

export function StaleChip({ offlineSinceIso }: StaleChipProps) {
  const label =
    offlineSinceIso === undefined
      ? "Stale · gateway offline"
      : `Stale · offline since ${offlineSinceIso}`;
  return (
    <output
      aria-label={label}
      className="inline-block px-2 py-0.5 text-xs rounded-full bg-[var(--color-warning-bg)] text-[var(--color-warning-text)] border border-[var(--color-warning-border)]"
    >
      {label}
    </output>
  );
}
