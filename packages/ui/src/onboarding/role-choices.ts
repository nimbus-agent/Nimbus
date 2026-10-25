// "What do you do?" for desktop onboarding (role packs P5). The same rule as `nimbus init`: one
// choice per pack the gateway lists (installed first, then available), then three fixed answers.
// Nothing here knows a pack id — a pack is offered because `pack.list` lists it.

export interface PackRow {
  readonly id: string;
  readonly name: string;
  readonly description: string | undefined;
  readonly installed: boolean;
  readonly roles: readonly string[];
  readonly suggestedConnectors: readonly string[];
  readonly visibleAgents: readonly string[];
}

export interface RoleChoice {
  readonly value: string;
  readonly label: string;
  readonly description?: string;
}

const FIXED: readonly RoleChoice[] = [
  { value: "engineering", label: "Engineering", description: "Code, repositories and reviews." },
  { value: "design", label: "Design", description: "Start with general suggestions." },
  { value: "other", label: "Something else", description: "Start with general suggestions." },
];

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

function strings(v: unknown): readonly string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function rows(v: unknown, installed: boolean): PackRow[] {
  if (!Array.isArray(v)) return [];
  const out: PackRow[] = [];
  for (const raw of v) {
    if (!isRecord(raw)) continue;
    const id = raw["id"];
    const name = raw["name"];
    if (typeof id !== "string" || typeof name !== "string") continue;
    const description = raw["description"];
    out.push({
      id,
      name,
      description: typeof description === "string" ? description : undefined,
      installed,
      roles: strings(raw["roles"]),
      suggestedConnectors: strings(raw["suggestedConnectors"]),
      visibleAgents: strings(raw["visibleAgents"]),
    });
  }
  return out;
}

/** Every pack `pack.list` names, installed first, one row per id. A malformed reply → `[]`. */
export function packRows(packList: unknown): readonly PackRow[] {
  if (!isRecord(packList)) return [];
  const all = [...rows(packList["installed"], true), ...rows(packList["available"], false)];
  return all.filter((r, i) => all.findIndex((x) => x.id === r.id) === i);
}

export function roleChoices(packList: unknown): readonly RoleChoice[] {
  const packs = packRows(packList).map(
    (p): RoleChoice => ({
      value: `pack:${p.id}`,
      label: p.name,
      ...(p.description === undefined ? {} : { description: p.description }),
    }),
  );
  return [...packs, ...FIXED];
}

/** The pack a choice value names, or undefined for the fixed answers and unknown ids. */
export function packFor(value: string, packList: unknown): PackRow | undefined {
  if (!value.startsWith("pack:")) return undefined;
  const id = value.slice("pack:".length);
  return packRows(packList).find((p) => p.id === id);
}

/** Whether a pack's onboarding ends on the Decisions step: it makes `decisions` visible. */
export function endsOnDecisions(pack: PackRow | undefined): boolean {
  return pack?.visibleAgents.includes("decisions") === true;
}
