import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";

export type LanSubcommand =
  | { kind: "status" }
  | { kind: "open" }
  | { kind: "close" }
  | { kind: "peers" }
  | { kind: "grant"; peerId: string }
  | { kind: "revoke"; peerId: string }
  | { kind: "remove"; peerId: string };

export function parseLanArgs(argv: string[]): LanSubcommand {
  const [sub, ...rest] = argv;
  switch (sub) {
    case "status":
    case undefined:
      return { kind: "status" };
    case "open":
      return { kind: "open" };
    case "close":
      return { kind: "close" };
    case "peers":
      return { kind: "peers" };
    case "grant": {
      const peerId = rest[0];
      if (!peerId || peerId.trim() === "") throw new Error("Usage: nimbus lan grant <peerId>");
      return { kind: "grant", peerId: peerId.trim() };
    }
    case "revoke": {
      const peerId = rest[0];
      if (!peerId || peerId.trim() === "") throw new Error("Usage: nimbus lan revoke <peerId>");
      return { kind: "revoke", peerId: peerId.trim() };
    }
    case "remove": {
      const peerId = rest[0];
      if (!peerId || peerId.trim() === "") throw new Error("Usage: nimbus lan remove <peerId>");
      return { kind: "remove", peerId: peerId.trim() };
    }
    default:
      throw new Error(
        `Unknown subcommand: ${sub}\nUsage: nimbus lan [status|open|close|peers|grant|revoke|remove]`,
      );
  }
}

async function lanStatus(): Promise<void> {
  const result = await withGatewayIpc((c) =>
    c.call<{
      enabled: boolean;
      pairingOpen: boolean;
      listenAddr: string | null;
      peers?: Array<{ peerId: string; direction: string; protoVersion: 1 | 2 }>;
      peersByProtocol?: { v1: number; v2: number };
    }>("lan.getStatus", {}),
  );
  console.log(`LAN enabled:  ${String(result.enabled)}`);
  console.log(`Pairing open: ${String(result.pairingOpen)}`);
  console.log(`Listen addr:  ${result.listenAddr ?? "(none)"}`);
  const by = result.peersByProtocol ?? { v1: 0, v2: 0 };
  console.log(
    `Peers:        ${String(by.v2)} on v2 (forward secret), ${String(by.v1)} on v1 (cannot connect)`,
  );
  for (const p of result.peers ?? []) {
    console.log(`  ${p.peerId.padEnd(24)} ${p.direction.padEnd(9)} v${String(p.protoVersion)}`);
  }
  if (by.v1 > 0) {
    console.log(
      `WARNING: ${String(by.v1)} paired peer(s) are still recorded on the v1 LAN wire, which this version no longer speaks, so they are refused. Upgrade each one to this release or newer; it moves to v2 on its first session with this gateway. If it cannot be upgraded, remove it (nimbus lan remove <peerId>).`,
    );
  }
}

async function lanOpen(): Promise<void> {
  const result = await withGatewayIpc((c) =>
    c.call<{ pairingCode: string; expiresAt: number }>("lan.openPairingWindow", {}),
  );
  const expiry = new Date(result.expiresAt).toISOString();
  console.log(`Pairing window open.`);
  console.log(`Pairing code: ${result.pairingCode}`);
  console.log(`Expires at:   ${expiry}`);
}

async function lanClose(): Promise<void> {
  await withGatewayIpc((c) => c.call<{ ok: boolean }>("lan.closePairingWindow", {}));
  console.log("Pairing window closed.");
}

async function lanPeers(): Promise<void> {
  const result = await withGatewayIpc((c) =>
    c.call<{
      peers: Array<{ peerId: string; displayName?: string; writeAllowed: boolean }>;
    }>("lan.listPeers", {}),
  );
  if (result.peers.length === 0) {
    console.log("No LAN peers.");
    return;
  }
  console.log(`${"Peer ID".padEnd(36)} ${"Write".padEnd(6)} Name`);
  console.log("-".repeat(60));
  for (const p of result.peers) {
    const write = p.writeAllowed ? "yes" : "no";
    const name = p.displayName ?? "(unknown)";
    console.log(`${p.peerId.padEnd(36)} ${write.padEnd(6)} ${name}`);
  }
}

async function lanGrant(peerId: string): Promise<void> {
  await withGatewayIpc((c) => c.call<{ ok: boolean }>("lan.grantWrite", { peerId }));
  console.log(`Write access granted to peer ${peerId}.`);
}

async function lanRevoke(peerId: string): Promise<void> {
  await withGatewayIpc((c) => c.call<{ ok: boolean }>("lan.revokeWrite", { peerId }));
  console.log(`Write access revoked for peer ${peerId}.`);
}

async function lanRemove(peerId: string): Promise<void> {
  await withGatewayIpc((c) => c.call<{ ok: boolean }>("lan.removePeer", { peerId }));
  console.log(`Peer ${peerId} removed.`);
}

export async function runLan(argv: string[]): Promise<void> {
  const sub = parseLanArgs(argv);
  switch (sub.kind) {
    case "status":
      return lanStatus();
    case "open":
      return lanOpen();
    case "close":
      return lanClose();
    case "peers":
      return lanPeers();
    case "grant":
      return lanGrant(sub.peerId);
    case "revoke":
      return lanRevoke(sub.peerId);
    case "remove":
      return lanRemove(sub.peerId);
  }
}
