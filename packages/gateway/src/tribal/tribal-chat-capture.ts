import type { TribalCaptureResult } from "../ipc/tribal-rpc.ts";

export interface ParsedTribalCaptureCommand {
  clusterId: string;
  target?: "notion" | "confluence";
}

/**
 * Recognize an in-chat capture command `tribal capture <cluster-id> [--target notion|confluence]`
 * (the `@nimbus` mention is already stripped upstream). Returns undefined for anything else, so the
 * message falls through to the normal IntentRouter. The in-chat trigger is a convenience atop the
 * primary CLI path; the capture itself still fires the LOCAL owner's HITL gate (I25).
 */
export function parseTribalCaptureCommand(text: string): ParsedTribalCaptureCommand | undefined {
  // strip a leading mention token (e.g. "<@U123>" / "@nimbus") then normalize whitespace
  const cleaned = text
    .replace(/<@[^>]+>/g, " ")
    .replace(/@\w+/g, " ")
    .trim();
  const m = /^tribal\s+capture\s+(\S+)(.*)$/i.exec(cleaned);
  if (m === null) return undefined;
  const clusterId = m[1] ?? "";
  if (clusterId === "" || clusterId.startsWith("--")) return undefined;
  const rest = m[2] ?? "";
  const tm = /--target\s+(notion|confluence)\b/i.exec(rest);
  if (tm !== null) {
    return { clusterId, target: tm[1]?.toLowerCase() as "notion" | "confluence" };
  }
  return { clusterId };
}

export interface ChatCaptureDeps {
  /** Run the capture (encapsulating synthesize + the owner-HITL submitAction). */
  capture: (clusterId: string, target?: "notion" | "confluence") => Promise<TribalCaptureResult>;
  /** Post a reply to the originating channel (I23 reply seam). */
  reply: (text: string) => Promise<void>;
}

/** Execute a parsed in-chat capture command and report the outcome back in-channel. */
export async function handleTribalCaptureCommand(
  deps: ChatCaptureDeps,
  cmd: ParsedTribalCaptureCommand,
): Promise<void> {
  let result: TribalCaptureResult;
  try {
    result = await deps.capture(cmd.clusterId, cmd.target);
  } catch (err) {
    await deps.reply(
      `Capture of ${cmd.clusterId} failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }
  if (result.ok) {
    await deps.reply(`✅ Captured ${cmd.clusterId} to the team KB (${result.pageRef ?? "saved"}).`);
  } else {
    await deps.reply(
      `Capture of ${cmd.clusterId} was not completed: ${result.error ?? "unknown"}.`,
    );
  }
}
