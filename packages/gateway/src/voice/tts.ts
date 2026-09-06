import type { TtsProvider } from "./types.ts";

type NativeTtsOptions = {
  platform: "win32" | "darwin" | "linux";
};

function buildTtsCommand(platform: "win32" | "darwin" | "linux", text: string): string[] {
  switch (platform) {
    case "darwin":
      return ["say", text];
    case "win32":
      return [
        "PowerShell.exe",
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        "(New-Object System.Speech.Synthesis.SpeechSynthesizer).Speak($args[0])",
        "--",
        text,
      ];
    case "linux": {
      const bin = Bun.which("espeak-ng") === null ? "spd-say" : "espeak-ng";
      return [bin, text];
    }
  }
}

export class NativeTtsProvider implements TtsProvider {
  private readonly platform: "win32" | "darwin" | "linux";

  constructor(opts: NativeTtsOptions) {
    this.platform = opts.platform;
  }

  async isAvailable(): Promise<boolean> {
    if (this.platform === "darwin" || this.platform === "win32") return true;
    return Bun.which("espeak-ng") !== null || Bun.which("spd-say") !== null;
  }

  async speak(text: string): Promise<void> {
    const cmd = buildTtsCommand(this.platform, text);
    const proc = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore", windowsHide: true });
    const exitCode = await proc.exited;
    if (exitCode !== 0) {
      throw new Error(`TTS exited with code ${exitCode}`);
    }
  }
}

type PiperTtsOptions = {
  piperBin: string;
  modelPath: string;
};

export class PiperTtsProvider implements TtsProvider {
  private readonly piperBin: string;
  private readonly modelPath: string;

  constructor(opts: PiperTtsOptions) {
    this.piperBin = opts.piperBin;
    this.modelPath = opts.modelPath;
  }

  async isAvailable(): Promise<boolean> {
    const binExists =
      this.piperBin.includes("/") || this.piperBin.includes("\\")
        ? await Bun.file(this.piperBin).exists()
        : Bun.which(this.piperBin) !== null;
    const modelExists = this.modelPath !== "" && (await Bun.file(this.modelPath).exists());
    return binExists && modelExists;
  }

  async speak(text: string): Promise<void> {
    const playerCmd = selectAudioPlayer();
    if (playerCmd === undefined) {
      throw new Error("No audio player found (tried aplay, afplay, PowerShell)");
    }

    const encoder = new TextEncoder();
    const proc = Bun.spawn([this.piperBin, "--model", this.modelPath, "--output-raw"], {
      stdin: new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode(text));
          controller.close();
        },
      }),
      stdout: "pipe",
      stderr: "ignore",
      windowsHide: true,
    });

    const player = Bun.spawn(playerCmd, {
      stdin: proc.stdout,
      stdout: "ignore",
      stderr: "ignore",
      windowsHide: true,
    });

    const [piperCode, playerCode] = await Promise.all([proc.exited, player.exited]);
    if (piperCode !== 0) throw new Error(`Piper exited with code ${piperCode}`);
    if (playerCode !== 0) throw new Error(`Audio player exited with code ${playerCode}`);
  }
}

function selectAudioPlayer(): string[] | undefined {
  const platform = process.platform;
  if (platform === "darwin") return ["afplay", "-"];
  if (platform === "win32") {
    return [
      "PowerShell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "$s = New-Object System.IO.MemoryStream; $input.BaseStream.CopyTo($s); [System.Media.SoundPlayer]::new($s).PlaySync()",
    ];
  }
  if (Bun.which("aplay") !== null) return ["aplay", "--file-type", "raw", "-"];
  return undefined;
}
