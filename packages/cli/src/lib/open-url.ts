/**
 * Opens an `https:` URL in the user's default browser (`nimbus extension report`). After the
 * gateway's `platform/browser.ts`, which the CLI may not import; stricter in two ways, because the
 * URL comes from a registry's signed index rather than from Nimbus itself: anything that does not
 * parse as an `https:` URL is refused before a process starts (no `file:` path, scheme handler or
 * leading-hyphen option ever reaches the launcher), and the promise resolves only once the launcher
 * has started, so a missing launcher rejects instead of being reported as opened.
 */
import { spawn as nodeSpawn, type SpawnOptions } from "node:child_process";
import type { EventEmitter } from "node:events";
import { win32 as pathWin32 } from "node:path";

export interface OpenUrlHost {
  readonly platform: NodeJS.Platform;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly spawn: typeof nodeSpawn;
}

function liveHost(): OpenUrlHost {
  return { platform: process.platform, env: process.env, spawn: nodeSpawn };
}

/** The URL, normalised, when it is an `https:` URL; throws otherwise. */
function httpsOnly(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("refusing to open a report destination that is not an https: URL");
  }
  if (url.protocol !== "https:") {
    throw new Error("refusing to open a report destination that is not an https: URL");
  }
  return url.toString();
}

export function openHttpsUrl(raw: string, host: OpenUrlHost = liveHost()): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = httpsOnly(raw);
    const detachedIgnore: SpawnOptions = { detached: true, stdio: "ignore" };
    let child: ReturnType<typeof nodeSpawn>;
    if (host.platform === "win32") {
      const systemRoot = host.env["SystemRoot"] ?? host.env["windir"] ?? String.raw`C:\Windows`;
      const rundll32 = pathWin32.join(systemRoot, "System32", "rundll32.exe");
      child = host.spawn(rundll32, ["url.dll,FileProtocolHandler", url], {
        ...detachedIgnore,
        windowsHide: true,
      });
    } else if (host.platform === "darwin") {
      // windows-console-ok: guarded by `platform === "darwin"`; unreachable on Windows.
      child = host.spawn("/usr/bin/open", [url], detachedIgnore);
    } else {
      // windows-console-ok: the non-win32/darwin branch; unreachable on Windows.
      child = host.spawn("/usr/bin/xdg-open", [url], detachedIgnore);
    }
    const events = child as unknown as EventEmitter;
    events.once("error", (err: Error) => reject(err));
    events.once("spawn", () => {
      child.unref();
      resolve();
    });
  });
}
