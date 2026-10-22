/** Translate Pi's session events into the smaller set Neovim and the router understand. */

import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { type ArgsOf, hint, type HintMessage, textOf } from "./hint.ts";
import type { SessionEvent, TaggedRole } from "./protocol.ts";

const isTagged = (role: string): role is TaggedRole =>
  role === "user" || role === "assistant" || role === "toolResult";

function handleMessageStart(event: {
  type: "message_start";
  message: { role: string };
}): SessionEvent | undefined {
  const { role } = event.message;
  // A tool result's output is represented by the header `message_end` adds, so its body
  // never reaches the workbench.
  return role === "assistant" || role === "toolResult"
    ? { type: "message_start", role }
    : undefined;
}

/**
 * Keep the events Neovim renders, in the shape `on_event` reads.
 *
 * `idOf` finds a message's session entry. Pi saves a message after its `message_end`
 * listeners run, so call this once the listener has returned. `argsOf` finds a tool
 * call's arguments, for a tool result's hint.
 */
function handleMessageEnd(
  event: { type: "message_end"; message: HintMessage },
  idOf: (message: object) => string | undefined,
  argsOf: ArgsOf,
): SessionEvent | undefined {
  const id = idOf(event.message);
  return isTagged(event.message.role) && id
    ? {
        type: "message_end",
        role: event.message.role,
        id,
        hint: hint(event.message, argsOf),
        text: textOf(event.message.content) !== "",
      }
    : undefined;
}

function handleMessageUpdate(event: {
  type: "message_update";
  assistantMessageEvent: { type: string; delta?: string };
}): SessionEvent | undefined {
  const update = event.assistantMessageEvent;
  switch (update.type) {
    case "text_delta":
      return { type: "text", delta: update.delta || "" };
    case "thinking_delta":
      return { type: "thinking", delta: update.delta || "" };
    default:
      return undefined;
  }
}

function handleToolExecutionStart(event: {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}): SessionEvent {
  return {
    type: "tool_start",
    call: event.toolCallId,
    name: event.toolName,
    args: event.args,
  };
}

function handleAgentEnd(event: {
  type: "agent_end";
  willRetry: boolean;
  messages: Array<{ role: string; errorMessage?: string }>;
}): SessionEvent | undefined {
  if (event.willRetry) {
    return undefined;
  }
  const last = event.messages.findLast((m) => m.role === "assistant");
  const error = last?.errorMessage;
  return error ? { type: "end", error } : { type: "end" };
}

export function forward(
  event: AgentSessionEvent,
  idOf: (message: object) => string | undefined,
  argsOf: ArgsOf = () => undefined,
): SessionEvent | undefined {
  switch (event.type) {
    case "message_start":
      return handleMessageStart(event);
    case "message_end":
      return handleMessageEnd(event, idOf, argsOf);
    case "message_update":
      return handleMessageUpdate(event);
    case "tool_execution_start":
      return handleToolExecutionStart(event);
    case "agent_end":
      return handleAgentEnd(event);
    default:
      return undefined;
  }
}
