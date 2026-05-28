import { processEnvGet } from "../platform/env-access.ts";
import type { SttProvider, SttResult } from "./types.ts";

type WhisperSttOptions = {
  whisperBin?: string;
  modelName?: string;
};

export function resolveWhisperBin(configuredPath?: string): string {
  if (configuredPath !== undefined && configuredPath !== "") return configuredPath;
  const envPath = processEnvGet("NIMBUS_WHISPER_PATH");
  if (envPath !== undefined && envPath !== "") return envPath;
  if (Bun.which("whisper-cli") !== null) return "whisper-cli";
  return "main";
}

function stripTimestamp(line: string): string {
  return line.replace(/^\[[^\]]+\]\s*/, "").trim();
}

export class WhisperSttProvider implements SttProvider {
  private readonly whisperBin: string;
  private readonly modelName: string | undefined;

  constructor(opts: WhisperSttOptions = {}) {
    this.whisperBin = opts.whisperBin ?? resolveWhisperBin();
    this.modelName = opts.modelName;
  }

  async isAvailable(): Promise<boolean> {
    if (this.whisperBin.includes("/") || this.whisperBin.includes("\\")) {
      try {
        return await Bun.file(this.whisperBin).exists();
      } catch {
        return false;
      }
    }
    return Bun.which(this.whisperBin) !== null;
  }

  async transcribe(audioPath: string): Promise<SttResult> {
    if (!(await Bun.file(audioPath).exists())) {
      throw new Error(`Audio file not found: ${audioPath}`);
    }

    const cmd: string[] = [this.whisperBin, "-f", audioPath, "-nt"];
    if (this.modelName !== undefined && this.modelName !== "") {
      cmd.push("-m", this.modelName);
    }

    const start = Date.now();
    const proc = Bun.spawn(cmd, {
      stdout: "pipe",
      stderr: "pipe",
    });

    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`Whisper exited with code ${exitCode} for file: ${audioPath}`);
    }

    const raw = await new Response(proc.stdout).text();
    const text = raw
      .split("\n")
      .map((line) => stripTimestamp(line))
      .filter((line) => line.length > 0)
      .join(" ")
      .trim();

    return {
      text,
      durationMs: Date.now() - start,
    };
  }
}
