import { expect, test } from "bun:test";

import {
  DECISION_SOURCE_TYPES,
  decisionSourceFilter,
} from "../decisions/decision-source-types.ts";
import {
  GLOSSARY_SOURCE_TYPES,
  glossarySourceFilter,
} from "../glossary/glossary-source-types.ts";
import {
  BUILTIN_SOURCE_KINDS,
  PASS_KINDS,
  sourceKindOf,
  sourceTypesFor,
  sourceTypesOfKind,
} from "./source-kinds.ts";

// The literals below are copied verbatim from decision-source-types.ts and glossary-source-types.ts
// as they stood before the kind table existed. They are the behaviour contract: do not edit them to
// make a failing test pass.
const DECISIONS_BEFORE = [
  "slack:message",
  "discord:message",
  "teams:message",
  "notion:page",
  "confluence:page",
  "obsidian:obsidian_note",
  "linear:issue",
  "jira:issue",
  "github:issue",
  "gitlab:issue",
];
const GLOSSARY_BEFORE = [
  ...DECISIONS_BEFORE,
  "github:commit",
  "gitlab:commit",
  "filesystem:git_commit",
];

test("the decisions set is exactly today's list, in today's order", () => {
  expect([...sourceTypesFor("decisions")]).toEqual(DECISIONS_BEFORE);
  expect([...DECISION_SOURCE_TYPES]).toEqual(DECISIONS_BEFORE);
});

test("the glossary set is exactly today's list, in today's order", () => {
  expect([...sourceTypesFor("glossary")]).toEqual(GLOSSARY_BEFORE);
  expect([...GLOSSARY_SOURCE_TYPES]).toEqual(GLOSSARY_BEFORE);
});

test("the filters' params are unchanged", () => {
  expect(decisionSourceFilter().params).toEqual(DECISIONS_BEFORE);
  expect(glossarySourceFilter().params).toEqual(GLOSSARY_BEFORE);
});

test("doc kind is the three long-form sources", () => {
  expect([...sourceTypesOfKind("doc")]).toEqual([
    "notion:page",
    "confluence:page",
    "obsidian:obsidian_note",
  ]);
});

test("the built-in table has no note, email, calendar or nimbus entries", () => {
  for (const [key, kind] of BUILTIN_SOURCE_KINDS) {
    expect(kind).not.toBe("note");
    expect(key.startsWith("nimbus:")).toBe(false);
    expect(/:(email|calendar_event|event)$/.test(key)).toBe(false);
  }
});

test("lookup is service-qualified", () => {
  expect(sourceKindOf("jira:issue")).toBe("ticket");
  expect(sourceKindOf("wiz:issue")).toBeUndefined();
  expect(sourceKindOf("issue")).toBeUndefined();
});

test("PASS_KINDS is the spec's two rows", () => {
  expect([...PASS_KINDS.decisions].sort()).toEqual(["doc", "message", "note", "ticket"]);
  expect([...PASS_KINDS.glossary].sort()).toEqual(["commit", "doc", "message", "note", "ticket"]);
});

test("the returned lists are computed once and frozen", () => {
  expect(sourceTypesFor("decisions")).toBe(sourceTypesFor("decisions"));
  expect(sourceTypesOfKind("doc")).toBe(sourceTypesOfKind("doc"));
  expect(Object.isFrozen(sourceTypesFor("glossary"))).toBe(true);
  expect(Object.isFrozen(sourceTypesOfKind("ticket"))).toBe(true);
});
