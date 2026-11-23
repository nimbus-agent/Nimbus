import { processEnvGet } from "../../platform/env-access.ts";
import { parseBool, parseString } from "../toml-primitives.ts";
import { forEachSectionEntry, loadTomlSection, loadTomlSectionFromConfig } from "./shared.ts";

export type NimbusVoiceToml = {
  enabled: boolean;
  whisperPath: string;
  whisperModel: string;
  wakeWordWhisperModel: string;
  wakeWord: string;
  piperPath: string;
  piperModel: string;
};

export const DEFAULT_NIMBUS_VOICE_TOML: NimbusVoiceToml = {
  enabled: false,
  whisperPath: "",
  whisperModel: "base.en",
  wakeWordWhisperModel: "tiny.en",
  wakeWord: "hey nimbus",
  piperPath: "",
  piperModel: "",
};

function applyNimbusVoiceKey(out: Partial<NimbusVoiceToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "whisper_path":
      out.whisperPath = parseString(valRaw);
      break;
    case "whisper_model":
      out.whisperModel = parseString(valRaw);
      break;
    case "wake_word_whisper_model":
      out.wakeWordWhisperModel = parseString(valRaw);
      break;
    case "wake_word":
      out.wakeWord = parseString(valRaw);
      break;
    case "piper_path":
      out.piperPath = parseString(valRaw);
      break;
    case "piper_model":
      out.piperModel = parseString(valRaw);
      break;
    default:
      break;
  }
}

export function parseNimbusTomlVoiceSection(source: string): Partial<NimbusVoiceToml> {
  const out: Partial<NimbusVoiceToml> = {};
  forEachSectionEntry(source, "[voice]", (key, valRaw) => {
    applyNimbusVoiceKey(out, key, valRaw);
  });
  return out;
}

function parseNimbusVoiceLoaded(raw: string): NimbusVoiceToml {
  return structuredClone({
    ...DEFAULT_NIMBUS_VOICE_TOML,
    ...parseNimbusTomlVoiceSection(raw),
  });
}

export function loadNimbusVoiceFromPath(tomlPath: string): NimbusVoiceToml {
  return loadTomlSection(tomlPath, DEFAULT_NIMBUS_VOICE_TOML, parseNimbusVoiceLoaded);
}

export function loadNimbusVoiceFromConfigDir(configDir: string): NimbusVoiceToml {
  return loadTomlSectionFromConfig(
    configDir,
    "voice",
    DEFAULT_NIMBUS_VOICE_TOML,
    parseNimbusVoiceLoaded,
  );
}

export type NimbusUpdaterToml = {
  enabled: boolean;
  url: string;
  checkOnStartup: boolean;
  autoApply: boolean;
};

export const DEFAULT_NIMBUS_UPDATER_TOML: NimbusUpdaterToml = {
  enabled: true,
  url: "https://github.com/nimbus-agent/Nimbus/releases/latest/download/latest.json",
  checkOnStartup: true,
  autoApply: false,
};

function applyNimbusUpdaterKey(out: Partial<NimbusUpdaterToml>, key: string, valRaw: string): void {
  switch (key) {
    case "enabled": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.enabled = b;
      break;
    }
    case "url":
      out.url = parseString(valRaw);
      break;
    case "check_on_startup": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.checkOnStartup = b;
      break;
    }
    case "auto_apply": {
      const b = parseBool(valRaw);
      if (b !== undefined) out.autoApply = b;
      break;
    }
    default:
      break;
  }
}

export function parseNimbusTomlUpdaterSection(source: string): Partial<NimbusUpdaterToml> {
  const out: Partial<NimbusUpdaterToml> = {};
  forEachSectionEntry(source, "[updater]", (key, valRaw) => {
    applyNimbusUpdaterKey(out, key, valRaw);
  });
  return out;
}

export function parseNimbusUpdaterToml(
  raw: string,
  defaults: NimbusUpdaterToml = DEFAULT_NIMBUS_UPDATER_TOML,
): NimbusUpdaterToml {
  const section = parseNimbusTomlUpdaterSection(raw);
  const result: NimbusUpdaterToml = { ...defaults, ...section };

  const urlOverride = processEnvGet("NIMBUS_UPDATER_URL");
  if (urlOverride) {
    result.url = urlOverride;
  }
  if (processEnvGet("NIMBUS_UPDATER_DISABLE") === "1") {
    result.enabled = false;
  }
  return result;
}

export function loadNimbusUpdaterFromPath(tomlPath: string): NimbusUpdaterToml {
  // The fallback goes through `parseNimbusUpdaterToml` too, so `NIMBUS_UPDATER_URL` and
  // `NIMBUS_UPDATER_DISABLE` apply whether or not a `nimbus.toml` exists. With the bare defaults
  // as the fallback they were silently ignored on every install that has no config file yet —
  // exactly a first boot, when the startup update check runs.
  return loadTomlSection(tomlPath, parseNimbusUpdaterToml(""), parseNimbusUpdaterToml);
}

export function loadNimbusUpdaterFromConfigDir(configDir: string): NimbusUpdaterToml {
  return loadTomlSectionFromConfig(
    configDir,
    "updater",
    parseNimbusUpdaterToml(""),
    parseNimbusUpdaterToml,
  );
}
