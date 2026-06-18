/** Render the provenance attribution chip for a received/forwarded share (spec §9.3). Pure. */
export function formatAttributionChip(p: { originLabel: string; hops: number }): string {
  if (p.hops <= 0) return `from ${p.originLabel} (direct)`;
  const unit = p.hops === 1 ? "hop" : "hops";
  return `forwarded from ${p.originLabel}, ${p.hops} ${unit} away`;
}
