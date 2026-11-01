import { expect, test } from "bun:test";
import { renderRpmSpec, rpmVersion } from "./rpm-spec.ts";

const BASE = {
  version: "0.5.0",
  binDir: "/work/bundle", // dir containing nimbus + nimbus-gateway + nimbus-sandbox-helper
  wrapperDir: "/work/wrappers", // dir containing the /usr/local/bin wrapper scripts
};

test("renders rpm package metadata", () => {
  const s = renderRpmSpec(BASE);
  expect(s).toContain("Name: nimbus-headless");
  expect(s).toContain("Version: 0.5.0");
  expect(s).toContain("Release: 1");
});

test("a pre-release version becomes one RPM accepts", () => {
  expect(rpmVersion("0.5.0")).toBe("0.5.0");
  expect(rpmVersion("0.1.0-rc1")).toBe("0.1.0~rc1");
  expect(renderRpmSpec({ ...BASE, version: "0.1.0-rc1" })).toContain("Version: 0.1.0~rc1");
});

test("the payload keeps the window that fits the package under the repo's file limit", () => {
  expect(renderRpmSpec(BASE)).toContain("%global _binary_payload w19L27.zstdio");
});

test("rpmbuild does not strip the binaries, since a compiled Bun binary would lose its program", () => {
  expect(renderRpmSpec(BASE)).toContain("%global __os_install_post %{nil}");
});

test("declares bubblewrap as the only runtime dependency, and no libcap", () => {
  const s = renderRpmSpec(BASE);
  expect(s).toContain("AutoReqProv: no");
  expect(s.match(/^Requires:.*$/gm)).toEqual(["Requires: bubblewrap"]);
  expect(s).not.toContain("libcap");
});

test("maps binaries to /usr/lib/nimbus/bin and wrappers to /usr/local/bin", () => {
  const s = renderRpmSpec(BASE);
  expect(s).toContain(
    "'/work/bundle/nimbus-gateway' '%{buildroot}/usr/lib/nimbus/bin/nimbus-gateway'",
  );
  expect(s).toContain("'/work/bundle/nimbus' '%{buildroot}/usr/lib/nimbus/bin/nimbus'");
  expect(s).toContain("'/work/wrappers/nimbus' '%{buildroot}/usr/local/bin/nimbus'");
  expect(s).toContain(
    "'/work/wrappers/nimbus-gateway' '%{buildroot}/usr/local/bin/nimbus-gateway'",
  );
});

test("a staged path cannot break the quoting or start a macro", () => {
  const s = renderRpmSpec({ ...BASE, binDir: "/work/it's 100%" });
  expect(s).toContain(`'/work/it'\\''s 100%%/nimbus-gateway' '%{buildroot}`);
});

test("every installed file is listed, owned by root", () => {
  const s = renderRpmSpec({ ...BASE, hasVec0: true });
  const installed = [...s.matchAll(/%\{buildroot\}(\S+)'$/gm)].map((m) => m[1]);
  const listed = [...s.matchAll(/^%attr\(\d+,root,root\) (\S+)$/gm)].map((m) => m[1]);
  expect(installed).toHaveLength(6);
  expect(listed).toEqual(installed);
});

test("ships vec0.so beside the gateway when the bundle has one, and not otherwise", () => {
  const s = renderRpmSpec({ ...BASE, hasVec0: true });
  expect(s).toContain(
    "install -D -m 0644 '/work/bundle/vec0.so' '%{buildroot}/usr/lib/nimbus/bin/vec0.so'",
  );
  expect(s).toContain("%attr(0644,root,root) /usr/lib/nimbus/bin/vec0.so");
  expect(renderRpmSpec(BASE)).not.toContain("vec0");
  expect(renderRpmSpec({ ...BASE, hasVec0: false })).not.toContain("vec0");
});

test("always includes the sandbox helper at mode 0755, with no install script", () => {
  const s = renderRpmSpec(BASE);
  expect(s).toContain("%attr(0755,root,root) /usr/lib/nimbus/bin/nimbus-sandbox-helper");
  // There is nothing for one to do: the helper holds no capability, and setcap is gone.
  expect(s).not.toContain("%post");
  expect(s).not.toContain("setcap");
});
