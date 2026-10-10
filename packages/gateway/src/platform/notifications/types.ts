/**
 * Shared shapes and text handling for the OS notification backends (pre-S3 item E).
 *
 * A backend raises ONE toast through a platform tool — `powershell.exe` (Windows), `osascript`
 * (macOS), `notify-send`/`gdbus` (Linux) — always via `spawnCapture` (hidden window on Windows,
 * bounded, never rejects) with a minimal environment and a timeout. The policy around it — config,
 * `title_only`, rate limiting, logging — lives in `os-notifications.ts`, not in a backend.
 *
 * The single rule every backend shares: title and body are UNTRUSTED. A watcher body carries an
 * indexed item title, so it can contain anything a third party typed into a ticket. No backend
 * ever splices that text into something a tool will PARSE — a PowerShell script, an AppleScript
 * statement, a GVariant literal — without an encoding whose alphabet cannot break out of it. Each
 * backend's file states which channel it uses and why it is safe; its tests prove it with hostile
 * strings.
 */
import type { SpawnCaptureOptions, SpawnCaptureResult } from "../spawn-capture.ts";

/** The `spawnCapture` signature, injected so tests never spawn a real process. */
export type NotificationSpawner = (
  argv: readonly string[],
  options: SpawnCaptureOptions,
) => Promise<SpawnCaptureResult>;

/** A source of environment variables (default `process.env`); injected for tests. */
export type NotificationEnvSource = Readonly<Record<string, string | undefined>>;

export type NotificationProbeResult = {
  readonly available: boolean;
  /** Why the backend is unavailable. Never carries notification text. */
  readonly reason?: string;
};

export type NotificationBackendId = "windows-toast" | "macos-osascript" | "linux-libnotify";

export interface NotificationBackend {
  readonly id: NotificationBackendId;
  /** Never rejects: a failure resolves `{ available: false, reason }`. */
  probe(): Promise<NotificationProbeResult>;
  /** Rejects with `NotificationSendError` when the tool fails. The error never carries the text. */
  send(title: string, body: string): Promise<void>;
}

/** A send failure. `message` is a short, text-free reason (exit code / timeout), never stderr. */
export class NotificationSendError extends Error {
  override readonly name = "NotificationSendError";
}

/**
 * Length caps, in code points. Toast UIs truncate far below these anyway; the cap exists to keep
 * every command line far below Windows' 32,767-character limit (the Windows backend's encoded
 * command roughly multiplies the text size by eight) and to bound what a hostile body can make
 * a tool parse.
 */
export const NOTIFICATION_TITLE_MAX_CHARS = 128;
export const NOTIFICATION_BODY_MAX_CHARS = 512;

/** Every backend spawn is killed after this long. */
export const NOTIFICATION_SPAWN_TIMEOUT_MS = 10_000;

const ELLIPSIS = "…";

/**
 * C0 controls except TAB and LF, plus DEL. NUL in particular would make `spawn` throw on POSIX
 * (an argv element cannot contain it), and CR/ESC sequences have no business in a toast.
 */
function isStrippedControl(cp: number): boolean {
  return (cp < 0x20 && cp !== 0x09 && cp !== 0x0a) || cp === 0x7f;
}

/**
 * Normalise one piece of notification text: strip control characters (keeping TAB and LF), then
 * cap to `max` code points — the last kept being `…` when anything was cut. Counting code points,
 * not UTF-16 units, means the cap can never split a surrogate pair into an unpaired half.
 */
export function prepareNotificationText(text: string, max: number): string {
  const points = Array.from(text).filter((ch) => !isStrippedControl(ch.codePointAt(0) ?? 0));
  if (points.length <= max) return points.join("");
  return `${points.slice(0, Math.max(0, max - 1)).join("")}${ELLIPSIS}`;
}

/**
 * Copy only the named variables from `source`, dropping absent/empty ones. A backend's child gets
 * this and nothing else — no credentials or tokens from the gateway's own environment ride along.
 */
export function pickEnv(
  source: NotificationEnvSource,
  keys: readonly string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) {
    const v = source[key];
    if (v !== undefined && v !== "") out[key] = v;
  }
  return out;
}

/** A text-free reason for a failed spawn. Deliberately ignores stderr, which can echo argv. */
export function describeSpawnFailure(tool: string, result: SpawnCaptureResult): string {
  return result.code === null
    ? `${tool} could not be started, was killed, or timed out`
    : `${tool} exited with code ${result.code}`;
}
