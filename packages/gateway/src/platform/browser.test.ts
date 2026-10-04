/**
 * `openUrlInDefaultBrowser` per platform, through its `host` seam: no test here starts a real
 * process, let alone a browser.
 */
import { describe, expect, test } from "bun:test";
import type { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { win32 } from "node:path";
import { type OpenUrlHost, openUrlInDefaultBrowser } from "./browser.ts";

const URL_TO_OPEN = "https://accounts.example.com/o/oauth2/auth?state=abc&code_challenge=xyz";

interface SpawnCall {
  readonly command: string;
  readonly args: readonly string[];
  readonly options: Record<string, unknown>;
}

class FakeChild extends EventEmitter {
  unrefs = 0;
  unref(): void {
    this.unrefs += 1;
  }
}

function host(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>> = {},
): { readonly host: OpenUrlHost; readonly calls: SpawnCall[]; readonly children: FakeChild[] } {
  const calls: SpawnCall[] = [];
  const children: FakeChild[] = [];
  const fakeSpawn = ((
    command: string,
    args: readonly string[],
    options: Record<string, unknown>,
  ) => {
    calls.push({ command, args: [...args], options: { ...options } });
    const child = new FakeChild();
    children.push(child);
    return child;
  }) as unknown as typeof spawn;
  return { host: { platform, env, spawn: fakeSpawn }, calls, children };
}

describe("openUrlInDefaultBrowser", () => {
  test("Windows hands the URL to rundll32 under SystemRoot, detached and HIDDEN", async () => {
    const h = host("win32", { SystemRoot: "SysRoot", windir: "Ignored" });
    await openUrlInDefaultBrowser(URL_TO_OPEN, h.host);
    expect(h.calls).toEqual([
      {
        command: win32.join("SysRoot", "System32", "rundll32.exe"),
        args: ["url.dll,FileProtocolHandler", URL_TO_OPEN],
        options: { detached: true, stdio: "ignore", windowsHide: true },
      },
    ]);
  });

  test("Windows falls back to windir, then to the default install root", async () => {
    const viaWindir = host("win32", { windir: "WinDir" });
    await openUrlInDefaultBrowser(URL_TO_OPEN, viaWindir.host);
    expect(viaWindir.calls[0]?.command).toBe(win32.join("WinDir", "System32", "rundll32.exe"));

    const bare = host("win32");
    await openUrlInDefaultBrowser(URL_TO_OPEN, bare.host);
    expect(bare.calls[0]?.command).toBe(win32.join("C:", "Windows", "System32", "rundll32.exe"));
  });

  test("macOS uses /usr/bin/open", async () => {
    const h = host("darwin", { SystemRoot: "SysRoot" });
    await openUrlInDefaultBrowser(URL_TO_OPEN, h.host);
    expect(h.calls).toEqual([
      {
        command: "/usr/bin/open",
        args: [URL_TO_OPEN],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
  });

  test.each(["linux", "freebsd"] as const)("%s uses /usr/bin/xdg-open", async (platform) => {
    const h = host(platform);
    await openUrlInDefaultBrowser(URL_TO_OPEN, h.host);
    expect(h.calls).toEqual([
      {
        command: "/usr/bin/xdg-open",
        args: [URL_TO_OPEN],
        options: { detached: true, stdio: "ignore" },
      },
    ]);
  });

  test("the launcher is unref'd so the gateway never waits on it", async () => {
    const h = host("linux");
    await openUrlInDefaultBrowser(URL_TO_OPEN, h.host);
    expect(h.children.map((c) => c.unrefs)).toEqual([1]);
  });

  test("a launcher error arriving after the call returned is absorbed, never thrown", async () => {
    // A spawn failure (no xdg-open installed) is emitted asynchronously, after the promise has
    // already resolved. Without a listener, an EventEmitter 'error' would throw and take the
    // gateway down with it.
    const h = host("linux");
    await expect(openUrlInDefaultBrowser(URL_TO_OPEN, h.host)).resolves.toBeUndefined();
    const child = h.children[0];
    expect(child?.listenerCount("error")).toBe(1);
    expect(() => child?.emit("error", new Error("spawn /usr/bin/xdg-open ENOENT"))).not.toThrow();
  });
});
