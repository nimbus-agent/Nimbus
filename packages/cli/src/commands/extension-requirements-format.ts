import { stripControl } from "./captures-format.ts";

/**
 * The connector-requirement status an extension's manifest produces, as the gateway reports it
 * (`ConnectorRequirementStatus` in the gateway's `extensions/connector-requirements.ts`). The CLI
 * cannot import gateway source, so the shape is mirrored here.
 */
export type RequirementState =
  | "met"
  | "configured_never_synced"
  | "not_connected"
  | "unknown_connector"
  | "unknown";

export type RequirementStatusView = {
  readonly connector: string;
  readonly state: RequirementState;
  readonly owner: { kind: "bundled" } | { kind: "extension"; extensionId: string };
  readonly fix: string[];
  readonly interactive: boolean;
  readonly requiredBy: string[];
};

const STATES: ReadonlySet<string> = new Set([
  "met",
  "configured_never_synced",
  "not_connected",
  "unknown_connector",
  "unknown",
]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

function parseOwner(v: unknown): RequirementStatusView["owner"] | undefined {
  if (!isRecord(v)) return undefined;
  if (v["kind"] === "bundled") return { kind: "bundled" };
  if (v["kind"] === "extension" && typeof v["extensionId"] === "string") {
    return { kind: "extension", extensionId: v["extensionId"] };
  }
  return undefined;
}

function parseOne(v: unknown): RequirementStatusView | undefined {
  if (!isRecord(v)) return undefined;
  const { connector, state, fix, interactive, requiredBy } = v;
  const owner = parseOwner(v["owner"]);
  if (
    typeof connector !== "string" ||
    typeof state !== "string" ||
    !STATES.has(state) ||
    owner === undefined ||
    !isStringArray(fix) ||
    typeof interactive !== "boolean"
  ) {
    return undefined;
  }
  return {
    connector,
    state: state as RequirementState,
    owner,
    fix,
    interactive,
    requiredBy: isStringArray(requiredBy) ? requiredBy : [],
  };
}

/** Parses an unknown IPC value; drops malformed entries rather than throwing. */
export function parseRequirementStatuses(raw: unknown): RequirementStatusView[] {
  if (!Array.isArray(raw)) return [];
  return raw.flatMap((v) => {
    const one = parseOne(v);
    return one === undefined ? [] : [one];
  });
}

function fixText(r: RequirementStatusView): string {
  return r.fix.map(stripControl).join(" && ");
}

function statusText(r: RequirementStatusView): string {
  switch (r.state) {
    case "met":
      return "connected";
    case "configured_never_synced":
      return `connected, never synced — run: ${fixText(r)}`;
    case "not_connected":
      return `not connected — run: ${fixText(r)}`;
    case "unknown_connector":
      return "not a connector this Nimbus knows";
    case "unknown":
      return "status unavailable";
  }
}

/** One indented line per connector requirement, in the order given. */
export function requirementLines(reqs: readonly RequirementStatusView[]): string[] {
  return reqs.map((r) => `  ${stripControl(r.connector)}: ${statusText(r)}`);
}
