import { describe, expect, test } from "bun:test";

import type { SpawnCaptureOptions, SpawnCaptureResult } from "../spawn-capture.ts";
import {
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_SPAWN_TIMEOUT_MS,
  NOTIFICATION_TITLE_MAX_CHARS,
  NotificationSendError,
  prepareNotificationText,
} from "./types.ts";
import {
  buildWin32PowershellArgv,
  buildWin32ToastScript,
  createWin32NotificationBackend,
  encodePowershellCommand,
  interpretWin32ProbeOutput,
  WIN32_BODY_TOKEN,
  WIN32_PROBE_SCRIPT,
  WIN32_TITLE_TOKEN,
  WIN32_TOAST_DISABLED_EXIT,
  WIN32_TOAST_SCRIPT_TEMPLATE,
  win32PowershellPath,
} from "./win32.ts";

const HOSTILE: readonly string[] = [
  "plain title",
  `it's "quoted"`,
  "back\\slash\\\\double",
  "<b>&amp;</text><x>",
  "line one\nline two\r\nthree",
  "$(Remove-Item C:\\ -Recurse) and $env:PATH",
  "`backtick` and $" + "{injected}",
  "'; Start-Process calc; '",
  "unicode: café, 日本語, emoji 😀, rtl \u202Eevil",
  "nul\u0000byte and esc\u001B[31m",
];

type Call = { argv: readonly string[]; options: SpawnCaptureOptions };

function recordingSpawn(result: Partial<SpawnCaptureResult> = {}) {
  const calls: Call[] = [];
  const spawn = (argv: readonly string[], options: SpawnCaptureOptions) => {
    calls.push({ argv, options });
    return Promise.resolve<SpawnCaptureResult>({
      ok: true,
      stdout: "",
      stderr: "",
      code: 0,
      ...result,
    });
  };
  return { calls, spawn };
}

function decodeEncodedCommand(argv: readonly string[]): string {
  const i = argv.indexOf("-EncodedCommand");
  const b64 = argv[i + 1];
  if (b64 === undefined) throw new Error("no -EncodedCommand");
  return Buffer.from(b64, "base64").toString("utf16le");
}

const B64_LITERAL = /FromBase64String\('([^']*)'\)/g;

/** Every base64 literal in the script, in order. */
function base64Literals(script: string): string[] {
  return [...script.matchAll(B64_LITERAL)].map((m) => m[1] ?? "");
}

const ENV = {
  SystemRoot: "C:\\Windows",
  PATH: "C:\\Windows\\System32",
  TEMP: "C:\\Temp",
  ANTHROPIC_API_KEY: "sk-secret",
  GITHUB_TOKEN: "ghp_secret",
};

describe("win32 toast — script construction", () => {
  test("the template holds each token exactly once, inside a single-quoted base64 literal", () => {
    for (const token of [WIN32_TITLE_TOKEN, WIN32_BODY_TOKEN]) {
      expect(WIN32_TOAST_SCRIPT_TEMPLATE.split(token)).toHaveLength(2);
      expect(WIN32_TOAST_SCRIPT_TEMPLATE).toContain(`FromBase64String('${token}')`);
    }
    // The text goes in as a DOM text node, never concatenated into toast XML.
    expect(WIN32_TOAST_SCRIPT_TEMPLATE).toContain("CreateTextNode($title)");
    expect(WIN32_TOAST_SCRIPT_TEMPLATE).toContain("CreateTextNode($body)");
    expect(WIN32_TOAST_SCRIPT_TEMPLATE).not.toContain("LoadXml");
  });

  test.each(HOSTILE.map((s) => [s]))(
    "hostile text %j reaches the script ONLY as base64 and round-trips exactly",
    (s) => {
      const script = buildWin32ToastScript(s, `${s} (body)`);
      const literals = base64Literals(script);
      expect(literals).toHaveLength(2);
      for (const lit of literals) expect(lit).toMatch(/^[A-Za-z0-9+/=]*$/);
      // Put the tokens back: what remains is the constant template, byte for byte.
      let restored = script;
      restored = restored.replace(`'${literals[0]}'`, `'${WIN32_TITLE_TOKEN}'`);
      restored = restored.replace(`'${literals[1]}'`, `'${WIN32_BODY_TOKEN}'`);
      expect(restored).toBe(WIN32_TOAST_SCRIPT_TEMPLATE);
      // The literals decode to the prepared text.
      expect(Buffer.from(literals[0] ?? "", "base64").toString("utf8")).toBe(
        prepareNotificationText(s, NOTIFICATION_TITLE_MAX_CHARS),
      );
      expect(Buffer.from(literals[1] ?? "", "base64").toString("utf8")).toBe(
        prepareNotificationText(`${s} (body)`, NOTIFICATION_BODY_MAX_CHARS),
      );
    },
  );

  test("the hostile text itself never appears in the script or on the command line", () => {
    const marker = "'; Start-Process calc; '<x>&";
    const argv = buildWin32PowershellArgv("ps.exe", buildWin32ToastScript(marker, marker));
    expect(decodeEncodedCommand(argv)).not.toContain(marker);
    expect(argv.join(" ")).not.toContain(marker);
    expect(argv.join(" ")).not.toContain("Start-Process");
  });

  test("a very long title/body is capped and the command line stays far below 32,767 chars", () => {
    const huge = "😀".repeat(50_000);
    const script = buildWin32ToastScript(huge, huge);
    const [t, b] = base64Literals(script).map((l) => Buffer.from(l, "base64").toString("utf8"));
    expect(Array.from(t ?? "")).toHaveLength(NOTIFICATION_TITLE_MAX_CHARS);
    expect(Array.from(b ?? "")).toHaveLength(NOTIFICATION_BODY_MAX_CHARS);
    expect(t?.endsWith("…")).toBe(true);
    const argv = buildWin32PowershellArgv(win32PowershellPath(ENV), script);
    expect(argv.join(" ").length).toBeLessThan(32_767);
  });

  test("argv is the absolute Windows PowerShell path plus fixed flags and -EncodedCommand", () => {
    const argv = buildWin32PowershellArgv(win32PowershellPath(ENV), "Write-Output 1");
    expect(argv).toEqual([
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
      "-NoProfile",
      "-NonInteractive",
      "-NoLogo",
      "-EncodedCommand",
      encodePowershellCommand("Write-Output 1"),
    ]);
    expect(decodeEncodedCommand(argv)).toBe("Write-Output 1");
  });

  test("the PowerShell path falls back to windir, then C:\\Windows", () => {
    expect(win32PowershellPath({ windir: "D:\\Win" })).toBe(
      "D:\\Win\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
    expect(win32PowershellPath({})).toBe(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    );
  });
});

describe("win32 toast — probe", () => {
  test("runs the constant probe script with a minimal env and a timeout", async () => {
    const { calls, spawn } = recordingSpawn({ stdout: "Enabled\r\n" });
    const backend = createWin32NotificationBackend({ spawn, env: ENV });
    expect(backend.id).toBe("windows-toast");
    expect(await backend.probe()).toEqual({ available: true });
    expect(calls).toHaveLength(1);
    const call = calls[0];
    expect(decodeEncodedCommand(call?.argv ?? [])).toBe(WIN32_PROBE_SCRIPT);
    expect(call?.options.timeoutMs).toBe(NOTIFICATION_SPAWN_TIMEOUT_MS);
    expect(call?.options.env).toEqual({
      SystemRoot: "C:\\Windows",
      PATH: "C:\\Windows\\System32",
      TEMP: "C:\\Temp",
    });
  });

  test("the probe registers the AUMID before reading the notifier setting", () => {
    expect(WIN32_PROBE_SCRIPT).toContain("HKCU:\\Software\\Classes\\AppUserModelId\\");
    expect(WIN32_PROBE_SCRIPT).toContain("'NimbusAgent.Nimbus'");
    expect(WIN32_PROBE_SCRIPT.indexOf("New-ItemProperty")).toBeLessThan(
      WIN32_PROBE_SCRIPT.indexOf("$notifier.Setting"),
    );
  });

  test("interprets every notifier setting", () => {
    expect(interpretWin32ProbeOutput("Enabled")).toEqual({ available: true });
    for (const s of [
      "DisabledForApplication",
      "DisabledForUser",
      "DisabledByGroupPolicy",
      "DisabledByManifest",
    ]) {
      const r = interpretWin32ProbeOutput(`${s}\r\n`);
      expect(r.available).toBe(false);
      expect(r.reason).toContain(s);
    }
    expect(interpretWin32ProbeOutput("").available).toBe(false);
    const odd = interpretWin32ProbeOutput("<script>whatever</script>");
    expect(odd.available).toBe(false);
    // Unrecognised output is not echoed into the reason.
    expect(odd.reason).not.toContain("script");
  });

  test("a failed or throwing spawn resolves unavailable, never rejects", async () => {
    const failed = createWin32NotificationBackend({
      spawn: recordingSpawn({ ok: false, code: null }).spawn,
      env: ENV,
    });
    const r = await failed.probe();
    expect(r.available).toBe(false);
    expect(r.reason).toContain("powershell.exe");

    const throwing = createWin32NotificationBackend({
      spawn: () => Promise.reject(new Error("boom")),
      env: ENV,
    });
    expect((await throwing.probe()).available).toBe(false);
  });
});

describe("win32 toast — send", () => {
  test("sends the built script with the minimal env", async () => {
    const { calls, spawn } = recordingSpawn();
    const backend = createWin32NotificationBackend({ spawn, env: ENV });
    await backend.send("Nimbus watcher", "w1: <ticket> & 'title'");
    expect(calls).toHaveLength(1);
    expect(decodeEncodedCommand(calls[0]?.argv ?? [])).toBe(
      buildWin32ToastScript("Nimbus watcher", "w1: <ticket> & 'title'"),
    );
    expect(calls[0]?.options.env).not.toHaveProperty("ANTHROPIC_API_KEY");
    expect(calls[0]?.options.env).not.toHaveProperty("GITHUB_TOKEN");
  });

  test("the disabled-at-send exit code and other failures reject without the text", async () => {
    const body = "SECRET-BODY-SENTINEL";
    const disabled = createWin32NotificationBackend({
      spawn: recordingSpawn({ ok: false, code: WIN32_TOAST_DISABLED_EXIT, stderr: body }).spawn,
      env: ENV,
    });
    const e1 = await disabled.send("t", body).catch((e: unknown) => e);
    expect(e1).toBeInstanceOf(NotificationSendError);
    expect((e1 as Error).message).toContain("off");
    expect((e1 as Error).message).not.toContain(body);

    const failed = createWin32NotificationBackend({
      spawn: recordingSpawn({ ok: false, code: 1, stderr: body, stdout: body }).spawn,
      env: ENV,
    });
    const e2 = await failed.send("t", body).catch((e: unknown) => e);
    expect(e2).toBeInstanceOf(NotificationSendError);
    expect((e2 as Error).message).toBe("powershell.exe exited with code 1");
  });
});
