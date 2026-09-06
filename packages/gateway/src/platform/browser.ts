import { type SpawnOptions, spawn } from "node:child_process";
import type { EventEmitter } from "node:events";
import { win32 as pathWin32 } from "node:path";

export async function openUrlInDefaultBrowser(url: string): Promise<void> {
  const detachedIgnore: SpawnOptions = { detached: true, stdio: "ignore" };

  return new Promise((resolve, reject) => {
    const os = process.platform;
    let child: ReturnType<typeof spawn>;
    if (os === "win32") {
      const systemRoot =
        process.env["SystemRoot"] ?? process.env["windir"] ?? String.raw`C:\Windows`;
      const rundll32 = pathWin32.join(systemRoot, "System32", "rundll32.exe");
      child = spawn(rundll32, ["url.dll,FileProtocolHandler", url], {
        ...detachedIgnore,
        windowsHide: true,
      });
    } else if (os === "darwin") {
      // windows-console-ok: guarded by `os === "darwin"`; unreachable on Windows.
      child = spawn("/usr/bin/open", [url], detachedIgnore);
    } else {
      // windows-console-ok: the non-win32/darwin branch; unreachable on Windows.
      child = spawn("/usr/bin/xdg-open", [url], detachedIgnore);
    }
    (child as unknown as EventEmitter).on("error", (err: Error) => {
      reject(err);
    });
    child.unref();
    resolve();
  });
}
