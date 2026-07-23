import { spawnSync } from "node:child_process";
import { join } from "node:path";

function windowsTaskkillExe(): string {
  const root = process.env["SystemRoot"] ?? String.raw`C:\Windows`;
  return join(root, "System32", "taskkill.exe");
}

function unixKillallExe(): string {
  return process.platform === "darwin" ? "/usr/sbin/killall" : "/usr/bin/killall";
}

const UNIX_PKILL = "/usr/bin/pkill";

export type TerminateGatewayBinaryResult = {
  ran: boolean;
  message: string;
};

export function terminateCompiledGatewayBinary(): TerminateGatewayBinaryResult {
  if (process.platform === "win32") {
    const r = spawnSync(windowsTaskkillExe(), ["/F", "/IM", "nimbus-gateway.exe", "/T"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const combined = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
    if (r.status === 0) {
      return { ran: true, message: "Terminated nimbus-gateway.exe (and child processes)." };
    }
    if (r.status === 128) {
      return { ran: true, message: "No nimbus-gateway.exe process was running." };
    }
    const statusMsg = `taskkill exited ${String(r.status)}`;
    const detail = combined === "" ? "" : `: ${combined}`;
    return {
      ran: true,
      message: `${statusMsg}${detail}`,
    };
  }

  let r = spawnSync(unixKillallExe(), ["nimbus-gateway"], { stdio: "ignore" });
  const killallErr = r.error;
  if (
    killallErr !== undefined &&
    killallErr !== null &&
    typeof killallErr === "object" &&
    "code" in killallErr &&
    killallErr.code === "ENOENT"
  ) {
    r = spawnSync(UNIX_PKILL, ["-x", "nimbus-gateway"], { stdio: "ignore" });
  }
  if (r.status === 0) {
    return { ran: true, message: "Sent signal to nimbus-gateway process(es)." };
  }
  return { ran: true, message: "No nimbus-gateway process found (killall/pkill)." };
}
