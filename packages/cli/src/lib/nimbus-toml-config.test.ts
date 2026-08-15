import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  getTomlValueFromFile,
  listTomlKeysWithEnv,
  setTomlValueInFile,
} from "./nimbus-toml-config.ts";

const SAVED = {
  agent: process.env["NIMBUS_AGENT_MODEL"],
  classifier: process.env["NIMBUS_CLASSIFIER_MODEL"],
  telemetry: process.env["NIMBUS_TELEMETRY_ENABLED"],
};

let dir: string;
let tomlPath: string;

beforeEach(() => {
  delete process.env["NIMBUS_AGENT_MODEL"];
  delete process.env["NIMBUS_CLASSIFIER_MODEL"];
  delete process.env["NIMBUS_TELEMETRY_ENABLED"];
  dir = mkdtempSync(join(tmpdir(), "nimbus-toml-cfg-"));
  tomlPath = join(dir, "nimbus.toml");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  if (SAVED.agent === undefined) delete process.env["NIMBUS_AGENT_MODEL"];
  else process.env["NIMBUS_AGENT_MODEL"] = SAVED.agent;
  if (SAVED.classifier === undefined) delete process.env["NIMBUS_CLASSIFIER_MODEL"];
  else process.env["NIMBUS_CLASSIFIER_MODEL"] = SAVED.classifier;
  if (SAVED.telemetry === undefined) delete process.env["NIMBUS_TELEMETRY_ENABLED"];
  else process.env["NIMBUS_TELEMETRY_ENABLED"] = SAVED.telemetry;
});

describe("listTomlKeysWithEnv — llm.* entries", () => {
  test("llm.remote_model surfaces from env when NIMBUS_AGENT_MODEL is set", () => {
    process.env["NIMBUS_AGENT_MODEL"] = "claude-opus-4-8";
    const rows = listTomlKeysWithEnv(tomlPath);
    const row = rows.find((r) => r.key === "llm.remote_model");
    expect(row).toEqual({
      key: "llm.remote_model",
      value: "claude-opus-4-8",
      source: "env",
      envVar: "NIMBUS_AGENT_MODEL",
    });
  });

  test("llm.classifier_model surfaces from env when NIMBUS_CLASSIFIER_MODEL is set", () => {
    process.env["NIMBUS_CLASSIFIER_MODEL"] = "claude-haiku-4-5-20251001";
    const rows = listTomlKeysWithEnv(tomlPath);
    const row = rows.find((r) => r.key === "llm.classifier_model");
    expect(row).toEqual({
      key: "llm.classifier_model",
      value: "claude-haiku-4-5-20251001",
      source: "env",
      envVar: "NIMBUS_CLASSIFIER_MODEL",
    });
  });

  test("llm.* surfaces from file when env is unset and the key is in the TOML", () => {
    writeFileSync(
      tomlPath,
      `[llm]\nremote_model = "claude-sonnet-4-6"\nclassifier_model = "claude-haiku-4-5-20251001"\n`,
    );
    const rows = listTomlKeysWithEnv(tomlPath);
    const remote = rows.find((r) => r.key === "llm.remote_model");
    const classifier = rows.find((r) => r.key === "llm.classifier_model");
    expect(remote).toEqual({
      key: "llm.remote_model",
      value: '"claude-sonnet-4-6"',
      source: "file",
    });
    expect(classifier).toEqual({
      key: "llm.classifier_model",
      value: '"claude-haiku-4-5-20251001"',
      source: "file",
    });
  });

  test("env beats file when both are set", () => {
    writeFileSync(tomlPath, `[llm]\nremote_model = "claude-sonnet-4-6"\n`);
    process.env["NIMBUS_AGENT_MODEL"] = "claude-opus-4-8";
    const rows = listTomlKeysWithEnv(tomlPath);
    const row = rows.find((r) => r.key === "llm.remote_model");
    expect(row?.source).toBe("env");
    expect(row?.value).toBe("claude-opus-4-8");
  });

  test("llm.* is omitted when both env and file are unset", () => {
    const rows = listTomlKeysWithEnv(tomlPath);
    expect(rows.find((r) => r.key === "llm.remote_model")).toBeUndefined();
    expect(rows.find((r) => r.key === "llm.classifier_model")).toBeUndefined();
  });

  test("trims whitespace-only env values to undefined and falls back to file", () => {
    process.env["NIMBUS_AGENT_MODEL"] = "   ";
    writeFileSync(tomlPath, `[llm]\nremote_model = "from-file"\n`);
    const rows = listTomlKeysWithEnv(tomlPath);
    const row = rows.find((r) => r.key === "llm.remote_model");
    expect(row?.source).toBe("file");
  });
});

describe("getTomlValueFromFile", () => {
  test("returns undefined when the file does not exist (ENOENT swallowed)", () => {
    expect(getTomlValueFromFile(tomlPath, "llm.remote_model")).toBeUndefined();
  });

  test("returns undefined for a malformed dotted key (no dot)", () => {
    writeFileSync(tomlPath, `[llm]\nremote_model = "x"\n`);
    expect(getTomlValueFromFile(tomlPath, "no_dot_here")).toBeUndefined();
  });

  test("returns undefined for a dotted key starting with '.' (dot index <= 0)", () => {
    writeFileSync(tomlPath, `[llm]\nremote_model = "x"\n`);
    expect(getTomlValueFromFile(tomlPath, ".leading-dot")).toBeUndefined();
  });

  test("returns undefined when the section is absent", () => {
    writeFileSync(tomlPath, `[other]\nkey = "x"\n`);
    expect(getTomlValueFromFile(tomlPath, "llm.remote_model")).toBeUndefined();
  });

  test("returns undefined when the key is absent in an existing section", () => {
    writeFileSync(tomlPath, `[llm]\nclassifier_model = "x"\n`);
    expect(getTomlValueFromFile(tomlPath, "llm.remote_model")).toBeUndefined();
  });

  test("returns the value when the key is present in the requested section", () => {
    writeFileSync(tomlPath, `[llm]\nremote_model = "claude-sonnet-4-6"\n`);
    expect(getTomlValueFromFile(tomlPath, "llm.remote_model")).toBe(`"claude-sonnet-4-6"`);
  });

  test("ignores inline comments and blank lines", () => {
    writeFileSync(
      tomlPath,
      `# top-comment\n\n[llm] # section header with comment\nremote_model = "v1" # inline\n`,
    );
    expect(getTomlValueFromFile(tomlPath, "llm.remote_model")).toBe(`"v1"`);
  });

  test("respects CRLF line endings", () => {
    writeFileSync(tomlPath, `[llm]\r\nremote_model = "crlf-value"\r\n`);
    expect(getTomlValueFromFile(tomlPath, "llm.remote_model")).toBe(`"crlf-value"`);
  });

  test("rethrows non-ENOENT read errors (passing a directory path triggers EISDIR)", () => {
    expect(() => getTomlValueFromFile(dir, "llm.remote_model")).toThrow();
  });

  test("ignores keys with an unparseable '=' position (eq <= 0)", () => {
    writeFileSync(tomlPath, `[llm]\n= bare\nremote_model = "still-found"\n`);
    expect(getTomlValueFromFile(tomlPath, "llm.remote_model")).toBe(`"still-found"`);
  });

  test("does not read keys from a different section even if names collide", () => {
    writeFileSync(tomlPath, `[other]\nremote_model = "wrong"\n[llm]\nremote_model = "right"\n`);
    expect(getTomlValueFromFile(tomlPath, "llm.remote_model")).toBe(`"right"`);
    expect(getTomlValueFromFile(tomlPath, "other.remote_model")).toBe(`"wrong"`);
  });
});

describe("setTomlValueInFile", () => {
  test("throws on a malformed dotted key", () => {
    expect(() => setTomlValueInFile(tomlPath, "no_dot_here", "x")).toThrow(/Invalid key/);
  });

  test("throws on a dotted key starting with '.'", () => {
    expect(() => setTomlValueInFile(tomlPath, ".leading", "x")).toThrow(/Invalid key/);
  });

  test("creates the TOML file and writes a new section when none exists", () => {
    setTomlValueInFile(tomlPath, "llm.remote_model", "claude-sonnet-4-6");
    const contents = readFileSync(tomlPath, "utf8");
    expect(contents).toContain("[llm]");
    expect(contents).toContain(`remote_model = "claude-sonnet-4-6"`);
  });

  test("appends a new section to an existing file without one", () => {
    writeFileSync(tomlPath, `[other]\nkey = "x"\n`);
    setTomlValueInFile(tomlPath, "llm.remote_model", "claude-sonnet-4-6");
    const contents = readFileSync(tomlPath, "utf8");
    expect(contents).toContain("[other]");
    expect(contents).toContain("[llm]");
    expect(contents).toContain(`remote_model = "claude-sonnet-4-6"`);
  });

  test("inserts a key into an existing section when the key is absent", () => {
    writeFileSync(tomlPath, `[llm]\nclassifier_model = "haiku"\n`);
    setTomlValueInFile(tomlPath, "llm.remote_model", "sonnet");
    const contents = readFileSync(tomlPath, "utf8");
    expect(contents).toContain(`classifier_model = "haiku"`);
    expect(contents).toContain(`remote_model = "sonnet"`);
  });

  test("replaces an existing key in place when one is already set", () => {
    writeFileSync(tomlPath, `[llm]\nremote_model = "old"\nclassifier_model = "haiku"\n`);
    setTomlValueInFile(tomlPath, "llm.remote_model", "new");
    const contents = readFileSync(tomlPath, "utf8");
    expect(contents).toContain(`remote_model = "new"`);
    expect(contents).not.toContain(`remote_model = "old"`);
    expect(contents).toContain(`classifier_model = "haiku"`);
  });

  test("formats boolean literals without quotes (true/false)", () => {
    setTomlValueInFile(tomlPath, "telemetry.enabled", "true");
    expect(readFileSync(tomlPath, "utf8")).toContain("enabled = true");

    setTomlValueInFile(tomlPath, "telemetry.enabled", "false");
    expect(readFileSync(tomlPath, "utf8")).toContain("enabled = false");
  });

  test("formats integer literals without quotes (positive and negative)", () => {
    setTomlValueInFile(tomlPath, "telemetry.flush_interval_seconds", "30");
    expect(readFileSync(tomlPath, "utf8")).toContain("flush_interval_seconds = 30");

    setTomlValueInFile(tomlPath, "telemetry.offset", "-7");
    expect(readFileSync(tomlPath, "utf8")).toContain("offset = -7");
  });

  test("escapes embedded backslashes and double quotes in string values", () => {
    setTomlValueInFile(tomlPath, "llm.remote_model", String.raw`tricky\"value`);
    const contents = readFileSync(tomlPath, "utf8");
    expect(contents).toContain(String.raw`remote_model = "tricky\\\"value"`);
    const read = getTomlValueFromFile(tomlPath, "llm.remote_model");
    expect(read).toBe(String.raw`"tricky\\\"value"`);
  });

  test("scopes section boundary correctly — does not touch identically-named keys in a sibling section", () => {
    writeFileSync(tomlPath, `[other]\nremote_model = "keep"\n[llm]\nremote_model = "old"\n`);
    setTomlValueInFile(tomlPath, "llm.remote_model", "new");
    const contents = readFileSync(tomlPath, "utf8");
    expect(contents).toContain(`[other]`);
    expect(contents.match(/remote_model = "keep"/g)).toHaveLength(1);
    expect(contents).toContain(`remote_model = "new"`);
  });

  test("appends a key at section end even when followed by another section", () => {
    writeFileSync(tomlPath, `[llm]\nclassifier_model = "haiku"\n[other]\nx = "y"\n`);
    setTomlValueInFile(tomlPath, "llm.remote_model", "sonnet");
    const contents = readFileSync(tomlPath, "utf8");
    const llmStart = contents.indexOf("[llm]");
    const otherStart = contents.indexOf("[other]");
    const newKey = contents.indexOf(`remote_model = "sonnet"`);
    expect(llmStart).toBeGreaterThanOrEqual(0);
    expect(otherStart).toBeGreaterThan(llmStart);
    expect(newKey).toBeGreaterThan(llmStart);
    expect(newKey).toBeLessThan(otherStart);
  });

  test("creates the config directory when it does not exist yet (fresh machine)", () => {
    // The install guide runs `nimbus config set llm.local_model …` BEFORE
    // "Start the Gateway", so on a new machine nothing has created the config
    // directory yet. Without the mkdir this threw
    // `ENOENT: ... mkdtemp '<configDir>/.nimbus.toml.swap-XXXXXX'` — an error naming a
    // swap file the user never asked for, from the very first documented setup command.
    // Found by running that documented sequence against a real gateway, not by a test.
    const freshDir = join(dir, "does", "not", "exist", "yet");
    const freshPath = join(freshDir, "nimbus.toml");
    expect(existsSync(freshDir)).toBe(false);

    setTomlValueInFile(freshPath, "llm.local_model", "llama3.2");

    expect(existsSync(freshPath)).toBe(true);
    expect(readFileSync(freshPath, "utf8")).toContain(`local_model = "llama3.2"`);
  });

  test("leaves an existing config directory and its other files alone", () => {
    // The mkdir is recursive and therefore idempotent; prove it does not disturb a
    // directory that already holds unrelated state.
    const sibling = join(dir, "unrelated.txt");
    writeFileSync(sibling, "keep me");
    setTomlValueInFile(tomlPath, "llm.remote_model", "sonnet");
    expect(readFileSync(sibling, "utf8")).toBe("keep me");
  });
});
