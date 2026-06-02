import { describe, expect, test } from "bun:test";

import {
  type BodyStructureNode,
  extractAttachments,
  findTextPlainPart,
} from "../src/bodystructure.ts";

describe("extractAttachments", () => {
  test("collects filename/size/mimetype from an attachment leaf (content-disposition)", () => {
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
      ],
    };
    expect(extractAttachments(root)).toEqual([
      { filename: "report.pdf", sizeBytes: 2048, mimeType: "application/pdf" },
    ]);
  });

  test("treats a content-type 'name' parameter as an attachment when no disposition", () => {
    const root: BodyStructureNode = {
      childNodes: [{ part: "1", type: "image/png", size: 50, parameters: { name: "logo.png" } }],
    };
    expect(extractAttachments(root)).toEqual([
      { filename: "logo.png", sizeBytes: 50, mimeType: "image/png" },
    ]);
  });

  test("ignores a plain text body part with no filename", () => {
    const root: BodyStructureNode = { part: "1", type: "text/plain", size: 10 };
    expect(extractAttachments(root)).toEqual([]);
  });

  test("recurses into nested multipart trees", () => {
    const root: BodyStructureNode = {
      childNodes: [
        {
          childNodes: [
            { part: "1.1", type: "text/plain", size: 10 },
            {
              part: "1.2",
              type: "application/zip",
              size: 9,
              disposition: "attachment",
              dispositionParameters: { filename: "a.zip" },
            },
          ],
        },
        {
          part: "2",
          type: "application/octet-stream",
          disposition: "attachment",
          dispositionParameters: { filename: "b.bin" },
        },
      ],
    };
    const names = extractAttachments(root)
      .map((a) => a.filename)
      .sort();
    expect(names).toEqual(["a.zip", "b.bin"]);
  });

  test("returns [] for an undefined / null structure", () => {
    expect(extractAttachments(undefined)).toEqual([]);
    expect(extractAttachments(null)).toEqual([]);
  });

  test("nulls a non-numeric size", () => {
    const root: BodyStructureNode = {
      type: "application/pdf",
      disposition: "attachment",
      dispositionParameters: { filename: "x.pdf" },
    };
    expect(extractAttachments(root)[0]?.sizeBytes).toBeNull();
  });
});

describe("findTextPlainPart", () => {
  test("returns the part key of the first non-attachment text/plain leaf", () => {
    const root: BodyStructureNode = {
      childNodes: [
        { part: "1", type: "text/html", size: 1 },
        { part: "2", type: "text/plain", size: 1 },
      ],
    };
    expect(findTextPlainPart(root)).toBe("2");
  });

  test("falls back to the first text/* part when no text/plain exists", () => {
    const root: BodyStructureNode = {
      childNodes: [{ part: "1", type: "text/html", size: 1 }],
    };
    expect(findTextPlainPart(root)).toBe("1");
  });

  test("never selects an attachment text part", () => {
    const root: BodyStructureNode = {
      childNodes: [
        {
          part: "1",
          type: "text/plain",
          disposition: "attachment",
          dispositionParameters: { filename: "note.txt" },
        },
        { part: "2", type: "text/html", size: 1 },
      ],
    };
    expect(findTextPlainPart(root)).toBe("2");
  });

  test("defaults to '1' for an empty / unknown structure", () => {
    expect(findTextPlainPart(undefined)).toBe("1");
    expect(findTextPlainPart({})).toBe("1");
  });
});
