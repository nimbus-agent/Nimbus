import { stripControl } from "./captures-format.ts";

/** How many extension ids the doctor line names before summarising the rest. */
const MAX_LISTED = 5;

const NEEDS_APPROVAL = new Set(["no_grant", "grant_stale"]);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/**
 * `nimbus doctor`'s extensions line, from an `extension.list` response: one `[warn]` naming the
 * installed extensions that have no run approval or an approval for older code, so an upgrade that
 * left them unapproved is visible rather than silent. Silent when there are none, and when the
 * gateway reports the extension runtime off — approving one would be refused then. An older gateway
 * that does not report `runtimeEnabled` is treated as having it on. Throws on a malformed response;
 * the caller turns that into a `[warn]`.
 */
export function doctorExtensionsLines(raw: unknown): { lines: string[]; exit: number } {
  if (!isRecord(raw) || !Array.isArray(raw["extensions"])) {
    throw new Error("malformed extension.list response from the gateway");
  }
  if (raw["runtimeEnabled"] === false) return { lines: [], exit: 0 };
  const ids = raw["extensions"].flatMap((e: unknown) =>
    isRecord(e) &&
    typeof e["id"] === "string" &&
    typeof e["runState"] === "string" &&
    NEEDS_APPROVAL.has(e["runState"])
      ? [stripControl(e["id"])]
      : [],
  );
  if (ids.length === 0) return { lines: [], exit: 0 };
  const shown = ids.slice(0, MAX_LISTED).join(", ");
  const more = ids.length > MAX_LISTED ? `, +${ids.length - MAX_LISTED} more` : "";
  return {
    lines: [
      `[warn] Extensions: ${ids.length} installed extension(s) not approved to run, or approved for an older version (${shown}${more}) — nimbus extension approve <id>`,
    ],
    exit: 1,
  };
}
