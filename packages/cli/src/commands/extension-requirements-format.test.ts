import { describe, expect, test } from "bun:test";

import {
  parseRequirementStatuses,
  type RequirementState,
  requirementLines,
} from "./extension-requirements-format.ts";

const base = {
  owner: { kind: "bundled" },
  interactive: false,
  requiredBy: ["acme.tool"],
};
const entry = (connector: string, state: RequirementState, fix: string[] = []) => ({
  ...base,
  connector,
  state,
  fix,
});

describe("requirementLines", () => {
  const lines = (connector: string, state: RequirementState, fix: string[] = []) =>
    requirementLines(parseRequirementStatuses([entry(connector, state, fix)]));

  test("met", () => {
    expect(lines("github", "met")).toEqual(["  github: connected"]);
  });

  test("configured_never_synced", () => {
    expect(lines("github", "configured_never_synced", ["nimbus connector sync github"])).toEqual([
      "  github: connected, never synced — run: nimbus connector sync github",
    ]);
  });

  test("not_connected, with one fix and with several joined by &&", () => {
    expect(lines("github", "not_connected", ["nimbus connector auth github"])).toEqual([
      "  github: not connected — run: nimbus connector auth github",
    ]);
    expect(
      lines("readwise", "not_connected", [
        "nimbus extension approve com.x.readwise",
        "nimbus extension credential set com.x.readwise token",
      ]),
    ).toEqual([
      "  readwise: not connected — run: nimbus extension approve com.x.readwise && nimbus extension credential set com.x.readwise token",
    ]);
  });

  test("unknown_connector", () => {
    expect(lines("foo", "unknown_connector")).toEqual(["  foo: not a connector this Nimbus knows"]);
  });

  test("unknown", () => {
    expect(lines("github", "unknown")).toEqual(["  github: status unavailable"]);
  });

  test("control characters in a manifest-sourced id are stripped", () => {
    const line = lines("git\u001b[31mhub\nx", "met")[0] ?? "";
    expect(line.includes("\u001b")).toBe(false);
    expect(line.includes("\n")).toBe(false);
  });
});

describe("parseRequirementStatuses", () => {
  test("drops a malformed entry and keeps the rest", () => {
    const out = parseRequirementStatuses([
      entry("github", "met"),
      { connector: "x" },
      { ...entry("y", "met"), state: "bogus" },
      "nope",
      null,
      entry("slack", "unknown"),
    ]);
    expect(out.map((r) => r.connector)).toEqual(["github", "slack"]);
  });

  test("a non-array is nothing to show", () => {
    expect(parseRequirementStatuses(undefined)).toEqual([]);
    expect(parseRequirementStatuses({})).toEqual([]);
  });

  test("keeps owner, interactive and requiredBy", () => {
    const [r] = parseRequirementStatuses([
      {
        ...entry("readwise", "not_connected", ["a"]),
        owner: { kind: "extension", extensionId: "com.x.readwise" },
        interactive: true,
      },
    ]);
    expect(r?.owner).toEqual({ kind: "extension", extensionId: "com.x.readwise" });
    expect(r?.interactive).toBe(true);
    expect(r?.requiredBy).toEqual(["acme.tool"]);
  });
});
