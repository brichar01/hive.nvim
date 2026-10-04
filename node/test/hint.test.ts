import assert from "node:assert/strict";
import { test } from "node:test";
import { hint, type HintMessage, truncate } from "../src/hint.ts";

const none = (): undefined => undefined;

const result = (toolName: string, args: object, output: string, isError = false): string =>
  hint({ role: "toolResult", toolName, toolCallId: "c1", isError, content: [{ type: "text", text: output }] }, () => args);

test("truncate makes one line, and keeps a number of non-whitespace characters when given one", () => {
  assert.equal(truncate("  read\n  lua/hive/init.lua"), "read lua/hive/init.lua");
  assert.equal(truncate("abcdefghij klmnopqrstuvwxyz", 20), "abcdefghij klmnopqrst");
});

test("truncate removes what would close the comment or add a fold marker", () => {
  assert.equal(truncate("a --> b"), "a -> b");
  assert.equal(truncate("hive:end x"), "hive end x");
});

test("a text hint joins all the message's text and keeps 20 characters", () => {
  assert.equal(hint({ role: "user", content: "fix\n\nthe bug in lua/hive/ui.lua" }, none), "fix the bug in lua/hive/");
  const reply: HintMessage = {
    role: "assistant",
    content: [
      { type: "text", text: "Done." },
      { type: "thinking" },
      { type: "text", text: "Tests pass now." },
    ],
  };
  assert.equal(hint(reply, none), "Done. Tests pass now.");
});

test("an assistant message with no text falls back to its tool calls, then its thinking", () => {
  const calls = [{ type: "thinking" }, { type: "toolCall" }, { type: "toolCall" }];
  assert.equal(hint({ role: "assistant", content: calls }, none), "2 tool calls");
  assert.equal(hint({ role: "assistant", content: [{ type: "thinking" }] }, none), "thinking");
});

test("read shows the path and the line range", () => {
  assert.equal(result("read", { path: "a.ts" }, "x"), "read a.ts");
  assert.equal(result("read", { path: "a.ts", offset: 20, limit: 41 }, "x"), "read a.ts:20-60");
  assert.equal(result("read", { path: "a.ts", offset: 20 }, "x"), "read a.ts:20-");
});

test("write and edit show the path and the size of the change", () => {
  assert.equal(result("write", { path: "a.ts", content: "1\n2\n3" }, "ok"), "write a.ts (3 lines)");
  assert.equal(result("edit", { path: "a.ts", edits: [{}, {}] }, "ok"), "edit a.ts (2 edits)");
  assert.equal(result("edit", { path: "a.ts", edits: [{}] }, "nope", true), "edit a.ts (1 edit) (failed)");
});

test("bash shows the command, and the exit code when it fails", () => {
  assert.equal(result("bash", { command: "npm test" }, "ok"), "bash npm test");
  assert.equal(result("bash", { command: "npm test" }, "boom\n\nCommand exited with code 1", true), "bash npm test (exit 1)");
  assert.equal(result("bash", { command: "sleep 99" }, "Command timed out", true), "bash sleep 99 (failed)");
});

test("grep, find and ls count what they found", () => {
  const grep = "lua/a.lua:3: set_folds(win)\nlua/a.lua-4- end\nlua/b.lua:9: set_folds(0)\n\n[50 matches limit reached]";
  assert.equal(result("grep", { pattern: "set_folds", path: "lua/" }, grep), 'grep "set_folds" lua/: 2 matches');
  assert.equal(result("grep", { pattern: "x" }, "No matches found"), 'grep "x": 0 matches');
  assert.equal(result("find", { pattern: "*.ts", path: "src" }, "src/a.ts"), "find *.ts src: 1 file");
  assert.equal(result("find", { pattern: "*.rs" }, "No files found matching pattern"), "find *.rs: 0 files");
  assert.equal(result("ls", {}, "a.ts\nb/"), "ls .: 2 entries");
  assert.equal(result("ls", { path: "x" }, "(empty directory)"), "ls x: 0 entries");
});

test("a tool with no formatter shows its name", () => {
  assert.equal(result("mystery", {}, "ok"), "mystery");
  assert.equal(result("mystery", {}, "no", true), "mystery (failed)");
});
