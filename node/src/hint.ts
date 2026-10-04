/** Hints for the workbench's entry tags, so a closed fold says what it holds. */

/** Non-whitespace characters a text hint keeps. */
export const TEXT_LIMIT = 20;

/** Non-whitespace characters a bash command keeps in its hint. */
export const COMMAND_LIMIT = 40;

/** The parts of a Pi message the hints read. */
export interface HintMessage {
  role: string;
  content?: string | { type: string; text?: string }[];
  toolCallId?: string;
  toolName?: string;
  isError?: boolean;
  errorMessage?: string;
}

type Args = Record<string, unknown>;

/** Finds a tool call's arguments by its id. */
export type ArgsOf = (callId: string) => unknown;

/** How the hint for one tool reads. */
export interface ToolHint {
  /** What the call acts on, from its arguments. */
  target: (args: Args) => string;
  /** What a successful call found, from its output. */
  summary?: (output: string) => string;
  /** Why a failed call failed, from its output. "failed" when absent. */
  failure?: (output: string) => string;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");

const plural = (count: number, one: string, many = `${one}s`): string => `${String(count)} ${count === 1 ? one : many}`;

const textOf = (content: HintMessage["content"]): string =>
  typeof content === "string"
    ? content
    : (content ?? []).flatMap((c) => (c.type === "text" && c.text ? [c.text] : [])).join("\n");

/** Output lines, without blanks and Pi's `[...]` notices. */
const listed = (output: string): string[] => output.split("\n").filter((line) => line.trim() && !line.startsWith("["));

/**
 * One line, safe inside the tag. With `limit`, it keeps that many non-whitespace characters.
 *
 * `--` would close the HTML comment, and `hive:` could add a fold marker.
 */
export function truncate(text: string, limit = Infinity): string {
  const line = text
    .replaceAll(/-{2,}/g, "-")
    .replaceAll("hive:", "hive ")
    .replaceAll(/\s+/g, " ")
    .trim();
  let count = 0;
  let end = 0;
  for (const char of line) {
    if (char !== " " && ++count > limit) {
      break;
    }
    end += char.length;
  }
  return line.slice(0, end).trimEnd();
}

const read: ToolHint = {
  target: ({ path, offset, limit }) => {
    if (typeof offset !== "number" && typeof limit !== "number") {
      return str(path);
    }
    const first = typeof offset === "number" ? offset : 1;
    const last = typeof limit === "number" ? String(first + limit - 1) : "";
    return `${str(path)}:${String(first)}-${last}`;
  },
};

const write: ToolHint = {
  target: ({ path, content }) => `${str(path)} (${plural(str(content).split("\n").length, "line")})`,
};

/** Each tool's hint. A tool with no entry shows its name alone. */
export const toolHints: Record<string, ToolHint> = {
  read,
  write,
  read_disk: read,
  write_disk: write,
  edit: {
    target: ({ path, edits }) => `${str(path)} (${plural(Array.isArray(edits) ? edits.length : 1, "edit")})`,
  },
  bash: {
    target: ({ command }) => truncate(str(command), COMMAND_LIMIT),
    failure: (output) => {
      const code = /Command exited with code (\d+)/.exec(output)?.[1];
      return code ? `exit ${code}` : "failed";
    },
  },
  grep: {
    target: ({ pattern, path }) => `"${str(pattern)}" ${str(path)}`,
    summary: (output) => `: ${plural(listed(output).filter((line) => /^.+:\d+: /.test(line)).length, "match", "matches")}`,
  },
  find: {
    target: ({ pattern, path }) => `${str(pattern)} ${str(path)}`,
    summary: (output) =>
      `: ${plural(output.startsWith("No files found") ? 0 : listed(output).length, "file")}`,
  },
  ls: {
    target: ({ path }) => str(path) || ".",
    summary: (output) =>
      `: ${plural(output.startsWith("(empty directory)") ? 0 : listed(output).length, "entry", "entries")}`,
  },
};

/** `<tool> <target><summary>`, or `<tool> <target> (<failure>)` for a failed call. */
export function toolHint(name: string, args: unknown, output: string, isError: boolean): string {
  const format = toolHints[name];
  if (!format) {
    return isError ? `${name} (failed)` : name;
  }
  const target = format.target(args && typeof args === "object" ? (args as Args) : {}).trim();
  const head = target ? `${name} ${target}` : name;
  if (isError) {
    return `${head} (${format.failure?.(output) ?? "failed"})`;
  }
  return head + (format.summary?.(output) ?? "");
}

/** What each role's hint shows. A text hint is all the message's text, cut to `TEXT_LIMIT`. */
export const roleHints: Record<string, (message: HintMessage, argsOf: ArgsOf) => string> = {
  user: (message) => truncate(textOf(message.content), TEXT_LIMIT),
  assistant: (message) => {
    const text = truncate(textOf(message.content), TEXT_LIMIT);
    if (text) {
      return text;
    }
    if (message.errorMessage) {
      return "error";
    }
    const content = typeof message.content === "string" ? [] : (message.content ?? []);
    const calls = content.filter((c) => c.type === "toolCall").length;
    if (calls > 0) {
      return plural(calls, "tool call");
    }
    return content.some((c) => c.type === "thinking") ? "thinking" : "";
  },
  toolResult: (message, argsOf) =>
    toolHint(
      message.toolName ?? "",
      message.toolCallId ? argsOf(message.toolCallId) : undefined,
      textOf(message.content),
      message.isError === true,
    ),
};

/** The hint for `message`, empty for a role with no entry in `roleHints`. */
export function hint(message: HintMessage, argsOf: ArgsOf): string {
  const format = roleHints[message.role];
  return format ? truncate(format(message, argsOf)) : "";
}
