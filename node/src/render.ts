/** How the workbench shows messages: their headers, thinking lines, and end line. */

import type { TaggedRole } from "./protocol.ts";

/** How much of a thinking block Neovim shows, until a summary of it replaces it. */
export const THINKING_PREVIEW_CHARS = 20;

/** The first eight characters of an entry id, as the workbench shows it. */
export function shortId(id: string): string {
  return id.slice(0, 8);
}

/** How the workbench shows a message's thinking, keyed by the entry the log holds it under. */
export function thinkingLine(id: string, summary: string): string {
  return `Thinking (${shortId(id)}): ${summary}`;
}

/** The first `THINKING_PREVIEW_CHARS` characters of `text`, on one line. */
export function preview(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, THINKING_PREVIEW_CHARS);
}

/** What each role is called in the workbench. */
const ROLE_NAMES: Record<TaggedRole, string> = {
  user: "You",
  assistant: "Response",
  toolResult: "Tool",
};

/**
 * The line a message starts with: what it is, its entry id, and for a tool result what the call
 * found. The id is the entry the log would hold the message's thinking or call under.
 */
export function entryLine(role: TaggedRole, id: string, hint = ""): string {
  const head = `${ROLE_NAMES[role]} (${shortId(id)}):`;
  return hint === "" ? head : `${head} ${hint}`;
}

/** The line that ends a reply, naming the prompt it answered. */
export function endLine(prompt: string): string {
  return `End response to ${shortId(prompt)}`;
}
