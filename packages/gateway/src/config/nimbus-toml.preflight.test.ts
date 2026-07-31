import { expect, test } from "bun:test";
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
