import { wrapToolOutput } from "../engine/tool-output-envelope.ts";
import type { DiscoveredEpic } from "./theme-discover.ts";
import { normalizeThemeLabel } from "./theme-identity.ts";

/** Minimal local-model surface; the real adapter is injected from assemble.ts. */
export type ThemeLlm = { complete: (prompt: string) => Promise<string | null> };

export type ExtractedTheme = { label: string; sourceItemIds: string[] };

/**
 * The model outcome, made explicit rather than collapsed to `[]`. Three
 * distinct situations used to all read as "zero themes": no model configured,
 * a transient provider error, and a model that genuinely ran and produced
 * nothing usable. Collapsing them meant a single closed-epic corpus was
 * permanently consumed (watermark advanced) the FIRST time the gateway ran
 * with no local model wired — see `premortem-pass.ts`, which now branches on
 * this discriminant instead of an empty array.
 */
export type ExtractOutcome = { kind: "no-model" } | { kind: "ok"; themes: ExtractedTheme[] };

// Ollama's default `num_ctx` is 4096 tokens (~16 KiB) and truncates FROM THE
// FRONT, which — with `INSTRUCTIONS` first in the prompt — used to strip the
// instructions entirely and leave only sources. Since V48 a prose body can be
// 16 KiB, so an uncapped batch of 20 could reach ~320 KiB. Each epic body is
// capped here; see `DEFAULT_BATCH_SIZE` in `premortem-pass.ts` for the other
// half of the fix and `INSTRUCTIONS`' position below for the third.
const EPIC_BODY_MAX = 2_048;

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
 * honest outcome is `{ kind: "no-model" }` — the caller does not advance past
 * this batch — and every structural risk is still computed regardless.
 */
export async function extractThemes(
  epics: readonly DiscoveredEpic[],
  opts: { llm?: ThemeLlm },
): Promise<ExtractOutcome> {
  // An empty batch is genuinely "nothing to do", never "no model" — it never
  // reaches the model at all, so it cannot tell us anything about whether one
  // is configured.
  if (epics.length === 0) {
    return { kind: "ok", themes: [] };
  }
  if (opts.llm === undefined) {
    return { kind: "no-model" };
  }

  // I11: indexed third-party content reaching the model must be enveloped.
  const wrapped = wrapToolOutput(
    { service: "nimbus", tool: "premortem.themes" },
    {
      epics: epics.map((e) => ({
        id: e.itemId,
        title: e.title,
        body: e.body.slice(0, EPIC_BODY_MAX),
      })),
    },
  );

  // `INSTRUCTIONS` goes AFTER the sources: front-truncation under a tight
  // `num_ctx` then degrades the data (an incomplete source list still yields
  // a usable — if smaller — extraction) rather than destroying the
  // instructions block outright, which used to turn every response into
  // unparseable prose.
  const prompt = `Sources:\n${wrapped}\n\n${INSTRUCTIONS}`;

  let raw: string | null;
  try {
    raw = await opts.llm.complete(prompt);
  } catch {
    // A thrown `complete()` is a transient failure (timeout, provider hiccup),
    // not proof no model exists. Treating it as "no model" means the batch is
    // retried next pass instead of burned — the non-obvious call here, since
    // the more common reading of a caught exception is "this failed, move on".
    return { kind: "no-model" };
  }
  if (raw === null || raw === "") {
    // `null`/`""` is the real no-Ollama case (see `decision-llm-adapter.ts`'s
    // `complete`) — this is the whole point of the fix: distinguishing it from
    // "the model ran and said nothing" below.
    return { kind: "no-model" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // The model DID respond; its output just was not usable. This burns the
    // batch (the caller advances the watermark) rather than retrying forever
    // against a persistently misbehaving model.
    return { kind: "ok", themes: [] };
  }

  const rec = asRecord(parsed);
  const list = rec?.["themes"];
  if (!Array.isArray(list)) {
    return { kind: "ok", themes: [] };
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
  return { kind: "ok", themes: out };
}
