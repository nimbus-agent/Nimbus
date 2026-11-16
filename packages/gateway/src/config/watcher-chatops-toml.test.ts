import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { SECTION_LOADERS } from "./config-explain.ts";
import { checkPackFragment, PACK_SETTABLE_KEYS } from "./pack-settable.ts";
import {
  DEFAULT_WATCHER_CHATOPS_CONFIG,
  parseNimbusTomlWatcherChatops,
  watcherChatopsDestination,
} from "./watcher-chatops-toml.ts";

const UUID = "0b9c1f7e-4d2a-4c55-9a3e-1f2d3c4b5a69";

describe("[watcher.chatops] config", () => {
  test("defaults: off, no namespace, no watchers", () => {
    expect(parseNimbusTomlWatcherChatops("")).toEqual(DEFAULT_WATCHER_CHATOPS_CONFIG);
    expect(DEFAULT_WATCHER_CHATOPS_CONFIG.enabled).toBe(false);
    expect(DEFAULT_WATCHER_CHATOPS_CONFIG.namespace).toBe("");
    expect(DEFAULT_WATCHER_CHATOPS_CONFIG.watchers).toEqual([]);
  });

  test("reads every key", () => {
    const c = parseNimbusTomlWatcherChatops(
      `[watcher.chatops]\nenabled = true\nnamespace = "platform"\nwatchers = ["${UUID}", "*"]\nmin_interval_minutes = 15\nmax_per_hour = 3\n`,
    );
    expect(c).toEqual({
      enabled: true,
      namespace: "platform",
      watchers: [UUID, "*"],
      minIntervalMinutes: 15,
      maxPerHour: 3,
      channel: "",
    });
  });

  test("reads the pinned channel, trimmed, and defaults to none", () => {
    expect(DEFAULT_WATCHER_CHATOPS_CONFIG.channel).toBe("");
    const c = parseNimbusTomlWatcherChatops(
      '[watcher.chatops]\nenabled = true\nchannel = " C0123ABCD "\n',
    );
    expect(c.channel).toBe("C0123ABCD");
  });

  test("an invalid pinned channel is reported", () => {
    const warnings: string[] = [];
    parseNimbusTomlWatcherChatops('[watcher.chatops]\nchannel = "#general"\n', (m) =>
      warnings.push(m),
    );
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("channel");
  });

  test("other sections are ignored", () => {
    expect(
      parseNimbusTomlWatcherChatops("[watcher.anomaly]\nnotify = true\n[x]\nenabled = true\n"),
    ).toEqual(DEFAULT_WATCHER_CHATOPS_CONFIG);
  });

  test("a bound that is out of range falls back to that key's default, reported", () => {
    const warnings: string[] = [];
    const c = parseNimbusTomlWatcherChatops(
      '[watcher.chatops]\nenabled = "yes"\nmin_interval_minutes = 1\nmax_per_hour = 61\n',
      (m) => warnings.push(m),
    );
    expect(c).toEqual(DEFAULT_WATCHER_CHATOPS_CONFIG);
    expect(warnings).toHaveLength(3);
  });

  test("a non-array watchers value is ignored, reported", () => {
    const warnings: string[] = [];
    const c = parseNimbusTomlWatcherChatops(
      `[watcher.chatops]\nenabled = true\nwatchers = "${UUID}"\n`,
      (m) => warnings.push(m),
    );
    expect(c.watchers).toEqual([]);
    expect(warnings).toHaveLength(1);
  });

  test("an entry that looks like a name is ignored with a message that says ids", () => {
    const warnings: string[] = [];
    const c = parseNimbusTomlWatcherChatops(
      `[watcher.chatops]\nwatchers = ["Service Prod", "svc.prod", "svc[1]", "${UUID}", "${UUID}"]\n`,
      (m) => warnings.push(m),
    );
    expect(c.watchers).toEqual([UUID]);
    expect(warnings).toHaveLength(3);
    for (const w of warnings) expect(w).toContain("ids");
  });

  test("an id longer than 64 characters is ignored", () => {
    const c = parseNimbusTomlWatcherChatops(
      `[watcher.chatops]\nwatchers = ["${"a".repeat(65)}"]\n`,
    );
    expect(c.watchers).toEqual([]);
  });

  test("is registered for config explain", () => {
    expect(SECTION_LOADERS["watcher.chatops"]).toBeDefined();
  });
});

function sourceFiles(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, out);
    else if (name.endsWith(".ts") && !name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

describe("I23 (g): [watcher.chatops] is owner-only", () => {
  test("no pack-settable key names the section", () => {
    expect(PACK_SETTABLE_KEYS.some((k) => k.section.startsWith("watcher"))).toBe(false);
  });

  test("the loader is read only by config/ and platform/assemble.ts", () => {
    const root = join(import.meta.dir, "..");
    const readers = sourceFiles(root)
      .filter((f) => readFileSync(f, "utf8").includes("loadNimbusWatcherChatopsFromConfigDir"))
      .map((f) => f.slice(root.length + 1).replaceAll("\\", "/"))
      .filter((f) => !f.startsWith("config/"));
    expect(readers).toEqual(["platform/assemble.ts"]);
  });
});

describe("[watcher.chatops] destination (I23 amendment: the owner's pinned channel)", () => {
  const on = { ...DEFAULT_WATCHER_CHATOPS_CONFIG, enabled: true };

  test("off is none", () => {
    expect(
      watcherChatopsDestination({ ...DEFAULT_WATCHER_CHATOPS_CONFIG, channel: "C0123ABCD" }).kind,
    ).toBe("none");
  });

  test("a namespace alone, or a valid channel alone, resolves", () => {
    expect(watcherChatopsDestination({ ...on, namespace: "platform" })).toEqual({
      kind: "namespace",
      namespace: "platform",
    });
    expect(watcherChatopsDestination({ ...on, channel: "C0123ABCD" })).toEqual({
      kind: "pinned",
      channelId: "C0123ABCD",
    });
    expect(watcherChatopsDestination({ ...on, channel: "G0123ABCD9" }).kind).toBe("pinned");
  });

  test("neither is none", () => {
    expect(watcherChatopsDestination(on).kind).toBe("none");
  });

  test("namespace AND channel is a config error: none, never a precedence", () => {
    const d = watcherChatopsDestination({ ...on, namespace: "platform", channel: "C0123ABCD" });
    expect(d.kind).toBe("none");
    if (d.kind === "none") expect(d.reason).toContain("not both");
  });

  test.each([
    "C123",
    "D0123456789",
    "#general",
    "U0123ABCD9",
    "c0123abcd",
    "C0123ABCD\n",
    "C0123 ABCD",
    "https://x.slack.com/C0123ABCD",
    "C0123456789012345678901",
    "<!here>",
  ])("an invalid pin %p is none and NEVER falls back to a namespace", (channel) => {
    expect(watcherChatopsDestination({ ...on, channel }).kind).toBe("none");
    expect(watcherChatopsDestination({ ...on, namespace: "platform", channel }).kind).toBe("none");
  });
});

describe("I23 amendment: no pack can set the channel", () => {
  test("a pack fragment naming [watcher.chatops] channel is refused whole", () => {
    const r = checkPackFragment('[watcher.chatops]\nchannel = "C0123ABCD"\n', () => []);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.join(" ")).toContain("watcher.chatops");
  });
});
