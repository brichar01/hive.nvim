import assert from "node:assert/strict";
import { test } from "node:test";
import {
  createSummarizer,
  SUMMARY_CHARS,
  summaryLine,
  summaryPrompt,
  THINKING_INPUT_CHARS,
} from "../src/summary.ts";

test("the prompt asks for one line, and carries the whole thinking block", () => {
  const prompt = summaryPrompt("  check\n the\tfold logic ");

  assert.match(prompt, /one-line status/);
  assert.match(prompt, /<thinking>\ncheck the fold logic\n<\/thinking>\nStatus:$/);
});

test("the prompt keeps a long thinking block to the characters a summary reads", () => {
  const prompt = summaryPrompt("x".repeat(THINKING_INPUT_CHARS + 500));
  const start = "<thinking>\n".length;
  const body = prompt.slice(prompt.indexOf("<thinking>\n") + start, prompt.indexOf("\n</thinking>"));

  assert.equal(body.length, THINKING_INPUT_CHARS);
});

test("a line drops the label, the marker and the quotes a model adds", () => {
  assert.equal(summaryLine("Status: Fixing the header order."), "Fixing the header order.");
  assert.equal(summaryLine('**Summary** - "Fixing the header order"'), "Fixing the header order");
  assert.equal(summaryLine("1. Checking the chunker."), "Checking the chunker.");
  assert.equal(summaryLine("- Widening the guard."), "Widening the guard.");
});

test("a line is one sentence, cut to the characters a line keeps", () => {
  assert.equal(summaryLine("Fixing the row. Then the header. And more."), "Fixing the row.");
  assert.equal(summaryLine("x".repeat(SUMMARY_CHARS + 20)), "x".repeat(SUMMARY_CHARS));
  assert.equal(summaryLine(" \n\t "), "");
});

test("a summary is the model's line, cleaned up", async () => {
  const summarizer = createSummarizer({
    ask: () => Promise.resolve('  "Folding the thinking line."  '),
  });

  assert.equal(await summarizer.summarize("check the fold logic"), "Folding the thinking line.");
});

test("thinking with no words is not sent to the model", async () => {
  let asked = 0;
  const summarizer = createSummarizer({
    ask: () => {
      asked += 1;
      return Promise.resolve("a line");
    },
  });

  assert.equal(await summarizer.summarize(" \n\t "), "");
  assert.equal(asked, 0);
});

test("a model that fails leaves no summary, and no rejection", async () => {
  const summarizer = createSummarizer({
    ask: () => Promise.reject(new Error("no model")),
  });

  assert.equal(await summarizer.summarize("check the fold logic"), "");
});

test("one summary runs at a time, so two messages never share a model call", async () => {
  const order: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const summarizer = createSummarizer({
    ask: async (prompt) => {
      const which = prompt.includes("alpha") ? "alpha" : "beta";
      order.push(`start ${which}`);
      if (which === "alpha") {
        await gate;
      }
      order.push(`end ${which}`);
      return "a line";
    },
  });

  const first = summarizer.summarize("thinking alpha");
  const second = summarizer.summarize("thinking beta");
  release();
  await Promise.all([first, second]);

  assert.deepEqual(order, ["start alpha", "end alpha", "start beta", "end beta"]);
});

test("a summary that takes too long gives up", async () => {
  const summarizer = createSummarizer({
    ask: () =>
      new Promise((resolve) => {
        setTimeout(() => {
          resolve("late");
        }, 50);
      }),
    timeoutMs: 10,
  });

  assert.equal(await summarizer.summarize("check the fold logic"), "");
});
