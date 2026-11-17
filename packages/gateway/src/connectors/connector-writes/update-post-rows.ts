/**
 * The write rows an incident update send (Phase 10 IC9b) runs, named in ONE place inside the row table's own
 * directory (static D20 confines every write tool id to it). `incident-update/update-send.ts` imports these ids
 * and looks each row up in the table; it adds no row and does not name a tool itself.
 */
export const UPDATE_POST_TOOL_IDS = Object.freeze({
  slack: "slack_message_post",
  teams: "teams_message_post",
} as const);
