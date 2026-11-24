import type { Database } from "bun:sqlite";

import type { IncidentUpdateBrief } from "../agents/_lib/incident-types.ts";
import {
  UPDATE_LEAD_HEADING,
  UPDATE_LEAD_NONE,
} from "../agents/_lib/incident-update-brief-render.ts";
import { chatSafe, type UpdateAudience } from "../agents/_lib/incident-update-render.ts";
import type { SynthesisRunner } from "../agents/_lib/synthesis-llm.ts";
import { type SynthesisProvenance, synthesize } from "../agents/_lib/synthesize.ts";
import { draftIncidentUpdate, type UpdateDraft } from "../incident-update/update-draft.ts";

/**
 * `nimbus incident update <id> --synthesize` (Phase 10 IC9b; owner ruling OR-S4-SCRIBE). The unattended scribe
 * stays model-free (OR-10-8); this is the OWNER's own request. The deterministic update (`draftIncidentUpdate`,
 * facts and disclosure footer) is carried as the `incident_update` brief and offered to the existing
 * `synthesize()`, which keeps `## Update text` verbatim (I31), wraps what the model sees in the I11 envelope and
 * falls back to the deterministic brief on any failure. The model writes ONE short lead paragraph; the text
 * returned is that lead (sanitised for chat and capped) followed by the deterministic update, byte for byte, and
 * is never parsed out of the model's output. The draft is posted only through the existing human-approved
 * `--send`, whose broadcast-mention and remote-content refusals run on the final text. Lives in its own folder:
 * `incident/**` takes no runner (static D46(a)) and `incident-update/**` imports no model module (its pin).
 */

export const LEAD_MAX = 600;

export type SynthesizedUpdate = UpdateDraft & {
  /** The lead the model wrote and the owner is shown, or null when none was used. */
  readonly lead: string | null;
  readonly synthesis: SynthesisProvenance;
};

export function updateBrief(draft: UpdateDraft, nowMs: number): IncidentUpdateBrief {
  return {
    kind: "incident_update",
    agentVersion: 1,
    generatedAt: nowMs,
    latencyMs: 0,
    gaps: [],
    recordId: draft.recordId,
    version: draft.version,
    audience: draft.audience,
    text: draft.text,
  };
}

/** The model's `## Lead` section as one chat-safe paragraph, or null (none written, the placeholder, empty). */
export function leadOf(markdown: string): string | null {
  const lines = markdown.split(/\r?\n/);
  const at = lines.findIndex((l) => l.trim() === UPDATE_LEAD_HEADING);
  if (at < 0) return null;
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.startsWith("## ") || l.startsWith("# ")) break;
    body.push(l);
  }
  const joined = body.join(" ").trim();
  if (joined === "" || joined === UPDATE_LEAD_NONE) return null;
  const lead = chatSafe(joined, LEAD_MAX);
  return lead === "" ? null : lead;
}

export async function draftUpdateWithLead(deps: {
  readonly db: Database;
  readonly recordId: string;
  readonly audience: UpdateAudience;
  readonly version?: number | undefined;
  readonly nowMs: number;
  /** Present only when the owner passed `--synthesize` AND a model can be used. */
  readonly runner?: SynthesisRunner | undefined;
}): Promise<SynthesizedUpdate> {
  const draft = draftIncidentUpdate(deps.db, deps.recordId, {
    audience: deps.audience,
    nowMs: deps.nowMs,
    ...(deps.version === undefined ? {} : { version: deps.version }),
  });
  if (deps.runner === undefined) {
    return { ...draft, lead: null, synthesis: { attempted: false, reason: "disabled" } };
  }
  const out = await synthesize(updateBrief(draft, deps.nowMs), { runner: deps.runner });
  const used = out.provenance.attempted && out.provenance.used === true;
  const lead = used ? leadOf(out.markdown) : null;
  return {
    ...draft,
    text: lead === null ? draft.text : `${lead}\n\n${draft.text}`,
    lead,
    synthesis: out.provenance,
  };
}
