import { describe, expect, test } from "bun:test";
import { parsePreflightConfig } from "./nimbus-toml.ts";

test("parses a per-namespace preflight command table", () => {
  const cfg = parsePreflightConfig(`
[federation.preflight."project:zurich"]
command = "bun"
args = ["test", "packages/api"]
cwd = "/srv/zurich"
timeout_seconds = 120
`);
  const z = cfg.get("project:zurich");
  expect(z).toEqual({
    command: "bun",
    args: ["test", "packages/api"],
    cwd: "/srv/zurich",
    timeoutSeconds: 120,
  });
});

test("defaults args=[] cwd='.' timeout=300, caps timeout at 1800, ignores command-less tables", () => {
  const cfg = parsePreflightConfig(`
[federation.preflight."a"]
command = "make check"
timeout_seconds = 99999

[federation.preflight."b"]
args = ["x"]

[federation.preflight."c"]
command = "run"
timeout_seconds = 0
`);
  expect(cfg.get("a")).toEqual({ command: "make check", args: [], cwd: ".", timeoutSeconds: 1800 });
  expect(cfg.has("b")).toBe(false); // no command → ignored
  expect(cfg.get("c")?.timeoutSeconds).toBe(300); // timeout_seconds = 0 → default 300
});

test("absent section → empty map", () => {
  expect(parsePreflightConfig("[federation]\nenabled = true\n").size).toBe(0);
});

test("skips a command line with a genuinely unterminated quoted value — a forgotten closing quote on a Windows path", () => {
  // Without the guard, parseString returns the unterminated fragment with
  // its leading quote still attached (`"C:\tools\build`), and since that
  // string is non-empty toPreflightCommandConfig accepts it — I24 says the
  // command is "resolved from local config only", so a corrupted command
  // string silently registering here is exactly the class of bug the guard
  // must close.
  const cfg = parsePreflightConfig(`
[federation.preflight."ns"]
command = "C:\\tools\\build
`);
  expect(cfg.has("ns")).toBe(false);
});

describe("a malformed header never rewrites the PREVIOUS namespace's command (I24)", () => {
  const ns1 = ['[federation.preflight."ns1"]', 'command = "bun"', 'args = ["test"]'];
  const ns2Body = ['command = "rm -rf build"', 'cwd = "/"'];
  const ns1Only = (cfg: ReturnType<typeof parsePreflightConfig>): void => {
    expect(cfg.get("ns1")).toEqual({
      command: "bun",
      args: ["test"],
      cwd: ".",
      timeoutSeconds: 300,
    });
    expect([...cfg.keys()]).toEqual(["ns1"]);
  };

  // Each of these headers used to leave the scanner on the previous, VALID table, so the keys
  // written under it landed in `ns1`: I24 resolves the command a peer's preflight runs from this
  // table, and `ns1` would have run `rm -rf build` in `/` instead of the `bun test` it configured.
  test.each([
    ["missing its closing bracket", '[federation.preflight."ns2"'],
    ["whose quote never closes", '[federation.preflight."ns2]'],
    ["with text after its closing bracket", '[federation.preflight."ns2"] command = "x"'],
  ])("a header %s ends the previous namespace and opens none", (_label, header) => {
    ns1Only(parsePreflightConfig([...ns1, header, ...ns2Body].join("\n")));
  });

  test("a bracketed header with text between its closing quote and bracket opens no namespace", () => {
    // Recognised as a header but not as a preflight one, so the previous namespace ends here too.
    ns1Only(parsePreflightConfig([...ns1, '[federation.preflight."ns2"x]', ...ns2Body].join("\n")));
  });

  test("a VALID header after a malformed one still opens its own namespace", () => {
    const cfg = parsePreflightConfig(
      [
        ...ns1,
        '[federation.preflight."ns2"',
        ...ns2Body,
        '[federation.preflight."ns3"]',
        'command = "make check"',
      ].join("\n"),
    );
    expect(cfg.get("ns1")?.command).toBe("bun");
    expect(cfg.get("ns3")?.command).toBe("make check");
    expect(cfg.has("ns2")).toBe(false);
  });
});
