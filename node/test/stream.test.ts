import assert from "node:assert/strict";
import { test } from "node:test";
import { createChunker } from "../src/stream.ts";

test("the chunker coalesces text deltas until an event flushes them", () => {
  const chunk = createChunker();
  const end = { type: "end" } as const;

  assert.deepEqual(chunk({ type: "text", delta: "Hel" }), []);
  assert.deepEqual(chunk({ type: "text", delta: "lo" }), []);
  assert.deepEqual(chunk(end), [{ type: "text", delta: "Hello" }, end]);
  assert.deepEqual(chunk.flush(), []);
});

test("the chunker holds text past many lines, and flushes on size", () => {
  const chunk = createChunker();
  const lines = "x\n".repeat(1000);

  assert.deepEqual(chunk({ type: "text", delta: lines }), []);
  assert.deepEqual(chunk({ type: "text", delta: "y".repeat(100_000) }), [
    { type: "text", delta: lines + "y".repeat(100_000) },
  ]);
});
