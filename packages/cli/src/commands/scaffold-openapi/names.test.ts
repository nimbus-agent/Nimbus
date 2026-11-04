import { describe, expect, test } from "bun:test";
import {
  credentialEnv,
  credentialName,
  fitCredentialNames,
  MAX_CREDENTIAL_NAME,
  normaliseName,
  toolName,
  uniqueNames,
} from "./names.ts";

describe("normaliseName", () => {
  test("lower-cases, turns other runs into one _, trims _", () => {
    expect(normaliseName("getPetById")).toBe("getpetbyid");
    expect(normaliseName("--List  Pets!!v2__")).toBe("list_pets_v2");
    expect(normaliseName("___")).toBe("");
  });
});

describe("toolName", () => {
  test("uses the normalised operationId", () => {
    expect(toolName({ operationId: "pets.List-All" }, "get", "/pets")).toBe("pets_list_all");
  });

  test("falls back to <method>_<path segments> without an operationId", () => {
    expect(toolName({}, "get", "/pets/{petId}/toys")).toBe("get_pets_petid_toys");
    expect(toolName({ operationId: 42 }, "delete", "/pets")).toBe("delete_pets");
  });

  test("falls back when the operationId normalises to nothing", () => {
    expect(toolName({ operationId: "$$$" }, "post", "/")).toBe("post");
  });

  test("an inherited operationId is not read", () => {
    const op = Object.create({ operationId: "inherited" }) as Record<string, unknown>;
    expect(toolName(op, "get", "/x")).toBe("get_x");
  });
});

describe("uniqueNames", () => {
  test("collisions get _2, _3 in order", () => {
    expect(uniqueNames(["a", "a", "a", "b"], 50)).toEqual({
      names: ["a", "a_2", "a_3", "b"],
      cut: [],
    });
  });

  test("a name longer than the cap is cut and listed", () => {
    const long = "x".repeat(60);
    expect(uniqueNames([long], 50)).toEqual({
      names: ["x".repeat(50)],
      cut: [{ from: long, to: "x".repeat(50) }],
    });
  });

  test("two long names that cut to the same prefix end distinct and within the cap", () => {
    const a = `${"y".repeat(50)}_alpha`;
    const b = `${"y".repeat(50)}_beta`;
    const out = uniqueNames([a, b], 50);
    expect(out.names).toEqual(["y".repeat(50), `${"y".repeat(48)}_2`]);
    expect(out.names.every((n) => n.length <= 50)).toBe(true);
    expect(out.cut).toEqual([
      { from: a, to: "y".repeat(50) },
      { from: b, to: `${"y".repeat(48)}_2` },
    ]);
  });

  test("a cut never leaves a trailing _", () => {
    expect(uniqueNames(["abcd_efgh"], 5).names).toEqual(["abcd"]);
  });
});

describe("credentialName / credentialEnv", () => {
  test("normalises the scheme name", () => {
    expect(credentialName("Api-Key")).toBe("api_key");
  });

  test("prefixes c_ when the name does not start with a letter", () => {
    expect(credentialName("2fa token")).toBe("c_2fa_token");
    expect(credentialName("_x")).toBe("x");
  });

  test("env is upper-cased, prefixed API_ when reserved", () => {
    expect(credentialEnv("petstore_key")).toBe("PETSTORE_KEY");
    expect(credentialEnv("path")).toBe("API_PATH");
    expect(credentialEnv("nimbus_token")).toBe("API_NIMBUS_TOKEN");
    expect(credentialEnv("lang")).toBe("API_LANG");
  });
});

describe("fitCredentialNames", () => {
  test("a single name is returned as is when free", () => {
    expect(fitCredentialNames("api_key", [""], new Set(), new Set())).toEqual(["api_key"]);
  });

  test("a collision gets _2", () => {
    expect(fitCredentialNames("api_key", [""], new Set(["api_key"]), new Set())).toEqual([
      "api_key_2",
    ]);
  });

  test("an env collision counts as a collision", () => {
    expect(fitCredentialNames("api_path", [""], new Set(), new Set(["API_PATH"]))).toEqual([
      "api_path_2",
    ]);
  });

  test("basic names are cut so the FINAL names, suffix and _N included, are at most 32", () => {
    const base = "b".repeat(40);
    const first = fitCredentialNames(base, ["_user", "_password"], new Set(), new Set());
    expect(first).toEqual([`${"b".repeat(23)}_user`, `${"b".repeat(23)}_password`]);
    const taken = new Set(first);
    const second = fitCredentialNames(base, ["_user", "_password"], taken, new Set());
    expect(second).toEqual([`${"b".repeat(21)}_2_user`, `${"b".repeat(21)}_2_password`]);
    for (const n of [...first, ...second])
      expect(n.length).toBeLessThanOrEqual(MAX_CREDENTIAL_NAME);
  });
});

describe("uniqueNames with a tiny cap", () => {
  test("a suffix longer than the room never slices from the end", () => {
    expect(uniqueNames(["ab", "ab"], 1).names).toEqual(["a", "_2"]);
  });
});
