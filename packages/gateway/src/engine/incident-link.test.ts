import { describe, expect, test } from "bun:test";

import { assertIncidentLink, isIncidentLink } from "./incident-link.ts";

const ID = "inc_0123456789abcdef";

describe("incident link shape (IC4 2.1)", () => {
  test("accepts exactly { id, version }, including a null-prototype object", () => {
    expect(isIncidentLink({ id: ID, version: 1 })).toBe(true);
    expect(isIncidentLink({ id: ID, version: 1_000_000 })).toBe(true);
    expect(isIncidentLink(Object.assign(Object.create(null), { id: ID, version: 3 }))).toBe(true);
  });

  const bad: [string, unknown][] = [
    ["uppercase hex", { id: "inc_0123456789ABCDEF", version: 1 }],
    ["short id", { id: "inc_0123", version: 1 }],
    ["long id", { id: `${ID}0`, version: 1 }],
    ["no prefix", { id: "0123456789abcdef", version: 1 }],
    ["non-hex digit", { id: "inc_0123456789abcdeg", version: 1 }],
    ["version 0", { id: ID, version: 0 }],
    ["version -1", { id: ID, version: -1 }],
    ["version 1.5", { id: ID, version: 1.5 }],
    ["version too large", { id: ID, version: 1_000_001 }],
    ["version string", { id: ID, version: "1" }],
    ["NaN version", { id: ID, version: Number.NaN }],
    ["extra key", { id: ID, version: 1, extra: true }],
    ["missing version", { id: ID }],
    ["array", [ID, 1]],
    ["null", null],
    ["string", ID],
    [
      "class instance",
      new (class L {
        id = ID;
        version = 1;
      })(),
    ],
    ["getter", Object.defineProperty({ version: 1 }, "id", { get: () => ID, enumerable: true })],
    ["symbol key", { id: ID, version: 1, [Symbol("x")]: 1 }],
  ];
  for (const [name, value] of bad) {
    test(`refuses ${name}`, () => {
      expect(isIncidentLink(value)).toBe(false);
      expect(() => assertIncidentLink(value)).toThrow();
    });
  }
});
