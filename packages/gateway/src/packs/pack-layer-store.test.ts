import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  getLayeredConfig,
  initLayeredConfig,
  resetLayeredConfigsForTests,
} from "../config/layered-config.ts";
import { loadNimbusDecisionsFromConfigDir } from "../config/nimbus-toml.ts";
import { PACK_FRAGMENT_MAX_BYTES } from "../config/pack-settable.ts";
import {
  createPackLayerStore,
  PackLayerRefusedError,
  type PackLayerStore,
  packSkipLogLines,
} from "./pack-layer-store.ts";

/** Every string value in `v`, recursively (keys too), so a path check cannot be defeated by escaping. */
function collectStrings(v: unknown, out: string[] = []): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) for (const x of v) collectStrings(x, out);
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) {
      out.push(k);
      collectStrings(x, out);
    }
  }
  return out;
}

const CONF = (v: string) => `[decisions]\nmin_confidence = ${v}\n`;
const JOB = (name: string) =>
  `[[fleet.job]]\nname = "${name}"\nagent = "standup"\ninterval_seconds = 86400\n`;

let dir: string;
beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-pack-store-"));
});
afterEach(() => {
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

const profileDir = (profile = "default") => join(dir, "packs", profile);
const packFile = (id: string, profile = "default") => join(profileDir(profile), `${id}.toml`);
const activeFile = (profile = "default") => join(profileDir(profile), "active.json");
const writeActive = (body: string, profile = "default") => {
  mkdirSync(profileDir(profile), { recursive: true });
  writeFileSync(activeFile(profile), body);
};
const readActive = (profile = "default"): unknown =>
  JSON.parse(readFileSync(activeFile(profile), "utf8"));

/** A store wired into a fresh reader for `dir` (default profile unless given). */
function wired(explicitProfile?: string): PackLayerStore {
  const store = createPackLayerStore({ configDir: dir });
  initLayeredConfig(dir, {
    packs: store,
    ...(explicitProfile !== undefined ? { explicitProfile } : {}),
  });
  return store;
}

function refusal(fn: () => unknown): PackLayerRefusedError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(PackLayerRefusedError);
    return err as PackLayerRefusedError;
  }
  throw new Error("expected a PackLayerRefusedError");
}

describe("setPackLayer", () => {
  test("set writes the file and active.json, and the value applies", () => {
    const store = wired();
    const r = store.setPackLayer("default", "pm", CONF("0.55"));
    expect(r.path).toBe(packFile("pm"));
    expect(readFileSync(packFile("pm"), "utf8")).toBe(CONF("0.55"));
    expect(readActive()).toEqual({ version: 1, packs: ["pm"] });
    expect(typeof r.snapshotVersion).toBe("number");
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.55);
    // Re-setting does not list the id twice.
    store.setPackLayer("default", "pm", CONF("0.6"));
    expect(readActive()).toEqual({ version: 1, packs: ["pm"] });
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.6);
  });

  test("never touches the user's files", () => {
    writeFileSync(join(dir, "nimbus.toml"), CONF("0.4"));
    writeFileSync(join(dir, "nimbus.work.toml"), CONF("0.45"));
    const fingerprint = (name: string) => {
      const p = join(dir, name);
      return [createHash("sha256").update(readFileSync(p)).digest("hex"), statSync(p).mtimeMs];
    };
    const before = [fingerprint("nimbus.toml"), fingerprint("nimbus.work.toml")];
    const store = wired();
    store.setPackLayer("default", "pm", CONF("0.55"));
    store.setPackLayer("work", "pm", CONF("0.55"));
    store.removePackLayer("default", "pm");
    store.removePackLayer("work", "pm");
    expect([fingerprint("nimbus.toml"), fingerprint("nimbus.work.toml")]).toEqual(before);
  });

  test("refuses off-list keys, naming them, and writes nothing", () => {
    const store = wired();
    const err = refusal(() =>
      store.setPackLayer("default", "pm", "[llm]\nprefer_local = false\n[fleet]\nbogus = 1\n"),
    );
    expect(err.message).toContain("[llm]");
    expect(err.problems.join("\n")).toContain("[fleet] bogus is not pack-settable");
    expect(err.message).toBe(err.problems.join("; "));
    expect(existsSync(join(dir, "packs"))).toBe(false);
  });

  test("refuses conflicting scalars and job names, even when the user's file sets the key", () => {
    writeFileSync(join(dir, "nimbus.toml"), "[fleet]\nretention_days = 30\n");
    const store = wired();
    store.setPackLayer("default", "a", `[fleet]\nretention_days = 7\n${JOB("daily")}`);
    const scalar = refusal(() =>
      store.setPackLayer("default", "b", "[fleet]\nretention_days = 14\n"),
    );
    expect(scalar.problems).toContain("[fleet] retention_days: pack a sets 7");
    const job = refusal(() => store.setPackLayer("default", "b", JOB("daily")));
    expect(job.problems).toContain("[[fleet.job]] daily is also set by pack a");
    expect(existsSync(packFile("b"))).toBe(false);
    expect(readActive()).toEqual({ version: 1, packs: ["a"] });
  });

  test("equal values and self-updates do not conflict", () => {
    const store = wired();
    store.setPackLayer(
      "default",
      "a",
      `[fleet]\nenabled = true\nretention_days = 7\n${CONF("0.7")}`,
    );
    store.setPackLayer("default", "b", `[fleet]\nenabled = true\n${CONF("0.70")}`);
    // A self-update with a changed value: no other pack sets retention_days.
    store.setPackLayer(
      "default",
      "a",
      `[fleet]\nenabled = true\nretention_days = 9\n${CONF("0.7")}`,
    );
    const conflict = refusal(() =>
      store.setPackLayer("default", "c", `[fleet]\nenabled = true\n${CONF("0.9")}`),
    );
    // Every disagreeing pack is named; the agreeing `enabled` is not.
    expect(conflict.problems).toEqual([
      "[decisions] min_confidence: pack a sets 0.7",
      "[decisions] min_confidence: pack b sets 0.7",
    ]);
    expect(readActive()).toEqual({ version: 1, packs: ["a", "b"] });
  });

  test("a tampered pack is not compared against", () => {
    const store = wired();
    store.setPackLayer("default", "a", "[fleet]\nretention_days = 7\n");
    writeFileSync(packFile("a"), "[fleet]\nretention_days = 7\n[llm]\nprefer_local = false\n");
    expect(() =>
      store.setPackLayer("default", "b", "[fleet]\nretention_days = 14\n"),
    ).not.toThrow();
  });

  test("refuses a bad id or profile before any filesystem write", () => {
    const store = wired();
    for (const [profile, id] of [
      ["default", "../x"],
      ["default", "PM"],
      ["../w", "pm"],
    ] as const) {
      const err = refusal(() => store.setPackLayer(profile, id, CONF("0.5")));
      expect(err.problems).toHaveLength(1);
      refusal(() => store.removePackLayer(profile, id));
    }
    expect(existsSync(join(dir, "packs"))).toBe(false);
  });

  test("a pack for another profile is stored but not applied", () => {
    writeFileSync(join(dir, "nimbus.toml"), CONF("0.4"));
    const store = wired();
    const before = getLayeredConfig(dir).snapshot().version;
    const r = store.setPackLayer("work", "pm", CONF("0.55"));
    expect(r.snapshotVersion).toBeNull();
    expect(existsSync(packFile("pm", "work"))).toBe(true);
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.4);
    expect(getLayeredConfig(dir).snapshot().version).toBe(before);
  });

  test("the default onChange matches the running profile exactly", () => {
    const store = wired("default");
    // On Linux `Default` is a different directory the running reader never reads.
    expect(store.setPackLayer("Default", "pm", CONF("0.5")).snapshotVersion).toBeNull();
    expect(typeof store.setPackLayer("default", "pm", CONF("0.5")).snapshotVersion).toBe("number");
  });

  test("with no reader registered, the default onChange returns null", () => {
    const store = createPackLayerStore({ configDir: dir });
    expect(store.setPackLayer("default", "pm", CONF("0.5")).snapshotVersion).toBeNull();
  });

  test("a custom onChange and checkJobs are used", () => {
    const seen: string[] = [];
    const store = createPackLayerStore({
      configDir: dir,
      checkJobs: () => ["no jobs here"],
      onChange: (profile) => {
        seen.push(profile);
        return 42;
      },
    });
    expect(store.setPackLayer("default", "pm", CONF("0.5")).snapshotVersion).toBe(42);
    expect(refusal(() => store.setPackLayer("default", "q", JOB("d"))).problems).toEqual([
      "no jobs here",
    ]);
    expect(store.removePackLayer("default", "pm").snapshotVersion).toBe(42);
    expect(store.removePackLayer("default", "pm").snapshotVersion).toBeNull();
    expect(seen).toEqual(["default", "default"]);
  });
});

describe("removePackLayer", () => {
  test("remove drops the entry, then the file", () => {
    const store = wired();
    store.setPackLayer("default", "pm", CONF("0.55"));
    store.setPackLayer("default", "qa", "[fleet]\nenabled = true\n");
    const r = store.removePackLayer("default", "pm");
    expect(r.removed).toBe(true);
    expect(r.path).toBe(packFile("pm"));
    expect(typeof r.snapshotVersion).toBe("number");
    expect(existsSync(packFile("pm"))).toBe(false);
    expect(readActive()).toEqual({ version: 1, packs: ["qa"] });
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.3);
  });

  test("removing an absent pack returns removed:false and writes nothing", () => {
    const store = wired();
    const r = store.removePackLayer("default", "pm");
    expect(r).toEqual({ path: packFile("pm"), snapshotVersion: null, removed: false });
    expect(existsSync(join(dir, "packs"))).toBe(false);
  });

  test("remove tolerates a missing file", () => {
    const store = wired();
    store.setPackLayer("default", "pm", CONF("0.55"));
    unlinkSync(packFile("pm"));
    expect(store.removePackLayer("default", "pm").removed).toBe(true);
    expect(readActive()).toEqual({ version: 1, packs: [] });
  });

  test("an unlisted leftover file is removed", () => {
    const store = wired();
    mkdirSync(profileDir(), { recursive: true });
    writeFileSync(packFile("pm"), CONF("0.5"));
    expect(store.removePackLayer("default", "pm").removed).toBe(true);
    expect(existsSync(packFile("pm"))).toBe(false);
    expect(existsSync(activeFile())).toBe(false);
  });
});

describe("read", () => {
  test("a missing profile dir or active.json gives no packs and no error", () => {
    const store = createPackLayerStore({ configDir: dir });
    expect(store.read("default")).toEqual({ layers: [], skipped: [] });
    mkdirSync(profileDir(), { recursive: true });
    expect(store.read("default")).toEqual({ layers: [], skipped: [] });
  });

  test("an invalid profile is a list error", () => {
    const store = createPackLayerStore({ configDir: dir });
    const r = store.read("../x");
    expect(r.layers).toEqual([]);
    expect(r.listError).toContain("profile");
  });

  test("a failing fragment's skip reason is its first problem plus a count, capped at 200", () => {
    const store = wired();
    store.setPackLayer("default", "pm", CONF("0.55"));
    const many = "[llm]\nprefer_local = false\n[vault]\nx = 1\n[sync]\ny = 2\n";
    writeFileSync(packFile("pm"), `${CONF("0.55")}${many}`);
    const reason = store.read("default").skipped[0]?.reason ?? "";
    expect(reason.startsWith("refused: ")).toBe(true);
    expect(reason).toMatch(/\(\+\d+ more\)$/);
    expect(reason).not.toContain("; ");
    expect(reason.length).toBeLessThanOrEqual(200);
    // The write side keeps the full list.
    const err = refusal(() => store.setPackLayer("default", "pm2", many));
    expect(err.problems.length).toBeGreaterThanOrEqual(3);

    writeFileSync(packFile("pm"), `${CONF("0.55")}[${"z".repeat(400)}]\nq = 1\n`);
    const long = store.read("default").skipped[0]?.reason ?? "";
    expect(long.length).toBe(200);
    expect(long.endsWith("…")).toBe(true);
  });

  test("a tampered file is skipped whole", () => {
    const store = wired();
    store.setPackLayer("default", "pm", CONF("0.55"));
    writeFileSync(packFile("pm"), `${CONF("0.55")}[llm]\nprefer_local = false\n`);
    const r = store.read("default");
    expect(r.layers).toEqual([]);
    expect(r.skipped).toHaveLength(1);
    expect(r.skipped[0]?.packId).toBe("pm");
    expect(r.skipped[0]?.reason).toContain("[llm] prefer_local");
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.3);
  });

  test("hostile active.json entries never become paths", () => {
    // A sentinel at the path "../../nimbus" would resolve to, as a valid fragment.
    writeFileSync(join(dir, "nimbus.toml"), CONF("0.95"));
    const store = createPackLayerStore({ configDir: dir });
    store.setPackLayer("default", "pm", CONF("0.55"));
    writeActive(JSON.stringify({ version: 1, packs: ["../../nimbus", "PM", "pm", "pm", "ghost"] }));
    const r = store.read("default");
    expect(r.layers.map((l) => [l.id, l.path])).toEqual([["pm", packFile("pm")]]);
    // An entry failing the id rule is reported by its position in `packs`, never verbatim.
    expect(r.skipped.map((s) => s.packId)).toEqual(["#0", "#1", "pm", "ghost"]);
    expect(r.skipped[0]?.reason).toBe("invalid pack id");
    expect(r.skipped[1]?.reason).toBe("invalid pack id");
    expect(r.skipped[2]?.reason).toContain("listed twice");
    expect(r.skipped[3]?.reason).toBe("missing");
    expect(r.layers.some((l) => l.text.includes("0.95"))).toBe(false);
  });

  test("an absolute-path or control-character entry is never echoed anywhere", () => {
    const pathEntry = join(dir, "Users", "alice", "Downloads", "pm.toml");
    const ctrlEntry = "pm\u001b[31mred\u0007";
    const store = createPackLayerStore({ configDir: dir });
    store.setPackLayer("default", "pm", CONF("0.55"));
    writeActive(JSON.stringify({ version: 1, packs: [pathEntry, "pm", ctrlEntry] }));
    const r = store.read("default");
    expect(r.layers.map((l) => l.id)).toEqual(["pm"]);
    expect(r.skipped).toEqual([
      { packId: "#0", reason: "invalid pack id" },
      { packId: "#2", reason: "invalid pack id" },
    ]);
    const strings = [
      ...collectStrings(r.skipped),
      ...packSkipLogLines({ skippedPacks: r.skipped }),
    ];
    for (const v of strings) {
      expect(v).not.toContain(pathEntry);
      expect(v).not.toContain("alice");
      expect(v).not.toContain(ctrlEntry);
      expect([...v].every((ch) => ch >= " " && ch !== "\u007f")).toBe(true);
    }
  });

  test("malformed active.json applies no packs, and writes refuse", () => {
    const store = createPackLayerStore({ configDir: dir });
    store.setPackLayer("default", "pm", CONF("0.55"));
    for (const body of [
      "{not json",
      JSON.stringify({ version: 2, packs: ["pm"] }),
      JSON.stringify({ version: 1, packs: "pm" }),
      JSON.stringify({ version: 1, packs: ["pm", 3] }),
      JSON.stringify(["pm"]),
      "null",
    ]) {
      writeActive(body);
      const r = store.read("default");
      expect(r.layers).toEqual([]);
      expect(r.listError).toBeDefined();
      const setErr = refusal(() => store.setPackLayer("default", "pm", CONF("0.6")));
      expect(setErr.problems).toEqual([r.listError as string]);
      refusal(() => store.removePackLayer("default", "pm"));
      expect(readFileSync(activeFile(), "utf8")).toBe(body);
    }
  });

  test("an unreadable or oversized pack file is skipped", () => {
    const store = createPackLayerStore({ configDir: dir });
    writeActive(JSON.stringify({ version: 1, packs: ["pm", "big"] }));
    mkdirSync(packFile("pm"));
    writeFileSync(packFile("big"), `# ${"x".repeat(PACK_FRAGMENT_MAX_BYTES)}\n`);
    const r = store.read("default");
    expect(r.layers).toEqual([]);
    expect(r.skipped.map((s) => s.packId)).toEqual(["pm", "big"]);
    for (const s of r.skipped) expect(s.reason.length).toBeGreaterThan(0);
    expect(r.skipped[1]?.reason).toContain(String(PACK_FRAGMENT_MAX_BYTES));
  });

  test("reasons carry no absolute path", () => {
    const store = createPackLayerStore({ configDir: dir });
    writeActive(JSON.stringify({ version: 1, packs: ["pm", "bad", "ghost"] }));
    mkdirSync(packFile("pm"));
    writeFileSync(packFile("bad"), `[fleet]\nenabled = "${dir}"\n`);
    const r = store.read("default");
    expect(r.skipped).toHaveLength(3);
    for (const s of r.skipped) expect(s.reason).not.toContain(dir);
    // A directory at active.json (EISDIR).
    rmSync(activeFile());
    mkdirSync(activeFile());
    const listed = store.read("default");
    expect(listed.listError).toBeDefined();
    expect(listed.listError).not.toContain(dir);
  });
});

describe("PackLayerRefusedError", () => {
  test("every refusal is a PackLayerRefusedError", () => {
    const store = createPackLayerStore({ configDir: dir });
    store.setPackLayer("default", "a", "[fleet]\nretention_days = 7\n");
    const cases: (() => unknown)[] = [
      () => store.setPackLayer("default", "Bad", CONF("0.5")),
      () => store.setPackLayer("Bad/", "a", CONF("0.5")),
      () => store.setPackLayer("default", "b", "[llm]\nprefer_local = true\n"),
      () => store.setPackLayer("default", "b", "[fleet]\nretention_days = 9\n"),
    ];
    for (const c of cases) {
      const err = refusal(c);
      expect(err.name).toBe("PackLayerRefusedError");
      expect(err.problems.length).toBeGreaterThan(0);
    }
    writeActive("{");
    refusal(() => store.setPackLayer("default", "b", CONF("0.5")));
  });
});

describe("packSkipLogLines", () => {
  test("one line per skipped pack plus one for a list error", () => {
    expect(packSkipLogLines({ skippedPacks: [] })).toEqual([]);
    expect(
      packSkipLogLines({
        skippedPacks: [
          { packId: "pm", reason: "missing" },
          { packId: "x", reason: "invalid pack id" },
        ],
        packListError: "active.json is not valid JSON",
      }),
    ).toEqual([
      'config: pack "pm" skipped: missing',
      'config: pack "x" skipped: invalid pack id',
      "config: packs not applied: active.json is not valid JSON",
    ]);
  });
});
