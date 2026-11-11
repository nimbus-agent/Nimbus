import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { EnforcedPolicy } from "../policy/policy-gate.ts";
import { buildLearningConfig } from "./learning-config.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});
function dirWith(toml: string | null): string {
  const d = mkdtempSync(join(tmpdir(), "nimbus-learning-cfg-"));
  dirs.push(d);
  if (toml !== null) writeFileSync(join(d, "nimbus.toml"), toml);
  return d;
}
const policy = (disabled: string[]): EnforcedPolicy =>
  ({ capabilitiesDisabled: new Set(disabled) }) as unknown as EnforcedPolicy;

describe("buildLearningConfig", () => {
  test("on when policy allows standing approvals and the gateway is not a demo", () => {
    const c = buildLearningConfig({
      demo: false,
      configDir: dirWith(null),
      enforcedPolicy: () => policy([]),
    });
    expect(c.enabled()).toBe(true);
  });

  test("off on a demo gateway, with the lockoff set, with no accessor, or when it throws", () => {
    const dir = dirWith(null);
    expect(
      buildLearningConfig({
        demo: true,
        configDir: dir,
        enforcedPolicy: () => policy([]),
      }).enabled(),
    ).toBe(false);
    expect(
      buildLearningConfig({
        demo: false,
        configDir: dir,
        enforcedPolicy: () => policy(["standing_approvals"]),
      }).enabled(),
    ).toBe(false);
    expect(buildLearningConfig({ demo: false, configDir: dir }).enabled()).toBe(false);
    expect(
      buildLearningConfig({
        demo: false,
        configDir: dir,
        enforcedPolicy: () => {
          throw new Error("unreadable");
        },
      }).enabled(),
    ).toBe(false);
  });

  test("suggest_after: default 5, the configured value, and a warned fallback when invalid", () => {
    const lines: string[] = [];
    const log = (_f: Record<string, unknown>, m: string): void => {
      lines.push(m);
    };
    expect(buildLearningConfig({ demo: false, configDir: dirWith(null), log }).suggestAfter()).toBe(
      5,
    );
    expect(
      buildLearningConfig({
        demo: false,
        configDir: dirWith("[standing]\nsuggest_after = 8\n"),
        log,
      }).suggestAfter(),
    ).toBe(8);
    expect(lines).toHaveLength(0);
    expect(
      buildLearningConfig({
        demo: false,
        configDir: dirWith("[standing]\nsuggest_after = 1\n"),
        log,
      }).suggestAfter(),
    ).toBe(5);
    expect(lines).toEqual(["[standing] is invalid; using the default suggest_after"]);
    expect(buildLearningConfig({ demo: false, configDir: dirWith(null) }).log).toBeUndefined();
  });
});
