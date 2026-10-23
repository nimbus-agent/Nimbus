import { describe, expect, test } from "bun:test";
import { bashQuote, pwshQuote, quoteForPrintedCommand } from "./shell-quote.ts";

describe("bashQuote / pwshQuote", () => {
  test("single-quote, so nothing inside expands", () => {
    expect(bashQuote("/tmp/$(rm -rf ~)/`id`")).toBe("'/tmp/$(rm -rf ~)/`id`'");
    expect(pwshQuote("C:\\a $env:X")).toBe("'C:\\a $env:X'");
  });

  test("escape an embedded single quote the way each shell reads it", () => {
    expect(bashQuote("it's")).toBe(String.raw`'it'\''s'`);
    expect(pwshQuote("it's")).toBe("'it''s'");
  });
});

describe("quoteForPrintedCommand", () => {
  test("a plain token stays bare", () => {
    expect(quoteForPrintedCommand("acme/tool@1.0.0", "linux")).toBe("acme/tool@1.0.0");
  });

  test("a path with $ or backticks is single-quoted, never double-quoted", () => {
    const clone = "/home/me/$(touch pwned) `id`";
    expect(quoteForPrintedCommand(clone, "linux")).toBe(`'${clone}'`);
    expect(quoteForPrintedCommand(clone, "darwin")).toBe(`'${clone}'`);
    expect(quoteForPrintedCommand(clone, "win32")).toBe(`'${clone}'`);
  });

  test("Windows gets PowerShell's quote escape, elsewhere bash's", () => {
    expect(quoteForPrintedCommand("O'Neil dir", "win32")).toBe("'O''Neil dir'");
    expect(quoteForPrintedCommand("O'Neil dir", "linux")).toBe(String.raw`'O'\''Neil dir'`);
  });
});
