export function encodeZoomMeetingPathSegment(idOrUuid: string): string {
  const needsDoubleEncode = idOrUuid.startsWith("/") || idOrUuid.includes("//");
  const once = encodeURIComponent(idOrUuid);
  return needsDoubleEncode ? encodeURIComponent(once) : once;
}
