import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { pathToFileURL } from "node:url";

import { resolveRegistryLocation, resolveRegistryResource } from "./registry-transport.ts";

const DEV = { production: false };

function refused(url: string, opts = DEV): void {
  expect(() => resolveRegistryLocation(url, opts)).toThrow("ERR_REGISTRY_TRANSPORT_REFUSED");
}

describe("resolveRegistryLocation", () => {
  test("refuses UNC backslash", () => {
    refused("\\\\evil.example\\share\\reg");
  });

  test("refuses //host", () => {
    refused("//evil.example/share/reg");
  });

  test("refuses \\\\?\\UNC\\ and device paths", () => {
    refused("\\\\?\\UNC\\evil.example\\share");
    refused("\\\\?\\C:\\reg");
    refused("\\\\.\\pipe\\reg");
  });

  test("refuses file://evil.example/x", () => {
    refused("file://evil.example/x");
  });

  test("refuses a relative path and an unsupported scheme", () => {
    refused("reg/relative");
    refused("ftp://example.com/reg");
  });

  test("accepts file://localhost/abs and file:///abs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-reg-"));
    try {
      const href = pathToFileURL(tmp).href;
      const a = resolveRegistryLocation(href, DEV);
      const b = resolveRegistryLocation(href.replace("file://", "file://localhost"), DEV);
      expect(a.kind).toBe("local");
      expect(b).toEqual(a);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("refuses http to a non-loopback host", () => {
    refused("http://registry.example/");
  });

  test("accepts http to loopback outside production, refuses it in production", () => {
    expect(resolveRegistryLocation("http://127.0.0.1:8080/reg", DEV).kind).toBe("remote");
    refused("http://127.0.0.1:8080/reg", { production: true });
  });

  test("https is accepted, with a trailing slash added to the base", () => {
    const loc = resolveRegistryLocation("https://reg.example/sub", { production: true });
    expect(loc).toEqual({ kind: "remote", base: new URL("https://reg.example/sub/") });
  });

  test("local root with spaces and non-ASCII", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-reg-"));
    try {
      const root = join(tmp, "Zoë Q", "reg");
      mkdirSync(root, { recursive: true });
      expect(resolveRegistryLocation(root, DEV)).toEqual({ kind: "local", root });
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  test("trailing slash is irrelevant", () => {
    const tmp = mkdtempSync(join(tmpdir(), "nimbus-reg-"));
    try {
      expect(resolveRegistryLocation(`${tmp}${sep}`, DEV)).toEqual(
        resolveRegistryLocation(tmp, DEV),
      );
      expect(resolveRegistryLocation("https://reg.example/a/", DEV)).toEqual(
        resolveRegistryLocation("https://reg.example/a", DEV),
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("resolveRegistryResource", () => {
  const remote = resolveRegistryLocation("https://reg.example/sub", DEV);
  const local = resolveRegistryLocation(tmpdir(), DEV);

  test("maps the three allowed shapes for remote and local", () => {
    expect(resolveRegistryResource(remote, "index.json")).toEqual({
      kind: "remote",
      url: "https://reg.example/sub/index.json",
    });
    expect(resolveRegistryResource(remote, "extensions/acme/deploy/1.0.0/package.tgz")).toEqual({
      kind: "remote",
      url: "https://reg.example/sub/extensions/acme/deploy/1.0.0/package.tgz",
    });
    expect(resolveRegistryResource(local, "extensions/acme/deploy/1.0.0/manifest.json")).toEqual({
      kind: "local",
      path: join(tmpdir(), "extensions", "acme", "deploy", "1.0.0", "manifest.json"),
    });
  });

  test("rejects a ../ relPath and other shapes", () => {
    for (const loc of [remote, local]) {
      for (const bad of [
        "../index.json",
        "extensions/../../etc/manifest.json",
        "extensions/a/../manifest.json",
        "extensions/acme/x/other.json",
        "/index.json",
        "index.json/",
        "https://evil.example/index.json",
      ]) {
        expect(() => resolveRegistryResource(loc, bad)).toThrow("ERR_REGISTRY_TRANSPORT_REFUSED");
      }
    }
  });
});
