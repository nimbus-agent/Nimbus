/**
 * Windows toast backend: Windows PowerShell 5.1 + the WinRT `ToastNotificationManager`.
 *
 * ## Why Windows PowerShell, by absolute path
 *
 * The WinRT type projection (`[T, Assembly, ContentType = WindowsRuntime]`) exists in Windows
 * PowerShell 5.1 and NOT in PowerShell 7 (`pwsh`), so `pwsh` cannot be a fallback. The binary is
 * resolved as `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe` rather than via PATH,
 * so a `powershell.exe` earlier on the PATH is never what runs.
 *
 * ## How the text reaches the script — and why it cannot break out
 *
 * The script is a CONSTANT template (`WIN32_TOAST_SCRIPT_TEMPLATE`). Title and body enter it only as
 * base64 of their UTF-8 bytes, substituted into single-quoted literals and decoded INSIDE the
 * script. The base64 alphabet (`A-Z a-z 0-9 + / =`) contains no quote, no `$`, no backtick and no
 * newline, so no input can end the literal or start an expression. The whole script then travels
 * as `-EncodedCommand` (UTF-16LE base64), so the command line itself also carries only base64.
 *
 * Inside the script the decoded text becomes an XML TEXT NODE via `XmlDocument.CreateTextNode` —
 * never string-concatenated into toast XML — so `<`, `&` and `</text>` are escaped by the DOM, not
 * by us. (Verified on Windows 11: an injection-shaped title/body is stored escaped in the toast
 * history.)
 *
 * ## The app identity
 *
 * A toast needs an AppUserModelID registered under `HKCU:\Software\Classes\AppUserModelId\<AUMID>`
 * with a `DisplayName`; an unregistered AUMID's notifier reports an empty `Setting` and shows
 * nothing. Both scripts register it first (idempotent, current-user only), so a key removed after
 * the probe does not silently break later toasts.
 *
 * The probe reports the notifier's `Setting`: `Enabled`, or one of `DisabledForApplication` /
 * `DisabledForUser` / `DisabledByGroupPolicy` / `DisabledByManifest` — so an owner who turned
 * Nimbus off in Windows Settings sees that as the reason, rather than toasts vanishing.
 */
import { win32 as winPath } from "node:path";

import { spawnCapture } from "../spawn-capture.ts";
import {
  describeSpawnFailure,
  NOTIFICATION_BODY_MAX_CHARS,
  NOTIFICATION_SPAWN_TIMEOUT_MS,
  NOTIFICATION_TITLE_MAX_CHARS,
  type NotificationBackend,
  type NotificationEnvSource,
  type NotificationProbeResult,
  NotificationSendError,
  type NotificationSpawner,
  pickEnv,
  prepareNotificationText,
} from "./types.ts";

export const WIN32_TOAST_AUMID = "NimbusAgent.Nimbus";
export const WIN32_TOAST_DISPLAY_NAME = "Nimbus";

/** The tokens the send template carries; replaced ONLY with base64 text. */
export const WIN32_TITLE_TOKEN = "__NIMBUS_TITLE_B64__";
export const WIN32_BODY_TOKEN = "__NIMBUS_BODY_B64__";

/** Exit code the send script uses when the notifier is not `Enabled` at send time. */
export const WIN32_TOAST_DISABLED_EXIT = 3;

/** Variables `powershell.exe` needs to start and load WinRT. Nothing else is passed. */
export const WIN32_TOAST_ENV_KEYS = [
  "SystemRoot",
  "windir",
  "SystemDrive",
  "PATH",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
] as const;

const REGISTER_AUMID = [
  "$ErrorActionPreference = 'Stop'",
  `$aumid = '${WIN32_TOAST_AUMID}'`,
  "$key = 'HKCU:\\Software\\Classes\\AppUserModelId\\' + $aumid",
  "if (-not (Test-Path -LiteralPath $key)) { $null = New-Item -Path $key -Force }",
  `$null = New-ItemProperty -LiteralPath $key -Name 'DisplayName' -Value '${WIN32_TOAST_DISPLAY_NAME}' -PropertyType String -Force`,
  "$null = [Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]",
  "$notifier = [Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($aumid)",
];

/** Registers the AUMID and prints the notifier's `Setting`. Carries no notification text. */
export const WIN32_PROBE_SCRIPT = [
  ...REGISTER_AUMID,
  "Write-Output ([string]$notifier.Setting)",
].join("\n");

/**
 * The send script. CONSTANT apart from the two tokens, each of which sits inside a single-quoted
 * literal and is replaced with base64 only (see the file header).
 */
export const WIN32_TOAST_SCRIPT_TEMPLATE = [
  ...REGISTER_AUMID,
  `if ([string]$notifier.Setting -ne 'Enabled') { exit ${WIN32_TOAST_DISABLED_EXIT} }`,
  `$title = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${WIN32_TITLE_TOKEN}'))`,
  `$body = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('${WIN32_BODY_TOKEN}'))`,
  "$null = [Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]",
  "$xml = New-Object Windows.Data.Xml.Dom.XmlDocument",
  "$toast = $xml.CreateElement('toast')",
  "$visual = $xml.CreateElement('visual')",
  "$binding = $xml.CreateElement('binding')",
  "$binding.SetAttribute('template', 'ToastGeneric')",
  "$titleNode = $xml.CreateElement('text')",
  "$null = $titleNode.AppendChild($xml.CreateTextNode($title))",
  "$bodyNode = $xml.CreateElement('text')",
  "$null = $bodyNode.AppendChild($xml.CreateTextNode($body))",
  "$null = $binding.AppendChild($titleNode)",
  "$null = $binding.AppendChild($bodyNode)",
  "$null = $visual.AppendChild($binding)",
  "$null = $toast.AppendChild($visual)",
  "$null = $xml.AppendChild($toast)",
  "$notifier.Show([Windows.UI.Notifications.ToastNotification]::new($xml))",
].join("\n");

function base64Utf8(text: string): string {
  return Buffer.from(text, "utf8").toString("base64");
}

/** The send script for one toast: the template with base64 in place of each token. */
export function buildWin32ToastScript(title: string, body: string): string {
  const t = base64Utf8(prepareNotificationText(title, NOTIFICATION_TITLE_MAX_CHARS));
  const b = base64Utf8(prepareNotificationText(body, NOTIFICATION_BODY_MAX_CHARS));
  // Function replacers: a string replacement would interpret `$&`/`$'` patterns. Base64 has no `$`,
  // so this is belt and braces, not a live hole.
  return WIN32_TOAST_SCRIPT_TEMPLATE.replace(WIN32_TITLE_TOKEN, () => t).replace(
    WIN32_BODY_TOKEN,
    () => b,
  );
}

/** `-EncodedCommand` takes base64 of the script's UTF-16LE bytes. */
export function encodePowershellCommand(script: string): string {
  return Buffer.from(script, "utf16le").toString("base64");
}

export function win32PowershellPath(env: NotificationEnvSource): string {
  const root = env["SystemRoot"] ?? env["windir"] ?? "C:\\Windows";
  return winPath.join(root, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function buildWin32PowershellArgv(powershellPath: string, script: string): string[] {
  return [
    powershellPath,
    "-NoProfile",
    "-NonInteractive",
    "-NoLogo",
    "-EncodedCommand",
    encodePowershellCommand(script),
  ];
}

const KNOWN_SETTINGS = new Set([
  "Enabled",
  "DisabledForApplication",
  "DisabledForUser",
  "DisabledByGroupPolicy",
  "DisabledByManifest",
]);

/** Interpret the probe script's stdout (the notifier `Setting`). */
export function interpretWin32ProbeOutput(stdout: string): NotificationProbeResult {
  const setting = stdout.trim().split(/\r?\n/).pop()?.trim() ?? "";
  if (setting === "Enabled") return { available: true };
  if (setting === "") {
    return { available: false, reason: "Windows reported no notification setting for Nimbus" };
  }
  if (KNOWN_SETTINGS.has(setting)) {
    return { available: false, reason: `Windows notifications are off for Nimbus (${setting})` };
  }
  return { available: false, reason: "Windows reported an unrecognised notification setting" };
}

export type Win32NotificationBackendDeps = {
  readonly spawn?: NotificationSpawner;
  readonly env?: NotificationEnvSource;
};

export function createWin32NotificationBackend(
  deps: Win32NotificationBackendDeps = {},
): NotificationBackend {
  const spawn = deps.spawn ?? spawnCapture;
  const env = deps.env ?? process.env;
  const exe = win32PowershellPath(env);
  const childEnv = pickEnv(env, WIN32_TOAST_ENV_KEYS);
  const run = (script: string) =>
    spawn(buildWin32PowershellArgv(exe, script), {
      env: childEnv,
      timeoutMs: NOTIFICATION_SPAWN_TIMEOUT_MS,
    });

  return {
    id: "windows-toast",
    async probe(): Promise<NotificationProbeResult> {
      try {
        const r = await run(WIN32_PROBE_SCRIPT);
        if (!r.ok) return { available: false, reason: describeSpawnFailure("powershell.exe", r) };
        return interpretWin32ProbeOutput(r.stdout);
      } catch {
        return { available: false, reason: "powershell.exe probe failed" };
      }
    },
    async send(title: string, body: string): Promise<void> {
      const r = await run(buildWin32ToastScript(title, body));
      if (r.ok) return;
      if (r.code === WIN32_TOAST_DISABLED_EXIT) {
        throw new NotificationSendError("Windows notifications are off for Nimbus");
      }
      throw new NotificationSendError(describeSpawnFailure("powershell.exe", r));
    },
  };
}
