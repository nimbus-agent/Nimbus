import { describe, expect, test } from "bun:test";

import type { PackageSource, WriteToolRegistration } from "./connector-write-registrations.ts";
import { resolveRegistrationMutates } from "./registration-mutates.ts";

function reg(file: string, text: string, id: string): [PackageSource[], WriteToolRegistration] {
  const open = text.indexOf("(");
  const close = text.lastIndexOf(")");
  return [
    [{ rel: file, text }],
    { id, file, line: 1, origin: file, tags: ["literal"], span: [open, close] },
  ];
}

describe("resolveRegistrationMutates", () => {
  test("a literal mutates", () => {
    const [s, r] = reg(
      "connectors/slack/src/tools.ts",
      'registerWriteTool("slack_message_post", { mutates: "slack.message.post" }, h)',
      "slack_message_post",
    );
    expect(resolveRegistrationMutates(s, r)).toEqual({ value: "slack.message.post" });
  });
  test("a helper whose first parameter is `mutates: string`", () => {
    const helper: PackageSource = {
      rel: "shared/imap-tool-kit.ts",
      text: "export function mailSendConsent<T extends { readonly to: string }>(\n  mutates: string,\n): X { return { mutates }; }",
    };
    const [s, r] = reg(
      "connectors/gmail/src/tools.ts",
      'registerWriteTool("gmail_message_send", mailSendConsent("gmail.message.send"), "d")',
      "gmail_message_send",
    );
    expect(resolveRegistrationMutates([...s, helper], r)).toEqual({ value: "gmail.message.send" });
  });
  test("a kit template sharing the id's prefix variable", () => {
    const [s, r] = reg(
      "shared/imap-tool-kit.ts",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS template source text
      "registerWriteTool(`${toolPrefix}_mail_send`, { mutates: `${toolPrefix}.mail.send` }, h)",
      "imap_mail_send",
    );
    expect(resolveRegistrationMutates(s, r)).toEqual({ value: "imap.mail.send" });
  });
  test("a kit template handed to a `mutates: string` helper (the 0.2.4 imap kit shape)", () => {
    const helper: PackageSource = {
      rel: "shared/consent.ts",
      text: "export function mailSendConsent<T>(\n  mutates: string,\n): X { return { mutates }; }",
    };
    const [s, r] = reg(
      "shared/imap-tool-kit.ts",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS template source text
      "registerWriteTool(`${toolPrefix}_mail_send`, mailSendConsent(`${toolPrefix}.mail.send`), h)",
      "protonmail_mail_send",
    );
    expect(resolveRegistrationMutates([...s, helper], r)).toEqual({
      value: "protonmail.mail.send",
    });
  });
  test("a template whose variable the id does not share is a reason", () => {
    const [s, r] = reg(
      "shared/imap-tool-kit.ts",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the fixture IS template source text
      "registerWriteTool(`${a}_mail_send`, { mutates: `${b}.mail.send` }, h)",
      "imap_mail_send",
    );
    expect(resolveRegistrationMutates(s, r)).toHaveProperty("reason");
  });
  test("a helper that does not take `mutates` first is not trusted", () => {
    const helper: PackageSource = {
      rel: "shared/x.ts",
      text: "export function other(\n  name: string,\n): X { return {}; }",
    };
    const [s, r] = reg(
      "connectors/x/src/tools.ts",
      'registerWriteTool("x_y", other("x.y"), h)',
      "x_y",
    );
    expect(resolveRegistrationMutates([...s, helper], r)).toHaveProperty("reason");
  });
  test("anything else is a reason, never a guess", () => {
    const [s, r] = reg("connectors/x/src/tools.ts", 'registerWriteTool("x_y", cfg, h)', "x_y");
    expect(resolveRegistrationMutates(s, r)).toHaveProperty("reason");
  });
});
