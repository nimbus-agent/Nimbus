import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { type ReportDeps, runExtensionReport } from "./extension-report.ts";

const FP = "a".repeat(32);
const EXTENSION = {
  id: "acme/tool",
  version: "1.2.3",
  source_registry: "main",
  publisher_key_fingerprint: FP,
  publisher: { id: "acme", key: "K".repeat(43) + "=" },
  install_path: "/home/me/.nimbus/extensions/acme/tool",
};

function harness(
  opts: {
    extension?: Record<string, unknown>;
    reportUrl?: string | null;
    infoError?: Error;
    tty?: boolean;
    answer?: boolean;
  } = {},
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const opened: string[] = [];
  let out = "";
  let err = "";
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (method === "extension.info") return { extension: opts.extension ?? EXTENSION };
      if (method === "registry.info") {
        if (opts.infoError !== undefined) throw opts.infoError;
        return {
          reportUrl:
            opts.reportUrl === undefined
              ? "https://github.com/acme/registry/issues/new"
              : opts.reportUrl,
        };
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as IPCClient;
  const deps: ReportDeps = {
    client,
    isTty: opts.tty ?? false,
    confirm: async () => opts.answer ?? false,
    openUrl: async (u) => {
      opened.push(u);
    },
    log: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    nimbusVersion: "10.6.0",
    osFamily: "linux",
  };
  return { deps, calls, opened, out: () => out, err: () => err };
}

describe("nimbus extension report", () => {
  test("a GitHub issue form gets a title and a body of PUBLIC metadata only, percent-encoded", async () => {
    const h = harness();
    expect(await runExtensionReport(["acme/tool"], h.deps)).toBe(0);
    expect(h.calls[1]).toEqual({
      method: "registry.info",
      params: { id: "acme/tool", registry: "main", reportOnly: true },
    });
    const printed =
      h
        .out()
        .split("\n")
        .find((l) => l.startsWith("https://")) ?? "";
    const url = new URL(printed);
    expect(url.origin + url.pathname).toBe("https://github.com/acme/registry/issues/new");
    expect(url.searchParams.get("title")).toBe("Report: acme/tool@1.2.3");
    const body = url.searchParams.get("body") ?? "";
    for (const want of ["acme/tool", "1.2.3", "acme", FP, "main", "10.6.0", "linux"]) {
      expect(body).toContain(want);
    }
    expect(body).not.toContain("/home/me");
    expect(printed).not.toContain(" ");
    expect(printed).not.toContain("\n");
  });

  test("off a terminal it prints and opens nothing; on one, it opens only after a yes", async () => {
    const off = harness();
    await runExtensionReport(["acme/tool"], off.deps);
    expect(off.opened).toEqual([]);
    const no = harness({ tty: true, answer: false });
    await runExtensionReport(["acme/tool"], no.deps);
    expect(no.opened).toEqual([]);
    const yes = harness({ tty: true, answer: true });
    await runExtensionReport(["acme/tool"], yes.deps);
    expect(yes.opened).toHaveLength(1);
    expect(yes.opened[0]).toStartWith("https://github.com/acme/registry/issues/new?");
  });

  test("a GitHub issue form with its own query keeps it and still gets the pre-fill", async () => {
    const h = harness({
      reportUrl: "https://github.com/acme/registry/issues/new?template=report.yml",
    });
    await runExtensionReport(["acme/tool"], h.deps);
    const printed =
      h
        .out()
        .split("\n")
        .find((l) => l.startsWith("https://")) ?? "";
    const url = new URL(printed);
    expect(url.origin + url.pathname).toBe("https://github.com/acme/registry/issues/new");
    expect(url.searchParams.get("template")).toBe("report.yml");
    expect(url.searchParams.get("title")).toBe("Report: acme/tool@1.2.3");
    expect(url.searchParams.get("body")).toContain("acme/tool");
  });

  test("a non-GitHub https destination is shown as it is, with no pre-fill", async () => {
    const h = harness({ reportUrl: "https://reports.example.com/form" });
    await runExtensionReport(["acme/tool"], h.deps);
    expect(h.out()).toContain("https://reports.example.com/form\n");
  });

  test("no destination is ERR_REPORT_NO_DESTINATION naming where the extension came from", async () => {
    const local = harness({ extension: { ...EXTENSION, source_registry: null } });
    expect(await runExtensionReport(["acme/tool"], local.deps)).toBe(2);
    expect(local.err()).toContain("ERR_REPORT_NO_DESTINATION");
    expect(local.err()).toContain("local path");
    const none = harness({ reportUrl: null });
    expect(await runExtensionReport(["acme/tool"], none.deps)).toBe(2);
    expect(none.err()).toContain("registry main");
    const gone = harness({ infoError: new Error("ERR_REGISTRY_NOT_FOUND: no acme/tool") });
    expect(await runExtensionReport(["acme/tool"], gone.deps)).toBe(2);
    expect(gone.err()).toContain("ERR_REPORT_NO_DESTINATION");
  });

  test("a usage error exits 2 and calls nothing", async () => {
    const h = harness();
    expect(await runExtensionReport([], h.deps)).toBe(2);
    expect(h.calls).toEqual([]);
  });
});
