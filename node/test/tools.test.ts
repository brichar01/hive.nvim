import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_TOOLS,
  resolveTools,
  TOOLS,
  toolMatches,
} from "../src/tools.ts";

test("toolMatches treats * as any characters", () => {
  assert.equal(toolMatches("read_disk", "read_disk"), true);
  assert.equal(toolMatches("read_disk", "read"), false);
  assert.equal(toolMatches("read_disk", "*_disk"), true);
  assert.equal(toolMatches("read", "*_disk"), false);
  assert.equal(toolMatches("mcp__radius__search", "mcp__radius__*"), true);
});

test("resolveTools selects plain names and globs", () => {
  assert.deepEqual(resolveTools(["read", "bash"]), ["read", "bash"]);
  assert.deepEqual(resolveTools(["*_disk"]), ["read_disk", "write_disk"]);
});

test("resolveTools applies deltas to the default selection", () => {
  assert.deepEqual(resolveTools(["+read_disk"]), [...DEFAULT_TOOLS, "read_disk"]);
  assert.deepEqual(
    resolveTools(["-write"]),
    DEFAULT_TOOLS.filter((tool) => tool !== "write"),
  );
  assert.deepEqual(
    resolveTools(["+read_disk", "-write"]),
    [...DEFAULT_TOOLS.filter((tool) => tool !== "write"), "read_disk"],
  );
});

test("resolveTools rejects unknown names, mixing, and empty patterns", () => {
  assert.throws(() => resolveTools(["rm"]), /unknown tool/);
  assert.throws(() => resolveTools(["read", "+write_disk"]), /mixing plain tool names/);
  assert.throws(() => resolveTools(["zzz*"]), /unknown tool/);
});

test("every registered tool has a spec", () => {
  assert.deepEqual(new Set(TOOLS).size, TOOLS.length);
  assert.deepEqual([...TOOLS].sort(), [
    "bash",
    "ddgr_search",
    "edit",
    "find",
    "grep",
    "ls",
    "read",
    "read_disk",
    "write",
    "write_disk",
  ]);
});
