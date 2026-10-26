/**
 * `nimbus trust status|refresh` (marketplace trust layer): what the Nimbus trust feed last told this
 * machine, and a manual refresh. Both talk to the running gateway (`trust.status`, `trust.refresh`).
 */
import type { IPCClient } from "../ipc-client/index.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export const TRUST_USAGE =
  "Usage: nimbus trust status [--json]\n       nimbus trust refresh [--json]\n";

export type TrustStatusView = {
  configured: boolean;
  url: string | null;
  rootFingerprint: string | null;
  sequence: number | null;
  lastFetchedAt: number | null;
  lastAttemptedAt: number | null;
  ageDays: number | null;
  intervalHours: number | null;
  counts: {
    revocations: number;
    takedowns: number;
    rotations: number;
    verifiedPublishers: number;
  };
};

export type TrustRefreshView =
  | { status: "accepted"; sequence: number; verified: number }
  | { status: "unchanged"; sequence: number }
  | { status: "not_configured" }
  | { status: "refused"; code: string; detail: string };

const iso = (ms: number | null): string => (ms === null ? "never" : new Date(ms).toISOString());

export function formatTrustStatus(s: TrustStatusView): string {
  const counts =
    `revocations ${s.counts.revocations}, takedowns ${s.counts.takedowns}, ` +
    `rotations ${s.counts.rotations}, verified publishers ${s.counts.verifiedPublishers}\n`;
  if (!s.configured) {
    return `No trust feed is configured in this build.\nStored statements: ${counts}`;
  }
  const age = s.ageDays === null ? "" : ` (${s.ageDays} day${s.ageDays === 1 ? "" : "s"} ago)`;
  return (
    `Trust feed: ${s.url ?? "?"}\n` +
    `Root fingerprint: ${s.rootFingerprint ?? "?"}\n` +
    `Sequence: ${s.sequence === null ? "none accepted yet" : String(s.sequence)}\n` +
    `Last updated: ${iso(s.lastFetchedAt)}${age}\n` +
    `Last attempt: ${iso(s.lastAttemptedAt)}\n` +
    `Checked every: ${s.intervalHours === null ? "?" : `${s.intervalHours} h`}\n` +
    `Stored statements: ${counts}`
  );
}

export function formatTrustRefresh(r: TrustRefreshView): string {
  switch (r.status) {
    case "accepted":
      return `Trust feed updated to sequence ${r.sequence}.\n`;
    case "unchanged":
      return `Trust feed unchanged (sequence ${r.sequence}).\n`;
    case "not_configured":
      return "No trust feed is configured in this build; nothing to refresh.\n";
    case "refused":
      return `Trust feed refresh refused: ${r.code}: ${r.detail}\n`;
  }
}

export interface TrustCmdDeps {
  /** Runs `fn` against the running gateway; the default is the shared `withGatewayIpc` lifecycle. */
  readonly withGateway: <T>(fn: (c: IPCClient) => Promise<T>) => Promise<T>;
  readonly stdout: (s: string) => void;
  readonly stderr: (s: string) => void;
  readonly exit: (code: number) => never;
}

const DEFAULT_DEPS: TrustCmdDeps = {
  withGateway: (fn) => withGatewayIpc(fn),
  stdout: (s) => void process.stdout.write(s),
  stderr: (s) => void process.stderr.write(s),
  exit: (code) => process.exit(code),
};

export async function runTrust(args: string[], deps: TrustCmdDeps = DEFAULT_DEPS): Promise<void> {
  const [sub, ...rest] = args;
  const json = rest.includes("--json");
  const unknown = rest.filter((a) => a !== "--json");
  if ((sub !== "status" && sub !== "refresh") || unknown.length > 0) {
    deps.stderr(TRUST_USAGE);
    deps.exit(2);
  }
  if (sub === "status") {
    const s = await deps.withGateway((c) => c.call<TrustStatusView>("trust.status", {}));
    deps.stdout(
      json
        ? `${JSON.stringify(s, null, 2)}
`
        : formatTrustStatus(s),
    );
    return;
  }
  const r = await deps.withGateway((c) => c.call<TrustRefreshView>("trust.refresh", {}));
  deps.stdout(
    json
      ? `${JSON.stringify(r, null, 2)}
`
      : formatTrustRefresh(r),
  );
  if (r.status === "refused") deps.exit(1);
}
