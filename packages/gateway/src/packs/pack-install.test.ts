import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseRolePackManifestValue, type RolePackManifest } from "@nimbus-dev/registry-format";
import { CATALOG_AGENT_NAMES } from "../catalog/agent-catalog.ts";
import { builtinCatalogConnectorIds } from "../catalog/catalog-list.ts";
import { explainConfig } from "../config/config-explain.ts";
import {
  getLayeredConfig,
  initLayeredConfig,
  resetLayeredConfigsForTests,
} from "../config/layered-config.ts";
import { BUNDLED_PACKS } from "./bundled-packs.ts";
import {
  installPack,
  listPacks,
  type PackDeps,
  PackError,
  type PackOwnerGate,
  packVisibleAgents,
  previewPack,
  removePack,
} from "./pack-install.ts";
import {
  createPackLayerStore,
  PackLayerRefusedError,
  type PackLayerStore,
} from "./pack-layer-store.ts";

let dir: string;
let store: PackLayerStore;

beforeEach(() => {
  resetLayeredConfigsForTests();
  dir = mkdtempSync(join(tmpdir(), "nimbus-pack-install-"));
  store = createPackLayerStore({ configDir: dir });
  initLayeredConfig(dir, { packs: store });
});
afterEach(() => {
  resetLayeredConfigsForTests();
  rmSync(dir, { recursive: true, force: true });
});

function deps(over: Partial<PackDeps> = {}): PackDeps {
  return {
    store,
    configDir: dir,
    bundled: BUNDLED_PACKS,
    isProduction: () => false,
    isConfigured: async (id) => id === "slack",
    connectorIds: new Set(builtinCatalogConnectorIds()),
    agentNames: new Set(CATALOG_AGENT_NAMES),
    now: () => new Date("2026-10-24T00:00:00.000Z"),
    ...over,
  };
}

type GateCall = Parameters<PackOwnerGate>[0];

function gate(answer = true): { gate: PackOwnerGate; calls: GateCall[] } {
  const calls: GateCall[] = [];
  return {
    calls,
    gate: async (action) => {
      calls.push(action);
      return answer;
    },
  };
}

const profile = (): string => getLayeredConfig(dir).profile.name;
const packDir = (): string => join(dir, "packs", profile());
const layerFile = (id: string): string => join(packDir(), `${id}.toml`);
const recordFile = (id: string): string => join(packDir(), `${id}.pack.json`);
const activeFile = (): string => join(packDir(), "active.json");

function fileText(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schema: 1,
    id: "mine",
    name: "Mine",
    version: "1.0.0",
    description: "A local pack.",
    roles: [],
    suggestedConnectors: [],
    members: [],
    defaults: "[decisions]\nmin_confidence = 0.5\n",
    ...over,
  });
}

const FILE_PATH = join(tmpdir(), "mine.json");
const RLO = String.fromCodePoint(0x202e);

async function refusal(p: Promise<unknown>): Promise<PackError> {
  try {
    await p;
  } catch (err) {
    if (err instanceof PackError) return err;
    throw err;
  }
  throw new Error("expected a PackError");
}

function pmWith(over: Partial<RolePackManifest>): RolePackManifest {
  const pm = BUNDLED_PACKS.get("pm");
  if (pm === undefined) throw new Error("pm missing");
  return parseRolePackManifestValue({ ...pm, ...over });
}

describe("installPack: the fixed refusal order", () => {
  const cases: {
    name: string;
    code: string;
    run: (gate: PackOwnerGate) => Promise<unknown>;
    detail?: RegExp;
  }[] = [
    {
      name: "1 unknown bundled id",
      code: "ERR_PACK_NOT_FOUND",
      run: (g) => installPack({ id: "nope" }, deps(), g),
    },
    {
      name: "2 a file in production",
      code: "ERR_PACK_LOCAL_FILE_PRODUCTION",
      // Also an unparseable file: production is refused before the parse.
      run: (g) =>
        installPack(
          { fileText: "{not json", filePath: FILE_PATH },
          deps({ isProduction: () => true }),
          g,
        ),
    },
    {
      name: "3 a file that does not parse",
      code: "ERR_PACK_INVALID",
      run: (g) => installPack({ fileText: "{not json", filePath: FILE_PATH }, deps(), g),
    },
    {
      name: "4 a file using a bundled id",
      code: "ERR_PACK_ID_RESERVED",
      run: (g) =>
        installPack(
          { fileText: fileText({ id: "pm", members: ["com.example.pack"] }), filePath: FILE_PATH },
          deps(),
          g,
        ),
    },
    {
      name: "5 non-empty members",
      code: "ERR_PACK_MEMBERS_UNSUPPORTED",
      run: (g) =>
        installPack(
          {
            fileText: fileText({ members: ["com.example.pack"], suggestedConnectors: ["nope_x"] }),
            filePath: FILE_PATH,
          },
          deps(),
          g,
        ),
    },
    {
      name: "6 an unknown connector",
      code: "ERR_PACK_INVALID",
      detail: /suggested connector "nope_x" is not known/,
      run: (g) =>
        installPack(
          { fileText: fileText({ suggestedConnectors: ["nope_x"] }), filePath: FILE_PATH },
          deps(),
          g,
        ),
    },
    {
      name: "6 an unknown agent",
      code: "ERR_PACK_INVALID",
      detail: /unknown agent "owners"/,
      run: (g) =>
        installPack(
          {
            fileText: fileText({ defaults: '[agents]\nvisible = ["owners"]\n' }),
            filePath: FILE_PATH,
          },
          deps(),
          g,
        ),
    },
    {
      name: "6 a non-allowlisted key",
      code: "ERR_PACK_INVALID",
      detail: /not pack-settable/,
      run: (g) =>
        installPack(
          { fileText: fileText({ defaults: "[llm]\nprefer_local = true\n" }), filePath: FILE_PATH },
          deps(),
          g,
        ),
    },
  ];
  for (const c of cases) {
    test(`${c.name} → ${c.code}, no gate call, nothing written`, async () => {
      const g = gate();
      const err = await refusal(c.run(g.gate));
      expect(err.code).toBe(c.code as PackError["code"]);
      expect(err.message.startsWith(`${c.code}: `)).toBe(true);
      if (c.detail !== undefined) expect(err.detail).toMatch(c.detail);
      expect(g.calls).toHaveLength(0);
      expect(existsSync(join(dir, "packs"))).toBe(false);
    });
  }

  test("7 an unreadable active.json → ERR_PACK_STORE_UNREADABLE naming the store's error", async () => {
    mkdirSync(packDir(), { recursive: true });
    writeFileSync(activeFile(), "{not json");
    const g = gate();
    const err = await refusal(installPack({ id: "pm" }, deps(), g.gate));
    expect(err.code).toBe("ERR_PACK_STORE_UNREADABLE");
    expect(err.detail).toContain("active.json is not valid JSON");
    expect(g.calls).toHaveLength(0);
    expect(existsSync(layerFile("pm"))).toBe(false);
  });

  test("8 a scalar conflict with another pack → ERR_PACK_CONFLICT naming the key", async () => {
    await installPack(
      { fileText: fileText({ defaults: "[fleet]\nenabled = false\n" }), filePath: FILE_PATH },
      deps(),
      gate().gate,
    );
    const g = gate();
    const err = await refusal(installPack({ id: "pm" }, deps(), g.gate));
    expect(err.code).toBe("ERR_PACK_CONFLICT");
    expect(err.detail).toContain("[fleet] enabled: pack mine sets false");
    expect(g.calls).toHaveLength(0);
    expect(existsSync(layerFile("pm"))).toBe(false);
  });
});

describe("installPack: approval", () => {
  test("approved → installed: layer and record written, snapshot advances, explain names the pack", async () => {
    const before = getLayeredConfig(dir).snapshot().version;
    const g = gate();
    const r = await installPack({ id: "pm" }, deps(), g.gate);
    expect(r).toMatchObject({ outcome: "installed", id: "pm", version: "1.0.0" });
    expect(r.snapshotVersion).toBeGreaterThan(before);
    expect(readFileSync(layerFile("pm"), "utf8")).toBe(BUNDLED_PACKS.get("pm")?.defaults ?? "");
    expect(JSON.parse(readFileSync(recordFile("pm"), "utf8"))).toMatchObject({
      digest: g.calls[0]?.payload["digest"],
      source: { kind: "bundled" },
      installedAt: "2026-10-24T00:00:00.000Z",
    });
    const entry = explainConfig(getLayeredConfig(dir), "fleet.enabled").entries[0];
    expect(entry?.source).toMatchObject({ kind: "layer", layer: { kind: "pack", id: "pm" } });
  });

  test("denied → ERR_PACK_INSTALL_NOT_APPROVED and nothing written", async () => {
    const g = gate(false);
    const err = await refusal(installPack({ id: "pm" }, deps(), g.gate));
    expect(err.code).toBe("ERR_PACK_INSTALL_NOT_APPROVED");
    expect(g.calls).toHaveLength(1);
    expect(existsSync(join(dir, "packs"))).toBe(false);
  });

  test("the gate payload is { packId, version, source, digest, promptText } with the full defaults", async () => {
    const g = gate();
    await installPack({ id: "pm" }, deps(), g.gate);
    const call = g.calls[0];
    expect(call?.type).toBe("pack.install");
    expect(Object.keys(call?.payload ?? {}).sort()).toEqual(
      ["digest", "packId", "promptText", "source", "version"].sort(),
    );
    expect(call?.payload).toMatchObject({ packId: "pm", version: "1.0.0", source: "bundled" });
    expect(call?.payload["digest"]).toMatch(/^[0-9a-f]{64}$/);
    const prompt = String(call?.payload["promptText"]);
    expect(prompt).toContain(BUNDLED_PACKS.get("pm")?.defaults ?? "missing");
    expect(prompt).toContain("Install role pack Product (pm)");
    expect(prompt).toContain("slack: configured");
    expect(prompt).toContain("jira: not configured");
    expect(prompt).toContain("pm-decisions-nightly: decisions every 86400s");
    expect(prompt).toContain("fleet.enabled = true, unset");
  });

  test("the devops prompt shows oncall.push.enabled as unset when no layer sets it", async () => {
    expect(explainConfig(getLayeredConfig(dir), "oncall.push.enabled").entries).toEqual([]);
    const g = gate();
    await installPack({ id: "devops" }, deps(), g.gate);
    const prompt = String(g.calls[0]?.payload["promptText"]);
    expect(prompt).toContain("oncall.push.enabled = true, unset");
    expect(g.calls[0]?.payload).toMatchObject({ packId: "devops", version: "1.1.0" });
  });

  test("the owner's [oncall.push] enabled = false is read through the two-segment header and marked", async () => {
    writeFileSync(join(dir, "nimbus.toml"), "[oncall.push]\nenabled = false\n");
    const g = gate();
    await installPack({ id: "devops" }, deps(), g.gate);
    const prompt = String(g.calls[0]?.payload["promptText"]);
    expect(prompt).toContain(
      "oncall.push.enabled = true, current false (nimbus.toml) (your file overrides this)",
    );
    const entry = explainConfig(getLayeredConfig(dir), "oncall.push.enabled").entries[0];
    expect(entry?.value).toBe("false");
    expect(entry?.source).toMatchObject({ kind: "layer", layer: { kind: "base" } });
  });

  test("a local file pack's source is shown as `local file <absolute path>`", async () => {
    const g = gate();
    const r = await installPack({ fileText: fileText(), filePath: FILE_PATH }, deps(), g.gate);
    expect(r.outcome).toBe("installed");
    expect(g.calls[0]?.payload["source"]).toBe(`local file ${FILE_PATH}`);
    expect(JSON.parse(readFileSync(recordFile("mine"), "utf8")).source).toEqual({
      kind: "file",
      path: FILE_PATH,
    });
  });

  test("the owner's own file setting a key is marked, the install succeeds, the value is unchanged", async () => {
    writeFileSync(
      join(dir, "nimbus.toml"),
      '[fleet]\nenabled = false\n\n[[fleet.job]]\nname = "pm-decisions-nightly"\nagent = "standup"\ninterval_seconds = 3600\n',
    );
    const g = gate();
    await installPack({ id: "pm" }, deps(), g.gate);
    const prompt = String(g.calls[0]?.payload["promptText"]);
    expect(prompt).toContain(
      "fleet.enabled = true, current false (nimbus.toml) (your file overrides this)",
    );
    expect(prompt).toContain("(replaced by your own job of this name)");
    expect(prompt).toContain("[fleet] enabled: false");
    const entry = explainConfig(getLayeredConfig(dir), "fleet.enabled").entries[0];
    expect(entry?.value).toBe("false");
    expect(entry?.source).toMatchObject({ kind: "layer", layer: { kind: "base" } });
  });

  test("the gate payload's source escapes invisible characters, LF and TAB in the file path", async () => {
    const g = gate();
    const filePath = join(tmpdir(), `a${RLO}\nb\tc.json`);
    await installPack({ fileText: fileText({}), filePath }, deps(), g.gate);
    const source = String(g.calls[0]?.payload["source"]);
    expect(source).toBe(`local file ${join(tmpdir(), String.raw`a\u202E\nb\tc.json`)}`);
    expect(source).not.toContain(RLO);
    expect(source).not.toContain("\n");
    expect(source).not.toContain("\t");
  });

  test("invisible characters in a local pack are escaped in the prompt, never raw", async () => {
    const g = gate();
    await installPack(
      { fileText: fileText({ description: `evil${RLO}txt` }), filePath: FILE_PATH },
      deps(),
      g.gate,
    );
    const prompt = String(g.calls[0]?.payload["promptText"]);
    expect(prompt).toContain("evil\\u202Etxt");
    expect(prompt).not.toContain(RLO);
  });

  test("a store refusal at write time (a race after the prompt) maps by reason", async () => {
    const racing: PackLayerStore = {
      ...store,
      setPackLayer: () => {
        throw new PackLayerRefusedError(["[fleet] enabled: pack x sets false"], "conflict");
      },
    };
    const err = await refusal(installPack({ id: "pm" }, deps({ store: racing }), gate().gate));
    expect(err.code).toBe("ERR_PACK_CONFLICT");
  });

  test("a non-refusal write error propagates unchanged", async () => {
    const broken: PackLayerStore = {
      ...store,
      setPackLayer: () => {
        throw new Error("disk full");
      },
    };
    await expect(installPack({ id: "pm" }, deps({ store: broken }), gate().gate)).rejects.toThrow(
      "disk full",
    );
  });
});

describe("installPack: re-installs", () => {
  test("identical digest with an intact layer → already_installed, no gate call", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    const g = gate();
    const r = await installPack({ id: "pm" }, deps(), g.gate);
    expect(r).toEqual({
      outcome: "already_installed",
      id: "pm",
      version: "1.0.0",
      snapshotVersion: null,
    });
    expect(g.calls).toHaveLength(0);
  });

  test("identical digest with the layer deleted → repair, one gate call, rewritten", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    unlinkSync(layerFile("pm"));
    const g = gate();
    const r = await installPack({ id: "pm" }, deps(), g.gate);
    expect(r.outcome).toBe("repaired");
    expect(g.calls).toHaveLength(1);
    expect(String(g.calls[0]?.payload["promptText"])).toContain("Repair role pack");
    expect(readFileSync(layerFile("pm"), "utf8")).toBe(BUNDLED_PACKS.get("pm")?.defaults ?? "");
  });

  test("identical digest with the layer hand-edited → repair", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    writeFileSync(layerFile("pm"), "[fleet]\nenabled = false\n");
    const g = gate();
    expect((await installPack({ id: "pm" }, deps(), g.gate)).outcome).toBe("repaired");
    expect(g.calls).toHaveLength(1);
    // The winning value is this pack's own previous layer: shown, never marked as an override.
    const prompt = String(g.calls[0]?.payload["promptText"]);
    expect(prompt).toContain("fleet.enabled = true, current false (pack pm)\n");
  });

  test("a profile overlay setting a key is named and marked as the owner's override", async () => {
    resetLayeredConfigsForTests();
    store = createPackLayerStore({ configDir: dir });
    initLayeredConfig(dir, { explicitProfile: "work", packs: store });
    writeFileSync(join(dir, "nimbus.work.toml"), "[fleet]\nenabled = false\n");
    const g = gate();
    expect((await installPack({ id: "pm" }, deps(), g.gate)).outcome).toBe("installed");
    expect(String(g.calls[0]?.payload["promptText"])).toContain(
      "fleet.enabled = true, current false (profile work) (your file overrides this)",
    );
    expect(existsSync(join(dir, "packs", "work", "pm.toml"))).toBe(true);
    expect(listPacks(deps()).profile).toBe("work");
  });

  test("identical digest but unlisted (a crash before the list write) → repair, then listed", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    writeFileSync(activeFile(), '{"version":1,"packs":[]}\n');
    const g = gate();
    expect((await installPack({ id: "pm" }, deps(), g.gate)).outcome).toBe("repaired");
    expect(JSON.parse(readFileSync(activeFile(), "utf8")).packs).toEqual(["pm"]);
  });

  test("a changed bundled manifest → updated, the prompt shows the diff", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    const pm = BUNDLED_PACKS.get("pm");
    const next = pmWith({
      version: "1.1.0",
      defaults: `${pm?.defaults ?? ""}\n[decisions]\nmin_confidence = 0.7\n`,
      suggestedConnectors: ["slack", "jira", "notion"],
    });
    const g = gate();
    const r = await installPack({ id: "pm" }, deps({ bundled: new Map([["pm", next]]) }), g.gate);
    expect(r).toMatchObject({ outcome: "updated", version: "1.1.0" });
    const prompt = String(g.calls[0]?.payload["promptText"]);
    expect(prompt).toContain("Update role pack Product (pm) version 1.1.0");
    expect(prompt).toContain("decisions.min_confidence = 0.7");
    expect(prompt).toContain("removed: google_drive");
    expect(JSON.parse(readFileSync(recordFile("pm"), "utf8")).manifest.version).toBe("1.1.0");
  });

  test("an update over a hand-edited layer file warns that the edits are replaced", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    writeFileSync(layerFile("pm"), "[decisions]\nmin_confidence = 0.9\n");
    const next = pmWith({ version: "1.1.0", description: "Newer." });
    const g = gate();
    await installPack({ id: "pm" }, deps({ bundled: new Map([["pm", next]]) }), g.gate);
    expect(String(g.calls[0]?.payload["promptText"])).toContain(
      "Your edits to this pack's layer file will be replaced.",
    );
    // An untouched layer carries no such line.
    const g2 = gate();
    const next2 = pmWith({ version: "1.2.0", description: "Newer still." });
    await installPack({ id: "pm" }, deps({ bundled: new Map([["pm", next2]]) }), g2.gate);
    expect(String(g2.calls[0]?.payload["promptText"])).not.toContain("Your edits to this pack's");
  });

  test("previewPack of an update over a hand-edited layer warns too", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    unlinkSync(layerFile("pm"));
    const next = pmWith({ version: "1.1.0", description: "Newer." });
    const r = await previewPack({ id: "pm" }, deps({ bundled: new Map([["pm", next]]) }));
    expect(r.mode).toBe("update");
    expect(r.prompt).toContain("Your edits to this pack's layer file will be replaced.");
  });

  test("a listed pack with a missing record prompts in install mode", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    unlinkSync(recordFile("pm"));
    const g = gate();
    expect((await installPack({ id: "pm" }, deps(), g.gate)).outcome).toBe("installed");
    expect(String(g.calls[0]?.payload["promptText"])).toContain("Install role pack");
  });
});

describe("listPacks and previewPack", () => {
  test("available holds only the bundled packs not installed; installing pm moves it", async () => {
    const before = listPacks(deps());
    expect(before.profile).toBe(profile());
    expect(before.installed).toEqual([]);
    expect(before.available.map((p) => p.id).sort()).toEqual(["devops", "pm"]);
    await installPack({ id: "pm" }, deps(), gate().gate);
    const after = listPacks(deps());
    expect(after.available.map((p) => p.id)).toEqual(["devops"]);
    expect(after.installed).toEqual([
      {
        id: "pm",
        name: "Product",
        version: "1.0.0",
        source: "bundled",
        updateAvailable: false,
        visibleAgents: ["decisions", "glossary", "catchup"],
      },
    ]);
  });

  test("packVisibleAgents normalises, dedupes and keeps manifest order", () => {
    expect(
      packVisibleAgents('[agents]\nvisible = ["agents.decisions", "glossary", "decisions"]\n'),
    ).toEqual(["decisions", "glossary"]);
  });

  test("packVisibleAgents is [] for defaults with no [agents] visible, or invalid defaults", () => {
    expect(packVisibleAgents("")).toEqual([]);
    expect(packVisibleAgents("[agents]\nvisible = 3\n")).toEqual([]);
  });

  test("listPacks reads visibleAgents from the INSTALLED record, not the bundled copy", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    const other = pmWith({ defaults: '[agents]\nvisible = ["owners"]\n' });
    const r = listPacks(deps({ bundled: new Map([["pm", other]]) }));
    expect(r.installed[0]?.visibleAgents).toEqual(["decisions", "glossary", "catchup"]);
  });

  test("updateAvailable against a newer bundled map", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    const next = pmWith({ version: "1.1.0", description: "Newer." });
    const r = listPacks(deps({ bundled: new Map([["pm", next]]) }));
    expect(r.installed[0]).toMatchObject({ updateAvailable: true, bundledVersion: "1.1.0" });
  });

  test("a local-file pack is listed with source file", async () => {
    await installPack({ fileText: fileText(), filePath: FILE_PATH }, deps(), gate().gate);
    expect(listPacks(deps()).installed[0]).toMatchObject({
      id: "mine",
      source: "file",
      updateAvailable: false,
    });
  });

  test("versionUnknown for a listed pack without a record; the store's skipped passes through", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    unlinkSync(recordFile("pm"));
    writeFileSync(activeFile(), '{"version":1,"packs":["pm","ghost","../x"]}\n');
    const r = listPacks(deps());
    expect(r.installed).toEqual([
      {
        id: "pm",
        name: "Product",
        version: "unknown",
        source: "bundled",
        updateAvailable: true,
        bundledVersion: "1.0.0",
        versionUnknown: true,
        visibleAgents: [],
      },
      {
        id: "ghost",
        name: "ghost",
        version: "unknown",
        source: "file",
        updateAvailable: false,
        versionUnknown: true,
        visibleAgents: [],
      },
    ]);
    expect(r.skipped).toEqual([
      { packId: "ghost", reason: "missing" },
      { packId: "#2", reason: "invalid pack id" },
    ]);
  });

  test("an unreadable active.json is reported as listError", () => {
    mkdirSync(packDir(), { recursive: true });
    writeFileSync(activeFile(), "[]");
    const r = listPacks(deps());
    expect(r.listError).toContain("active.json");
    expect(r.installed).toEqual([]);
    // Installed state is unknown, so nothing may be offered as "available".
    expect(r.available).toEqual([]);
  });

  test("previewPack with fileText returns the prompt and never writes", async () => {
    const r = await previewPack({ fileText: fileText(), filePath: FILE_PATH }, deps());
    expect(r.mode).toBe("install");
    expect(r.prompt).toContain("Install role pack Mine (mine)");
    expect(r.prompt).toContain("decisions.min_confidence = 0.5");
    expect(existsSync(join(dir, "packs"))).toBe(false);
  });

  test("previewPack refuses fileText in production", async () => {
    const err = await refusal(
      previewPack(
        { fileText: fileText(), filePath: FILE_PATH },
        deps({ isProduction: () => true }),
      ),
    );
    expect(err.code).toBe("ERR_PACK_LOCAL_FILE_PRODUCTION");
  });

  test("previewPack of an intact install is already_installed, headed as installed, with the record", async () => {
    const g = gate();
    await installPack({ id: "pm" }, deps(), g.gate);
    const r = await previewPack({ id: "pm" }, deps());
    expect(r.mode).toBe("already_installed");
    expect(r.prompt).toStartWith("Installed: role pack Product (pm) version 1.0.0");
    expect(r.prompt).not.toContain("Install role pack");
    expect(r.prompt).toContain("Config defaults:");
    expect(r.installed).toEqual({
      version: "1.0.0",
      source: "bundled",
      installedAt: "2026-10-24T00:00:00.000Z",
      digest: String(g.calls[0]?.payload["digest"]),
    });
  });

  test("previewPack of a bundled pack not installed has no installed field", async () => {
    const r = await previewPack({ id: "pm" }, deps());
    expect(r.mode).toBe("install");
    expect(r.installed).toBeUndefined();
  });

  test("previewPack { id } of an installed local-file pack renders from its record", async () => {
    const g = gate();
    await installPack({ fileText: fileText(), filePath: FILE_PATH }, deps(), g.gate);
    const r = await previewPack({ id: "mine" }, deps());
    expect(r.mode).toBe("already_installed");
    expect(r.prompt).toStartWith("Installed: role pack Mine (mine) version 1.0.0");
    expect(r.prompt).toContain(`Source: local file ${FILE_PATH}`);
    expect(r.installed).toEqual({
      version: "1.0.0",
      source: `local file ${FILE_PATH}`,
      installedAt: "2026-10-24T00:00:00.000Z",
      digest: String(g.calls[0]?.payload["digest"]),
    });
    unlinkSync(layerFile("mine"));
    const repair = await previewPack({ id: "mine" }, deps());
    expect(repair.mode).toBe("repair");
    expect(repair.prompt).toStartWith("Repair role pack Mine (mine)");
    expect(repair.installed?.version).toBe("1.0.0");
  });

  test("previewPack { id } with neither a bundled pack nor an installed record → ERR_PACK_NOT_FOUND", async () => {
    const err = await refusal(previewPack({ id: "ghost" }, deps()));
    expect(err.code).toBe("ERR_PACK_NOT_FOUND");
    expect(err.detail).toBe('no bundled or installed pack "ghost"');
  });

  test("installPack { id } of an installed local-file pack stays bundled-only", async () => {
    await installPack({ fileText: fileText(), filePath: FILE_PATH }, deps(), gate().gate);
    const g = gate();
    const err = await refusal(installPack({ id: "mine" }, deps(), g.gate));
    expect(err.code).toBe("ERR_PACK_NOT_FOUND");
    expect(err.detail).toBe('no bundled pack "mine"; a local-file pack is installed with --file');
    expect(g.calls).toHaveLength(0);
  });

  test("previewPack shows the update and repair modes", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    const next = pmWith({ version: "1.1.0", description: "Newer." });
    const up = await previewPack({ id: "pm" }, deps({ bundled: new Map([["pm", next]]) }));
    expect(up.mode).toBe("update");
    expect(up.prompt).toContain("This update has no config changes.");
    unlinkSync(layerFile("pm"));
    expect((await previewPack({ id: "pm" }, deps())).mode).toBe("repair");
  });
});

describe("removePack", () => {
  test("restores config explain fleet.enabled to its pre-install layer", async () => {
    writeFileSync(join(dir, "nimbus.toml"), "[decisions]\nmin_confidence = 0.4\n");
    expect(explainConfig(getLayeredConfig(dir), "fleet.enabled").entries).toEqual([]);
    await installPack({ id: "pm" }, deps(), gate().gate);
    expect(explainConfig(getLayeredConfig(dir), "fleet.enabled").entries).toHaveLength(1);
    const r = removePack("pm", deps());
    expect(r.removed).toBe(true);
    expect(r.snapshotVersion).not.toBeNull();
    expect(explainConfig(getLayeredConfig(dir), "fleet.enabled").entries).toEqual([]);
    expect(existsSync(layerFile("pm"))).toBe(false);
    expect(existsSync(recordFile("pm"))).toBe(false);
  });

  test("an unknown id is removed: false and touches no file", () => {
    expect(removePack("pm", deps())).toEqual({ removed: false, snapshotVersion: null });
    expect(existsSync(join(dir, "packs"))).toBe(false);
  });

  test("an unreadable active.json → ERR_PACK_STORE_UNREADABLE", async () => {
    await installPack({ id: "pm" }, deps(), gate().gate);
    writeFileSync(activeFile(), "{not json");
    const err = await refusal(Promise.resolve().then(() => removePack("pm", deps())));
    expect(err.code).toBe("ERR_PACK_STORE_UNREADABLE");
    expect(existsSync(layerFile("pm"))).toBe(true);
  });

  test("an invalid id → ERR_PACK_INVALID", async () => {
    const err = await refusal(Promise.resolve().then(() => removePack("../x", deps())));
    expect(err.code).toBe("ERR_PACK_INVALID");
  });

  test("a non-refusal error propagates unchanged", () => {
    const broken: PackLayerStore = {
      ...store,
      removePackLayer: () => {
        throw new Error("EACCES");
      },
    };
    expect(() => removePack("pm", deps({ store: broken }))).toThrow("EACCES");
  });
});
