import { IPCClient } from "../ipc-client/index.ts";

/**
 * Request-timeout budgets for the CLI's IPC clients, and the single constructor
 * that applies them.
 *
 * `IPCClient` bounds EVERY `call()` with `requestTimeoutMs` (default 30_000). The
 * timer is armed at send time and cleared only by the matching response — no
 * incoming notification resets it, so a method that streams progress for minutes
 * still dies at the bound. Nearly every Gateway method answers in milliseconds, so
 * 30s is the right default: it surfaces an alive-but-wedged Gateway quickly.
 *
 * It is the wrong bound for two classes of call, and both were shipping broken:
 *
 *   1. The handler awaits the WHOLE operation. `connector.sync` awaits a full sync
 *      run, `index.regraph` re-walks every indexed item, `data.export` packs and
 *      encrypts a bundle. Past 30s the CLI printed
 *      `IPC request timed out after 30000ms: <method>` and exited 1 while the
 *      operation ran to completion server-side — so the command reported failure
 *      for work that succeeded, and a user who re-ran it queued the work twice.
 *
 *   2. The call can block on a HUMAN. A HITL gate raises `consent.request`, and the
 *      CLI answers from a `@clack` `confirm()` that runs INSIDE the still-pending
 *      call's window (see `interactive-ipc-handlers.ts`). The bound therefore became
 *      the user's think time: answer the y/n prompt slower than 30s and the call it
 *      belonged to was already dead. This bit regardless of data volume — a
 *      one-item index included.
 *
 * A DEAD Gateway does not depend on these timers. `IPCClient.failAll` rejects every
 * pending `call()` on socket close or error, so a long budget still fails fast when
 * the socket dies. The timeout backstops only a Gateway that is alive and silent,
 * which is why these values are long but FINITE: `requestTimeoutMs: 0` disables the
 * timer outright and restores the hang-forever behaviour the transport's own
 * docblock records it was added to prevent. (The Tauri bridge takes the opposite
 * side of that trade for its five `NO_TIMEOUT_METHODS`; the CLI does not follow it.)
 *
 * These are opt-in per construction site rather than raised globally because
 * `requestTimeoutMs` is a per-CLIENT constructor option, not per-call. A client that
 * issues one long call and a dozen fast ones would otherwise lose the tight bound on
 * all of them.
 */

/**
 * Machine-bound work: a full connector sync, a whole-index regraph or reindex, a
 * bundle export/import, an update download + signature verify + install. Larger than
 * {@link INTERACTIVE_RPC_TIMEOUT_MS} because the ceiling is the user's data volume,
 * which the CLI cannot predict — a first full sync of a large mailbox is legitimately
 * slow, and cutting it off is exactly the bug this replaces.
 */
export const BATCH_RPC_TIMEOUT_MS = 6 * 60 * 60 * 1_000;

/**
 * Human-bound work: an agent or workflow run that can raise a HITL prompt the user
 * answers at a `confirm()`. The ceiling here is a person's attention span, not a
 * data volume, so it is the shorter of the two — a run still pending an hour after
 * the prompt appeared is one the user has walked away from.
 */
export const INTERACTIVE_RPC_TIMEOUT_MS = 60 * 60 * 1_000;

/**
 * Build an `IPCClient`, applying `requestTimeoutMs` only when one is supplied.
 *
 * The conditional matters under `exactOptionalPropertyTypes`: passing
 * `{ requestTimeoutMs: undefined }` is a type error, and passing it as a present-but-
 * undefined key would in any case defeat the transport's own `?? DEFAULT` fallback.
 * Routing every timeout-aware construction through here keeps that detail in one
 * place instead of at each call site.
 */
export function createIpcClient(socketPath: string, requestTimeoutMs?: number): IPCClient {
  return requestTimeoutMs === undefined
    ? new IPCClient(socketPath)
    : new IPCClient(socketPath, { requestTimeoutMs });
}
