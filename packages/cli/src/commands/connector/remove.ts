import { confirm, isCancel } from "@clack/prompts";

import { BATCH_RPC_TIMEOUT_MS } from "../../lib/rpc-timeouts.ts";
import { withIpc } from "./shared.ts";

const REMOVE_YES_FLAGS: ReadonlySet<string> = new Set(["--yes", "-y"]);

type ConnectorRemoveResult = {
  ok: boolean;
  itemsDeleted: number;
  vaultKeysRemoved: string[];
};

/**
 * Shape the Gateway returns instead of {@link ConnectorRemoveResult} when the executor's HITL
 * gate rejects the action (`{ kind: "hit", value: { status: "rejected", reason } }` in
 * `ipc/connector-rpc.ts`). Detecting it keeps a declined removal from printing
 * `Removed index rows: undefined` and exiting 0.
 */
type ConnectorRemoveRejection = { status: "rejected"; reason?: string };

function isConnectorRemoveRejection(r: unknown): r is ConnectorRemoveRejection {
  return typeof r === "object" && r !== null && (r as { status?: unknown }).status === "rejected";
}

/**
 * `nimbus connector remove` is irreversible (Vault entries + index rows are deleted
 * atomically), so it is gated the same way `nimbus extension remove` is: an interactive
 * confirmation, `--yes`/`-y` to skip it for scripts, and a fail-closed refusal rather
 * than a hanging prompt when there is no TTY to prompt on.
 *
 * `connector.remove` is ALSO in the executor's frozen HITL set, so the Gateway pushes a
 * `consent.request` notification and blocks until `consent.respond` arrives. The two
 * confirmations are composed, not stacked: this CLI prompt is the single point of consent,
 * and the decision it produces is what answers the Gateway. A declined prompt returns before
 * any IPC connection is made, so the Gateway never sees the request at all; an accepted
 * prompt (or `--yes`) registers an auto-approve `consent.request` handler on the client that
 * `withIpc` builds, so the gate is answered programmatically with the decision the user
 * already gave. Without that handler nothing would ever answer and the call would die on the
 * client's 30s request timeout, removing nothing.
 */
export async function runConnectorRemove(tail: string[]): Promise<void> {
  const accept = tail.some((a) => REMOVE_YES_FLAGS.has(a));
  const service = tail.find((a) => !REMOVE_YES_FLAGS.has(a));
  if (service === undefined) {
    throw new Error("Usage: nimbus connector remove <service> [--yes]");
  }
  if (!accept) {
    const interactive = process.stdin.isTTY === true && process.stdout.isTTY === true;
    if (!interactive) {
      throw new Error(
        "Refusing to remove without confirmation in non-TTY mode. Pass --yes to proceed.",
      );
    }
    const ok = await confirm({
      message: `Remove connector "${service}"? This deletes its Vault credentials and index rows. This cannot be undone.`,
    });
    if (isCancel(ok) || ok !== true) {
      console.log("Cancelled.");
      return;
    }
  }
  const res = await withIpc(
    (c) =>
      c.call<ConnectorRemoveResult | ConnectorRemoveRejection>("connector.remove", {
        serviceId: service,
      }),
    { kind: "auto", sourceLabel: accept ? "--yes" : "confirmed" },
  );
  if (isConnectorRemoveRejection(res)) {
    throw new Error(
      `Gateway rejected the removal of "${service}": ${res.reason ?? "no reason given"}`,
    );
  }
  console.log(`Removed index rows: ${String(res.itemsDeleted)}`);
  if (res.vaultKeysRemoved.length > 0) {
    console.log(`Cleared vault keys: ${res.vaultKeysRemoved.join(", ")}`);
  }
}

export async function runConnectorReindex(args: string[]): Promise<void> {
  const service = args[0];
  if (service === undefined) {
    throw new Error(
      "Usage: nimbus connector reindex <name> [--depth <metadata_only|summary|full>]",
    );
  }
  const depthIdx = args.indexOf("--depth");
  const depth = depthIdx >= 0 ? (args[depthIdx + 1] ?? "metadata_only") : "metadata_only";
  // `--depth full` is HITL-gated (`ipc/reindex-rpc.ts` gates on `connector.reindex`
  // before doing any work), so this MUST register a `consent.request` handler: the
  // Gateway blocks on `consent.respond`, and a client that never answers just times
  // out. Without it `reindex --depth full` failed 100% of the time regardless of
  // index size — same defect, and same fix, as `connector remove` (#1013).
  //
  // The prompt handler is the right one rather than auto-approve: unlike `remove`,
  // reindex has no `--yes` flag, so no approval has been collected up front and the
  // user must be the one to answer. The batch budget then covers both the human's
  // think time at that prompt and the re-walk itself, which the Gateway awaits.
  const result = await withIpc(
    (c) => c.call<{ itemsAffected: number; mode: string }>("connector.reindex", { service, depth }),
    { kind: "prompt" },
    BATCH_RPC_TIMEOUT_MS,
  );
  console.log(
    `[ok] ${service} reindex ${result.mode} — ${String(result.itemsAffected)} items affected`,
  );
}
