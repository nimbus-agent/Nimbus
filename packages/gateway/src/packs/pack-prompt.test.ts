import { describe, expect, test } from "bun:test";
import type { RolePackManifest } from "@nimbus-dev/registry-format";
import { diffPacks, type PackPromptInput, renderPackPrompt, visibleText } from "./pack-prompt.ts";

const DEFAULTS =
  '[agents]\nvisible = ["oncall", "why"]\n\n[fleet]\nenabled = true\nmin_idle_seconds = 300\n\n' +
  '[[fleet.job]]\nname = "nightly"\nagent = "changelog"\ninterval_seconds = 86400\n';

function manifest(over: Partial<RolePackManifest> = {}): RolePackManifest {
  return {
    schema: 1,
    id: "devops",
    name: "DevOps",
    version: "1.0.0",
    description: "d",
    roles: ["devops"],
    suggestedConnectors: ["pagerduty", "github"],
    members: [],
    defaults: DEFAULTS,
    ...over,
  };
}

function input(over: Partial<PackPromptInput> = {}): PackPromptInput {
  return {
    manifest: manifest(),
    source: { kind: "bundled" },
    mode: "install",
    scalars: [
      {
        key: "fleet.enabled",
        packValue: "true",
        current: "false",
        currentLayer: "default",
        userOverrides: false,
      },
    ],
    visibleAgents: ["oncall", "why"],
    jobs: [{ name: "nightly", agent: "changelog", intervalSeconds: 86400, userReplaces: false }],
    connectors: [
      { id: "pagerduty", configured: true },
      { id: "github", configured: false },
    ],
    ...over,
  };
}

const BEL = String.fromCodePoint(7);
const RLO = String.fromCodePoint(0x202e);

describe("visibleText", () => {
  test("escapes controls, format characters and astral code points; keeps LF and TAB", () => {
    const tag = String.fromCodePoint(0xe0041);
    const del = String.fromCodePoint(0x7f);
    const out = visibleText(`a${RLO}b${BEL}c${del}d\n\te${tag}`);
    expect(out).toBe("a\\u202Eb\\u0007c\\u007Fd\n\te\\u{E0041}");
  });
});

describe("renderPackPrompt", () => {
  test("install prompt has every section and header", () => {
    const t = renderPackPrompt(input());
    expect(t).toContain("DevOps");
    expect(t).toContain("devops");
    expect(t).toContain("1.0.0");
    expect(t).toContain("bundled");
    for (const h of [
      "Config defaults:",
      "Visible agents:",
      "Overnight jobs:",
      "Suggested connectors:",
    ]) {
      expect(t).toContain(h);
    }
    expect(t).toContain("nightly");
    expect(t).toContain("current false (default)");
  });

  test("a local file source names the path, escaped", () => {
    const t = renderPackPrompt(input({ source: { kind: "file", path: `C:\\p\\x${BEL}.json` } }));
    expect(t).toContain("local file C:\\p\\x\\u0007.json");
  });

  test("empty sections print none and defaults '' prints the no-config line", () => {
    const t = renderPackPrompt(
      input({
        manifest: manifest({ defaults: "" }),
        scalars: [],
        visibleAgents: [],
        jobs: [],
        connectors: [],
      }),
    );
    expect(t.match(/^ {2}none$/gm)?.length).toBe(4);
    expect(t).toContain("This pack writes no config.");
  });

  test("marks a user override and a replaced job", () => {
    const t = renderPackPrompt(
      input({
        scalars: [
          {
            key: "fleet.enabled",
            packValue: "true",
            current: "false",
            currentLayer: "nimbus.toml",
            userOverrides: true,
          },
        ],
        jobs: [{ name: "nightly", agent: "changelog", intervalSeconds: 5, userReplaces: true }],
      }),
    );
    expect(t).toContain("(your file overrides this)");
    expect(t).toContain("(replaced by your own job of this name)");
  });

  test("unset current, connector states in order, fleet enabled statement", () => {
    const t = renderPackPrompt(
      input({
        scalars: [
          {
            key: "fleet.enabled",
            packValue: "true",
            current: undefined,
            currentLayer: undefined,
            userOverrides: false,
          },
        ],
      }),
    );
    expect(t).toContain("unset");
    expect(t.indexOf("pagerduty")).toBeLessThan(t.indexOf("github"));
    expect(t).toContain("pagerduty: configured");
    expect(t).toContain("github: not configured");
    expect(t).toContain("[fleet] enabled: true");
  });

  test("prints the defaults verbatim and the closing line", () => {
    const t = renderPackPrompt(input());
    expect(t).toContain(DEFAULTS);
    expect(t).toContain(
      "This pack changes no credentials, no network reach and no approvals, and your nimbus.toml is not edited. Undo it with: nimbus pack remove devops",
    );
  });

  test("escapes manifest strings", () => {
    const t = renderPackPrompt(
      input({ manifest: manifest({ name: `A${RLO}B`, defaults: `${DEFAULTS}# ${BEL}\n\tx` }) }),
    );
    expect(t).not.toContain(RLO);
    expect(t).not.toContain(BEL);
    expect(t).toContain("A\\u202EB");
    expect(t).toContain("\\u0007");
    expect(t).toContain("\n\tx");
  });

  test("update mode lists only the diff, then the full new text", () => {
    const next = manifest({
      version: "1.1.0",
      defaults: DEFAULTS.replace("300", "600").replace('"why"', '"why", "impact"'),
    });
    const diff = diffPacks(manifest(), next);
    const t = renderPackPrompt(
      input({
        manifest: next,
        mode: "update",
        diff,
        scalars: [
          {
            key: "fleet.min_idle_seconds",
            packValue: "600",
            current: "300",
            currentLayer: "pack devops",
            userOverrides: true,
          },
          {
            key: "fleet.enabled",
            packValue: "true",
            current: "true",
            currentLayer: "pack devops",
            userOverrides: false,
          },
        ],
      }),
    );
    const head = t.slice(0, t.indexOf(next.defaults));
    expect(head).toContain("fleet.min_idle_seconds");
    expect(head).toContain("(your file overrides this)");
    expect(head).toContain("impact");
    expect(head).not.toContain("fleet.enabled");
    expect(t).toContain(next.defaults);
  });

  test("metadata-only update says no config changes", () => {
    const next = manifest({ version: "1.0.1" });
    const t = renderPackPrompt(
      input({ manifest: next, mode: "update", diff: diffPacks(manifest(), next) }),
    );
    expect(t).toContain("no config changes");
  });

  test("update without a diff is a programming error", () => {
    expect(() => renderPackPrompt(input({ mode: "update" }))).toThrow();
  });

  test("installed mode heads the summary as installed, not as an install", () => {
    const t = renderPackPrompt(input({ mode: "installed" }));
    expect(t).toStartWith("Installed: role pack ");
    expect(t).not.toContain("Install role pack");
    expect(t).toContain("Config defaults:");
    expect(t).toContain(DEFAULTS);
  });

  test("repair mode states the layer no longer matches", () => {
    const t = renderPackPrompt(input({ mode: "repair" }));
    expect(t).toContain("no longer matches");
    expect(t).toContain(DEFAULTS);
  });
});

describe("diffPacks", () => {
  test("scalars added, removed and changed", () => {
    const prev = manifest({ defaults: "[fleet]\nenabled = true\nretention_days = 7\n" });
    const next = manifest({ defaults: "[fleet]\nenabled = false\nmin_idle_seconds = 5\n" });
    const d = diffPacks(prev, next);
    expect(d.scalars.added).toEqual(["fleet.min_idle_seconds"]);
    expect(d.scalars.removed).toEqual(["fleet.retention_days"]);
    expect(d.scalars.changed).toEqual(["fleet.enabled"]);
    expect(d.metadataOnly).toBe(false);
  });

  test("visible agents added and removed", () => {
    const prev = manifest({ defaults: '[agents]\nvisible = ["oncall", "why"]\n' });
    const next = manifest({ defaults: '[agents]\nvisible = ["why", "impact"]\n' });
    const d = diffPacks(prev, next);
    expect(d.visible.added).toEqual(["impact"]);
    expect(d.visible.removed).toEqual(["oncall"]);
  });

  test("jobs added, removed and changed", () => {
    const job = (n: string, i: number): string =>
      `[[fleet.job]]\nname = "${n}"\nagent = "changelog"\ninterval_seconds = ${i}\n`;
    const prev = manifest({ defaults: `${job("a", 1)}\n${job("b", 1)}` });
    const next = manifest({
      defaults: `${job("b", 2)}\n[fleet]\nenabled = true\n\n${job("c", 1)}`,
    });
    const d = diffPacks(prev, next);
    expect(d.jobs.added).toEqual(["c"]);
    expect(d.jobs.removed).toEqual(["a"]);
    expect(d.jobs.changed).toEqual(["b"]);
  });

  test("connectors added and removed; metadataOnly only when defaults identical", () => {
    const prev = manifest({ suggestedConnectors: ["a", "b"] });
    const next = manifest({ suggestedConnectors: ["b", "c"] });
    const d = diffPacks(prev, next);
    expect(d.connectors).toEqual({ added: ["c"], removed: ["a"] });
    expect(d.metadataOnly).toBe(true);
  });

  test("an invalid fragment diffs as empty", () => {
    const d = diffPacks(manifest({ defaults: "junk\n" }), manifest({ defaults: "[x]\n" }));
    expect(d.scalars.added).toEqual([]);
  });
});
