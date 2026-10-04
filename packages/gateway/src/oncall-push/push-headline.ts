import { escapeSlackText } from "../chatops/escape-outbound.ts";
import type { PushDelivery } from "./push-runner.ts";

/** Coalesced ids the summary post lists; the rest stay reachable locally (design: 2026-10-02-oncall-push-chatops-design.md § 3). */
export const SUMMARY_ID_CAP = 10;
/** Per inserted field, in code points (design: 2026-10-02-oncall-push-chatops-design.md § 3). */
export const FIELD_MAX_CODEPOINTS = 200;
const MINUTE_MS = 60_000;

// Format characters (bidi overrides/isolates, zero-width, BOM): removed, so the rendered line reads
// the same as its bytes. Controls (incl. \t \r \n U+0085) and line/paragraph separators: collapsed
// to one space, so a title cannot forge the headline's next line.
const FORMAT_RE = /\p{Cf}/gu;
const BREAK_RE = /[\p{Cc}\p{Zl}\p{Zp}]+/gu;

/** One display line of at most FIELD_MAX_CODEPOINTS code points. Escaping is a separate step. */
export function oneLine(s: string): string {
  const flat = s.replace(FORMAT_RE, "").replace(BREAK_RE, " ").trim();
  const cps = Array.from(flat);
  return cps.length <= FIELD_MAX_CODEPOINTS
    ? flat
    : `${cps.slice(0, FIELD_MAX_CODEPOINTS - 1).join("")}…`;
}

/** Every inserted value goes through here: normalise, cap, THEN escape (so a cut never splits an entity). */
function field(s: string): string {
  return escapeSlackText(oneLine(s));
}

function nonEmpty(s: string | null | undefined): string | undefined {
  if (s === null || s === undefined) return undefined;
  return oneLine(s) === "" ? undefined : s;
}

export type HeadlineBrief = {
  readonly nimbusServiceId: string | null;
  readonly deployment: {
    readonly title: string;
    readonly startedAtMs: number;
    readonly finishedAtMs: number | null;
  } | null;
};

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * The two fields the headline needs from a stored `OncallBrief` (the `briefReady` `findings`). There
 * is no decoder for the stored brief, so this narrows on its own. `null`, malformed JSON or the wrong
 * shape all mean "no brief". `deployment` must be PRESENT (null or an object); an absent key is the
 * wrong shape, not "no deployment".
 */
export function parseHeadlineBrief(json: string | null): HeadlineBrief | null {
  if (json === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!isRecord(v) || !("deployment" in v)) return null;
  const binding = v["binding"];
  if (!isRecord(binding)) return null;
  // The two NULLABLE fields also accept a missing key, read as null. Today's writer always emits
  // both (`finished_at_ms` comes back from SQLite as null, never absent), but rejecting the whole
  // brief over a missing nullable field would print "could not be assembled" for a brief that
  // exists. Treating it as null lands on the spec's own fallbacks instead. A WRONG TYPE still
  // rejects.
  const sid = binding["nimbusServiceId"] ?? null;
  if (sid !== null && typeof sid !== "string") return null;
  const dep = v["deployment"];
  if (dep === null) return { nimbusServiceId: sid, deployment: null };
  if (!isRecord(dep)) return null;
  const title = dep["title"];
  const startedAtMs = dep["startedAtMs"];
  const finishedAtMs = dep["finishedAtMs"] ?? null;
  if (typeof title !== "string" || typeof startedAtMs !== "number") return null;
  if (finishedAtMs !== null && typeof finishedAtMs !== "number") return null;
  return { nimbusServiceId: sid, deployment: { title, startedAtMs, finishedAtMs } };
}

/**
 * The service a pushed brief is about, shared by the ChatOps headline and `oncall.pushedList` so
 * Slack and the desktop name it identically: the brief's mapped Nimbus service, then the incident's
 * PagerDuty service id, then null. Blank values fall through. RAW: each surface formats it itself.
 */
export function resolvePushService(
  brief: HeadlineBrief | null,
  pagerdutyServiceId: string | null,
): string | null {
  return nonEmpty(brief?.nimbusServiceId) ?? nonEmpty(pagerdutyServiceId) ?? null;
}

/** The ChatOps agent intent for one incident. The parameter is `incidentId` (ipc/agent-param-kinds.ts). */
export function pushAgentCommand(incidentId: string): string {
  return `@nimbus agent oncall incidentId=${field(incidentId)}`;
}

function deploymentLine(brief: HeadlineBrief | null, openedAtMs: number | null): string {
  if (brief === null) return "Brief could not be assembled; rerun the agent below to retry";
  const dep = brief.deployment;
  if (dep === null) return "No deployment found before the alert";
  const deployAt = dep.finishedAtMs ?? dep.startedAtMs;
  const when =
    openedAtMs === null
      ? ""
      : ` (${Math.max(0, Math.round((openedAtMs - deployAt) / MINUTE_MS))} min before)`;
  return `Last deployment before the alert: ${field(nonEmpty(dep.title) ?? "(untitled)")}${when} — timing only, not a proven cause`;
}

/** Design § 3 (2026-10-02-oncall-push-chatops-design.md): at most three lines. Every inserted value is single-lined, capped and escaped. */
export function renderPushHeadline(d: PushDelivery): string {
  const brief = d.row.status === "ok" ? parseHeadlineBrief(d.row.briefJson) : null;
  const severity = nonEmpty(d.incident.severity) ?? "P1";
  const service = resolvePushService(brief, d.incident.pagerdutyServiceId) ?? "unknown service";
  const title = nonEmpty(d.incident.title) ?? "(untitled)";
  const id = d.row.incidentId;
  return [
    `${field(severity)} · ${field(service)} — ${field(title)}`,
    deploymentLine(brief, d.incident.openedAtMs),
    `${pushAgentCommand(id)}  ·  locally: nimbus oncall pushed ${field(id)}`,
  ].join("\n");
}

/**
 * The one post for rows past the cap. `N`/`M` count ALL rows, exactly as the toast summary does
 * (push-sinks.ts); the listed ids are `rest`, the rows that got no headline of their own.
 */
export function renderPushSummary(
  all: readonly PushDelivery[],
  rest: readonly PushDelivery[],
): string {
  const ready = all.filter((d) => d.row.status === "ok").length;
  const shown = rest.slice(0, SUMMARY_ID_CAP).map((d) => field(d.row.incidentId));
  const more = rest.length - shown.length;
  const list =
    more > 0
      ? `${shown.join(", ")} … and ${more} more (locally: nimbus oncall pushed list)`
      : shown.join(", ");
  // `<id>` is template text, but `<` would still start a Slack token, so it is escaped too.
  return `${all.length} P1 incidents paged (${ready} brief${ready === 1 ? "" : "s"} ready). Not posted individually: ${list} — ${escapeSlackText("@nimbus agent oncall incidentId=<id>")} for any of them`;
}
