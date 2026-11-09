// D2 Task 9: the iac rows' free text is shown in FULL and deliberately NOT scanned.
//  - A CloudFormation `templateBody` is YAML or JSON CODE, not Markdown or HTML: an `<img>` tag, a URL,
//    `@here` or a line starting with `/` is ordinary text in a template (a `UserData` script, a
//    parameter default, a `Fn::Sub`), and scanning it as Markdown would refuse real templates. The
//    owner reads the whole template and the change set the gateway renders (the template is shown in
//    full as a field, up to 51,200 bytes), and the audit row keeps only its size and hash.
//  - The rendered plan is gateway-built text (escaped, capped, shown in full or the write is
//    refused), never model text, so there is nothing to scan.
//  - Reason recorded for the remote-content rule: it exists for text that is RENDERED when someone
//    opens a draft, page, note or markup file. Neither a template nor a plan is rendered anywhere.
// These tests fail if any iac key is added to a scan table by accident (a decision, not a drift).
import { describe, expect, test } from "bun:test";
import type { ChatopsPolicy } from "../../policy/types.ts";
import {
  actDoorRefusal,
  modelWriteRefusal,
  nullRefusedOptionalKeys,
  quickActionTextKeys,
  remoteContentScannedKeys,
  remoteContentScannedRows,
  scannedTextKeys,
  scopedLabelKeys,
} from "./model-write-refusals.ts";

const IAC_ROWS = [
  "iac_terraform_apply",
  "iac_terraform_destroy",
  "iac_cloudformation_deploy",
  "iac_pulumi_up",
  "iac_cloudformation_changeset_discard",
] as const;
const NO_CHATOPS: ChatopsPolicy = { channels: new Map(), ownership: new Map() };

describe("iac free text is shown in full and not scanned", () => {
  test("no iac row is in any scan table, whatever its keys", () => {
    for (const id of IAC_ROWS) {
      expect(remoteContentScannedRows(), id).not.toContain(id);
      expect(remoteContentScannedKeys(id), id).toEqual([]);
      expect(scannedTextKeys(id), id).toEqual([]);
      expect(quickActionTextKeys(id), id).toEqual([]);
      expect(scopedLabelKeys(id), id).toEqual([]);
      expect(nullRefusedOptionalKeys(id), id).toEqual([]);
    }
  });

  test("template code that would be refused as Markdown or chat text passes on the model door", () => {
    const template = [
      "Resources:",
      "  Fn:",
      "    Type: AWS::Lambda::Function",
      "    Properties:",
      "      Description: '<img src=\"https://example.invalid/pixel.png\"> @here @channel <!here>'",
      "      Code:",
      "        ZipFile: |",
      "          /close",
      "          [![badge](https://example.invalid/b.svg)](https://example.invalid)",
    ].join("\n");
    const input = { stackName: "prod-stack", templateBody: template, capabilities: [] };
    expect(
      modelWriteRefusal("iac_cloudformation_deploy", input, { chatops: NO_CHATOPS, kb: undefined }),
    ).toBeUndefined();
  });

  test("the act door's refusal check is not the control for an iac row either (every iac type is denied there)", () => {
    for (const id of IAC_ROWS) {
      expect(
        actDoorRefusal(
          id,
          { templateBody: "<img src=x>" },
          {
            chatops: NO_CHATOPS,
            kb: undefined,
            kbUnreadable: false,
          },
        ),
        id,
      ).toBeUndefined();
    }
  });
});
