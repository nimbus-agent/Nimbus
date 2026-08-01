import { readFileSync } from "node:fs";

import { confirm, isCancel } from "@clack/prompts";

import type { IPCClient } from "../ipc-client/index.ts";

export function registerAgentChunkStdout(client: IPCClient): void {
  client.onNotification("agent.chunk", (params: unknown) => {
    const t = (params as { text?: string }).text;
    if (typeof t === "string" && t.length > 0) {
      process.stdout.write(t);
    }
  });
}

type ConfirmFn = (opts: { message: string }) => Promise<boolean | symbol>;

export function registerConsentPromptHandler(
  client: IPCClient,
  confirmFn: ConfirmFn = confirm,
): void {
  client.onNotification("consent.request", async (params: unknown) => {
    const p = params as { requestId?: string; prompt?: string };
    if (typeof p.requestId !== "string") {
      return;
    }
    const message = typeof p.prompt === "string" ? p.prompt : "Approve action?";
    const ok = await confirmFn({ message });
    const approved = !isCancel(ok) && ok === true;
    await client.call("consent.respond", {
      requestId: p.requestId,
      approved,
    });
  });
}

/**
 * Answer the Gateway's HITL `consent.request` with an approval the caller has ALREADY obtained
 * from the user, so the same removal/export is never confirmed twice.
 *
 * `sourceLabel` names where that approval came from and is echoed on stderr so the transcript
 * still shows an auto-approval happened: `--yes` (the default) for a flag-driven run, or e.g.
 * `confirmed` when an interactive CLI-side prompt already asked the same question. Registering
 * this handler on a client is what turns an otherwise-hanging HITL call into a completed one —
 * without a `consent.request` handler the Gateway's gate never receives `consent.respond` and
 * the request dies on the client's 30s timeout.
 */
export function registerAutoApproveConsentHandler(client: IPCClient, sourceLabel = "--yes"): void {
  client.onNotification("consent.request", async (params: unknown) => {
    const p = params as { requestId?: string; prompt?: string };
    if (typeof p.requestId !== "string") {
      return;
    }
    const detail = typeof p.prompt === "string" && p.prompt.length > 0 ? p.prompt : p.requestId;
    process.stderr.write(`[${sourceLabel}] auto-approving HITL request: ${detail}\n`);
    await client.call("consent.respond", {
      requestId: p.requestId,
      approved: true,
    });
  });
}

interface ScriptDecision {
  readonly approved: boolean;
  readonly note?: string;
}

export function registerScriptConsentHandler(client: IPCClient, source: string): void {
  let decisions: ReadonlyArray<ScriptDecision>;
  try {
    const text = readFileSync(source, "utf8");
    decisions = text
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line, lineIdx) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(line);
        } catch (err) {
          throw new Error(
            `--script-consent-source: malformed JSONL on line ${lineIdx + 1}: ${(err as Error).message}`,
          );
        }
        if (typeof parsed !== "object" || parsed === null) {
          throw new Error(
            `--script-consent-source: malformed JSONL on line ${lineIdx + 1}: not an object`,
          );
        }
        const o = parsed as Record<string, unknown>;
        if (typeof o["approved"] !== "boolean") {
          throw new TypeError(
            `--script-consent-source: malformed JSONL on line ${lineIdx + 1}: missing or non-boolean "approved"`,
          );
        }
        return {
          approved: o["approved"],
          ...(typeof o["note"] === "string" ? { note: o["note"] } : {}),
        };
      });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(`--script-consent-source: script consent source not found: ${source}`);
    }
    throw err;
  }
  let cursor = 0;
  client.onNotification("consent.request", async (params: unknown) => {
    const p = params as { requestId?: string; prompt?: string };
    if (typeof p.requestId !== "string") {
      return;
    }
    if (cursor >= decisions.length) {
      throw new Error(
        `--script-consent-source: no scripted decision for consent request "${p.requestId}" (exhausted at line ${cursor})`,
      );
    }
    const decision = decisions[cursor];
    if (decision === undefined) {
      throw new Error(
        `--script-consent-source: internal error reading decision at cursor ${cursor}`,
      );
    }
    cursor += 1;
    const promptText = typeof p.prompt === "string" ? p.prompt : "(no prompt)";
    const decisionWord = decision.approved ? "approve" : "reject";
    const noteSuffix = decision.note === undefined ? "" : ` — ${decision.note}`;
    process.stdout.write(
      `[consent.request] ${promptText}\n[scripted: ${decisionWord}]${noteSuffix}\n`,
    );
    await client.call("consent.respond", {
      requestId: p.requestId,
      approved: decision.approved,
    });
  });
}

export interface SelectConsentHandlerOptions {
  readonly yes: boolean;
  readonly scriptConsentSource?: string;
}

export function selectConsentHandler(client: IPCClient, opts: SelectConsentHandlerOptions): void {
  if (opts.scriptConsentSource !== undefined && opts.scriptConsentSource.length > 0) {
    if (opts.yes) {
      process.stderr.write(
        "[warn] --script-consent-source overrides --yes; consent decisions come from the JSONL file.\n",
      );
    }
    registerScriptConsentHandler(client, opts.scriptConsentSource);
    return;
  }
  if (opts.yes) {
    registerAutoApproveConsentHandler(client);
    return;
  }
  registerConsentPromptHandler(client);
}

export function registerInteractiveCliIpcHandlers(client: IPCClient): void {
  const scriptSource = process.env["NIMBUS_SCRIPT_CONSENT_SOURCE"];
  if (scriptSource !== undefined && scriptSource.length > 0) {
    registerScriptConsentHandler(client, scriptSource);
  } else {
    registerConsentPromptHandler(client);
  }
  registerAgentChunkStdout(client);
}
