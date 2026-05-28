/**
 * Zoom path-encode a meeting id-or-UUID. Per Zoom's REST API docs: numeric
 * meeting IDs and UUIDs both go in the `{meetingId}` slot, but if a UUID
 * begins with `/` or contains `//`, it MUST be double-encoded. The simplest
 * safe rule is: detect the literal prefix / substring and double-encode in
 * those cases, single-encode otherwise. Numeric IDs never trigger the
 * double-encode branch.
 */
export function encodeZoomMeetingPathSegment(idOrUuid: string): string {
  const needsDoubleEncode = idOrUuid.startsWith("/") || idOrUuid.includes("//");
  const once = encodeURIComponent(idOrUuid);
  return needsDoubleEncode ? encodeURIComponent(once) : once;
}
