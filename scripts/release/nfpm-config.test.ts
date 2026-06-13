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
  // nfpm overrides.rpm.depends must use the RPM-distro package names.
  expect(y).toMatch(/overrides:\s*[\s\S]*rpm:[\s\S]*depends:[\s\S]*-\s*bubblewrap/);
  expect(y).toContain("- libcap");
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
});
