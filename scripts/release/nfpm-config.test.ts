import { expect, test } from "bun:test";
import { renderNfpmConfig } from "./nfpm-config.ts";

const BASE = {
  version: "0.5.0",
  binDir: "/work/bundle", // dir containing nimbus + nimbus-gateway (+ optional helper)
  wrapperDir: "/work/wrappers", // dir containing the /usr/local/bin wrapper scripts
  hasSandboxHelper: true,
};

test("renders rpm package metadata", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toContain("name: nimbus-headless");
  expect(y).toContain("version: 0.5.0");
  expect(y).toContain("arch: amd64");
});

test("declares rpm runtime deps (bubblewrap + libcap, not the .deb's libcap2-bin)", () => {
  const y = renderNfpmConfig(BASE);
  // Isolate the rpm overrides sub-block (from `  rpm:` up to the next 2-space
  // key, i.e. `  deb:`) so a `[\s\S]*` match can't wander into the deb block.
  const rpmBlock = y.match(/\n {2}rpm:\n([\s\S]*?)\n {2}\w/)?.[1] ?? "";
  expect(rpmBlock).toMatch(/-\s*bubblewrap(?:\r?\n|$)/);
  // Full-token "- libcap": must not pass merely because "- libcap2-bin" (the deb
  // dep) is a substring, and libcap2-bin must NOT appear in the rpm block.
  expect(rpmBlock).toMatch(/-\s*libcap(?:\r?\n|$)/);
  expect(rpmBlock).not.toContain("libcap2-bin");
});

test("maps binaries to /usr/lib/nimbus/bin and wrappers to /usr/local/bin", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus");
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus-gateway");
  expect(y).toContain("dst: /usr/local/bin/nimbus");
  expect(y).toContain("dst: /usr/local/bin/nimbus-gateway");
});

test("includes the sandbox helper + a postinstall setcap scriptlet when present", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus-sandbox-helper");
  expect(y).toContain("scripts:");
  expect(y).toContain("postinstall:");
});

test("omits the helper + postinstall when absent", () => {
  const y = renderNfpmConfig({ ...BASE, hasSandboxHelper: false });
  expect(y).not.toContain("nimbus-sandbox-helper");
  expect(y).not.toContain("scripts:");
  expect(y).not.toContain("postinstall:");
});
