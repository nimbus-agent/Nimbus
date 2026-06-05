import { expect, test } from "bun:test";
import { parseIdentityArgs } from "./identity.ts";

test("login (default)", () => {
  expect(parseIdentityArgs([])).toEqual({ kind: "login" });
  expect(parseIdentityArgs(["login"])).toEqual({ kind: "login" });
});
test("status / logout", () => {
  expect(parseIdentityArgs(["status"])).toEqual({ kind: "status" });
  expect(parseIdentityArgs(["logout"])).toEqual({ kind: "logout" });
});
test("bind requires email + peer", () => {
  expect(parseIdentityArgs(["bind", "a@acme.com", "peer:aa"])).toEqual({
    kind: "bind",
    email: "a@acme.com",
    peerId: "peer:aa",
  });
  expect(() => parseIdentityArgs(["bind", "a@acme.com"])).toThrow();
});
test("unbind / list-bindings", () => {
  expect(parseIdentityArgs(["unbind", "peer:aa"])).toEqual({ kind: "unbind", peerId: "peer:aa" });
  expect(parseIdentityArgs(["list-bindings", "a@acme.com"])).toEqual({
    kind: "listBindings",
    email: "a@acme.com",
  });
});
test("unknown throws", () => {
  expect(() => parseIdentityArgs(["bogus"])).toThrow();
});
