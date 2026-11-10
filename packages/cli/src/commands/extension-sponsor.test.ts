import { describe, expect, test } from "bun:test";

import type { IPCClient } from "../ipc-client/index.ts";
import { runExtensionSponsor, type SponsorDeps } from "./extension-sponsor.ts";

const ESC = String.fromCodePoint(0x1b);
const A = { url: "https://github.com/sponsors/acme", label: "GitHub" };
const B = { url: "https://opencollective.com/acme" };

function harness(
  opts: {
    local?: Record<string, unknown>;
    remote?: Record<string, unknown>;
    error?: Error;
    tty?: boolean;
    answer?: boolean;
    openError?: Error;
  } = {},
) {
  const calls: Array<{ method: string; params: unknown }> = [];
  const opened: string[] = [];
  const questions: string[] = [];
  let out = "";
  let err = "";
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      if (opts.error !== undefined) throw opts.error;
      if (method === "extension.info") {
        return { extension: opts.local ?? { id: "acme/tool", version: "1.0.0", funding: [A, B] } };
      }
      if (method === "registry.info") {
        return (
          opts.remote ?? {
            funding: [A, B],
            evidenceFor: { version: "2.0.0", channel: "stable" },
          }
        );
      }
      throw new Error(`unexpected ${method}`);
    },
  } as unknown as IPCClient;
  const deps: SponsorDeps = {
    client,
    isTty: opts.tty ?? false,
    confirm: async (q) => {
      questions.push(q);
      return opts.answer ?? false;
    },
    openUrl: async (u) => {
      if (opts.openError !== undefined) throw opts.openError;
      opened.push(u);
    },
    log: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
  };
  return { deps, calls, opened, questions, out: () => out, err: () => err };
}

describe("runExtensionSponsor", () => {
  test("off a TTY prints the list and the URL, opens nothing", async () => {
    const h = harness();
    expect(await runExtensionSponsor(["acme/tool"], h.deps)).toBe(0);
    expect(h.out()).toContain("Funding links for acme/tool:");
    expect(h.out()).toContain("  1. GitHub https://github.com/sponsors/acme");
    expect(h.out()).toContain("Open https://github.com/sponsors/acme in your browser to sponsor.");
    expect(h.questions).toHaveLength(0);
    expect(h.opened).toHaveLength(0);
  });

  test("on a TTY a yes opens the first link", async () => {
    const h = harness({ tty: true, answer: true });
    expect(await runExtensionSponsor(["acme/tool"], h.deps)).toBe(0);
    expect(h.questions).toEqual(["Open github.com in your browser? [y/N] "]);
    expect(h.opened).toEqual(["https://github.com/sponsors/acme"]);
  });

  test("on a TTY a no opens nothing", async () => {
    const h = harness({ tty: true, answer: false });
    expect(await runExtensionSponsor(["acme/tool"], h.deps)).toBe(0);
    expect(h.opened).toHaveLength(0);
  });

  test("--index 2 opens the second kept entry", async () => {
    const h = harness({
      tty: true,
      answer: true,
      local: {
        id: "acme/tool",
        version: "1.0.0",
        funding: [{ url: "javascript:alert(1)" }, A, B],
      },
    });
    expect(await runExtensionSponsor(["acme/tool", "--index", "2"], h.deps)).toBe(0);
    expect(h.opened).toEqual(["https://opencollective.com/acme"]);
  });

  test.each([["0"], ["3"], ["x"], ["1.5"]])("--index %s is a usage error", async (v) => {
    const h = harness();
    expect(await runExtensionSponsor(["acme/tool", "--index", v], h.deps)).toBe(2);
    expect(h.err()).toContain("Usage: nimbus extension sponsor");
  });

  test("--index with no value and a missing id are usage errors", async () => {
    const h = harness();
    expect(await runExtensionSponsor(["acme/tool", "--index"], h.deps)).toBe(2);
    expect(await runExtensionSponsor([], h.deps)).toBe(2);
  });

  test("a javascript: url is neither printed nor opened", async () => {
    const h = harness({
      tty: true,
      answer: true,
      local: { id: "acme/tool", version: "1", funding: [{ url: "javascript:alert(1)" }, B] },
    });
    expect(await runExtensionSponsor(["acme/tool"], h.deps)).toBe(0);
    expect(h.out()).not.toContain("javascript:");
    expect(h.opened).toEqual(["https://opencollective.com/acme"]);
  });

  test("a label carrying an escape sequence is printed cleaned", async () => {
    const h = harness({
      local: {
        id: "acme/tool",
        version: "1",
        funding: [{ url: "https://github.com/sponsors/acme", label: `Pay${ESC}[2J me` }],
      },
    });
    await runExtensionSponsor(["acme/tool"], h.deps);
    expect(h.out()).not.toContain(ESC);
    expect(h.out()).toContain("Pay[2J me");
  });

  test("the remote form passes registry and reads top-level fields", async () => {
    const h = harness();
    expect(await runExtensionSponsor(["acme/tool", "--registry", "main"], h.deps)).toBe(0);
    expect(h.calls).toEqual([
      {
        method: "registry.info",
        params: { id: "acme/tool", registry: "main", liveness: false },
      },
    ]);
    expect(h.out()).toContain("Funding links for acme/tool (from 2.0.0, stable):");
  });

  test.each([
    ["blocked", { blockedBy: ["stmt-1"] }],
    ["signature-disabled", { signature_disabled: true }],
  ])("a %s extension prints the refusal note", async (_n, extra) => {
    const h = harness({ local: { id: "acme/tool", version: "1", funding: [A], ...extra } });
    expect(await runExtensionSponsor(["acme/tool"], h.deps)).toBe(0);
    expect(h.out()).toContain(
      "Note: Nimbus refuses to run acme/tool here (blocked or failed its signature check); check before you pay its author.\n",
    );
    expect(h.out().indexOf("Note:")).toBeLessThan(h.out().indexOf("to sponsor."));
  });

  test("a normal extension prints no note", async () => {
    const h = harness({
      local: {
        id: "acme/tool",
        version: "1",
        funding: [A],
        blockedBy: [],
        signature_disabled: false,
      },
    });
    await runExtensionSponsor(["acme/tool"], h.deps);
    expect(h.out()).not.toContain("Note:");
  });

  test("the local form calls extension.info", async () => {
    const h = harness();
    await runExtensionSponsor(["acme/tool"], h.deps);
    expect(h.calls).toEqual([{ method: "extension.info", params: { id: "acme/tool" } }]);
  });

  test("null funding, malformed funding, and all-dropped funding exit 1", async () => {
    const none = harness({ local: { id: "acme/tool", version: "1", funding: null } });
    expect(await runExtensionSponsor(["acme/tool"], none.deps)).toBe(1);
    expect(none.err()).toContain("acme/tool declares no funding links.");
    const bad = harness({
      local: { id: "acme/tool", version: "1", funding: null, fundingInvalid: true },
    });
    expect(await runExtensionSponsor(["acme/tool"], bad.deps)).toBe(1);
    expect(bad.err()).toContain("acme/tool's funding field is malformed and is ignored.");
    const dropped = harness({
      tty: true,
      answer: true,
      local: { id: "acme/tool", version: "1", funding: [{ url: "javascript:x" }] },
    });
    expect(await runExtensionSponsor(["acme/tool"], dropped.deps)).toBe(1);
    expect(dropped.opened).toHaveLength(0);
  });

  test("a registry or not-found IPC error prints its cleaned message, exit 1", async () => {
    const h = harness({ error: new Error(`ERR_REGISTRY_UNKNOWN: no${ESC}[2J registry`) });
    expect(await runExtensionSponsor(["acme/tool", "--registry", "x"], h.deps)).toBe(1);
    expect(h.err()).toContain("no[2J registry");
    expect(h.err()).not.toContain(ESC);
    const nf = harness({ error: new Error("Extension not found: acme/tool") });
    expect(await runExtensionSponsor(["acme/tool"], nf.deps)).toBe(1);
  });

  test("an openUrl rejection reports and exits 1 after printing the URL", async () => {
    const h = harness({ tty: true, answer: true, openError: new Error("no browser") });
    expect(await runExtensionSponsor(["acme/tool"], h.deps)).toBe(1);
    expect(h.err()).toContain("could not open the browser: no browser");
    expect(h.out()).toContain("https://github.com/sponsors/acme");
  });
});
