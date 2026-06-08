import { describe, expect, test } from "bun:test";

import { planFromIntent } from "./planner.ts";
import type { ClassifiedIntent } from "./router.ts";

const paths = {
  configDir: "/c",
  dataDir: "/d",
  logDir: "/l",
  socketPath: "/s.sock",
  extensionsDir: "/e",
  tempDir: "/t",
};

describe("planFromIntent", () => {
  test("low confidence yields clarification reply", () => {
    const c: ClassifiedIntent = {
      intent: "file_search",
      entities: { pattern: "x" },
      requiresHITL: false,
      confidence: 0.2,
    };
    const p = planFromIntent(c, paths);
    expect(p.kind).toBe("reply");
    if (p.kind === "reply") {
      expect(p.text.length).toBeGreaterThan(10);
    }
  });

  test("file_search builds filesystem_search_files action", () => {
    const c: ClassifiedIntent = {
      intent: "file_search",
      entities: { pattern: "*.ts" },
      requiresHITL: false,
      confidence: 0.9,
    };
    const p = planFromIntent(c, paths);
    expect(p.kind).toBe("actions");
    if (p.kind === "actions") {
      expect(p.actions).toHaveLength(1);
      const a = p.actions[0];
      expect(a?.type).toBe("filesystem_search_files");
      expect(a?.payload).toEqual({
        input: { path: paths.dataDir, pattern: "*.ts" },
      });
    }
  });

  test("file_organize uses file.move + filesystem_move_file for HITL", () => {
    const c: ClassifiedIntent = {
      intent: "file_organize",
      entities: { source: "/a", destination: "/b" },
      requiresHITL: true,
      confidence: 1,
    };
    const p = planFromIntent(c, paths);
    expect(p.kind).toBe("actions");
    if (p.kind === "actions") {
      expect(p.actions[0]?.type).toBe("file.move");
      expect(p.actions[0]?.payload).toEqual({
        mcpToolId: "filesystem_move_file",
        input: { source: "/a", destination: "/b" },
      });
    }
  });

  // L29 branch 0: file_search with empty pattern → clarification reply
  test("file_search with empty pattern yields clarification reply", () => {
    const c: ClassifiedIntent = {
      intent: "file_search",
      entities: { pattern: "" },
      requiresHITL: false,
      confidence: 0.9,
    };
    const p = planFromIntent(c, paths);
    expect(p.kind).toBe("reply");
    if (p.kind === "reply") {
      expect(p.text).toContain("pattern");
    }
  });

  // L36 branch 0: file_search with explicit path entity → uses provided path, not dataDir
  test("file_search with explicit path entity uses that path", () => {
    const c: ClassifiedIntent = {
      intent: "file_search",
      entities: { pattern: "*.json", path: "/custom/root" },
      requiresHITL: false,
      confidence: 0.9,
    };
    const p = planFromIntent(c, paths);
    expect(p.kind).toBe("actions");
    if (p.kind === "actions") {
      expect(p.actions).toHaveLength(1);
      const a = p.actions[0];
      expect(a?.type).toBe("filesystem_search_files");
      expect(a?.payload).toEqual({
        input: { path: "/custom/root", pattern: "*.json" },
      });
    }
  });

  // L52 branch 0: file_organize with missing source → clarification reply
  test("file_organize with missing source yields clarification reply", () => {
    const c: ClassifiedIntent = {
      intent: "file_organize",
      entities: { source: "", destination: "/b" },
      requiresHITL: false,
      confidence: 0.9,
    };
    const p = planFromIntent(c, paths);
    expect(p.kind).toBe("reply");
    if (p.kind === "reply") {
      expect(p.text).toContain("source");
    }
  });

  // L52 branch 0 (second OR arm): file_organize with missing destination → clarification reply
  test("file_organize with missing destination yields clarification reply", () => {
    const c: ClassifiedIntent = {
      intent: "file_organize",
      entities: { source: "/a", destination: "" },
      requiresHITL: false,
      confidence: 0.9,
    };
    const p = planFromIntent(c, paths);
    expect(p.kind).toBe("reply");
    if (p.kind === "reply") {
      expect(p.text).toContain("destination");
    }
  });
});
