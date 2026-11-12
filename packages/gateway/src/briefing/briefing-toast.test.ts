import { describe, expect, test } from "bun:test";

import type { BriefingCounts } from "../agents/_lib/briefing-types.ts";
import { briefingToastText, deadlineToastText } from "./briefing-toast.ts";

const ZERO: BriefingCounts = {
  meetings: 0,
  onCallShifts: 0,
  incidents: 0,
  reviews: 0,
  ticketsDue: 0,
  unreadMail: 0,
  unreadChat: 0,
};

describe("briefingToastText", () => {
  test("the spec example", () => {
    const t = briefingToastText({
      meetings: 3,
      onCallShifts: 1,
      incidents: 1,
      reviews: 2,
      ticketsDue: 4,
      unreadMail: 2,
      unreadChat: 1,
    });
    expect(t.title).toBe("Nimbus briefing");
    expect(t.body).toBe(
      "3 meetings · 2 reviews waiting · 1 active incident · 4 tickets due or overdue · 2 unread mail threads · 1 unread chat thread · on call today",
    );
  });

  test("singular forms, zero parts omitted", () => {
    expect(
      briefingToastText({ ...ZERO, meetings: 1, reviews: 1, ticketsDue: 1, unreadMail: 1 }).body,
    ).toBe("1 meeting · 1 review waiting · 1 ticket due or overdue · 1 unread mail thread");
  });

  test("all zero reads nothing is waiting; on call alone reads on call today", () => {
    expect(briefingToastText(ZERO).body).toBe("Nothing is waiting for you today");
    expect(briefingToastText({ ...ZERO, onCallShifts: 2 }).body).toBe("on call today");
  });

  test("property: 200 random counts (NaN, negative, fractional) always produce count-only text", () => {
    const pool = [Number.NaN, -3, 0, 1, 2, 7.9, 1e9, Number.POSITIVE_INFINITY];
    const pick = (i: number) => pool[(i * 7919) % pool.length] ?? 0;
    const re =
      /^(Nothing is waiting for you today|(\d+ [a-z ]+|on call today)( · (\d+ [a-z ]+|on call today))*)$/;
    for (let i = 0; i < 200; i++) {
      const counts: BriefingCounts = {
        meetings: pick(i),
        onCallShifts: pick(i + 1),
        incidents: pick(i + 2),
        reviews: pick(i * 3),
        ticketsDue: pick(i * 5 + 1),
        unreadMail: Math.random() * 20 - 5,
        unreadChat: Math.floor(Math.random() * 30),
      };
      const body = briefingToastText(counts).body;
      expect(body).toMatch(re);
    }
  });

  test("a string field cannot be added to the input (type-level)", () => {
    // @ts-expect-error - BriefingCounts has no free-text field
    const bad: BriefingCounts = { ...ZERO, title: "secret" };
    expect(briefingToastText(bad).body).toBe("Nothing is waiting for you today");
  });
});

describe("deadlineToastText", () => {
  test("plural, singular and a non-default lead", () => {
    expect(deadlineToastText(2, 24)).toEqual({
      title: "Nimbus deadlines",
      body: "2 open items due within 24 h with no recent activity",
    });
    expect(deadlineToastText(1, 24).body).toBe(
      "1 open item due within 24 h with no recent activity",
    );
    expect(deadlineToastText(3, 48).body).toContain("within 48 h");
  });

  test("clamps junk numbers", () => {
    expect(deadlineToastText(Number.NaN, -5).body).toBe(
      "0 open items due within 0 h with no recent activity",
    );
  });
});
