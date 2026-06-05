import { expect, test } from "bun:test";
import { parseScimArgs } from "./scim.ts";

test("status / list-users defaults", () => {
  expect(parseScimArgs(["status"])).toEqual({ kind: "status" });
  expect(parseScimArgs(["list-users"])).toEqual({ kind: "listUsers" });
});
test("set-token requires a token", () => {
  expect(parseScimArgs(["set-token", "secret"])).toEqual({ kind: "setToken", token: "secret" });
  expect(() => parseScimArgs(["set-token"])).toThrow();
});
test("deprovision requires an email", () => {
  expect(parseScimArgs(["deprovision", "a@acme.com"])).toEqual({
    kind: "deprovision",
    email: "a@acme.com",
  });
  expect(() => parseScimArgs(["deprovision"])).toThrow();
});
