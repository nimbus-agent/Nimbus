import type { CaptureDetail, CaptureSummary } from "../../ipc/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Time left on a proposed action; past due reads as due (the next list call sweeps it). */
export function formatTimeLeft(expiresAt: number, nowMs: number): string {
  const d = expiresAt - nowMs;
  if (d <= 0) return "expiry due";
  if (d < HOUR) return `expires in ${Math.max(1, Math.floor(d / MIN))} min`;
  if (d < DAY) return `expires in ${Math.floor(d / HOUR)} h`;
  return `expires in ${Math.floor(d / DAY)} d`;
}

const PURGEABLE: ReadonlySet<string> = new Set(["executed", "failed", "rejected", "expired"]);

/**
 * The terminal commands that act on this capture. The page performs none of them: every owner verb
 * stays CLI-only (it is absent from the Tauri allowlist), and this is only what to type.
 */
export function terminalCommands(
  c: Pick<CaptureSummary | CaptureDetail, "id" | "kind" | "state">,
): string[] {
  if (c.state === "proposed") {
    return [`nimbus captures accept ${c.id}`, `nimbus captures reject ${c.id}`];
  }
  if (c.state === "live" || c.state === "accepted") return [`nimbus captures revoke ${c.id}`];
  if (c.kind === "action" && PURGEABLE.has(c.state)) return [`nimbus captures purge ${c.id}`];
  return [];
}
