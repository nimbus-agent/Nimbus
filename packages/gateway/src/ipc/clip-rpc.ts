import { randomBytes } from "node:crypto";
import { listClipFingerprints, revokeClipToken } from "../clips/clip-token-store.ts";
import type { PairingWindowController } from "../clips/pairing-window.ts";
import type { NimbusVault } from "../vault/nimbus-vault.ts";

export interface ClipRpcDeps {
  readonly pairing: PairingWindowController;
  readonly vault: NimbusVault;
  /**
   * The gateway's loopback HTTP origin (e.g. `http://127.0.0.1:7474`), present only when the
   * read-only HTTP sidecar is running (NIMBUS_HTTP_PORT set). Echoed back by `clip.pair` so the
   * CLI can print the exact URL to paste into the extension. Undefined → the clip surface isn't
   * reachable, and the CLI warns the owner to (re)start with `nimbus serve --port`.
   */
  readonly httpBaseUrl?: string;
}

type Outcome = { kind: "hit"; value: unknown } | { kind: "miss" };

function asRecord(p: unknown): Record<string, unknown> {
  return p !== null && typeof p === "object" ? (p as Record<string, unknown>) : {};
}

export async function dispatchClipRpc(
  method: string,
  params: unknown,
  deps: ClipRpcDeps,
): Promise<Outcome> {
  const rec = asRecord(params);
  switch (method) {
    case "clip.pair": {
      // Random suffix, NOT a memory-only counter: a counter resets to 0 on gateway restart and a
      // fresh "device-1" would overwrite an existing "device-1" token in the Vault map.
      const label =
        typeof rec["label"] === "string" && rec["label"].length > 0
          ? (rec["label"] as string)
          : `device-${randomBytes(3).toString("hex")}`;
      const { code, expiresAtMs } = deps.pairing.open(label);
      return {
        kind: "hit",
        value: {
          code,
          expiresAtMs,
          label,
          ...(deps.httpBaseUrl === undefined ? {} : { gatewayUrl: deps.httpBaseUrl }),
        },
      };
    }
    case "clip.status": {
      const devices = await listClipFingerprints(deps.vault);
      return { kind: "hit", value: { devices } };
    }
    case "clip.revoke": {
      const label = typeof rec["label"] === "string" ? (rec["label"] as string) : "";
      if (label === "") return { kind: "hit", value: { revoked: 0 } };
      const revoked = await revokeClipToken(deps.vault, label);
      return { kind: "hit", value: { revoked } };
    }
    default:
      return { kind: "miss" };
  }
}
