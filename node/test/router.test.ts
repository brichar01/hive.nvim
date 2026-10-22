import assert from "node:assert/strict";
import { test } from "node:test";
import type { ForwardedEvent, SessionEvent } from "../src/protocol.ts";
import { createRouter, type Router } from "../src/router.ts";
import type { LoggedEntry } from "../src/workbench_log.ts";

/**
 * A router that records what Neovim is sent and what goes to the log. Its `router` sends without
 * waiting, which these tests rely on: none of their events waits for a summary.
 */
function fakeRouter(): {
  events: ForwardedEvent[];
  logged: LoggedEntry[];
  router: ((event: SessionEvent) => void) & Pick<Router, "flush">;
} {
  const events: ForwardedEvent[] = [];
  const logged: LoggedEntry[] = [];
  const queue = createRouter(
    (event) => {
      events.push(event);
    },
    {
      write: (entry) => {
        logged.push(entry);
        return Promise.resolve();
      },
      drained: () => Promise.resolve(),
    },
  );
  // Every event these tests send is complete when the call returns, so nothing waits here.
  const router = (event: SessionEvent): void => {
    void queue(event);
  };
  router.flush = () => {
    queue.flush();
  };
  return { events, logged, router };
}

/** A router whose thinking lines come from `summarize`, and the events it sends. */
function summaryRouter(summarize: (thinking: string) => Promise<string>): {
  events: ForwardedEvent[];
  router: Router;
} {
  const events: ForwardedEvent[] = [];
  const router = createRouter(
    (event) => {
      events.push(event);
    },
    { write: () => Promise.resolve(), drained: () => Promise.resolve() },
    summarize,
  );
  return { events, router };
}

test("the router logs raw thinking and shows it as one line", () => {
  const { events, logged, router } = fakeRouter();

  router({ type: "message_start", role: "assistant" });
  router({ type: "thinking", delta: "check the " });
  router({ type: "thinking", delta: "fold logic" });
  router({ type: "text", delta: "Hello" });
  router({
    type: "message_end",
    role: "assistant",
    id: "763328b4",
    hint: "Hello",
    text: true,
  });

  assert.deepEqual(events, [
    { type: "message_start", role: "assistant" },
    { type: "text", delta: "Hello" },
    {
      type: "message_end",
      role: "assistant",
      header: [
        "",
        "Thinking (763328b4): check the fold logic",
        "Response (763328b4):",
      ],
    },
  ]);
  assert.deepEqual(logged, [
    { type: "thinking", id: "763328b4", text: "check the fold logic" },
  ]);
});

test("the router gives a message without text no line of its own", () => {
  const { events, router } = fakeRouter();

  router({ type: "message_start", role: "assistant" });
  router({
    type: "message_end",
    role: "assistant",
    id: "763328b4",
    hint: "1 tool call",
    text: false,
  });

  assert.deepEqual(events, [
    { type: "message_start", role: "assistant" },
    { type: "message_end", role: "assistant", header: [] },
  ]);
});

test("a tool result's line says what the call found, and the call is logged", () => {
  const { events, logged, router } = fakeRouter();

  router({
    type: "message_end",
    role: "assistant",
    id: "763328b4",
    hint: "read",
    text: false,
  });
  router({ type: "tool_start", call: "c1", name: "read", args: { path: "a.lua" } });
  router({ type: "message_start", role: "toolResult" });
  router({
    type: "message_end",
    role: "toolResult",
    id: "ab12cd34",
    hint: "read a.lua:20-60",
    text: true,
  });

  assert.deepEqual(events, [
    { type: "message_end", role: "assistant", header: [] },
    { type: "message_start", role: "toolResult" },
    {
      type: "message_end",
      role: "toolResult",
      header: ["", "Tool (ab12cd34): read a.lua:20-60"],
    },
  ]);
  assert.deepEqual(logged, [
    { type: "tool_call", id: "763328b4", name: "read", args: { path: "a.lua" } },
  ]);
});

test("the router logs every call in a batch, and each result gets its own line", () => {
  const { events, logged, router } = fakeRouter();

  router({
    type: "message_end",
    role: "assistant",
    id: "763328b4",
    hint: "two calls",
    text: false,
  });
  router({ type: "tool_start", call: "c1", name: "read", args: { path: "a.lua" } });
  router({ type: "tool_start", call: "c2", name: "bash", args: { command: "true" } });
  router({ type: "message_start", role: "toolResult" });
  router({
    type: "message_end",
    role: "toolResult",
    id: "t1",
    hint: "read a.lua:2 lines",
    text: true,
  });
  router({ type: "message_start", role: "toolResult" });
  router({
    type: "message_end",
    role: "toolResult",
    id: "t2",
    hint: "bash true (exit 1)",
    text: true,
  });

  assert.deepEqual(
    events.flatMap((event) => (event.type === "message_end" ? event.header : [])),
    [
      "",
      "Tool (t1): read a.lua:2 lines",
      "",
      "Tool (t2): bash true (exit 1)",
    ],
  );
  assert.deepEqual(logged, [
    { type: "tool_call", id: "763328b4", name: "read", args: { path: "a.lua" } },
    { type: "tool_call", id: "763328b4", name: "bash", args: { command: "true" } },
  ]);
});

test("the router keeps each assistant message's thinking apart", () => {
  const { events, logged, router } = fakeRouter();

  router({ type: "message_start", role: "assistant" });
  router({ type: "thinking", delta: "first" });
  router({
    type: "message_end",
    role: "assistant",
    id: "aaaaaaaa",
    hint: "one",
    text: false,
  });
  router({ type: "message_start", role: "assistant" });
  router({ type: "thinking", delta: "second" });
  router({
    type: "message_end",
    role: "assistant",
    id: "bbbbbbbb",
    hint: "two",
    text: false,
  });

  assert.deepEqual(
    events.flatMap((event) =>
      event.type === "message_end" ? event.header.slice(1) : []
    ),
    ["Thinking (aaaaaaaa): first", "Thinking (bbbbbbbb): second"],
  );
  assert.deepEqual(logged, [
    { type: "thinking", id: "aaaaaaaa", text: "first" },
    { type: "thinking", id: "bbbbbbbb", text: "second" },
  ]);
});

test("a message's thinking line shows its summary, not the start of its thinking", async () => {
  const { events, router } = summaryRouter(() => Promise.resolve("Folding the thinking line"));

  await router({ type: "thinking", delta: "check the fold logic and its guard" });
  await router({
    type: "message_end",
    role: "assistant",
    id: "763328b4",
    hint: "",
    text: false,
  });

  assert.deepEqual(events, [
    {
      type: "message_end",
      role: "assistant",
      header: ["", "Thinking (763328b4): Folding the thinking line"],
    },
  ]);
});

test("a summary with nothing to say leaves the thinking's start in place", async () => {
  const { events, router } = summaryRouter(() => Promise.resolve(""));

  await router({ type: "thinking", delta: "check the fold logic" });
  await router({
    type: "message_end",
    role: "assistant",
    id: "763328b4",
    hint: "",
    text: true,
  });

  assert.deepEqual(events, [
    {
      type: "message_end",
      role: "assistant",
      header: [
        "",
        "Thinking (763328b4): check the fold logic",
        "Response (763328b4):",
      ],
    },
  ]);
});

test("an assistant message's header waits for its summary", async () => {
  let answer: (summary: string) => void = () => undefined;
  const { events, router } = summaryRouter(
    () =>
      new Promise((resolve) => {
        answer = resolve;
      }),
  );

  await router({ type: "thinking", delta: "weigh the order of events" });
  const ended = router({
    type: "message_end",
    role: "assistant",
    id: "aaaaaaaa",
    hint: "",
    text: false,
  });
  // Nothing reaches Neovim until the summary is there to go above the reply.
  assert.deepEqual(events, []);

  answer("Weighing the order of events");
  await ended;
  assert.deepEqual(events, [
    {
      type: "message_end",
      role: "assistant",
      header: ["", "Thinking (aaaaaaaa): Weighing the order of events"],
    },
  ]);
});

test("the router ends the turn with the prompt it answered", () => {
  const { events, router } = fakeRouter();

  router({
    type: "message_end",
    role: "user",
    id: "aaaaaaaa-rest",
    hint: "hello",
    text: true,
  });
  router({ type: "end" });

  assert.deepEqual(events, [
    { type: "message_end", role: "user", header: ["", "You (aaaaaaaa):"] },
    { type: "end", footer: "End response to aaaaaaaa" },
  ]);
});

test("the router flushes buffered text on demand", () => {
  const { events, router } = fakeRouter();

  router({ type: "text", delta: "tail" });
  assert.deepEqual(events, []);
  router.flush();
  assert.deepEqual(events, [{ type: "text", delta: "tail" }]);
});
