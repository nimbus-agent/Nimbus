import { describe, expect, test } from "bun:test";

import { DEFAULT_COST_AWS_CONFIG, parseS3ExportUrl } from "./cost-aws-toml.ts";
import { resolveCostConfig } from "./cost-toml.ts";
import { mergeLayerDocs, parseLayerDoc } from "./layered-merge.ts";

const base = (text: string) =>
  resolveCostConfig(
    mergeLayerDocs([parseLayerDoc({ kind: "base", id: "base", path: "/x/0" }, text)]).sections,
  );
const aws = (body: string) => base(`[cost.aws]\n${body}\n`);

describe("[cost.aws]", () => {
  test("absent: nothing configured", () => {
    expect(base("").aws).toEqual(DEFAULT_COST_AWS_CONFIG);
  });

  test("an export URL and the Cost Explorer opt-in", () => {
    const c = aws('export = "s3://my-bucket/focus/prod/"\ncost_explorer = true');
    expect(c.error).toBeNull();
    expect(c.aws).toEqual({
      export: { bucket: "my-bucket", prefix: "focus/prod" },
      costExplorer: true,
    });
  });

  test("a bucket alone has an empty prefix", () => {
    expect(parseS3ExportUrl("s3://my.bucket-1")).toEqual({ bucket: "my.bucket-1", prefix: "" });
  });

  test("refusals", () => {
    for (const v of [
      "https://b/x",
      "s3://",
      "s3://AB/x",
      "s3://ab/x",
      "s3://a..b/x",
      "s3://192.168.0.1/x",
      "s3://bucket/../x",
      "s3://bucket/a//b",
      "s3://bucket/a b",
      "s3://bucket/a?b",
      `s3://bucket/${"a".repeat(600)}`,
      3,
    ]) {
      expect(() => parseS3ExportUrl(v)).toThrow("[cost.aws].export");
    }
  });

  test("an unknown key or a non-boolean opt-in refuses the whole cost config", () => {
    expect(aws('bucket = "x"').error).toContain('unknown key "bucket"');
    expect(aws('cost_explorer = "yes"').error).toContain("true or false");
    expect(aws('export = "nope"').error).toContain("[cost.aws].export");
  });
});
