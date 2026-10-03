import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_ONCALL_PUSH_CONFIG,
  loadNimbusOncallPushFromPath,
  parseNimbusTomlOncallPush,
} from "./oncall-push-toml.ts";

describe("[oncall.push] config", () => {
  test("absent section → defaults, disabled", () => {
    expect(parseNimbusTomlOncallPush("[fleet]\nenabled = true\n")).toEqual(
      DEFAULT_ONCALL_PUSH_CONFIG,
    );
    expect(DEFAULT_ONCALL_PUSH_CONFIG.enabled).toBe(false);
    expect(DEFAULT_ONCALL_PUSH_CONFIG.retentionDays).toBe(90);
  });

  test("parses every key; severities lowercased and deduped", () => {
    const c = parseNimbusTomlOncallPush(
      [
        "[oncall.push]",
        "enabled = true",
        'severities = ["P1", "sev-1", "p1"]',
        'chatops_namespace = "payments"',
        "retention_days = 30",
      ].join("\n"),
    );
    expect(c).toEqual({
      enabled: true,
      severities: ["p1", "sev-1"],
      chatopsNamespace: "payments",
      retentionDays: 30,
    });
  });

  test("only the exact header counts — [oncall] and [oncall.push.x] are ignored", () => {
    expect(parseNimbusTomlOncallPush("[oncall]\nenabled = true\n").enabled).toBe(false);
    expect(parseNimbusTomlOncallPush("[oncall.push.x]\nenabled = true\n").enabled).toBe(false);
  });

  test("retention_days below 1 is ignored, not clamped", () => {
    expect(parseNimbusTomlOncallPush("[oncall.push]\nretention_days = 0\n").retentionDays).toBe(90);
  });

  test("an unparseable severities value keeps the default instead of throwing (boot path)", () => {
    // A bare string, and a multi-line array — which this line-based parser sees as a lone `[`.
    expect(
      parseNimbusTomlOncallPush(
        ["[oncall.push]", "enabled = true", 'severities = "P1"'].join("\n"),
      ),
    ).toEqual({ ...DEFAULT_ONCALL_PUSH_CONFIG, enabled: true });
    const multi = parseNimbusTomlOncallPush(
      ["[oncall.push]", "severities = [", '  "P1",', '  "sev-1",', "]", "retention_days = 30"].join(
        "\n",
      ),
    );
    expect(multi.severities).toEqual(DEFAULT_ONCALL_PUSH_CONFIG.severities);
    expect(multi.retentionDays).toBe(30);
  });

  test("load from a missing path → defaults", () => {
    const dir = mkdtempSync(join(tmpdir(), "oncall-push-toml-"));
    try {
      expect(loadNimbusOncallPushFromPath(join(dir, "nope.toml"))).toEqual(
        DEFAULT_ONCALL_PUSH_CONFIG,
      );
      const p = join(dir, "nimbus.toml");
      writeFileSync(p, "[oncall.push]\nenabled = true\n");
      expect(loadNimbusOncallPushFromPath(p).enabled).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
