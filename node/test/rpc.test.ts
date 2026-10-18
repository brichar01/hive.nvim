import assert from "node:assert/strict";
import { test } from "node:test";
import type { NvimConnection } from "../src/nvim_wrapper.ts";
import { createHandlers, parsePromptRequest } from "../src/rpc.ts";

const handlers = createHandlers({ prompt: () => Promise.resolve() });

/** Sessions a `load` test needs: it never prompts. */
const noSessions = { prompt: () => Promise.resolve() };

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

test("load reports the download every step, then the path", async () => {
  const { nvim, calls } = fakeNvim();
  const load = createHandlers(noSessions, {
    resolve: (options) => {
      options?.onProgress?.({ downloadedSize: 5, totalSize: 100 });
      options?.onProgress?.({ downloadedSize: 50, totalSize: 100 });
      options?.onProgress?.({ downloadedSize: 100, totalSize: 100 });
      return Promise.resolve("/models/summary.gguf");
    },
  });

  await load.load?.(nvim, []);

  assert.deepEqual(
    calls.map(([code, args]) => [code, args[0]]),
    [
      ["require('hive.agent').on_load(...)", { status: "downloading", percent: 50 }],
      ["require('hive.agent').on_load(...)", { status: "downloading", percent: 100 }],
      ["require('hive.agent').on_load(...)", { status: "ready", path: "/models/summary.gguf" }],
    ],
  );
});

test("a second load joins the download in flight", async () => {
  let downloads = 0;
  const { nvim } = fakeNvim();
  const load = createHandlers(noSessions, {
    resolve: () => {
      downloads += 1;
      return Promise.resolve("/models/summary.gguf");
    },
  });

  await Promise.all([load.load?.(nvim, []), load.load?.(nvim, [])]);

  assert.equal(downloads, 1);
});

test("a download that fails is reported, not thrown", async () => {
  const { nvim, calls } = fakeNvim();
  const load = createHandlers(noSessions, {
    resolve: () => Promise.reject(new Error("offline")),
  });

  await load.load?.(nvim, []);

  assert.deepEqual(calls.map(([, args]) => args[0]), [
    { status: "error", error: "offline" },
  ]);
});

test("prompt request maps the Lua field names", () => {
  const request = parsePromptRequest({
    text: "hi",
    model: "m",
    thinking: "low",
    workbench: "p-1",
    log: "/w/p-1.log",
    cwd: "/w",
    tools: ["read", "read_disk"],
  });
  assert.deepEqual(request, {
    text: "hi",
    model: "m",
    thinking: "low",
    workbench: "p-1",
    log: "/w/p-1.log",
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
        log: "/w/p-1.log",
        cwd: "/w",
        tools: ["read", "rm"],
      }),
    /unknown tool/,
  );
});

test("prompt request accepts globs and deltas", () => {
  assert.deepEqual(
    parsePromptRequest({
      text: "hi",
      model: "m",
      thinking: "low",
      workbench: "p-1",
      log: "/w/p-1.log",
      cwd: "/w",
      tools: ["*_disk"],
    }).tools,
    ["*_disk"],
  );
  assert.deepEqual(
    parsePromptRequest({
      text: "hi",
      model: "m",
      thinking: "low",
      workbench: "p-1",
      log: "/w/p-1.log",
      cwd: "/w",
      tools: ["+read_disk", "-write"],
    }).tools,
    ["+read_disk", "-write"],
  );
});

test("prompt request rejects mixing plain names with deltas", () => {
  assert.throws(
    () =>
      parsePromptRequest({
        text: "hi",
        model: "m",
        thinking: "low",
        workbench: "p-1",
        log: "/w/p-1.log",
        cwd: "/w",
        tools: ["read", "+write_disk"],
      }),
    /mixing plain tool names/,
  );
});

test("prompt request rejects a missing field", () => {
  assert.throws(
    () =>
      parsePromptRequest({
        text: "hi",
        thinking: "low",
        workbench: "p-1",
        log: "/w/p-1.log",
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
        log: "/w/p-1.log",
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
