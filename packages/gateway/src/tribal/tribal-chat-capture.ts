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
    .replace(/<@[^<>]+>/g, " ")
    .replace(/@\w+/g, " ")
    .trim();
  // Tokenize on whitespace rather than matching one regex with an optional `(.*)` tail — a single
  // linear split avoids the super-linear backtracking Sonar flags (S8786). Command shape:
  // `tribal capture <cluster-id> [--target notion|confluence]`.
  const tokens = cleaned.split(/\s+/);
  if (tokens.length < 3) return undefined;
  if (tokens[0]?.toLowerCase() !== "tribal" || tokens[1]?.toLowerCase() !== "capture") {
    return undefined;
  }
  const clusterId = tokens[2] ?? "";
  if (clusterId === "" || clusterId.startsWith("--")) return undefined;
  const rest = tokens.slice(3).join(" ");
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
    // `TribalCaptureResult` makes `pageRef`/`error` non-optional on each arm of the union, so no
    // nullish fallback is reachable here.
    await deps.reply(`✅ Captured ${cmd.clusterId} to the team KB (${result.pageRef}).`);
  } else {
    await deps.reply(`Capture of ${cmd.clusterId} was not completed: ${result.error}.`);
  }
}
