import assert from "node:assert/strict";
import { test } from "node:test";
import { hint, truncate } from "../src/hint.ts";

const result = (toolName: string, args: object, output: string, isError = false): string =>
  hint({ role: "toolResult", toolName, toolCallId: "c1", isError, content: [{ type: "text", text: output }] }, () => args);

test("truncate makes one line, and keeps a number of non-whitespace characters when given one", () => {
  assert.equal(truncate("  read\n  lua/hive/init.lua"), "read lua/hive/init.lua");
  assert.equal(truncate("abcdefghij klmnopqrstuvwxyz", 20), "abcdefghij klmnopqrst");
});

test("truncate keeps punctuation as it is", () => {
  assert.equal(truncate("a --> b"), "a --> b");
  assert.equal(truncate("hive:end x"), "hive:end x");
});

test("a message that is not a tool result gets no hint", () => {
  const user = (): undefined => undefined;
  assert.equal(hint({ role: "user", content: "fix the bug" }, user), "");
  assert.equal(hint({ role: "assistant", content: [{ type: "text", text: "Done." }] }, user), "");
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
