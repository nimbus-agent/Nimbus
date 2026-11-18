import { describe, expect, test } from "bun:test";
import { parseNimbusTomlIacDrift } from "./iac-drift-toml.ts";

function parse(src: string): { cfg: ReturnType<typeof parseNimbusTomlIacDrift>; notes: string[] } {
  const notes: string[] = [];
  return { cfg: parseNimbusTomlIacDrift(src, (m) => notes.push(m)), notes };
}

describe("[iac.drift] (OR-DRIFT-2: off by default)", () => {
  test("absent section: no schedule, notify on, a valid zone", () => {
    const { cfg, notes } = parse('[other]\nschedule = "0 6 * * *"\n');
    expect(cfg.schedule).toBeUndefined();
    expect(cfg.notify).toBe(true);
    expect(typeof cfg.tz).toBe("string");
    expect(notes).toEqual([]);
  });

  test("a valid schedule, zone and notify are read", () => {
    const { cfg, notes } = parse(
      '[iac.drift]\nschedule = "0 6 * * 1-5"\ntz = "Europe/Berlin"\nnotify = false\n',
    );
    expect(cfg).toEqual({ schedule: "0 6 * * 1-5", tz: "Europe/Berlin", notify: false });
    expect(notes).toEqual([]);
  });

  test("a schedule under five minutes turns the schedule off and is reported", () => {
    const { cfg, notes } = parse('[iac.drift]\nschedule = "* * * * *"\n');
    expect(cfg.schedule).toBeUndefined();
    expect(notes.join(" ")).toContain("the scheduled drift check is off");
  });

  test("a malformed schedule, zone or notify falls back and is reported", () => {
    const { cfg, notes } = parse(
      '[iac.drift]\nschedule = "nope"\ntz = "Mars/Base"\nnotify = maybe\n',
    );
    expect(cfg.schedule).toBeUndefined();
    expect(cfg.notify).toBe(true);
    expect(cfg.tz).not.toBe("Mars/Base");
    expect(notes).toHaveLength(3);
  });

  test("an unknown key and a line that is not a key are ignored", () => {
    const { cfg, notes } = parse("[iac.drift]\nfoo = 1\nnot a key\n");
    expect(cfg.schedule).toBeUndefined();
    expect(notes).toEqual([]);
  });

  test("parsing without a fallback sink does not throw", () => {
    expect(parseNimbusTomlIacDrift('[iac.drift]\ntz = "Mars/Base"\n').schedule).toBeUndefined();
  });
});
