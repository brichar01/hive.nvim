/**
 * Route a session's events to where they go: Neovim's buffer or the workbench's log.
 */

import { type ForwardedEvent, type SessionEvent } from "./protocol.ts";
import { entryLine, endLine, preview, thinkingLine } from "./render.ts";
import { createChunker } from "./stream.ts";
import type { WorkbenchLog } from "./workbench_log.ts";

export interface Router {
  /**
   * Send `event` on its way. Neovim is sent everything but a summary before this returns; an
   * assistant message's header waits for its summary, so await this to keep events in order.
   */
  (event: SessionEvent): Promise<void>;
  /** Send whatever the chunker holds now. */
  flush: () => void;
  /** Resolve once every log write queued so far has finished. */
  drained: () => Promise<void>;
}

/**
 * Split a session's events by where they go: streamed text, message boundaries and the end go to
 * Neovim, while raw thinking and tool calls go to `log`, keyed by the entry of the message they
 * belong to. Neovim sees each message as a header line and its text, with a message's thinking as
 * one summary line above it and a tool result's header saying what the call found. With
 * `summarize`, that line is the summary of the thinking rather than the start of it.
 */
export function createRouter(
  send: (event: ForwardedEvent) => void,
  log: WorkbenchLog,
  summarize?: (thinking: string) => Promise<string>,
): Router {
  const chunker = createChunker();
  /** The thinking of the message coming through, until its end. */
  let thinking = "";
  /** The id of the last assistant message, which the tools it starts belong to. */
  let entry: string | undefined;
  /** The id of the prompt this turn answers, for the line that ends it. */
  let prompt: string | undefined;

  const sendAll = (events: ForwardedEvent[]): void => {
    for (const event of events) {
      send(event);
    }
  };

  /**
   * Send a message's header, at the boundary that ends it. Everything but an assistant message's
   * thinking line is ready at once; the thinking line waits for its summary, if there is one.
   */
  const endMessage = (
    event: Extract<SessionEvent, { type: "message_end" }>,
  ): void | Promise<void> => {
    const header: string[] = [];

    /** The rest of the header, once the thinking line above it is settled. */
    const finish = (): void => {
      // A message with no text of its own, such as one that only calls a tool, gets no line.
      if (event.role !== "assistant" || event.text) {
        const found = event.role === "toolResult" ? event.hint : "";
        header.push(entryLine(event.role, event.id, found));
      }
      // A blank line keeps each message's block apart from the one before it.
      sendAll(
        chunker({
          type: "message_end",
          role: event.role,
          header: header.length === 0 ? [] : ["", ...header],
        }),
      );
    };

    if (event.role === "user") {
      prompt = event.id;
    }
    let text = "";
    if (event.role === "assistant") {
      entry = event.id;
      text = thinking;
      thinking = "";
    }
    if (text === "") {
      finish();
      return;
    }

    void log.write({ type: "thinking", id: event.id, text });
    if (summarize === undefined) {
      header.push(thinkingLine(event.id, preview(text)));
      finish();
      return;
    }
    // The summary takes the preview's place, so the header waits for it, and an empty or slow
    // summary leaves the preview where it is.
    return summarize(text).then((summary) => {
      header.push(thinkingLine(event.id, summary || preview(text)));
      finish();
    });
  };

  const handle = (event: SessionEvent): void | Promise<void> => {
    switch (event.type) {
      case "thinking":
        thinking += event.delta;
        return;
      case "tool_start":
        if (entry !== undefined) {
          void log.write({
            type: "tool_call",
            id: entry,
            name: event.name,
            args: event.args,
          });
        }
        return;
      case "text":
        sendAll(chunker({ type: "text", delta: event.delta }));
        return;
      case "message_start":
        sendAll(chunker(event));
        return;
      case "message_end":
        return endMessage(event);
      case "end": {
        const ended: ForwardedEvent =
          prompt === undefined ? event : { ...event, footer: endLine(prompt) };
        sendAll(chunker(ended));
        return;
      }
    }
  };
  const router = (event: SessionEvent): Promise<void> =>
    Promise.resolve(handle(event));
  router.flush = (): void => {
    sendAll(chunker.flush());
  };
  router.drained = () => log.drained();
  return router;
}
