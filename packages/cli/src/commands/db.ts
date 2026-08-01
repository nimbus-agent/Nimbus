import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { isProcessAlive, readGatewayState } from "../lib/gateway-process.ts";
import { restoreDbFromSnapshot } from "../lib/restore-db-from-snapshot.ts";
import { withGatewayIpc } from "../lib/with-gateway-ipc.ts";
import { getCliPlatformPaths } from "../paths.ts";

function takeFlag(args: string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  if (i < 0 || i + 1 >= args.length) {
    return undefined;
  }
  return args[i + 1];
}

/** Mirrors the gateway's `VerifyFinding` (packages/gateway/src/db/verify.ts). */
type VerifyFinding = { label: string; status: "ok" | "fail"; detail?: string };

/** Mirrors the gateway's `RepairReport` (packages/gateway/src/db/repair.ts). */
type RepairReport = {
  outcomes: Array<{ action: string; status: "applied" | "skipped" | "error"; detail?: string }>;
  repairedAt: string;
};

async function dbCmdVerify(tail: string[]): Promise<void> {
  const json = tail.includes("--json");
  const r = await withGatewayIpc((c) =>
    c.call<{ clean: boolean; findings: VerifyFinding[]; formatted: string; exitCode: number }>(
      "db.verify",
      {},
    ),
  );
  if (json) {
    // `formatted` is the gateway's pre-rendered human report — dropped here so stdout carries only
    // structured data. `exitCode` is kept in the document AND applied to the process.
    console.log(
      JSON.stringify({ clean: r.clean, findings: r.findings, exitCode: r.exitCode }, null, 2),
    );
  } else {
    console.log(r.formatted);
  }
  process.exitCode = r.exitCode;
}

async function dbCmdRepair(tail: string[]): Promise<void> {
  const yes = tail.includes("--yes");
  if (!yes) {
    throw new Error("Usage: nimbus db repair --yes");
  }
  const json = tail.includes("--json");
  const r = await withGatewayIpc((c) =>
    c.call<{ report: RepairReport; formatted: string }>("db.repair", { confirm: true }),
  );
  if (json) {
    // The structured `report` only; `formatted` is its human rendering.
    console.log(JSON.stringify(r.report, null, 2));
    return;
  }
  console.log(r.formatted);
}

async function dbCmdSnapshot(): Promise<void> {
  const r = await withGatewayIpc((c) => c.call<{ path: string }>("db.snapshot.take", {}));
  console.log(r.path);
}

async function dbCmdSnapshotsList(): Promise<void> {
  const rows = await withGatewayIpc((c) =>
    c.call<
      Array<{
        filename: string;
        timestampMs: number;
        compressedSizeBytes: number;
        path: string;
      }>
    >("db.snapshots.list", {}),
  );
  if (rows.length === 0) {
    console.log("No snapshots yet.");
    return;
  }
  for (const e of rows) {
    console.log(
      `${e.filename}\t${String(e.timestampMs)}\t${String(e.compressedSizeBytes)} B\t${e.path}`,
    );
  }
}

async function dbCmdSnapshotsPrune(tail: string[]): Promise<void> {
  const yes = tail.includes("--yes");
  if (!yes) {
    throw new Error("Usage: nimbus db snapshots prune --yes [--keep-last N]");
  }
  const keepRaw = takeFlag(tail, "--keep-last");
  const keepLast = keepRaw === undefined ? Number.NaN : Number.parseInt(keepRaw, 10);
  const params: { confirm: true; keepLast?: number } = { confirm: true };
  if (Number.isFinite(keepLast) && keepLast > 0) {
    params.keepLast = Math.floor(keepLast);
  }
  const r = await withGatewayIpc((c) =>
    c.call<{ deleted: number; keepLast: number }>("db.snapshots.prune", params),
  );
  console.log(`Pruned ${String(r.deleted)} snapshot(s); keep_last=${String(r.keepLast)}`);
}

async function dbCmdBackupsList(): Promise<void> {
  const rows = await withGatewayIpc((c) => c.call<unknown[]>("db.backups.list", {}));
  console.log(JSON.stringify(rows, null, 2));
}

async function dbCmdRestore(tail: string[]): Promise<void> {
  const snap = tail[0]?.trim() ?? "";
  if (snap === "") {
    throw new Error("Usage: nimbus db restore <snapshot.db.gz> [--yes]");
  }
  const yes = tail.includes("--yes");
  const paths = getCliPlatformPaths();
  const state = await readGatewayState(paths);
  if (state !== undefined && isProcessAlive(state.pid)) {
    throw new Error("Stop the Gateway before restoring the database file (nimbus stop).");
  }
  if (!yes) {
    console.log(
      "Restoring overwrites nimbus.db. Stop the Gateway, then run:\n" +
        `  nimbus db restore ${snap} --yes`,
    );
    return;
  }
  const dbPath = join(paths.dataDir, "nimbus.db");
  mkdirSync(paths.dataDir, { recursive: true });
  restoreDbFromSnapshot(snap, dbPath);
  console.log(`Restored database from ${snap}`);
}

export async function runDb(args: string[]): Promise<void> {
  const sub = args[0];
  const tail = args.slice(1);
  if (sub === undefined || sub === "help" || sub === "--help" || sub === "-h") {
    printDbHelp();
    return;
  }

  if (sub === "verify") {
    await dbCmdVerify(tail);
    return;
  }

  if (sub === "repair") {
    await dbCmdRepair(tail);
    return;
  }

  if (sub === "snapshot") {
    await dbCmdSnapshot();
    return;
  }

  if (sub === "snapshots") {
    const op = tail[0];
    if (op === "list") {
      await dbCmdSnapshotsList();
      return;
    }
    if (op === "prune") {
      await dbCmdSnapshotsPrune(tail);
      return;
    }
    throw new Error(
      "Usage: nimbus db snapshots list | nimbus db snapshots prune --yes [--keep-last N]",
    );
  }

  if (sub === "backups") {
    const op = tail[0];
    if (op !== "list") {
      throw new Error("Usage: nimbus db backups list");
    }
    await dbCmdBackupsList();
    return;
  }

  if (sub === "restore") {
    await dbCmdRestore(tail);
    return;
  }

  throw new Error(`Unknown db subcommand: ${sub}. Try: nimbus db help`);
}

function printDbHelp(): void {
  console.log(`nimbus db — index integrity and snapshots (Gateway IPC)

Usage:
  nimbus db verify [--json]
  nimbus db repair --yes [--json]
  nimbus db snapshot
  nimbus db snapshots list
  nimbus db snapshots prune --yes [--keep-last N]
  nimbus db backups list
  nimbus db restore <path-to.db.gz> [--yes]   (requires Gateway stopped; destructive)
`);
}
