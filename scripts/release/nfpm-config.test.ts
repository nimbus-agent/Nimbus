import { expect, test } from "bun:test";
import { renderNfpmConfig } from "./nfpm-config.ts";

const BASE = {
  version: "0.5.0",
  binDir: "/work/bundle", // dir containing nimbus + nimbus-gateway + nimbus-sandbox-helper
  wrapperDir: "/work/wrappers", // dir containing the /usr/local/bin wrapper scripts
};

test("renders rpm package metadata", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toContain("name: nimbus-headless");
  expect(y).toContain("version: 0.5.0");
  expect(y).toContain("arch: amd64");
});

test("declares bubblewrap as the only runtime dependency, and no libcap", () => {
  const y = renderNfpmConfig(BASE);
  // Isolate the rpm overrides sub-block (from `  rpm:` up to the next 2-space
  // key, i.e. `  deb:`) so a `[\s\S]*` match can't wander into the deb block.
  const rpmBlock = y.match(/\n {2}rpm:\n([\s\S]*?)\n {2}\w/)?.[1] ?? "";
  expect(rpmBlock).toMatch(/-\s*bubblewrap(?:\r?\n|$)/);
  expect(y).not.toContain("libcap");
});

test("maps binaries to /usr/lib/nimbus/bin and wrappers to /usr/local/bin", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus");
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus-gateway");
  expect(y).toContain("dst: /usr/local/bin/nimbus");
  expect(y).toContain("dst: /usr/local/bin/nimbus-gateway");
});

test("ships vec0.so beside the gateway when the bundle has one, and not otherwise", () => {
  const y = renderNfpmConfig({ ...BASE, hasVec0: true });
  expect(y).toContain(
    "  - src: /work/bundle/vec0.so\n    dst: /usr/lib/nimbus/bin/vec0.so\n    file_info:\n      mode: 0644",
  );
  // Same directory as the gateway: it resolves the extension from dirname(process.execPath).
  expect(y).toContain("dst: /usr/lib/nimbus/bin/nimbus-gateway");
  expect(renderNfpmConfig(BASE)).not.toContain("vec0");
  expect(renderNfpmConfig({ ...BASE, hasVec0: false })).not.toContain("vec0");
});

test("always includes the sandbox helper at mode 0755, with no install script", () => {
  const y = renderNfpmConfig(BASE);
  expect(y).toMatch(
    /dst: \/usr\/lib\/nimbus\/bin\/nimbus-sandbox-helper\n {4}file_info:\n {6}mode: 0755/,
  );
  // There is nothing for one to do: the helper holds no capability, and setcap is gone.
  expect(y).not.toContain("scripts:");
  expect(y).not.toContain("postinstall");
  expect(y).not.toContain("setcap");
});
