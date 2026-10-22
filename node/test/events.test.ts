import assert from "node:assert/strict";
import { test } from "node:test";
import { forward } from "../src/events.ts";

test("forward passes thinking and text through, but never a tool result's output", () => {
  const none = (): undefined => undefined;
  const update = (assistantMessageEvent: object) =>
    ({ type: "message_update", message: {}, assistantMessageEvent }) as never;

  assert.deepEqual(forward(update({ type: "thinking_delta", delta: "hmm" }), none), {
    type: "thinking",
    delta: "hmm",
  });
  assert.deepEqual(forward(update({ type: "text_delta", delta: "hi" }), none), {
    type: "text",
    delta: "hi",
  });
  assert.equal(forward(update({ type: "text_start" }), none), undefined);
  assert.deepEqual(
    forward(
      {
        type: "message_start",
        message: {
          role: "toolResult",
          content: [
            { type: "text", text: "a" },
            { type: "image" },
            { type: "text", text: "b" },
          ],
        },
      } as never,
      none,
    ),
    { type: "message_start", role: "toolResult" },
  );
});
