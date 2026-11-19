import type { SynthInput } from "./brief-kinds.ts";

/**
 * The `tool` name each brief is enveloped under (`wrapToolOutput`, I11) when it is handed to the
 * model. Total over the brief kinds, so a new kind is a compile error until it is named here —
 * the same guarantee the exhaustive dispatch above gives. Note `conflict` maps to the PLURAL
 * `agents.conflicts`: that is the method name, not a typo.
 */
export const TOOL_NAME_BY_KIND: Readonly<Record<SynthInput["kind"], string>> = {
  expert: "agents.expert",
  impact: "agents.impact",
  catchup: "agents.catchup",
  ghost: "agents.ghost",
  conflict: "agents.conflicts",
  janitor: "agents.janitor",
  preflight: "agents.preflight",
  why: "agents.why",
  glossary: "agents.glossary",
  decisions: "agents.decisions",
  ownership: "agents.ownership",
  huddle: "agents.huddle",
  premortem: "agents.premortem",
  negotiate: "agents.negotiate",
  changelog: "agents.changelog",
  standup: "agents.standup",
  oncall: "agents.oncall",
  // Never sent anywhere: the briefing calls `synthesize` with no runner (OR-10-8), so no tool envelope exists.
  briefing: "agents.briefing",
  // Never sent anywhere either: an incident record is rendered with no runner (OR-10-8, I57 (a)).
  incident: "agents.incident",
  // Never sent anywhere either: the Data Incident Brief is rendered with no runner (OR-10-8, I57 (a)).
  incident_data: "agents.incident_data",
  // A model may rewrite it (IC9a, `--synthesize`): only in a command the owner runs, never unattended.
  incident_investigation: "agents.incident_investigation",
  // The one record brief a model may rewrite (IC7a): only in a command the owner runs, never unattended.
  incident_postmortem: "agents.incident_postmortem",
  pr_prereview: "agents.pr_prereview",
};
