// packages/gateway/src/connectors/connector-writes/delete-readers.ts
// The before-state readers of the three Wave 4 deletes (Phase 9.7 D1, group D): the OneDrive item,
// the Outlook calendar event and the iCloud calendar event. The OneDrive and Outlook replies are
// Microsoft Graph's own JSON (`driveItem`, `event`); the iCloud one is the connector's `ViewEvent`.
// Imported BY `files.ts` and `mail-calendar.ts`, so it imports nothing from the row table.
import {
  arrayAt,
  type BeforeInput,
  beforeReplyJson,
  boolAt,
  excerptHead,
  listAt,
  nonEmptyString,
  presentFields,
  requiredStringAt,
  shownHead,
  stringAt,
  yesNo,
} from "./before-select.ts";
import type { BeforeStateField } from "./types.ts";

/** Whether `j` has an own property `key` that is a non-null object (a Graph facet). */
export function hasFacet(j: unknown, key: string): boolean {
  if (typeof j !== "object" || j === null || !Object.hasOwn(j, key)) return false;
  const v = (j as Record<string, unknown>)[key];
  return typeof v === "object" && v !== null;
}

/** The parent reference of a Graph driveItem: its path when it has one, else its id. */
export function onedriveParent(j: unknown): string | undefined {
  return stringAt(j, ["parentReference", "path"]) ?? stringAt(j, ["parentReference", "id"]);
}

/** A read whose only input is `key`, taken from the write's `fromKey` (a non-empty string). */
export function singleIdArgs(
  key: string,
  fromKey: string,
): (input: BeforeInput) => Record<string, unknown> | undefined {
  return (input) => {
    const id = nonEmptyString(input[fromKey]);
    return id === undefined ? undefined : { [key]: id };
  };
}

/**
 * OneDrive `onedrive_item_get` (before-state) for a delete: what is about to be deleted. A folder
 * says it takes everything inside with it; the connector describes the delete as permanent.
 */
export function selectOnedriveItemDelete(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const name = requiredStringAt(j, ["name"]);
  let type = "item";
  if (hasFacet(j, "folder")) {
    const children = stringAt(j, ["folder", "childCount"]);
    const count = children === undefined ? "" : ` with ${children} items`;
    type = `folder${count}: deleting it deletes everything inside`;
  } else if (hasFacet(j, "file")) {
    type = "file";
  }
  const parent = onedriveParent(j);
  const size = stringAt(j, ["size"]);
  return [
    { label: "Name", value: excerptHead(name) },
    { label: "Type", value: type },
    ...presentFields([
      ["Size", size === undefined ? undefined : `${size} bytes`],
      ["Parent", shownHead(parent)],
      ["Shared", hasFacet(j, "shared") ? "yes: others can open it" : "no"],
      ["Modified", shownHead(stringAt(j, ["lastModifiedDateTime"]))],
    ]),
  ];
}

/** `Start`/`End` of a Graph event: `dateTime (timeZone)`. */
function graphTime(j: unknown, key: string): string | undefined {
  const at = stringAt(j, [key, "dateTime"]);
  if (at === undefined) return undefined;
  const zone = stringAt(j, [key, "timeZone"]);
  return zone === undefined ? at : `${at} (${zone})`;
}

/** The attendees of a Graph event as `<count>: addresses` (capped), else `(none)`. */
function graphAttendees(j: unknown): string | undefined {
  const attendees = arrayAt(j, ["attendees"]);
  if (attendees === undefined) return undefined;
  if (attendees.length === 0) return "(none)";
  const addresses = attendees.flatMap((a) => {
    const address = stringAt(a, ["emailAddress", "address"]);
    return address === undefined ? [] : [address];
  });
  const list =
    addresses.length === 0
      ? "(unreadable)"
      : (listAt({ addresses }, ["addresses"]) ?? "(unreadable)");
  return `${String(attendees.length)}: ${list}`;
}

/**
 * Outlook `outlook_calendar_get` (before-state) for a delete: the event that disappears, with its
 * time zone, whether the owner organises it (deleting an event one organises cancels it for the
 * attendees) and its attendees.
 */
export function selectOutlookEventDelete(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  const subject = requiredStringAt(j, ["subject"]);
  const organizer =
    stringAt(j, ["organizer", "emailAddress", "address"]) ??
    stringAt(j, ["organizer", "emailAddress", "name"]);
  return [
    { label: "Subject", value: excerptHead(subject) },
    ...presentFields([
      ["Start", shownHead(graphTime(j, "start"))],
      ["End", shownHead(graphTime(j, "end"))],
      ["Organizer", shownHead(organizer)],
      ["Is organizer", yesNo(boolAt(j, ["isOrganizer"]))],
      ["Attendees", shownHead(graphAttendees(j))],
      ["Cancelled", yesNo(boolAt(j, ["isCancelled"]))],
    ]),
  ];
}

/** The iCloud event's attendees as `<count>: addresses` (capped), else `(none)`. */
function viewAttendees(j: unknown): string | undefined {
  const attendees = arrayAt(j, ["attendees"]);
  if (attendees === undefined) return undefined;
  if (attendees.length === 0) return "(none)";
  const addresses = attendees.flatMap((a) => (typeof a === "string" ? [a] : []));
  const list =
    addresses.length === 0
      ? "(unreadable)"
      : (listAt({ addresses }, ["addresses"]) ?? "(unreadable)");
  return `${String(attendees.length)}: ${list}`;
}

/**
 * iCloud `apple_calendar_event_get` (before-state) for a delete: the event (the connector refuses an
 * href outside the account's calendars). A recurring event (an `rrule`) says the delete takes the
 * whole series.
 */
export function selectAppleEventDelete(reply: unknown): readonly BeforeStateField[] {
  const j = beforeReplyJson(reply);
  // The `uid` is the event's identity; a reply without one is not an event.
  requiredStringAt(j, ["uid"]);
  const rrule = stringAt(j, ["rrule"]);
  return [
    { label: "Summary", value: excerptHead(stringAt(j, ["summary"]) ?? "(no title)") },
    ...presentFields([
      ["Start", shownHead(stringAt(j, ["start"]))],
      ["End", shownHead(stringAt(j, ["end"]))],
      ["Calendar", shownHead(stringAt(j, ["calendar"]))],
      ["Organizer", shownHead(stringAt(j, ["organizer"]))],
      ["Attendees", shownHead(viewAttendees(j))],
      ["Location", shownHead(stringAt(j, ["location"]))],
      [
        "Recurrence",
        rrule === undefined
          ? undefined
          : excerptHead(`RECURRING: this deletes the whole series (${rrule})`),
      ],
    ]),
  ];
}
