import { wrapToolOutput } from "../engine/tool-output-envelope.ts";
import type { DiscoveredEpic } from "./theme-discover.ts";
import { normalizeThemeLabel } from "./theme-identity.ts";

/** Minimal local-model surface; the real adapter is injected from assemble.ts. */
export type ThemeLlm = { complete: (prompt: string) => Promise<string | null> };

export type ExtractedTheme = { label: string; sourceItemIds: string[] };

const INSTRUCTIONS = [
  "You are given closed engineering epics, each with an id and body text.",
  "Identify recurring BLOCKER themes — reasons work was delayed or abandoned.",
  "Respond with JSON only:",
  '{"themes":[{"label":"short noun phrase","sources":["<epic id>", ...]}]}',
  "- A theme must recur, or be a substantive blocker; do not list one-off remarks.",
  "- `sources` must contain only ids present in the input. Never invent an id.",
  "- The label must be grounded in the text. Never invent facts not present.",
].join("\n");

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

/**
 * NO snippet fallback exists, by decision. `glossary` can fall back to picking a
 * snippet because it already holds the term and needs only a definition; here
 * discovery IS the task, so there is nothing to look up. Without a model the
 * honest output is zero themes — the brief says so, and every structural risk
 * is still computed.
 */
export async function extractThemes(
  epics: readonly DiscoveredEpic[],
  opts: { llm?: ThemeLlm },
): Promise<ExtractedTheme[]> {
  if (opts.llm === undefined || epics.length === 0) {
    return [];
  }

  // I11: indexed third-party content reaching the model must be enveloped.
  const wrapped = wrapToolOutput(
    { service: "nimbus", tool: "premortem.themes" },
    { epics: epics.map((e) => ({ id: e.itemId, title: e.title, body: e.body })) },
  );

  let raw: string | null;
  try {
    raw = await opts.llm.complete(`${INSTRUCTIONS}\n\nSources:\n${wrapped}`);
  } catch {
    return [];
  }
  if (raw === null || raw === "") {
    return [];
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }

  const rec = asRecord(parsed);
  const list = rec?.["themes"];
  if (!Array.isArray(list)) {
    return [];
  }

  const known = new Set(epics.map((e) => e.itemId));
  const out: ExtractedTheme[] = [];
  for (const entry of list) {
    const t = asRecord(entry);
    if (t === undefined) continue;
    const label = t["label"];
    if (typeof label !== "string") continue;
    // Normalize to test emptiness, not `trim()`: a label of "..." passes a trim
    // check but normalizes to "", which would key a theme on the empty string
    // and render as a blank bullet.
    if (normalizeThemeLabel(label) === "") continue;
    const sources = t["sources"];
    if (!Array.isArray(sources)) continue;
    // A source the model invented would fabricate corroboration, and
    // corroboration IS the confidence score — so filter, never trust.
    const valid = sources.filter((s): s is string => typeof s === "string" && known.has(s));
    if (valid.length === 0) continue;
    out.push({ label: label.trim(), sourceItemIds: [...new Set(valid)] });
  }
  return out;
}
