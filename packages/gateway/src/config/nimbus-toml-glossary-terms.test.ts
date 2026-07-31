import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  type GlossaryManualConfig,
  loadGlossaryManualFromConfigDir,
  parseGlossaryManualToml,
} from "./nimbus-toml-glossary-terms.ts";

function loadedOrThrow(cfg: GlossaryManualConfig) {
  if (!cfg.loaded) throw new Error("expected a loaded config");
  return cfg;
}

test("an absent section parses to loaded-but-empty", () => {
  const cfg = loadedOrThrow(parseGlossaryManualToml("[glossary]\nenabled = true"));
  expect(cfg.terms).toEqual([]);
  expect(cfg.synonyms.size).toBe(0);
});

test("parses terms, normalizing the key and keeping the authored display form", () => {
  const raw = ["[glossary.terms]", 'CDR = "Our append-only audit row."'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toEqual([
    { termKey: "cdr", displayTerm: "CDR", definition: "Our append-only audit row." },
  ]);
});

test("a quoted key carrying spaces or dots parses", () => {
  const raw = ["[glossary.terms]", '"node.js" = "Pinned to the Bun-compatible LTS line."'].join(
    "\n",
  );
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms[0]?.termKey).toBe("node.js");
  expect(cfg.terms[0]?.displayTerm).toBe("node.js");
});

test("a definition containing a hash survives", () => {
  const raw = ["[glossary.terms]", 'CDR = "Tracks the # of writes."'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms[0]?.definition).toBe("Tracks the # of writes.");
});

test("an alias resolves to its authored term", () => {
  const raw = [
    "[glossary.terms]",
    'CDR = "Our append-only audit row."',
    "[glossary.synonyms]",
    '"change data record" = "CDR"',
  ].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.synonyms.get("change data record")).toBe("cdr");
});

test("an empty definition is skipped with a reason", () => {
  const raw = ["[glossary.terms]", 'CDR = ""'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toEqual([]);
  expect(cfg.skipped).toHaveLength(1);
  expect(cfg.skipped[0]?.entry).toBe("CDR");
  expect(cfg.skipped[0]?.reason).toContain("empty definition");
});

test("an alias with no authored target is skipped with a reason", () => {
  const raw = ["[glossary.synonyms]", '"change data record" = "CDR"'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.synonyms.size).toBe(0);
  expect(cfg.skipped[0]?.reason).toContain("no authored term");
});

test("an alias colliding with an authored term key is skipped", () => {
  const raw = [
    "[glossary.terms]",
    'CDR = "Our append-only audit row."',
    "[glossary.synonyms]",
    'cdr = "CDR"',
  ].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.synonyms.size).toBe(0);
  expect(cfg.skipped[0]?.reason).toContain("is itself an authored term");
});

test("two raw keys normalizing to one term_key take the last and warn", () => {
  const raw = ["[glossary.terms]", 'CDR = "first"', 'Cdr = "second"'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toHaveLength(1);
  expect(cfg.terms[0]?.definition).toBe("second");
  expect(cfg.terms[0]?.displayTerm).toBe("Cdr");
  expect(cfg.skipped[0]?.reason).toContain("duplicate");
});

test("keys outside the two blocks are ignored", () => {
  const raw = [
    "[glossary]",
    "min_doc_freq = 9",
    "[glossary.terms]",
    'CDR = "Our append-only audit row."',
  ].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toHaveLength(1);
});

test("a duplicate alias takes the last and warns", () => {
  const raw = [
    "[glossary.terms]",
    'CDR = "Our append-only audit row."',
    'CDX = "Something else."',
    "[glossary.synonyms]",
    '"change data record" = "CDR"',
    '"change data record" = "CDX"',
  ].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.synonyms.get("change data record")).toBe("cdx");
  expect(cfg.skipped.some((s) => s.reason.includes("duplicate alias"))).toBe(true);
});

test("a dotted key under [glossary] is reported, not silently ignored", () => {
  // `[glossary]` + `terms.CDR = "..."` is valid TOML that this line parser
  // cannot see. Silence would leave the user with a term that never appears
  // and no explanation.
  const raw = ["[glossary]", 'terms.CDR = "Our append-only audit row."'].join("\n");
  const cfg = loadedOrThrow(parseGlossaryManualToml(raw));
  expect(cfg.terms).toEqual([]);
  expect(cfg.skipped[0]?.entry).toBe("terms.CDR");
  expect(cfg.skipped[0]?.reason).toContain("[glossary.terms]");
});

test("an ordinary [glossary] key is not mistaken for a misplaced term", () => {
  const cfg = loadedOrThrow(parseGlossaryManualToml("[glossary]\nmin_doc_freq = 9"));
  expect(cfg.skipped).toEqual([]);
});

test("a missing config file yields loaded:false, NOT an empty config", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-glossary-cfg-"));
  expect(loadGlossaryManualFromConfigDir(dir)).toEqual({ loaded: false });
});

test("a readable config file yields loaded:true", () => {
  const dir = mkdtempSync(join(tmpdir(), "nimbus-glossary-cfg-"));
  writeFileSync(join(dir, "nimbus.toml"), '[glossary.terms]\nCDR = "x"\n', "utf8");
  const cfg = loadedOrThrow(loadGlossaryManualFromConfigDir(dir));
  expect(cfg.terms).toHaveLength(1);
});
