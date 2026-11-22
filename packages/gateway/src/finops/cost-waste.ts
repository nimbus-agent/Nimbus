// Phase 10 FinOps: the cloud cost "garbage collection" classifier (slice G4a).
//
// Pure: given what a FinOps vendor says about one recommendation, decide whether it names WASTE (an
// orphaned or idle resource that can simply go) or something else (rightsizing, commitments), which a
// waste report counts but does not list. Confined by static rule D48 (`finops-confined`): no network,
// no connector, no model.
//
// The vendor's type and category vocabulary is undocumented and has not been checked against a live
// account, so this is a keyword heuristic over vendor strings, and the report says so. The table is
// exported so a reader (and a test) sees exactly which words decide.

export const WASTE_KINDS = [
  "unattached",
  "idle",
  "orphaned_snapshot",
  "empty_environment",
] as const;
export type WasteKind = (typeof WASTE_KINDS)[number];
export type WasteClass = WasteKind | "not_waste";

export interface WasteRule {
  readonly kind: WasteKind;
  /** Lower-case words; the rule matches when any appears in the joined vendor text. */
  readonly words: readonly string[];
}

/**
 * Checked in order: the first rule with a matching word wins. `orphaned_snapshot` comes first so an
 * "unused snapshot" is a snapshot, and `empty_environment` before `idle` so an "idle empty cluster"
 * reads as an empty environment.
 */
export const WASTE_RULES: readonly WasteRule[] = [
  { kind: "orphaned_snapshot", words: ["snapshot", "orphaned image", "unused image", "old ami"] },
  {
    kind: "empty_environment",
    words: [
      "empty environment",
      "empty cluster",
      "abandoned",
      "empty node group",
      "empty namespace",
    ],
  },
  {
    kind: "unattached",
    words: ["unattached", "unassociated", "detached", "unused volume", "unused disk", "unused ip"],
  },
  {
    kind: "idle",
    words: ["idle", "unused", "orphan", "zero traffic", "no traffic", "stale", "zombie"],
  },
];

/**
 * Words that mark a recommendation as NOT waste even when a waste word also appears (for example
 * "rightsize idle instances" is a rightsizing, not a deletion). Checked before {@link WASTE_RULES}.
 */
export const NOT_WASTE_WORDS: readonly string[] = [
  "rightsiz",
  "right siz",
  "downsiz",
  "reserved instance",
  "reservation",
  "savings plan",
  "commitment",
  "committed use",
  "upgrade",
  "migrate",
];

export interface WasteInput {
  readonly recommendationType: string | null;
  readonly category: string | null;
  readonly title: string | null;
}

/** The lower-cased vendor text a rule is matched against, with `_` and `-` read as spaces. */
function vendorText(input: WasteInput): string {
  return [input.recommendationType, input.category, input.title]
    .filter((s): s is string => typeof s === "string" && s !== "")
    .join(" ")
    .toLowerCase()
    .replaceAll(/[_-]+/g, " ");
}

/** One recommendation's waste class: the first matching rule, or `not_waste`. */
export function classifyWaste(input: WasteInput): WasteClass {
  const text = vendorText(input);
  if (text === "") return "not_waste";
  if (NOT_WASTE_WORDS.some((w) => text.includes(w))) return "not_waste";
  for (const rule of WASTE_RULES) {
    if (rule.words.some((w) => text.includes(w))) return rule.kind;
  }
  return "not_waste";
}

export function isWasteKind(v: unknown): v is WasteKind {
  return typeof v === "string" && (WASTE_KINDS as readonly string[]).includes(v);
}
