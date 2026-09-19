import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_NIMBUS_UPDATER_TOML,
  loadNimbusUpdaterFromConfigDir,
  parseNimbusUpdaterToml,
} from "./nimbus-toml.ts";

describe("parseNimbusUpdaterToml", () => {
  test("returns defaults when [updater] absent", () => {
    expect(parseNimbusUpdaterToml("")).toEqual(DEFAULT_NIMBUS_UPDATER_TOML);
  });

  test("parses overrides", () => {
    const toml = `
[updater]
enabled = false
url = "https://example.com/manifest.json"
check_on_startup = false
auto_apply = false
`;
    const out = parseNimbusUpdaterToml(toml);
    expect(out.enabled).toBe(false);
    expect(out.url).toBe("https://example.com/manifest.json");
    expect(out.checkOnStartup).toBe(false);
  });

  test("NIMBUS_UPDATER_DISABLE=1 env overrides to disabled", () => {
    const prev = process.env["NIMBUS_UPDATER_DISABLE"];
    process.env["NIMBUS_UPDATER_DISABLE"] = "1";
    try {
      const out = parseNimbusUpdaterToml(`[updater]\nenabled = true`);
      expect(out.enabled).toBe(false);
    } finally {
      if (prev === undefined) delete process.env["NIMBUS_UPDATER_DISABLE"];
      else process.env["NIMBUS_UPDATER_DISABLE"] = prev;
    }
  });
});

describe("loadNimbusUpdaterFromConfigDir — env overrides apply with or without a nimbus.toml", () => {
  // A first boot has no config file at all, and that is exactly when the startup update check
  // runs. The overrides used to be applied only while PARSING a file, so on a toml-less install
  // `NIMBUS_UPDATER_URL` and `NIMBUS_UPDATER_DISABLE` were silently ignored.
  const saved = {
    url: process.env["NIMBUS_UPDATER_URL"],
    disable: process.env["NIMBUS_UPDATER_DISABLE"],
  };
  let dir = "";

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "nimbus-updater-cfg-"));
    delete process.env["NIMBUS_UPDATER_URL"];
    delete process.env["NIMBUS_UPDATER_DISABLE"];
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (saved.url === undefined) delete process.env["NIMBUS_UPDATER_URL"];
    else process.env["NIMBUS_UPDATER_URL"] = saved.url;
    if (saved.disable === undefined) delete process.env["NIMBUS_UPDATER_DISABLE"];
    else process.env["NIMBUS_UPDATER_DISABLE"] = saved.disable;
  });

  test("no nimbus.toml, no env: the defaults", () => {
    expect(loadNimbusUpdaterFromConfigDir(dir)).toEqual(DEFAULT_NIMBUS_UPDATER_TOML);
  });

  test("no nimbus.toml: NIMBUS_UPDATER_URL still overrides the manifest URL", () => {
    process.env["NIMBUS_UPDATER_URL"] = "http://127.0.0.1:1/latest.json";
    expect(loadNimbusUpdaterFromConfigDir(dir).url).toBe("http://127.0.0.1:1/latest.json");
  });

  test("no nimbus.toml: NIMBUS_UPDATER_DISABLE=1 still disables the updater", () => {
    process.env["NIMBUS_UPDATER_DISABLE"] = "1";
    expect(loadNimbusUpdaterFromConfigDir(dir).enabled).toBe(false);
  });

  test("with a nimbus.toml: the env override still wins over the file", () => {
    writeFileSync(join(dir, "nimbus.toml"), '[updater]\nurl = "https://example.com/m.json"\n');
    process.env["NIMBUS_UPDATER_URL"] = "http://127.0.0.1:1/latest.json";
    expect(loadNimbusUpdaterFromConfigDir(dir).url).toBe("http://127.0.0.1:1/latest.json");
  });
});
