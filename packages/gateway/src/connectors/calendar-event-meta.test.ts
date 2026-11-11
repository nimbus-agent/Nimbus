import { describe, expect, test } from "bun:test";

import { REBODY_META_TARGETS } from "../ipc/index-rebody-rpc.ts";
import {
  GOOGLE_CALENDAR_EVENT_META_VERSION,
  OUTLOOK_EVENT_META_VERSION,
} from "./calendar-event-meta.ts";

describe("calendar event depth versions", () => {
  test("both start at 1", () => {
    expect(GOOGLE_CALENDAR_EVENT_META_VERSION).toBe(1);
    expect(OUTLOOK_EVENT_META_VERSION).toBe(1);
  });

  test("neither is a rebody target: every sync re-writes its whole window, so a target would stay pending forever", () => {
    const eventTargets = REBODY_META_TARGETS.filter(
      (t) => t.service === "google_calendar" || (t.service === "outlook" && t.type === "event"),
    );
    expect(eventTargets).toEqual([]);
  });
});
