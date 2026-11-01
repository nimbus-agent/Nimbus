import { describe, expect, test } from "bun:test";

import { sandboxNetworkPosture } from "./sandbox-posture.ts";

type PostureRunner = Parameters<typeof sandboxNetworkPosture>[0];

function runner(opts: {
  fullyActive: boolean;
  scope?: "per_port" | "all_or_nothing";
  refused?: boolean;
}): PostureRunner {
  const { scope, refused } = opts;
  return {
    isFullyActive: () => opts.fullyActive,
    ...(scope === undefined ? {} : { networkScope: () => scope }),
    ...(refused === undefined ? {} : { networkRefused: () => refused }),
  };
}

describe("sandboxNetworkPosture", () => {
  test("a fully active runner with no scope filters per host", () => {
    expect(sandboxNetworkPosture(runner({ fullyActive: true }))).toBe("per_host");
  });
  test("a fully active runner reports its own narrower scope", () => {
    expect(sandboxNetworkPosture(runner({ fullyActive: true, scope: "per_port" }))).toBe(
      "per_port",
    );
    expect(sandboxNetworkPosture(runner({ fullyActive: true, scope: "all_or_nothing" }))).toBe(
      "all_or_nothing",
    );
  });
  test("a degraded runner that refuses reads refusing", () => {
    expect(sandboxNetworkPosture(runner({ fullyActive: false, refused: true }))).toBe("refusing");
  });
  test("a degraded runner that lets the child through reads all_or_nothing", () => {
    expect(sandboxNetworkPosture(runner({ fullyActive: false }))).toBe("all_or_nothing");
    expect(sandboxNetworkPosture(runner({ fullyActive: false, refused: false }))).toBe(
      "all_or_nothing",
    );
  });
});
