import { describe, expect, test } from "bun:test";
import { encodeNimbusJsonCursor } from "../../nimbus-json-cursor.ts";
import {
  decodeTeamsSyncCursor,
  encodeTeamsSyncCursor,
  initialCursor,
  parseCursor,
  TEAMS_CURSOR_PREFIX,
  type TeamsSyncCursorV1,
} from "./cursor.ts";

// Helper: encode an arbitrary object (not necessarily a valid cursor) with the
// Teams prefix so decodeNimbusJsonCursorPayload succeeds and structural
// validation inside decodeTeamsSyncCursor / isTeamsCursorV1 is exercised.
function encodeRaw(payload: unknown): string {
  return encodeNimbusJsonCursor(TEAMS_CURSOR_PREFIX, payload);
}

// A valid complete cursor for round-trip testing.
const validCursor: TeamsSyncCursorV1 = {
  v: 1,
  phase: "teams",
  teams: [{ id: "team-1" }],
  teamsNext: "next-tok",
  channelTeamIdx: 2,
  channelsByTeam: { "team-1": ["chan-a", "chan-b"] },
  chanNext: "ch-tok",
  pairs: [{ teamId: "team-1", channelId: "chan-a" }],
  pairIdx: 0,
  deltaByKey: { "team-1|chan-a": "2026-01-01T00:00:00Z", "team-1|chan-b": null },
};

// ─── TEAMS_CURSOR_PREFIX ──────────────────────────────────────────────────────

describe("TEAMS_CURSOR_PREFIX", () => {
  test("has expected value", () => {
    expect(TEAMS_CURSOR_PREFIX).toBe("nimbus-tms1:");
  });

  test("encoded cursor always starts with prefix", () => {
    expect(encodeTeamsSyncCursor(validCursor).startsWith(TEAMS_CURSOR_PREFIX)).toBe(true);
  });
});

// ─── initialCursor defaults ───────────────────────────────────────────────────

describe("initialCursor()", () => {
  test("returns expected defaults", () => {
    const c = initialCursor();
    expect(c.v).toBe(1);
    expect(c.phase).toBe("teams");
    expect(c.teams).toEqual([]);
    expect(c.teamsNext).toBeNull();
    expect(c.channelTeamIdx).toBe(0);
    expect(c.channelsByTeam).toEqual({});
    expect(c.chanNext).toBeNull();
    expect(c.pairs).toEqual([]);
    expect(c.pairIdx).toBe(0);
    expect(c.deltaByKey).toEqual({});
  });

  test("returns a fresh object each call", () => {
    const a = initialCursor();
    const b = initialCursor();
    a.teams.push({ id: "x" });
    expect(b.teams).toHaveLength(0);
  });
});

// ─── parseCursor ─────────────────────────────────────────────────────────────

describe("parseCursor()", () => {
  test("null → initialCursor()", () => {
    expect(parseCursor(null)).toEqual(initialCursor());
  });

  test("empty string → initialCursor()", () => {
    expect(parseCursor("")).toEqual(initialCursor());
  });

  test("valid encoded cursor → decoded cursor (round-trip)", () => {
    const encoded = encodeTeamsSyncCursor(validCursor);
    expect(parseCursor(encoded)).toEqual(validCursor);
  });

  // L131: isTeamsCursorV1 returns false → falls back to initialCursor()
  test("encoded but structurally invalid payload → initialCursor() fallback", () => {
    const bad = encodeRaw({ v: 1, phase: "teams" /* missing required fields */ });
    expect(parseCursor(bad)).toEqual(initialCursor());
  });

  test("wrong prefix → initialCursor() fallback", () => {
    expect(parseCursor("nimbus-other:eyJ2IjoxfQ")).toEqual(initialCursor());
  });
});

// ─── encodeTeamsSyncCursor / decodeTeamsSyncCursor round-trips ───────────────

describe("encodeTeamsSyncCursor / decodeTeamsSyncCursor — round-trips", () => {
  test("full valid cursor round-trips", () => {
    expect(decodeTeamsSyncCursor(encodeTeamsSyncCursor(validCursor))).toEqual(validCursor);
  });

  test("channels phase", () => {
    const c: TeamsSyncCursorV1 = { ...initialCursor(), phase: "channels" };
    expect(decodeTeamsSyncCursor(encodeTeamsSyncCursor(c))).toEqual(c);
  });

  test("messages phase", () => {
    const c: TeamsSyncCursorV1 = { ...initialCursor(), phase: "messages" };
    expect(decodeTeamsSyncCursor(encodeTeamsSyncCursor(c))).toEqual(c);
  });

  test("null teamsNext and chanNext survive round-trip", () => {
    const c: TeamsSyncCursorV1 = { ...initialCursor(), teamsNext: null, chanNext: null };
    expect(decodeTeamsSyncCursor(encodeTeamsSyncCursor(c))).toEqual(c);
  });

  test("deltaByKey with null value survives round-trip", () => {
    const c: TeamsSyncCursorV1 = {
      ...initialCursor(),
      deltaByKey: { k1: null, k2: "ts" },
    };
    expect(decodeTeamsSyncCursor(encodeTeamsSyncCursor(c))).toEqual(c);
  });

  test("multiple pairs survive round-trip", () => {
    const c: TeamsSyncCursorV1 = {
      ...initialCursor(),
      pairs: [
        { teamId: "t1", channelId: "c1" },
        { teamId: "t2", channelId: "c2" },
      ],
      pairIdx: 1,
    };
    expect(decodeTeamsSyncCursor(encodeTeamsSyncCursor(c))).toEqual(c);
  });
});

// ─── decodeTeamsSyncCursor — top-level shape guards (L78-L86) ────────────────

describe("decodeTeamsSyncCursor — top-level shape guards", () => {
  // L78: o is null
  test("null payload → undefined", () => {
    expect(decodeTeamsSyncCursor(encodeRaw(null))).toBeUndefined();
  });

  // L78: o is not an object (string)
  test("string scalar payload → undefined", () => {
    expect(decodeTeamsSyncCursor(encodeRaw("hello"))).toBeUndefined();
  });

  // L78: Array.isArray(o) → true
  test("array payload → undefined", () => {
    expect(decodeTeamsSyncCursor(encodeRaw([1, 2, 3]))).toBeUndefined();
  });

  // L82: r["v"] !== 1
  test("v = 2 → undefined (wrong version)", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 2,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("v missing → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L86: phase invalid
  test("unknown phase → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "unknown",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("phase missing → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // Bad prefix / bad base64
  test("wrong prefix → undefined", () => {
    expect(decodeTeamsSyncCursor("nimbus-other:eyJ2IjoxfQ")).toBeUndefined();
  });

  test("bad base64 after correct prefix → undefined", () => {
    expect(decodeTeamsSyncCursor(`${TEAMS_CURSOR_PREFIX}!!!not-base64`)).toBeUndefined();
  });
});

// ─── teamsCursorTeamsEntriesOk guards (L34, L38, L42) ────────────────────────

describe("decodeTeamsSyncCursor — teams array guards", () => {
  // L34: teams is not an array
  test("teams is not an array → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: "not-array",
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("teams is null → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: null,
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L38: element is null
  test("teams contains null entry → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [null],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L38: element is not an object (string)
  test("teams contains string entry → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: ["team-string"],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L38: element is an array (Array.isArray check)
  test("teams contains array entry → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [["nested"]],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L42: id is not a string
  test("teams entry with non-string id → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [{ id: 42 }],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L42: id is empty string
  test("teams entry with empty string id → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [{ id: "" }],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L42: id is missing
  test("teams entry with missing id → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [{}],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });
});

// ─── teamsNext guard (L93) ────────────────────────────────────────────────────

describe("decodeTeamsSyncCursor — teamsNext guard", () => {
  // L93: teamsNext !== null && typeof teamsNext !== "string"
  test("teamsNext is a number → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: 123,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("teamsNext is false → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: false,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("teamsNext is an object → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: {},
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });
});

// ─── channelTeamIdx guard (L97-L100) ─────────────────────────────────────────

describe("decodeTeamsSyncCursor — channelTeamIdx guard", () => {
  // L97: typeof channelTeamIdx !== "number"
  test("channelTeamIdx is a string → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: "zero",
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L98: !Number.isInteger (float)
  test("channelTeamIdx is a float → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 1.5,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L99: channelTeamIdx < 0
  test("channelTeamIdx is negative → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: -1,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });
});

// ─── channelsByTeam guard (L105-L110) ────────────────────────────────────────

describe("decodeTeamsSyncCursor — channelsByTeam guard", () => {
  // L105: channelsByTeam is null
  test("channelsByTeam is null → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: null,
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L106: typeof channelsByTeam !== "object" (string)
  test("channelsByTeam is a string → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: "not-an-object",
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L108: Array.isArray(channelsByTeam)
  test("channelsByTeam is an array → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: ["chan-a"],
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });
});

// ─── chanNext guard (L113) ────────────────────────────────────────────────────

describe("decodeTeamsSyncCursor — chanNext guard", () => {
  // L113: chanNext !== null && typeof chanNext !== "string"
  test("chanNext is a number → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: 0,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("chanNext is true → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: true,
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("chanNext is an array → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: [],
          pairs: [],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });
});

// ─── teamsCursorPairsEntriesOk guards (L50, L54, L58) ────────────────────────

describe("decodeTeamsSyncCursor — pairs array guards", () => {
  // L50: pairs is not an array
  test("pairs is not an array → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: "not-array",
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  test("pairs is null → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: null,
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L54: pair entry is null
  test("pairs contains null entry → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [null],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L54: pair entry is not an object (string)
  test("pairs contains string entry → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: ["string-pair"],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L54: pair entry is an array
  test("pairs contains array entry → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [["t1", "c1"]],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L58: teamId is not a string
  test("pair entry with non-string teamId → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [{ teamId: 42, channelId: "c1" }],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L58: channelId is not a string
  test("pair entry with non-string channelId → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [{ teamId: "t1", channelId: null }],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L58: both missing
  test("pair entry missing both teamId and channelId → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [{}],
          pairIdx: 0,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });
});

// ─── pairIdx guard (L120) ─────────────────────────────────────────────────────

describe("decodeTeamsSyncCursor — pairIdx guard", () => {
  // L120: typeof pairIdx !== "number"
  test("pairIdx is a string → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: "0",
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L120: !Number.isInteger (float)
  test("pairIdx is a float → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0.5,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });

  // L120: pairIdx < 0
  test("pairIdx is negative → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: -1,
          deltaByKey: {},
        }),
      ),
    ).toBeUndefined();
  });
});

// ─── teamsCursorDeltaValuesOk guards (L66, L70) ───────────────────────────────

describe("decodeTeamsSyncCursor — deltaByKey guards", () => {
  // L66: deltaByKey is null
  test("deltaByKey is null → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: null,
        }),
      ),
    ).toBeUndefined();
  });

  // L66: typeof deltaByKey !== "object" (string)
  test("deltaByKey is a string → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: "not-an-object",
        }),
      ),
    ).toBeUndefined();
  });

  // L66: Array.isArray(deltaByKey)
  test("deltaByKey is an array → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: ["delta-entry"],
        }),
      ),
    ).toBeUndefined();
  });

  // L70: value is not null and not a string (number)
  test("deltaByKey value is a number → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: { key1: 42 },
        }),
      ),
    ).toBeUndefined();
  });

  // L70: value is boolean
  test("deltaByKey value is a boolean → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: { key1: true },
        }),
      ),
    ).toBeUndefined();
  });

  // L70: value is an object
  test("deltaByKey value is an object → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          deltaByKey: { key1: {} },
        }),
      ),
    ).toBeUndefined();
  });

  // Valid: empty deltaByKey is accepted
  test("empty deltaByKey → valid cursor", () => {
    const c: TeamsSyncCursorV1 = { ...initialCursor(), deltaByKey: {} };
    expect(decodeTeamsSyncCursor(encodeTeamsSyncCursor(c))).toEqual(c);
  });

  // Valid: deltaByKey with mixed null/string values
  test("deltaByKey with mixed null and string values → valid cursor", () => {
    const c: TeamsSyncCursorV1 = {
      ...initialCursor(),
      deltaByKey: { a: "2026-01-01T00:00:00Z", b: null },
    };
    expect(decodeTeamsSyncCursor(encodeTeamsSyncCursor(c))).toEqual(c);
  });
});

// ─── L143: decodeTeamsSyncCursor returns undefined on malformed ───────────────

describe("decodeTeamsSyncCursor — undefined on malformed", () => {
  test("partially valid object (missing deltaByKey) → undefined", () => {
    expect(
      decodeTeamsSyncCursor(
        encodeRaw({
          v: 1,
          phase: "teams",
          teams: [],
          teamsNext: null,
          channelTeamIdx: 0,
          channelsByTeam: {},
          chanNext: null,
          pairs: [],
          pairIdx: 0,
          // deltaByKey omitted
        }),
      ),
    ).toBeUndefined();
  });

  test("numeric literal payload → undefined", () => {
    expect(decodeTeamsSyncCursor(encodeRaw(42))).toBeUndefined();
  });
});
