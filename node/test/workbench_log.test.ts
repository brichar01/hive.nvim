import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { createWorkbenchLog } from "../src/workbench_log.ts";

const sandbox = mkdtempSync(join(tmpdir(), "hive-workbench-log-"));

after(() => {
  rmSync(sandbox, { recursive: true, force: true });
});

test("the log appends one JSON line per entry, keyed by its id", async () => {
  const path = join(sandbox, "project-20261004000000.log");
  const log = createWorkbenchLog(path);

  await log.write({ type: "thinking", id: "763328b4", text: "one\ntwo" });
  await log.write({
    type: "tool_call",
    id: "763328b4",
    name: "read",
    args: { path: "a.lua" },
  });

  const lines = readFileSync(path, "utf-8").trim().split("\n").map((line) =>
    JSON.parse(line) as Record<string, unknown>
  );
  assert.equal(lines.length, 2);
  assert.deepEqual(
    lines.map(({ ts, ...rest }) => {
      assert.equal(typeof ts, "string");
      return rest;
    }),
    [
      { id: "763328b4", type: "thinking", text: "one\ntwo" },
      { id: "763328b4", type: "tool_call", name: "read", args: { path: "a.lua" } },
    ],
  );
});

test("the log serialises writes in call order", async () => {
  const path = join(sandbox, "ordered.log");
  const log = createWorkbenchLog(path);

  await Promise.all([
    log.write({ type: "thinking", id: "one", text: "1" }),
    log.write({ type: "thinking", id: "two", text: "2" }),
    log.write({ type: "thinking", id: "three", text: "3" }),
  ]);

  const ids = readFileSync(path, "utf-8")
    .trim()
    .split("\n")
    .map((line) => (JSON.parse(line) as { id: string }).id);
  assert.deepEqual(ids, ["one", "two", "three"]);
});

test("the log's drain waits for writes queued before it", async () => {
  const path = join(sandbox, "drained.log");
  const log = createWorkbenchLog(path);

  const write = log.write({ type: "thinking", id: "one", text: "1" });
  await log.drained();

  const lines = readFileSync(path, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  await write;
});

test("the log keeps writing after an append fails", async () => {
  const dir = join(sandbox, "missing");
  const path = join(dir, "project.log");
  const log = createWorkbenchLog(path);

  // The first append cannot open the file, and write() resolves rather than rejecting.
  await log.write({ type: "thinking", id: "lost", text: "no directory" });
  mkdirSync(dir, { recursive: true });
  await log.write({ type: "thinking", id: "kept", text: "now it exists" });

  const lines = readFileSync(path, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  const { ts, ...rest } = JSON.parse(lines[0] ?? "{}") as Record<
    string,
    unknown
  >;
  assert.equal(typeof ts, "string");
  assert.deepEqual(rest, { id: "kept", type: "thinking", text: "now it exists" });
});
