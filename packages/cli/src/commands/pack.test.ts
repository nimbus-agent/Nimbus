import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { isAbsolute } from "node:path";
import { fileURLToPath } from "node:url";

import { type PackIo, runPack, runPackWith } from "./pack.ts";

interface Harness {
  readonly io: PackIo;
  readonly stdout: string[];
  readonly stderr: string[];
  readonly calls: { method: string; params: unknown }[];
  readonly call: <T>(method: string, params: unknown) => Promise<T>;
}

function harness(
  opts: {
    tty?: boolean;
    size?: number;
    fileText?: string;
    reply?: (method: string) => unknown;
  } = {},
): Harness {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const calls: { method: string; params: unknown }[] = [];
  const tty = opts.tty ?? true;
  const io: PackIo = {
    stdinIsTty: tty,
    stdoutIsTty: tty,
    readFile: () => opts.fileText ?? "name = 'x'",
    statSize: () => opts.size ?? 10,
    out: (s) => stdout.push(s),
    err: (s) => stderr.push(s),
  };
  const call = async <T>(method: string, params: unknown): Promise<T> => {
    calls.push({ method, params });
    const r = opts.reply?.(method);
    if (r instanceof Error) throw r;
    return r as T;
  };
  return { io, stdout, stderr, calls, call };
}

describe("nimbus pack install", () => {
  it("refuses non-TTY and makes no IPC call", async () => {
    const h = harness({ tty: false });
    const code = await runPackWith(["install", "pm"], h.io, h.call);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toContain(
      "Refusing to install a pack in non-TTY mode: the approval must be answered at a terminal.",
    );
    expect(h.calls).toEqual([]);
  });

  it("has no --yes", async () => {
    const h = harness();
    const code = await runPackWith(["install", "pm", "--yes"], h.io, h.call);
    expect(code).toBe(1);
    expect(h.stderr.join("")).toContain("no --yes");
    expect(h.calls).toEqual([]);
  });

  it("refuses a --file over 131072 bytes before reading it", async () => {
    let read = false;
    const h = harness({ size: 131073 });
    const io: PackIo = {
      ...h.io,
      readFile: () => {
        read = true;
        return "";
      },
    };
    const code = await runPackWith(["install", "--file", "p.toml"], io, h.call);
    expect(code).toBe(1);
    expect(read).toBe(false);
    expect(h.stderr.join("")).toContain("131072");
    expect(h.calls).toEqual([]);
  });

  it("sends { fileText, filePath } with the absolute path", async () => {
    const h = harness({
      fileText: "TEXT",
      reply: () => ({ outcome: "installed", id: "x", version: "1.0.0", snapshotVersion: 3 }),
    });
    const code = await runPackWith(["install", "--file", "rel/p.toml"], h.io, h.call);
    expect(code).toBe(0);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]?.method).toBe("pack.install");
    const p = h.calls[0]?.params as { fileText: string; filePath: string };
    expect(p.fileText).toBe("TEXT");
    expect(isAbsolute(p.filePath)).toBe(true);
    expect(h.stdout.join("")).toContain("installed");
  });

  it("sends { id } for a bundled pack", async () => {
    const h = harness({
      reply: () => ({
        outcome: "already_installed",
        id: "pm",
        version: "1.0.0",
        snapshotVersion: 1,
      }),
    });
    await runPackWith(["install", "pm"], h.io, h.call);
    expect(h.calls[0]?.params).toEqual({ id: "pm" });
    expect(h.stdout.join("")).toContain("already installed");
  });
});

describe("nimbus pack list / show / remove", () => {
  const listResult = {
    profile: "default",
    installed: [
      {
        id: "pm",
        name: "PM",
        version: "1.0.0",
        source: "bundled",
        updateAvailable: true,
        bundledVersion: "1.1.0",
      },
      { id: "old", name: "Old", version: "0.1.0", source: "file", updateAvailable: false },
    ],
    available: [{ id: "devops", name: "DevOps", version: "1.0.0", description: "Ops things" }],
    skipped: 0,
  };

  it("prints installed and available, marks update available", async () => {
    const h = harness({ reply: () => listResult });
    expect(await runPackWith(["list"], h.io, h.call)).toBe(0);
    const out = h.stdout.join("");
    expect(out).toContain("pm");
    expect(out).toContain("update available");
    expect(out).toContain("devops");
    expect(out).toContain("default");
  });

  it("--json prints the raw result", async () => {
    const h = harness({ reply: () => listResult });
    await runPackWith(["list", "--json"], h.io, h.call);
    expect(JSON.parse(h.stdout.join(""))).toEqual(listResult);
  });

  it("show keeps newlines, strips control characters and prints the installed line", async () => {
    const h = harness({
      reply: () => ({
        prompt: "line one\nline \u001b[31mtwo",
        mode: "update",
        installed: { version: "1.0.0", source: "bundled", installedAt: "2026-10-24", digest: "d" },
      }),
    });
    expect(await runPackWith(["show", "pm"], h.io, h.call)).toBe(0);
    const out = h.stdout.join("");
    expect(out).toContain("line one\nline [31mtwo");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("Installed: version 1.0.0, source bundled, installed at 2026-10-24");
  });

  it("remove prints removed / not installed", async () => {
    const a = harness({ reply: () => ({ removed: true, snapshotVersion: 2 }) });
    await runPackWith(["remove", "pm"], a.io, a.call);
    expect(a.stdout.join("")).toContain("removed");
    const b = harness({ reply: () => ({ removed: false, snapshotVersion: 2 }) });
    await runPackWith(["remove", "pm"], b.io, b.call);
    expect(b.stdout.join("")).toContain("not installed");
  });

  it("an ERR_PACK_* error prints its message (sanitised) and exits 1", async () => {
    const h = harness({ reply: () => new Error("ERR_PACK_NOT_FOUND: no \u001b[2Jpack") });
    const code = await runPackWith(["show", "zz"], h.io, h.call);
    expect(code).toBe(1);
    const err = h.stderr.join("");
    expect(err).toContain("ERR_PACK_NOT_FOUND: no [2Jpack");
    expect(err).not.toContain("\u001b");
  });

  it("an unknown subcommand prints usage and exits 2", async () => {
    const h = harness();
    expect(await runPackWith(["bogus"], h.io, h.call)).toBe(2);
    expect(h.stderr.join("")).toContain("Usage: nimbus pack");
    expect(await runPackWith([], h.io, h.call)).toBe(2);
    expect(await runPackWith(["show"], h.io, h.call)).toBe(2);
  });
});

describe("pack.ts source pin", () => {
  it("install's consent handler is the prompt handler only", () => {
    const src = readFileSync(fileURLToPath(new URL("./pack.ts", import.meta.url)), "utf8");
    expect(src).toContain("registerConsentPromptHandler(");
    expect(src).not.toContain("withGatewayIpc(");
    expect(src).not.toContain("registerConsentFor(");
    expect(src).not.toContain("registerDefaultConsentHandler(");
  });
});

describe("nimbus pack branches", () => {
  const installOk = { outcome: "installed", id: "x", version: "1.0.0", snapshotVersion: 1 };

  it("-y is refused like --yes", async () => {
    const h = harness();
    expect(await runPackWith(["install", "pm", "-y"], h.io, h.call)).toBe(1);
    expect(h.stderr.join("")).toContain("no --yes");
    expect(h.calls).toEqual([]);
  });

  it("an install with no target prints usage and exits 2", async () => {
    const h = harness();
    expect(await runPackWith(["install"], h.io, h.call)).toBe(2);
    expect(h.stderr.join("")).toContain("Usage: nimbus pack");
    expect(h.calls).toEqual([]);
  });

  it("--file with no value (or a flag as its value) prints usage and exits 2", async () => {
    const a = harness();
    expect(await runPackWith(["install", "--file"], a.io, a.call)).toBe(2);
    const b = harness();
    expect(await runPackWith(["show", "--file", "--json"], b.io, b.call)).toBe(2);
    expect(b.calls).toEqual([]);
  });

  it("show --file over the size limit errors without reading", async () => {
    const h = harness({ size: 131073 });
    expect(await runPackWith(["show", "--file", "p.toml"], h.io, h.call)).toBe(1);
    expect(h.stderr.join("")).toContain("131072");
    expect(h.calls).toEqual([]);
  });

  it("a stat failure is reported and exits 1", async () => {
    const h = harness();
    const io: PackIo = {
      ...h.io,
      statSize: () => {
        throw new Error("ENOENT: no such file");
      },
    };
    expect(await runPackWith(["install", "--file", "gone.toml"], io, h.call)).toBe(1);
    expect(h.stderr.join("")).toContain("ENOENT");
    expect(h.calls).toEqual([]);
  });

  it("show --file sends fileText and filePath; show --json prints the raw result", async () => {
    const shown = { prompt: "P", mode: "install" };
    const h = harness({ fileText: "T", reply: () => shown });
    expect(await runPackWith(["show", "--file", "p.toml", "--json"], h.io, h.call)).toBe(0);
    expect(h.calls[0]?.method).toBe("pack.show");
    expect((h.calls[0]?.params as { fileText: string } | undefined)?.fileText).toBe("T");
    expect(JSON.parse(h.stdout.join(""))).toEqual(shown);
  });

  it("show of a pack that is not installed prints only the prompt", async () => {
    const h = harness({ reply: () => ({ prompt: "P", mode: "install" }) });
    expect(await runPackWith(["show", "pm"], h.io, h.call)).toBe(0);
    expect(h.stdout.join("")).toBe("P\n");
  });

  it("an unknown install outcome is printed cleaned, not as undefined", async () => {
    const h = harness({ reply: () => ({ ...installOk, outcome: "wei\u001b[2Jrd" }) });
    expect(await runPackWith(["install", "x"], h.io, h.call)).toBe(0);
    const out = h.stdout.join("");
    expect(out).toContain("wei[2Jrd");
    expect(out).not.toContain("undefined");
    expect(out).not.toContain("\u001b");
  });

  it("every known outcome has its own text", async () => {
    for (const [outcome, text] of [
      ["updated", "updated"],
      ["repaired", "repaired"],
    ] as const) {
      const h = harness({ reply: () => ({ ...installOk, outcome }) });
      await runPackWith(["install", "x"], h.io, h.call);
      expect(h.stdout.join("")).toContain(`: ${text}.`);
    }
  });

  it("remove with no id prints usage and exits 2; a non-Error throw is stringified", async () => {
    const a = harness();
    expect(await runPackWith(["remove"], a.io, a.call)).toBe(2);
    const b = harness({
      reply: () => {
        throw "plain string failure";
      },
    });
    expect(await runPackWith(["remove", "pm"], b.io, b.call)).toBe(1);
    expect(b.stderr.join("")).toContain("plain string failure");
  });

  it("list renders versionUnknown, a missing bundledVersion, listError, skipped, and a cleaned source", async () => {
    const h = harness({
      reply: () => ({
        profile: "p\u001b[2J",
        installed: [
          {
            id: "a",
            name: "A",
            version: "0",
            source: "fi\u001b[2Jle",
            updateAvailable: true,
            versionUnknown: true,
          },
        ],
        available: [],
        skipped: 1,
        listError: "bad\u001b[2J json",
      }),
    });
    expect(await runPackWith(["list"], h.io, h.call)).toBe(0);
    const out = h.stdout.join("");
    expect(out).toContain("version unknown");
    expect(out).toContain("[update available]");
    expect(out).toContain("(fi[2Jle)");
    expect(out).toContain("could not read the installed list: bad[2J json");
    expect(out).toContain("1 entry skipped.");
    expect(out).not.toContain("\u001b");
    expect(out).toContain("Available:\n  (none)");
  });

  it("list says (none) for an empty installed list and pluralises skipped", async () => {
    const h = harness({
      reply: () => ({ profile: "d", installed: [], available: [], skipped: 3 }),
    });
    await runPackWith(["list"], h.io, h.call);
    const out = h.stdout.join("");
    expect(out).toContain("Installed:\n  (none)");
    expect(out).toContain("3 entries skipped.");
  });
});

describe("runPack", () => {
  it("an unknown subcommand writes usage to stderr and throws CliExit(2)", async () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      await expect(runPack(["bogus"])).rejects.toMatchObject({ code: 2 });
    } finally {
      process.stderr.write = orig;
    }
    expect(chunks.join("")).toContain("Usage: nimbus pack");
  });
});
