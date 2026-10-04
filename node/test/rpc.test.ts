import assert from "node:assert/strict";
import { test } from "node:test";
import type { NvimConnection } from "../src/nvim_wrapper.ts";
import { createHandlers, parsePromptRequest } from "../src/rpc.ts";

const handlers = createHandlers({ prompt: () => Promise.resolve() });

function fakeNvim(): { nvim: NvimConnection; calls: [string, unknown[]][] } {
  const calls: [string, unknown[]][] = [];
  const nvim: NvimConnection = {
    on: () => {},
    exec: (code, args = []) => {
      calls.push([code, args]);
      return Promise.resolve(0);
    },
  };
  return { nvim, calls };
}

test("echo sends the text back through on_echo", async () => {
  const { nvim, calls } = fakeNvim();
  await handlers.echo?.(nvim, ["hello"]);
  assert.deepEqual(calls, [["require('hive.agent').on_echo(...)", ["hello"]]]);
});

test("echo sends an empty string for a non-string argument", async () => {
  const { nvim, calls } = fakeNvim();
  await handlers.echo?.(nvim, [42]);
  assert.deepEqual(calls[0]?.[1], [""]);
});

test("prompt request maps the Lua field names", () => {
  const request = parsePromptRequest({
    text: "hi",
    model: "m",
    thinking: "low",
    workbench: "p-1",
    cwd: "/w",
    tools: ["read", "read_disk"],
  });
  assert.deepEqual(request, {
    text: "hi",
    model: "m",
    thinking: "low",
    workbench: "p-1",
    cwd: "/w",
    tools: ["read", "read_disk"],
  });
});

test("prompt request rejects an unknown tool", () => {
  assert.throws(
    () =>
      parsePromptRequest({
        text: "hi",
        model: "m",
        thinking: "low",
        workbench: "p-1",
        cwd: "/w",
        tools: ["read", "rm"],
      }),
    /tools must be a list of/,
  );
});

test("prompt request rejects a missing field", () => {
  assert.throws(
    () =>
      parsePromptRequest({
        text: "hi",
        thinking: "low",
        workbench: "p-1",
        cwd: "/w",
      }),
    /model/,
  );
});

test("prompt request rejects an unknown thinking level", () => {
  assert.throws(
    () =>
      parsePromptRequest({
        text: "hi",
        model: "m",
        thinking: "extreme",
        workbench: "p-1",
        cwd: "/w",
      }),
    /thinking must be one of/,
  );
});

test("prompt request rejects a missing workbench", () => {
  assert.throws(
    () =>
      parsePromptRequest({
        text: "hi",
        model: "m",
        thinking: "low",
        cwd: "/w",
      }),
    /workbench/,
  );
});
