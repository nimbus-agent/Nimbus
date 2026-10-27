import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";

import { type OpenUrlHost, openHttpsUrl } from "./open-url.ts";

type Spawned = { cmd: string; args: readonly string[]; opts: Record<string, unknown> };

function host(platform: NodeJS.Platform, outcome: "spawn" | "error" = "spawn") {
  const calls: Spawned[] = [];
  const h: OpenUrlHost = {
    platform,
    env: { SystemRoot: String.raw`C:\Windows` },
    spawn: ((cmd: string, args: readonly string[], opts: Record<string, unknown>) => {
      calls.push({ cmd, args, opts });
      const child = new EventEmitter() as EventEmitter & { unref: () => void };
      child.unref = () => {};
      queueMicrotask(() => {
        if (outcome === "spawn") child.emit("spawn");
        else child.emit("error", new Error("ENOENT"));
      });
      return child;
    }) as unknown as OpenUrlHost["spawn"],
  };
  return { h, calls };
}

const URL_OK = "https://github.com/acme/registry/issues/new?title=x";

describe("openHttpsUrl", () => {
  test("launches each platform's opener with the URL as one argument, hidden on Windows", async () => {
    const win = host("win32");
    await openHttpsUrl(URL_OK, win.h);
    expect(win.calls[0]?.cmd).toContain("rundll32.exe");
    expect(win.calls[0]?.args).toEqual(["url.dll,FileProtocolHandler", URL_OK]);
    expect(win.calls[0]?.opts["windowsHide"]).toBe(true);
    const mac = host("darwin");
    await openHttpsUrl(URL_OK, mac.h);
    expect(mac.calls[0]).toMatchObject({ cmd: "/usr/bin/open", args: [URL_OK] });
    const linux = host("linux");
    await openHttpsUrl(URL_OK, linux.h);
    expect(linux.calls[0]).toMatchObject({ cmd: "/usr/bin/xdg-open", args: [URL_OK] });
  });

  test("refuses anything that is not an https: URL, before spawning", async () => {
    for (const bad of [
      "file:///C:/x.bat",
      "javascript:alert(1)",
      "-a Terminal",
      "http://example.com",
      "calc.exe",
    ]) {
      const { h, calls } = host("darwin");
      await expect(openHttpsUrl(bad, h)).rejects.toThrow("https");
      expect(calls).toEqual([]);
    }
  });

  test("on Windows, finds rundll32 under windir when SystemRoot is unset, else C:\\Windows", async () => {
    const windir = host("win32");
    await openHttpsUrl(URL_OK, { ...windir.h, env: { windir: String.raw`D:\Win` } });
    expect(windir.calls[0]?.cmd).toBe(String.raw`D:\Win\System32\rundll32.exe`);
    const neither = host("win32");
    await openHttpsUrl(URL_OK, { ...neither.h, env: {} });
    expect(neither.calls[0]?.cmd).toBe(String.raw`C:\Windows\System32\rundll32.exe`);
  });

  test("the default host still refuses a non-https URL before any process starts", async () => {
    await expect(openHttpsUrl("http://example.com")).rejects.toThrow("https");
  });

  test("a launcher that fails to start rejects (it is not reported as opened)", async () => {
    const { h } = host("linux", "error");
    await expect(openHttpsUrl(URL_OK, h)).rejects.toThrow("ENOENT");
  });
});
