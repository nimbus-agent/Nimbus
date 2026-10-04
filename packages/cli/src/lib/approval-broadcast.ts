import { confirm, isCancel } from "@clack/prompts";
import type { IPCClient } from "../ipc-client/index.ts";
import { INTERACTIVE_RPC_TIMEOUT_MS } from "./rpc-timeouts.ts";
import { withGatewayIpc } from "./with-gateway-ipc.ts";

/**
 * The plumbing shared by the commands that answer a gateway APPROVAL BROADCAST: `nimbus exec`
 * (`exec.approvalRequest`), `nimbus tool create` / `save` (`toolgen.approvalRequest` /
 * `toolgen.saveApprovalRequest`) and `nimbus computer` (`computer.envelopeRequest` /
 * `computer.actionRequest`).
 *
 * None of those gates raises the generic `consent.request` that `withGatewayIpc` already answers:
 * each broadcasts its own method, and the command registers a handler for it before making the call
 * that raises it. What a handler SHOWS the owner, and which respond method it answers over, stay in
 * the command — a prompt that reads the same for two different grants would defeat the reason they
 * are separate broadcasts. What is shared lives here: how an untrusted list field is validated, how
 * the owner's answer is read, and the real-world dependencies the commands are built on.
 */

/**
 * Shows the owner a prompt and resolves with their answer UNINTERPRETED — only
 * {@link isExplicitApproval} decides whether it approves.
 */
export type AskOwner = (message: string) => Promise<unknown>;

/** Sends the owner's decision for one request over the respond method its command wired. */
export type RespondToApproval = (requestId: string, approved: boolean) => Promise<unknown>;

/**
 * A copy of `v` when it is an array of strings, otherwise `[]`.
 *
 * A broadcast crosses a process boundary, so every list field is `unknown` until checked no matter
 * who sent it — and a prompt renderer handed a non-array throws before the owner's answer is sent,
 * leaving the gate to wait out its TTL and report a denial the owner never made. All-or-nothing
 * rather than a filter: an array with even one non-string element yields `[]`, not its string
 * subset. The result is always a fresh array, never the caller's own.
 */
export function stringArrayOrEmpty(v: unknown): string[] {
  return Array.isArray(v) && v.every((e) => typeof e === "string") ? [...(v as string[])] : [];
}

/**
 * Whether the owner's answer APPROVES. Only an explicit boolean `true` does: cancelling the prompt
 * (Ctrl-C) is a denial, and so is every other value — a truthy `1`, the string `"true"`, the
 * `undefined` of an abandoned prompt. Fail-closed, because the alternative is approving by accident.
 *
 * The `=== true` conjunct is what carries that rule: `isCancel` matches only the prompt library's
 * cancel symbol, which `=== true` rejects anyway, so the `isCancel` check states the intent that a
 * cancel is a denial rather than enforcing anything `=== true` does not.
 */
export function isExplicitApproval(answer: unknown): boolean {
  return !isCancel(answer) && answer === true;
}

/** The real-world seams every approval-answering command is built on. */
export interface InteractiveCommandDeps {
  readonly runWithClient: <T>(fn: (c: IPCClient) => Promise<T>) => Promise<T>;
  readonly ask: AskOwner;
  readonly sink: { readonly out: (s: string) => void; readonly err: (s: string) => void };
  readonly setExitCode: (code: number) => void;
}

/**
 * The prompt `ask` shows the owner: `@clack/prompts`' `confirm` in production. A parameter only so
 * a test can see the message it is handed, the same seam `registerConsentPromptHandler` gives the
 * `consent.request` prompt.
 */
type ConfirmPrompt = (opts: { message: string }) => Promise<unknown>;

/**
 * The production {@link InteractiveCommandDeps}: a gateway connection with the INTERACTIVE request
 * budget, `@clack/prompts`' `confirm` as the prompt, this process's own stdout/stderr, and
 * `process.exitCode`. Each command spreads this into its own deps and adds what only it needs.
 *
 * The interactive budget is the point. The call that raises an approval broadcast stays pending
 * while the owner reads the prompt, so the transport's 30s default would become the owner's think
 * time: answer slower than that and the call the answer belonged to is already dead.
 *
 * `ask` hands the prompt the rendered text VERBATIM and sets no other option: that text is what the
 * owner approves. Production callers pass nothing, and `ask` then calls `confirm` itself, resolved
 * at each call exactly as each command's own copy did; `confirmPrompt` exists for the test.
 */
export function interactiveCommandDeps(confirmPrompt?: ConfirmPrompt): InteractiveCommandDeps {
  return {
    runWithClient: (fn) =>
      withGatewayIpc(fn, undefined, { requestTimeoutMs: INTERACTIVE_RPC_TIMEOUT_MS }),
    ask: (message) => (confirmPrompt ?? confirm)({ message }),
    sink: {
      out: (s) => void process.stdout.write(s),
      err: (s) => void process.stderr.write(s),
    },
    setExitCode: (c) => {
      process.exitCode = c;
    },
  };
}
