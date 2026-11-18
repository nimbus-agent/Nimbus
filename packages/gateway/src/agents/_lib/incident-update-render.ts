import type { IncidentRecordV1 } from "../../incident/incident-record-types.ts";
import type { Timeline, TimelineEvent } from "../../incident/timeline.ts";

/**
 * The deterministic render of an incident UPDATE (Phase 10 IC9b, incident-engine spec § 5.9): a short
 * stakeholder or engineer message drafted from a stored record version and its timeline. No model (OR-10-8):
 * the text is a pure function of its input, every time is UTC, so it is byte-identical across machines.
 *
 * The target is a CHAT message (a Slack `text`, a Teams `text` body), not a Markdown brief, so it has its own
 * hardening rather than `hardenedPlain`'s Markdown escaping (whose backslashes would show in a chat client):
 * every provider-supplied string is stripped of control, format and line-structure characters (ANSI, bidi,
 * newlines), of the chat formatting marks `` ` * _ ~ ``, and has `<` and `>` replaced by `‹` and `›`, so a title
 * can neither open a Slack control sequence (`<!here>`, `<@U1>`, `<url|text>`) nor forge a line of ours. The
 * send still runs the shared broadcast-mention refusal on the final text (a plain `@here` is refused there).
 */

export type UpdateAudience = "stakeholders" | "engineers";

export const UPDATE_AUDIENCES: readonly UpdateAudience[] = Object.freeze([
  "stakeholders",
  "engineers",
]);

export type UpdateRenderInput = {
  readonly recordId: string;
  readonly record: IncidentRecordV1;
  readonly version: number;
  readonly timeline: Timeline;
  readonly audience: UpdateAudience;
  /** When the draft is made (the footer's time). */
  readonly nowMs: number;
};

const TEXT_MAX = 120;
const ENGINEER_EVENTS = 10;

/** A provider string made safe for a chat line (see the module comment). */
export function chatSafe(text: string, max = TEXT_MAX): string {
  const s = text
    .replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/[`*_~]/g, "")
    .replaceAll("<", "‹")
    .replaceAll(">", "›")
    .replace(/\s+/g, " ")
    .trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function utc(ms: number): string {
  return `${new Date(ms).toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function duration(fromMs: number, toMs: number): string {
  const mins = Math.max(0, Math.round((toMs - fromMs) / 60_000));
  if (mins < 60) return `${String(mins)} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m === 0 ? `${String(h)} h` : `${String(h)} h ${String(m)} min`;
}

function statusWord(r: IncidentRecordV1): string {
  if (r.trigger.status === "closed") return "Resolved";
  if (r.trigger.status === "open") return "Ongoing";
  return "Status not known";
}

function httpsUrl(url: string | null): string | null {
  if (url === null) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== "https:") return null;
    // Whitespace and angle brackets would end the link in a chat client.
    return /[\s<>]/.test(u.href) ? null : u.href;
  } catch {
    return null;
  }
}

function statusLine(r: IncidentRecordV1, service: string | null): string {
  const parts = [`Status: ${statusWord(r)}`];
  if (service !== null) parts.push(`Service: ${service}`);
  if (r.trigger.severity !== null) parts.push(`Severity: ${chatSafe(r.trigger.severity, 20)}`);
  return parts.join(" | ");
}

function headerLines(r: IncidentRecordV1, recordId: string, version: number): string[] {
  const t = r.trigger;
  const service = r.binding.service === null ? null : chatSafe(r.binding.service, 60);
  return [
    `Incident update: ${chatSafe(t.title)}`,
    statusLine(r, service),
    `Record: ${recordId} (version ${String(version)})`,
  ];
}

function timeLines(r: IncidentRecordV1, nowMs: number): string[] {
  const t = r.trigger;
  const lines: string[] = [];
  if (t.opened.ms === null) {
    lines.push("Started: not recorded by the source");
  } else {
    lines.push(`Started: ${utc(t.opened.ms)}`);
  }
  if (t.status === "closed") {
    if (t.closed.ms === null) lines.push("Resolved: time not recorded");
    else {
      const d = t.opened.ms === null ? "" : ` (after ${duration(t.opened.ms, t.closed.ms)})`;
      lines.push(`Resolved: ${utc(t.closed.ms)}${d}`);
    }
  } else if (t.opened.ms !== null) {
    lines.push(`Open for: ${duration(t.opened.ms, nowMs)}`);
  }
  return lines;
}

function knownLines(r: IncidentRecordV1, timeline: Timeline): string[] {
  const lines = [
    `What we know: ${String(timeline.events.length)} event${timeline.events.length === 1 ? "" : "s"} on the timeline so far.`,
  ];
  const dep = r.change.deployment;
  if (dep !== null) {
    lines.push(
      `A deployment finished ${String(dep.minutesBeforeOpen)} min before the alert (timing only, not a proven cause).`,
    );
  }
  return lines;
}

function eventLine(e: TimelineEvent): string {
  return `- ${utc(e.atMs)} ${e.kind.replaceAll("_", " ")} (${chatSafe(e.source, 30)}): ${chatSafe(e.text)}`;
}

function engineerLines(r: IncidentRecordV1, timeline: Timeline): string[] {
  const t = r.trigger;
  const lines = [`Trigger: ${t.service} ${chatSafe(t.type, 30)} ${chatSafe(t.providerId, 60)}`];
  const url = httpsUrl(t.url);
  if (url !== null) lines.push(`Link: ${url}`);
  const dep = r.change.deployment;
  if (dep !== null) {
    lines.push(
      `Last deployment before the alert: ${chatSafe(dep.provider, 30)} ${chatSafe(dep.sha.slice(0, 12), 12)} to ${chatSafe(dep.environment, 40)} (${chatSafe(dep.conclusion, 20)})`,
    );
  }
  if (r.change.pr !== null) lines.push(`Pull request: ${chatSafe(r.change.pr.title)}`);
  if (r.change.ci !== null) {
    lines.push(
      r.change.ci.conclusion === null
        ? `CI run: ${chatSafe(r.change.ci.title)}`
        : `CI run: ${chatSafe(r.change.ci.title)} (${chatSafe(r.change.ci.conclusion, 20)})`,
    );
  }
  const events = timeline.events.slice(-ENGINEER_EVENTS);
  if (events.length > 0) {
    lines.push(
      timeline.events.length > events.length
        ? `Latest ${String(events.length)} of ${String(timeline.events.length)} events:`
        : "Events:",
    );
    for (const e of events) lines.push(eventLine(e));
  }
  return lines;
}

/** The update text. Lines end in `\n`; blocks are separated by one blank line. */
export function renderIncidentUpdate(input: UpdateRenderInput): string {
  const r = input.record;
  const blocks: string[][] = [
    headerLines(r, input.recordId, input.version),
    timeLines(r, input.nowMs),
    knownLines(r, input.timeline),
  ];
  if (input.audience === "engineers") blocks.push(engineerLines(r, input.timeline));
  blocks.push([
    r.trigger.status === "closed"
      ? "This incident is resolved."
      : "Next update: when the status changes.",
    `Drafted by Nimbus from the local index at ${utc(input.nowMs)}. Not checked with the provider.`,
  ]);
  return `${blocks.map((b) => b.join("\n")).join("\n\n")}\n`;
}
