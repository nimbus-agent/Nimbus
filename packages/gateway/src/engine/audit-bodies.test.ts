// packages/gateway/src/engine/audit-bodies.test.ts
// Phase 9.7 D2: the audit row and the egress ledger record a CloudFormation template's size and
// hash, never its text.
import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { CONNECTOR_WRITE_ROWS } from "../connectors/connector-writes/index.ts";
import {
  carriesTemplateText,
  omitTemplateText,
  TEMPLATE_WRITE_ACTION_TYPES,
  withoutTemplateText,
} from "./audit-bodies.ts";

const TEMPLATE = "Resources:\n  Bucket:\n    Type: AWS::S3::Bucket # sécret-looking text\n";
const SHA = createHash("sha256").update(TEMPLATE, "utf8").digest("hex");
const BYTES = Buffer.byteLength(TEMPLATE, "utf8");

describe("omitTemplateText", () => {
  test("nested: the template becomes its byte size and hash; everything else is kept", () => {
    const payload = {
      mcpToolId: "t",
      input: { stackName: "s", templateBody: TEMPLATE, capabilities: ["CAPABILITY_IAM"] },
    };
    expect(omitTemplateText(payload)).toEqual({
      mcpToolId: "t",
      input: {
        stackName: "s",
        capabilities: ["CAPABILITY_IAM"],
        templateBytes: BYTES,
        templateSha256: SHA,
      },
    });
    expect(payload.input.templateBody).toBe(TEMPLATE);
  });

  test("flat: the same at the payload root", () => {
    expect(omitTemplateText({ stackName: "s", templateBody: TEMPLATE })).toEqual({
      stackName: "s",
      templateBytes: BYTES,
      templateSha256: SHA,
    });
  });

  test("a template that is not text is recorded as malformed, never as itself", () => {
    expect(omitTemplateText({ input: { templateBody: { Resources: {} } } })).toEqual({
      input: { templateMalformed: true },
    });
    expect(omitTemplateText({ templateBody: 7 })).toEqual({ templateMalformed: true });
  });

  test("no templateBody key: undefined; a non-object input falls back to the root", () => {
    expect(omitTemplateText({})).toBeUndefined();
    expect(omitTemplateText({ input: { stackName: "s" } })).toBeUndefined();
    expect(omitTemplateText({ input: "x", templateBody: TEMPLATE })).toEqual({
      input: "x",
      templateBytes: BYTES,
      templateSha256: SHA,
    });
  });
});

describe("withoutTemplateText: only the deploy write and the iac prepare read", () => {
  test("the recognised write type is the CloudFormation bound row's, and the prepare read is iac's", () => {
    const cfn = CONNECTOR_WRITE_ROWS.filter(
      (r) =>
        r.bound?.prepare.settle === "iac-cfn" &&
        r.preview?.fields.some((f) => f.key === "templateBody"),
    );
    expect([...TEMPLATE_WRITE_ACTION_TYPES].sort()).toEqual(cfn.map((r) => r.actionType).sort());
    for (const type of ["iac.cloudformation.deploy", "iac.write.prepare"]) {
      expect(carriesTemplateText(type), type).toBe(true);
    }
    for (const type of [
      "github.write.prepare",
      "iac.write.prepare.x",
      "iac.write",
      "iac",
      "iac.terraform.apply",
      "",
      "mcp_files.tool.run",
    ]) {
      expect(carriesTemplateText(type), type).toBe(false);
    }
  });

  test("the write and the prepare read lose their template text, nested and flat", () => {
    for (const type of ["iac.cloudformation.deploy", "iac.write.prepare"]) {
      for (const payload of [
        { mcpToolId: "t", input: { templateBody: TEMPLATE } },
        { templateBody: TEMPLATE },
      ]) {
        const out = withoutTemplateText({ type, payload });
        expect(JSON.stringify(out), type).not.toContain("sécret");
        expect(JSON.stringify(out), type).toContain(SHA);
      }
    }
  });

  test("a 50 KiB template is never in the recorded action", () => {
    const big = `# ${"x".repeat(51_000)}\n`;
    const out = withoutTemplateText({
      type: "iac.cloudformation.deploy",
      payload: { input: { stackName: "s", templateBody: big } },
    });
    expect(JSON.stringify(out).length).toBeLessThan(500);
  });

  test("every other action is returned as it is", () => {
    const other = { type: "github.file.commit", payload: { input: { templateBody: TEMPLATE } } };
    expect(withoutTemplateText(other)).toBe(other);
    const noPayload = { type: "iac.cloudformation.deploy" };
    expect(withoutTemplateText(noPayload)).toBe(noPayload);
    const noBody = { type: "iac.cloudformation.deploy", payload: { input: { stackName: "s" } } };
    expect(withoutTemplateText(noBody)).toBe(noBody);
  });
});

describe("omitTemplateText strips BOTH levels (adversarial review of batch 2)", () => {
  test("a root-level templateBody beside a nested input never reaches the record", () => {
    const payload = {
      mcpToolId: "t",
      templateBody: TEMPLATE,
      input: { stackName: "s", templateBody: TEMPLATE },
    };
    const out = omitTemplateText(payload);
    expect(JSON.stringify(out)).not.toContain("Bucket");
    expect(out).toEqual({
      mcpToolId: "t",
      templateBytes: BYTES,
      templateSha256: SHA,
      input: { stackName: "s", templateBytes: BYTES, templateSha256: SHA },
    });
  });

  test("a root-level templateBody beside an input that carries none is still stripped", () => {
    const out = omitTemplateText({ templateBody: TEMPLATE, input: { stackName: "s" } });
    expect(out).toEqual({
      templateBytes: BYTES,
      templateSha256: SHA,
      input: { stackName: "s" },
    });
  });

  test("withoutTemplateText applies it to the audit and the ledger form of a deploy", () => {
    const action = {
      type: "iac.cloudformation.deploy",
      payload: { templateBody: TEMPLATE, input: { stackName: "s" } },
    };
    expect(JSON.stringify(withoutTemplateText(action))).not.toContain("Bucket");
  });
});
