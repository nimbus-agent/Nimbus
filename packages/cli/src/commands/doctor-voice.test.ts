import { describe, expect, test } from "bun:test";
import type { DoctorEnv, DoctorVoiceConfig } from "./doctor-core.ts";
import { doctorVoiceLines } from "./doctor-core.ts";

const ENABLED_CFG: DoctorVoiceConfig = {
  enabled: true,
  whisperPath: "",
  piperPath: "",
  piperModel: "",
};

function voiceLines(cfg: DoctorVoiceConfig, env: DoctorEnv): string[] {
  return doctorVoiceLines(cfg, env);
}

function linuxNoToolLines(): string[] {
  return voiceLines(ENABLED_CFG, { which: () => null, platform: "linux" });
}

describe("doctorVoiceLines", () => {
  test("returns empty array when voice is disabled", () => {
    const lines = voiceLines(
      { enabled: false, whisperPath: "", piperPath: "", piperModel: "" },
      { which: () => null, platform: "linux" },
    );
    expect(lines).toEqual([]);
  });

  test.each([
    ["whisper-cli", "whisper-cli"],
    ["ffmpeg", "ffmpeg"],
    ["Linux TTS (espeak-ng)", "espeak-ng"],
  ])("reports %s missing on PATH", (_, search) => {
    const lines = linuxNoToolLines();
    expect(lines.some((l) => l.includes("[warn]") && l.includes(search))).toBe(true);
  });

  test("reports Linux TTS ok when espeak-ng is on PATH", () => {
    const lines = voiceLines(ENABLED_CFG, {
      which: (n) => (n === "espeak-ng" ? "/usr/bin/espeak-ng" : null),
      platform: "linux",
    });
    expect(lines.some((l) => l.includes("[ok]") && l.includes("espeak-ng"))).toBe(true);
  });

  test("skips Linux TTS check on darwin/win32 (always available)", () => {
    const darwin = voiceLines(ENABLED_CFG, { which: () => null, platform: "darwin" });
    expect(darwin.some((l) => l.includes("say"))).toBe(true);
    const win = voiceLines(ENABLED_CFG, { which: () => null, platform: "win32" });
    expect(win.some((l) => l.includes("SAPI") || l.includes("PowerShell"))).toBe(true);
  });
});
