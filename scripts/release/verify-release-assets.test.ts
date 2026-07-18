import { describe, expect, test } from "bun:test";
import type { GitHubApi, Release } from "./gh-api.ts";
import { diffReleaseAssets, runVerify } from "./verify-release-assets.ts";

describe("diffReleaseAssets", () => {
  const local = [
    { name: "SHA256SUMS", size: 10 },
    { name: "nimbus.deb", size: 500 },
  ];
  test("complete set → no gaps", () => {
    expect(
      diffReleaseAssets(local, [
        { name: "SHA256SUMS", size: 10 },
        { name: "nimbus.deb", size: 500 },
      ]),
    ).toEqual([]);
  });
  test("missing file → gap", () => {
    expect(diffReleaseAssets(local, [{ name: "SHA256SUMS", size: 10 }])).toEqual([
      { name: "nimbus.deb", reason: "missing" },
    ]);
  });
  test("zero-byte remote asset → gap", () => {
    expect(
      diffReleaseAssets(local, [
        { name: "SHA256SUMS", size: 10 },
        { name: "nimbus.deb", size: 0 },
      ]),
    ).toEqual([{ name: "nimbus.deb", reason: "zero-byte" }]);
  });
  test("extra remote asset → ignored", () => {
    expect(
      diffReleaseAssets(local, [
        { name: "SHA256SUMS", size: 10 },
        { name: "nimbus.deb", size: 5 },
        { name: "extra", size: 9 },
      ]),
    ).toEqual([]);
  });
});

function fakeApi(release: Release | null): GitHubApi {
  return { getReleaseByTag: async () => release } as unknown as GitHubApi;
}

describe("runVerify", () => {
  const local = [
    { name: "SHA256SUMS", size: 10 },
    { name: "SHA256SUMS.asc", size: 5 },
    { name: "nimbus.deb", size: 9 },
  ];
  test("all present → ok", async () => {
    const r = await runVerify({ api: fakeApi({ tagName: "v1", assets: local }), tag: "v1", local });
    expect(r.ok).toBe(true);
    expect(r.gaps).toEqual([]);
  });
  test("missing asset → not ok, gap listed", async () => {
    const r = await runVerify({
      api: fakeApi({ tagName: "v1", assets: local.slice(0, 2) }),
      tag: "v1",
      local,
    });
    expect(r.ok).toBe(false);
    expect(r.gaps).toEqual([{ name: "nimbus.deb", reason: "missing" }]);
    expect(r.summary).toContain("nimbus.deb");
  });
  test("no release at all → not ok", async () => {
    const r = await runVerify({ api: fakeApi(null), tag: "v1", local });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("no release");
  });
  test("SHA256SUMS.asc absent → not ok (sanity assert)", async () => {
    const l = [
      { name: "SHA256SUMS", size: 10 },
      { name: "nimbus.deb", size: 9 },
    ];
    const r = await runVerify({
      api: fakeApi({ tagName: "v1", assets: l }),
      tag: "v1",
      local: l,
      requireSums: true,
    });
    expect(r.ok).toBe(false);
    expect(r.summary).toContain("SHA256SUMS.asc");
  });
});
