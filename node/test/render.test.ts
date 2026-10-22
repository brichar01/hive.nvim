import assert from "node:assert/strict";
import { test } from "node:test";
import {
  endLine,
  entryLine,
  preview,
  THINKING_PREVIEW_CHARS,
  thinkingLine,
} from "../src/render.ts";

test("preview collapses whitespace and keeps the first characters", () => {
  assert.equal(preview("  check \n the\tfold logic and more "), "check the fold logic");
  assert.equal(preview("x".repeat(THINKING_PREVIEW_CHARS + 5)), "x".repeat(THINKING_PREVIEW_CHARS));
  assert.equal(preview(" \n\t "), "");
});

test("thinkingLine keys the summary by the start of the entry id", () => {
  assert.equal(thinkingLine("763328b4-rest", "check the fold logic"), "Thinking (763328b4): check the fold logic");
  assert.equal(thinkingLine("short", "hmm"), "Thinking (short): hmm");
});

test("entryLine names the role and the entry, and a tool result what it found", () => {
  assert.equal(entryLine("user", "763328b4-rest"), "You (763328b4):");
  assert.equal(entryLine("assistant", "763328b4-rest"), "Response (763328b4):");
  assert.equal(
    entryLine("toolResult", "ab12cd34-rest", 'grep "hive" lua/: 4 matches'),
    'Tool (ab12cd34): grep "hive" lua/: 4 matches',
  );
});

test("endLine names the prompt a reply answers", () => {
  assert.equal(endLine("763328b4-rest"), "End response to 763328b4");
});
