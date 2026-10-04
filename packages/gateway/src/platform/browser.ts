import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import { win32 as pathWin32 } from "node:path";

/**
 * What `openUrlInDefaultBrowser` reads from the machine it runs on. A parameter rather than direct
 * `process.*` reads only so a test can drive every platform's launcher without opening a real
 * browser; production passes nothing and gets the live process, read at call time.
 */
export interface OpenUrlHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly spawn: typeof nodeSpawn;
}

function liveHost(): OpenUrlHost {
  return { platform: process.platform, env: process.env, spawn: nodeSpawn };
}

export async function openUrlInDefaultBrowser(
  url: string,
  host: OpenUrlHost = liveHost(),
): Promise<void> {
  const detachedIgnore: SpawnOptions = { detached: true, stdio: "ignore" };
  const { platform: os, env, spawn } = host;

  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof spawn>;
    if (os === "win32") {
      const systemRoot = env["SystemRoot"] ?? env["windir"] ?? String.raw`C:\Windows`;
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
