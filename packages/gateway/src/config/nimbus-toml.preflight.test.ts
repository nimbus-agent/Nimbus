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
