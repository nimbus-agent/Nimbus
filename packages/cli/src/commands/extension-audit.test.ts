import { describe, expect, test } from "bun:test";
import type { IPCClient } from "@nimbus-dev/client";

import {
  displayName,
  type ExtensionAuditEntry,
  formatExtensionAudit,
  runExtensionAudit,
} from "./extension-audit.ts";

const NL = String.fromCharCode(10);
const CLOSING = [
  'At least these. Short connections can be missed, and "not seen" does not mean not used.',
  "File access is not observed.",
];

function entry(over: Partial<ExtensionAuditEntry> = {}): ExtensionAuditEntry {
  return {
    id: "acme.tool",
    version: "1.2.0",
    os: "linux",
    networkObserved: true,
    runs: 3,
    observedDays: 2,
    firstSeen: 1,
    lastSeen: 2,
    declared: ["api.example.com:443", "other.example.com:443"],
    used: [{ destination: "api.example.com", port: 443, count: 7 }],
    notSeen: ["other.example.com:443"],
    refused: [],
    unmatched: [],
    dropped: 0,
    ...over,
  };
}

function fakeClient(extensions: ExtensionAuditEntry[]): {
  client: IPCClient;
  calls: Array<{ method: string; params: unknown }>;
} {
  const calls: Array<{ method: string; params: unknown }> = [];
  const client = {
    call: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { extensions };
    },
  } as unknown as IPCClient;
  return { client, calls };
}

describe("formatExtensionAudit", () => {
  test("an observed Linux entry, exact text", () => {
    expect(
      formatExtensionAudit(
        entry({ refused: [{ destination: "evil.test", port: 0, count: 2 }], dropped: 4 }),
      ),
    ).toEqual([
      "acme.tool 1.2.0   observed 3 run(s) over 2 day(s), on this machine only",
      "Network   declared api.example.com:443, other.example.com:443",
      "  used      api.example.com:443 (7 connection(s))",
      "  not seen  other.example.com:443",
      "  refused   evil.test (2 lookup(s))",
      "  more not shown: 4",
      ...CLOSING,
    ]);
  });

  test("a declared host that was refused keeps its name and is not called undeclared", () => {
    const lines = formatExtensionAudit(
      entry({
        used: [],
        notSeen: ["other.example.com:443"],
        refused: [{ destination: "other.example.com", port: 0, count: 1 }],
      }),
    );
    expect(lines).toContain("  refused   other.example.com (1 lookup(s))");
    expect(lines.join("\n")).not.toContain("undeclared");
  });

  test("a refused entry with a port prints name:port", () => {
    const lines = formatExtensionAudit(
      entry({ refused: [{ destination: "x.test", port: 8080, count: 1 }] }),
    );
    expect(lines).toContain("  refused   x.test:8080 (1 lookup(s))");
  });

  test("nothing declared reads 'nothing'", () => {
    const lines = formatExtensionAudit(entry({ declared: [], used: [], notSeen: [] }));
    expect(lines[1]).toBe("Network   declared nothing");
  });

  test("an entry with no coverage row says not observed yet", () => {
    const lines = formatExtensionAudit(
      entry({
        runs: 0,
        observedDays: 0,
        firstSeen: undefined,
        lastSeen: undefined,
        os: undefined,
        networkObserved: false,
      }),
    );
    expect(lines).toEqual(["acme.tool 1.2.0   not observed yet", ...CLOSING]);
  });

  test("a Windows entry counts runs but says the network is not observed on this OS yet", () => {
    const lines = formatExtensionAudit(
      entry({ os: "win32", networkObserved: false, used: [], notSeen: [] }),
    );
    expect(lines).toEqual([
      "acme.tool 1.2.0   observed 3 run(s) over 2 day(s), on this machine only",
      "Network   not observed on this OS yet",
      ...CLOSING,
    ]);
  });
});

describe("hostile declared hosts (grant-sourced names)", () => {
  const bad = "ev[31mil.test:443";
  const hostileDeclared = entry({ declared: [bad], used: [], notSeen: [bad] });
  const clean = "ev??31mil.test:443";

  test("declared and not seen are sanitised in text", () => {
    const lines = formatExtensionAudit(hostileDeclared);
    expect(lines).toContain(`Network   declared ${clean}`);
    expect(lines).toContain(`  not seen  ${clean}`);
    expect(lines.join(NL)).not.toContain("");
  });

  test("declared and not seen are sanitised in --json", async () => {
    const out: string[] = [];
    await runExtensionAudit(["--json"], {
      client: fakeClient([hostileDeclared]).client,
      out: (s) => out.push(s),
    });
    const parsed = JSON.parse(out.join("")) as { extensions: ExtensionAuditEntry[] };
    expect(parsed.extensions[0]?.declared).toEqual([clean]);
    expect(parsed.extensions[0]?.notSeen).toEqual([clean]);
  });
});

describe("displayName", () => {
  test("keeps the safe alphabet, replaces the rest with ?, cuts at 253", () => {
    expect(displayName("a.b-c_D9")).toBe("a.b-c_D9");
    expect(displayName("ev\u001b[31mil\nhost\u202e")).toBe("ev?[31mil?host?".replace("[", "?"));
    expect(displayName("a".repeat(300))).toHaveLength(253);
  });
});

describe("runExtensionAudit", () => {
  const hostile = entry({
    refused: [{ destination: "bad\u001b]0;pwn\u0007.test", port: 0, count: 1 }],
    used: [{ destination: "x\ny.test", port: 443, count: 1 }],
  });

  test("a hostile name is printed sanitised in text", async () => {
    const out: string[] = [];
    await runExtensionAudit([], { client: fakeClient([hostile]).client, out: (s) => out.push(s) });
    const text = out.join("");
    expect([...text].some((c) => c !== NL && c.charCodeAt(0) < 32)).toBe(false);
    expect(text).toContain("  refused   bad??0?pwn?.test (1 lookup(s))");
    expect(text).toContain("  used      x?y.test:443 (1 connection(s))");
  });

  test("a hostile name is sanitised in --json too", async () => {
    const out: string[] = [];
    await runExtensionAudit(["--json"], {
      client: fakeClient([hostile]).client,
      out: (s) => out.push(s),
    });
    const parsed = JSON.parse(out.join("")) as { extensions: ExtensionAuditEntry[] };
    expect(parsed.extensions[0]?.refused[0]?.destination).toBe("bad??0?pwn?.test");
    expect(parsed.extensions[0]?.used[0]?.destination).toBe("x?y.test");
    expect(out.join("")).not.toContain("\u001b");
  });

  test("an id is passed to the gateway; no id lists every extension, closing lines each time", async () => {
    const two = [entry(), entry({ id: "b.tool", networkObserved: false })];
    const a = fakeClient(two);
    const out: string[] = [];
    expect(await runExtensionAudit([], { client: a.client, out: (s) => out.push(s) })).toBe(0);
    expect(a.calls).toEqual([{ method: "extension.audit", params: {} }]);
    const text = out.join("");
    expect(text).toContain("acme.tool 1.2.0");
    expect(text).toContain("b.tool 1.2.0");
    expect(text.split(CLOSING[1] ?? "").length - 1).toBe(2);
    const b = fakeClient([entry()]);
    await runExtensionAudit(["acme.tool", "--json"], { client: b.client, out: () => {} });
    expect(b.calls).toEqual([{ method: "extension.audit", params: { id: "acme.tool" } }]);
  });

  test("nothing installed says so", async () => {
    const out: string[] = [];
    await runExtensionAudit([], { client: fakeClient([]).client, out: (s) => out.push(s) });
    expect(out.join("")).toBe("No extensions installed.\n");
  });
});
