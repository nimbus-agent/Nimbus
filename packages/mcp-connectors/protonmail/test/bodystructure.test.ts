import { describe, expect, test } from "bun:test";

import {
  type BodyStructureNode,
  extractAttachments,
  findTextPlainPart,
} from "../src/bodystructure.ts";

describe("extractAttachments", () => {
  test("collects filename/size/mimetype from attachment leaves (disposition + name param)", () => {
    const root: BodyStructureNode = {
      childNodes: [
        { part: "1", type: "text/plain", size: 100 },
        {
          part: "2",
          type: "application/pdf",
          size: 2048,
          disposition: "attachment",
          dispositionParameters: { filename: "report.pdf" },
        },
        { part: "3", type: "image/png", size: 50, parameters: { name: "logo.png" } },
      ],
    };
    expect(
      extractAttachments(root)
        .map((a) => a.filename)
        .sort(),
    ).toEqual(["logo.png", "report.pdf"]);
  });

  test("recurses nested multiparts and ignores plain body parts", () => {
    const root: BodyStructureNode = {
      childNodes: [
        {
          childNodes: [
            { part: "1.1", type: "text/plain", size: 10 },
            {
              part: "1.2",
              type: "application/zip",
              disposition: "attachment",
              dispositionParameters: { filename: "a.zip" },
            },
          ],
        },
      ],
    };
    expect(extractAttachments(root)).toEqual([
      { filename: "a.zip", sizeBytes: null, mimeType: "application/zip" },
    ]);
  });

  test("returns [] for undefined/null", () => {
    expect(extractAttachments(undefined)).toEqual([]);
    expect(extractAttachments(null)).toEqual([]);
  });
});

describe("findTextPlainPart", () => {
  test("prefers the first non-attachment text/plain leaf", () => {
    expect(
      findTextPlainPart({
        childNodes: [
          { part: "1", type: "text/html", size: 1 },
          { part: "2", type: "text/plain", size: 1 },
        ],
      }),
    ).toBe("2");
  });

  test("falls back to the first text/* part, then to '1'", () => {
    expect(findTextPlainPart({ childNodes: [{ part: "1", type: "text/html", size: 1 }] })).toBe(
      "1",
    );
    expect(findTextPlainPart(undefined)).toBe("1");
    expect(findTextPlainPart({})).toBe("1");
  });

  test("never selects an attachment text part", () => {
    expect(
      findTextPlainPart({
        childNodes: [
          {
            part: "1",
            type: "text/plain",
            disposition: "attachment",
            dispositionParameters: { filename: "note.txt" },
          },
          { part: "2", type: "text/html", size: 1 },
        ],
      }),
    ).toBe("2");
  });
});
