import { expect, test } from "bun:test";
import { isQuestion } from "./is-question.ts";

test("classifies questions", () => {
  for (const q of [
    "how do I deploy the gateway?",
    "Where does the vault key live?",
    "what's the difference between I23 and I24",
    "can someone explain the preflight gate",
  ]) {
    expect(isQuestion(q)).toBe(true);
  }
});

test("rejects non-questions and noise", () => {
  for (const s of ["deploying now", "lgtm 🚀", "thanks!", "", "?", "ok", "<@U123> shipped it"]) {
    expect(isQuestion(s)).toBe(false);
  }
});
