import { describe, expect, test } from "bun:test";
import {
  APT_ARCH,
  APT_CODENAME,
  APT_COMPONENT,
  assetSha256,
  debAssetName,
  renderRepreproDistributions,
  renderYumRepoFile,
  rpmAssetName,
} from "./linux-repo-config.ts";

const SUMS = [
  "1111111111111111111111111111111111111111111111111111111111111111  nimbus-headless_1.2.3_amd64.deb",
  "2222222222222222222222222222222222222222222222222222222222222222  nimbus-headless-1.2.3-x86_64.rpm",
  "3333333333333333333333333333333333333333333333333333333333333333  SHA256SUMS",
  "",
].join("\n");

describe("linux-repo-config artifact helpers", () => {
  test("debAssetName builds the released .deb name, stripping a leading v", () => {
    expect(debAssetName("1.2.3")).toBe("nimbus-headless_1.2.3_amd64.deb");
    expect(debAssetName("v1.2.3")).toBe("nimbus-headless_1.2.3_amd64.deb");
  });

  test("rpmAssetName builds the released .rpm name, stripping a leading v", () => {
    expect(rpmAssetName("1.2.3")).toBe("nimbus-headless-1.2.3-x86_64.rpm");
    expect(rpmAssetName("v1.2.3")).toBe("nimbus-headless-1.2.3-x86_64.rpm");
  });

  test("assetSha256 extracts a file's hash from SHA256SUMS", () => {
    expect(assetSha256(SUMS, "nimbus-headless_1.2.3_amd64.deb")).toBe(
      "1111111111111111111111111111111111111111111111111111111111111111",
    );
    expect(assetSha256(SUMS, "nimbus-headless-1.2.3-x86_64.rpm")).toBe(
      "2222222222222222222222222222222222222222222222222222222222222222",
    );
  });

  test("assetSha256 throws (fail loud) when the file is absent", () => {
    expect(() => assetSha256(SUMS, "nope.deb")).toThrow("nope.deb");
  });
});

describe("renderRepreproDistributions", () => {
  const conf = renderRepreproDistributions();

  test("declares the stable distribution with our codename/component/arch", () => {
    expect(conf).toContain(`Codename: ${APT_CODENAME}`);
    expect(conf).toContain(`Components: ${APT_COMPONENT}`);
    expect(conf).toContain(`Architectures: ${APT_ARCH}`);
  });

  test("does NOT set SignWith (we sign Release manually with loopback gpg)", () => {
    expect(conf).not.toContain("SignWith");
  });

  test("ends with a trailing newline (reprepro requires a final newline)", () => {
    expect(conf.endsWith("\n")).toBe(true);
  });
});

describe("renderYumRepoFile", () => {
  const repo = renderYumRepoFile({ baseUrl: "https://nimbus-agent.github.io/linux-repo" });

  test("points baseurl at the yum tree and gpgkey at the published key", () => {
    expect(repo).toContain("baseurl=https://nimbus-agent.github.io/linux-repo/yum");
    expect(repo).toContain("gpgkey=https://nimbus-agent.github.io/linux-repo/gpg.key");
  });

  test("enables gpg + repo_gpg checks (the repo metadata is signed)", () => {
    expect(repo).toContain("gpgcheck=1");
    expect(repo).toContain("repo_gpgcheck=1");
  });

  test("strips a trailing slash on baseUrl so URLs aren't doubled", () => {
    const r = renderYumRepoFile({ baseUrl: "https://nimbus-agent.github.io/linux-repo/" });
    expect(r).toContain("baseurl=https://nimbus-agent.github.io/linux-repo/yum");
    expect(r).not.toContain("linux-repo//yum");
  });
});
