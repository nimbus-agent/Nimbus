import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InvalidProfileNameError, resolveActiveProfile } from "./active-profile.ts";
import {
  basenameSafeMessage,
  getLayeredConfig,
  initLayeredConfig,
  LayeredConfig,
  layeredHasUserLayer,
  layerReadError,
  type PackLayerSource,
  type PackLayersRead,
  peekLayeredConfig,
  resetLayeredConfigsForTests,
} from "./layered-config.ts";
import {
  loadNimbusDecisionsFromConfigDir,
  loadNimbusLanFromConfigDir,
  loadNimbusLanFromPath,
} from "./nimbus-toml.ts";
import { loadGlossaryManualFromConfigDir } from "./nimbus-toml-glossary-terms.ts";

describe("LayeredConfig", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-layered-"));
  });
  afterEach(() => {
    resetLayeredConfigsForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
  const work = () =>
    new LayeredConfig({ configDir: dir, profile: { name: "work", source: "argument" } });
  const dflt = () =>
    new LayeredConfig({ configDir: dir, profile: { name: "default", source: "default" } });

  test("profile inherits base", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.3\n[chatops]\nenabled = true\n");
    write("nimbus.work.toml", "[decisions]\nmin_confidence = 0.6\n");
    const text = work().snapshot().text ?? "";
    expect(text).toContain("0.6");
    expect(text).toContain("[chatops]");
  });

  test("profile without a file reads base and targets the profile file", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.3\n");
    const base = dflt().snapshot().text;
    const cfg = work();
    expect(cfg.snapshot().text).toBe(base);
    expect(cfg.writeTargetPath()).toBe(join(dir, "nimbus.work.toml"));
    expect(dflt().writeTargetPath()).toBe(join(dir, "nimbus.toml"));
  });

  test("no files gives null text", () => {
    expect(dflt().snapshot().text).toBeNull();
  });

  test("same-size rewrite is seen without a restart", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.5\n");
    const cfg = dflt();
    const a = cfg.snapshot();
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.8\n");
    const b = cfg.snapshot();
    expect(b.text).toContain("0.8");
    expect(b.version).toBe(a.version + 1);
  });

  test("unchanged files keep the version", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.5\n");
    const cfg = dflt();
    const a = cfg.snapshot();
    const b = cfg.snapshot();
    expect(b.version).toBe(a.version);
    expect(b).toBe(a);
  });

  test("a file appearing or disappearing bumps the version", () => {
    const cfg = dflt();
    const a = cfg.snapshot();
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.5\n");
    const b = cfg.snapshot();
    expect(b.version).toBe(a.version + 1);
    rmSync(join(dir, "nimbus.toml"));
    const c = cfg.snapshot();
    expect(c.version).toBe(b.version + 1);
    expect(c.text).toBeNull();
  });

  test("pinned profile ignores a later marker change", () => {
    write(".nimbus-profile", "work");
    const cfg = initLayeredConfig(dir, {});
    expect(cfg.profile.name).toBe("work");
    write(".nimbus-profile", "home");
    expect(cfg.profile.name).toBe("work");
    expect(cfg.markerProfile()).toBe("home");
    expect(getLayeredConfig(dir)).toBe(cfg);
  });

  test("init twice with a different profile throws", () => {
    initLayeredConfig(dir, { explicitProfile: "work" });
    expect(() => initLayeredConfig(dir, { explicitProfile: "home" })).toThrow();
    const same = initLayeredConfig(dir, { explicitProfile: "work" });
    expect(same.profile.name).toBe(resolveActiveProfile({ configDir: dir, explicit: "work" }).name);
  });

  test("an unreadable layer carries readError and is absent from the merge", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.3\n");
    mkdirSync(join(dir, "nimbus.work.toml"));
    const snap = work().snapshot();
    const profileLayer = snap.layers.find((l) => l.layer.kind === "profile");
    expect(profileLayer?.exists).toBe(false);
    expect(profileLayer?.readError).toEqual(expect.any(String));
    expect(snap.layers.find((l) => l.layer.kind === "base")?.readError).toBeUndefined();
    expect(snap.text).toContain("0.3");
  });

  test("a missing layer has no readError", () => {
    const snap = work().snapshot();
    expect(snap.layers.every((l) => l.readError === undefined)).toBe(true);
  });

  test("layerReadError names the unreadable file; undefined when every layer reads", () => {
    write(".nimbus-profile", "work");
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.3\n");
    expect(layerReadError(dir)).toBeUndefined();
    resetLayeredConfigsForTests();
    mkdirSync(join(dir, "nimbus.work.toml"));
    expect(layerReadError(dir)).toContain(`could not read ${join(dir, "nimbus.work.toml")}`);
  });

  test("markerProfile tolerates an unreadable marker", () => {
    const cfg = work();
    mkdirSync(join(dir, ".nimbus-profile"));
    expect(cfg.markerProfile()).toBe("default");
  });

  test("section fallback is cleared on change", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.5\n");
    const cfg = dflt();
    cfg.snapshot();
    cfg.recordSectionFallback("decisions", "bad");
    expect(cfg.sectionFallback("decisions")).toBe("bad");
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.9\n");
    cfg.snapshot();
    expect(cfg.sectionFallback("decisions")).toBeUndefined();
  });
});

describe("initLayeredConfig with an invalid profile", () => {
  test("throws InvalidProfileNameError naming the value and the source", () => {
    const dir = mkdtempSync(join(tmpdir(), "nimbus-layered-bad-"));
    try {
      let caught: unknown;
      try {
        initLayeredConfig(dir, { explicitProfile: "bad name!" });
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(InvalidProfileNameError);
      const err = caught as InvalidProfileNameError;
      expect(err.message).toContain("bad name!");
      expect(err.message).toContain("argument");
      expect(err.value).toBe("bad name!");
      expect(err.source).toBe("argument");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pack layers", () => {
  let dir: string;
  beforeEach(() => {
    resetLayeredConfigsForTests();
    dir = mkdtempSync(join(tmpdir(), "nimbus-layered-packs-"));
  });
  afterEach(() => {
    resetLayeredConfigsForTests();
    rmSync(dir, { recursive: true, force: true });
  });

  const write = (name: string, body: string) => writeFileSync(join(dir, name), body);
  const packPath = (id: string) => join(dir, "packs", "default", `${id}.toml`);

  /** A source whose result the test can swap between reads. */
  function fakeSource(initial: PackLayersRead): {
    source: PackLayerSource;
    set(r: PackLayersRead): void;
  } {
    let current = initial;
    return {
      source: { read: () => current },
      set: (r) => {
        current = r;
      },
    };
  }
  const oneLayer = (id: string, text: string): PackLayersRead => ({
    layers: [{ id, path: packPath(id), text }],
    skipped: [],
  });

  test("a pack layer sits below base and profile", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.6\n");
    write("nimbus.work.toml", "[decisions]\nmin_confidence = 0.7\n");
    const { source } = fakeSource(oneLayer("p1", "[decisions]\nmin_confidence = 0.5\n"));
    const cfg = new LayeredConfig({
      configDir: dir,
      profile: { name: "work", source: "argument" },
      packs: source,
    });
    const snap = cfg.snapshot();
    const entry = snap.doc.sections
      .find((s) => s.header === "decisions")
      ?.entries.find((e) => e.key === "min_confidence");
    expect(entry?.valRaw).toBe("0.7");
    expect(entry?.layer.kind).toBe("profile");
    // `shadowed` is in layer order, low to high: the pack's value, then base's.
    expect(entry?.shadowed.map((s) => [s.layer.kind, s.valRaw])).toEqual([
      ["pack", "0.5"],
      ["base", "0.6"],
    ]);
    expect(snap.activePacks).toEqual(["p1"]);
    expect(snap.hasUserLayer).toBe(true);
    expect(snap.layers.map((l) => l.layer.kind)).toEqual(["pack", "base", "profile"]);
    expect(snap.layers[0]?.exists).toBe(true);
  });

  test("pack-only config renders and glossary stays unloaded", () => {
    const { source } = fakeSource(oneLayer("p1", "[decisions]\nmin_confidence = 0.5\n"));
    initLayeredConfig(dir, { packs: source });
    const snap = getLayeredConfig(dir).snapshot();
    expect(snap.text).not.toBeNull();
    expect(snap.hasUserLayer).toBe(false);
    expect(layeredHasUserLayer(dir)).toBe(false);
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.5);
    expect(loadGlossaryManualFromConfigDir(dir)).toEqual({ loaded: false });
  });

  test("no layer at all still gives null text", () => {
    const { source } = fakeSource({ layers: [], skipped: [] });
    initLayeredConfig(dir, { packs: source });
    expect(getLayeredConfig(dir).snapshot().text).toBeNull();
    expect(layeredHasUserLayer(dir)).toBe(false);
  });

  test("a base file counts as a user layer", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.6\n");
    expect(layeredHasUserLayer(dir)).toBe(true);
  });

  test("NIMBUS_LAN_PORT applies with no config file", () => {
    const prev = process.env["NIMBUS_LAN_PORT"];
    process.env["NIMBUS_LAN_PORT"] = "12399";
    try {
      expect(loadNimbusLanFromConfigDir(dir).port).toBe(12399);
      expect(loadNimbusLanFromPath(join(dir, "nimbus.toml")).port).toBe(12399);
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_LAN_PORT"];
      else process.env["NIMBUS_LAN_PORT"] = prev;
    }
  });

  test("init after an implicit reader refuses a pack source", () => {
    getLayeredConfig(dir);
    const { source } = fakeSource({ layers: [], skipped: [] });
    expect(() => initLayeredConfig(dir, { packs: source })).toThrow();
  });

  test("init with the same pack source, or none, returns the existing reader", () => {
    const { source } = fakeSource({ layers: [], skipped: [] });
    const cfg = initLayeredConfig(dir, { packs: source });
    expect(initLayeredConfig(dir, { packs: source })).toBe(cfg);
    expect(initLayeredConfig(dir)).toBe(cfg);
    const other = fakeSource({ layers: [], skipped: [] }).source;
    expect(() => initLayeredConfig(dir, { packs: other })).toThrow();
  });

  test("skips and list errors are carried on the snapshot", () => {
    const { source } = fakeSource({
      layers: [{ id: "good", path: packPath("good"), text: "[decisions]\nmin_confidence = 0.5\n" }],
      skipped: [{ packId: "bad", reason: "r" }],
      listError: "e",
    });
    initLayeredConfig(dir, { packs: source });
    const snap = getLayeredConfig(dir).snapshot();
    expect(snap.activePacks).toEqual(["good"]);
    expect(snap.skippedPacks).toEqual([{ packId: "bad", reason: "r" }]);
    expect(snap.packListError).toBe("e");
  });

  test("no list error leaves packListError absent", () => {
    const { source } = fakeSource({ layers: [], skipped: [] });
    initLayeredConfig(dir, { packs: source });
    const snap = getLayeredConfig(dir).snapshot();
    expect("packListError" in snap).toBe(false);
    expect(snap.activePacks).toEqual([]);
    expect(snap.skippedPacks).toEqual([]);
  });

  test("a pack text change rebuilds; an identical read reuses the snapshot", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.6\n");
    const fake = fakeSource(oneLayer("p1", "[fleet]\nenabled = true\n"));
    const cfg = initLayeredConfig(dir, { packs: fake.source });
    const a = cfg.snapshot();
    // A fresh but identical read result reuses the cached snapshot.
    fake.set(oneLayer("p1", "[fleet]\nenabled = true\n"));
    const b = cfg.snapshot();
    expect(b).toBe(a);
    fake.set(oneLayer("p1", "[fleet]\nenabled = false\n"));
    const c = cfg.snapshot();
    expect(c.version).toBe(b.version + 1);
    expect(c.text).toContain("enabled = false");
    const skippedX = [{ packId: "x", reason: "r" }];
    fake.set({ ...oneLayer("p1", "[fleet]\nenabled = false\n"), skipped: skippedX });
    const d = cfg.snapshot();
    expect(d.version).toBe(c.version + 1);
    fake.set({
      ...oneLayer("p1", "[fleet]\nenabled = false\n"),
      skipped: skippedX,
      listError: "e",
    });
    const e = cfg.snapshot();
    expect(e.version).toBe(d.version + 1);
    fake.set(oneLayer("p2", "[fleet]\nenabled = false\n"));
    const f = cfg.snapshot();
    expect(f.version).toBe(e.version + 1);
    expect(f.activePacks).toEqual(["p2"]);
  });

  test("the source is read once per snapshot, with the pinned profile name", () => {
    const seen: string[] = [];
    initLayeredConfig(dir, {
      explicitProfile: "work",
      packs: {
        read: (profile) => {
          seen.push(profile);
          return { layers: [], skipped: [] };
        },
      },
    });
    getLayeredConfig(dir).snapshot();
    expect(seen).toEqual(["work"]);
  });

  test("a throwing source becomes a list error with no packs applied", () => {
    write("nimbus.toml", "[decisions]\nmin_confidence = 0.6\n");
    const secret = join(dir, "packs", "default", "active.json");
    let fail = true;
    const skipped = [{ packId: "x", reason: "r" }];
    initLayeredConfig(dir, {
      packs: {
        read: () => {
          if (fail) throw new Error(`boom at ${secret}`);
          return { layers: [], skipped };
        },
      },
    });
    const snap = getLayeredConfig(dir).snapshot();
    expect(snap.activePacks).toEqual([]);
    expect(snap.skippedPacks).toEqual([]);
    expect(snap.packListError).toBe("pack source failed: boom at active.json");
    expect(loadNimbusDecisionsFromConfigDir(dir).minConfidence).toBe(0.6);
    fail = false;
    const next = getLayeredConfig(dir).snapshot();
    expect(next.skippedPacks).toEqual([{ packId: "x", reason: "r" }]);
    // The cached copy does not follow a source that mutates its own array.
    skipped.push({ packId: "y", reason: "r" });
    const after = getLayeredConfig(dir).snapshot();
    expect(after.version).toBe(next.version + 1);
    expect(next.skippedPacks).toHaveLength(1);
  });

  test("peekLayeredConfig returns undefined before init and the reader after it", () => {
    expect(peekLayeredConfig(dir)).toBeUndefined();
    const cfg = initLayeredConfig(dir);
    expect(peekLayeredConfig(dir)).toBe(cfg);
  });
});

describe("basenameSafeMessage", () => {
  const root = join(tmpdir(), "nimbus-root-x");
  test("replaces paths under the root with their basename", () => {
    expect(basenameSafeMessage(`EISDIR, open '${join(root, "packs", "a.toml")}'`, root)).toBe(
      "EISDIR, open 'a.toml'",
    );
    expect(basenameSafeMessage(`at ${root}`, root)).toBe("at nimbus-root-x");
    expect(basenameSafeMessage("no path here", root)).toBe("no path here");
  });
  test("matches either separator", () => {
    const fwd = `${root}/packs/b.toml`.split("\\").join("/");
    expect(basenameSafeMessage(`x ${fwd} y`, root)).toBe("x b.toml y");
  });
});
