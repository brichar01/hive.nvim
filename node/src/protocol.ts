/**
 * The contract between Hive's Lua side and the agent service: the values Neovim sends, the
 * events it receives, and the product configuration both sides share.
 */

import type { AgentSession } from "@earendil-works/pi-coding-agent";

export const HIVE_SYSTEM_PROMPT = "## The Hive Agent Harness\n" +
  "The harness you have access to has three modified tools, the read, write and update tools have been modified \n" +
  "so that they write directly to an attached Neovim's buffers and not to the filesystem, this is so it can be \n" +
  "reviewed as it goes. Instead, tool calls to writes and updates will respond with the any available \n" +
  "lsp errors. Fix them, then stop for review, when review is complete, the next prompt will \n" +
  "include the diff against the last update and instruction on how to proceed, such as what and how to test. \n" +
  "Some prompts will bypass buffers, this is a privilege not a right, these tools will be registered for that \n" +
  "prompt, and for this time, stay laser focussed with it's use, treat the current code the source of truth and \n" +
  "if you find a feature that doesn't serve the task at hand or uncover a bug or issue in the source, stop.";

export const PROVIDER = "deepseek";

export type ThinkingLevel = AgentSession["thinkingLevel"];

/** Matches `thinking_levels` in lua/hive/config.lua. */
export const THINKING_LEVELS = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const satisfies readonly ThinkingLevel[];

export function isThinkingLevel(value: string): value is ThinkingLevel {
  return (THINKING_LEVELS as readonly string[]).includes(value);
}

/** What Neovim sends with each prompt. */
export interface PromptRequest {
  text: string;
  model: string;
  thinking: ThinkingLevel;
  workbench: string;
  cwd: string;
  /** The active tools, resolved from the registry by exact name, `*` pattern, or `+`/`-` delta. */
  tools: string[];
  /** The workbench's log file, where its raw thinking and tool calls go. */
  log: string;
}

/** Messages that get a header line in the workbench. */
export type TaggedRole = "user" | "assistant" | "toolResult";

/** What a session's events become before routing: what Neovim needs, and what it does not. */
export type SessionEvent =
  /** A message's start, which Neovim marks so its header can go above it. */
  | { type: "message_start"; role: TaggedRole }
  /** `hint` says what the message holds, `text` whether it has text of its own, for its header. */
  | {
      type: "message_end";
      role: TaggedRole;
      id: string;
      hint: string;
      text: boolean;
    }
  | { type: "text"; delta: string }
  /** Raw thinking, which goes to the workbench's log instead of into its buffer. */
  | { type: "thinking"; delta: string }
  | { type: "tool_start"; call: string; name: string; args: unknown }
  | { type: "end"; error?: string };

/** What Neovim is sent, with the lines it shows already made. */
export type ForwardedEvent =
  | { type: "message_start"; role: TaggedRole }
  /** `header` goes above the message's text, as it is. */
  | { type: "message_end"; role: TaggedRole; header: string[] }
  | { type: "text"; delta: string }
  /** `footer` ends the reply, so the workbench knows what its unanswered text is. */
  | { type: "end"; footer?: string; error?: string };
