/** The tools a Hive session registers, and how a prompt's selection becomes the active set. */

import {
  type AgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  defineTool,
} from "@earendil-works/pi-coding-agent";
import type { NvimOperations } from "./nvim_ops.ts";

/** How the model reaches a tool. Matches Pi's `ToolExposure`. */
export type ToolExposure =
  "direct" | "model-only" | "codemode" | "deferred" | "hidden";

/** A tool `:Hive` registers. Matches `tool_registry` in lua/hive/config.lua. */
export interface ToolSpec {
  name: string;
  exposure: ToolExposure;
}

/**
 * Every tool a session registers, with its exposure. `direct` tools are declared to the model
 * while active; `codemode` tools are callable from scripts without cluttering the tool list.
 * Matches `tool_registry` in lua/hive/config.lua.
 */
export const TOOL_REGISTRY: readonly ToolSpec[] = [
  { name: "read", exposure: "direct" },
  { name: "write", exposure: "direct" },
  { name: "edit", exposure: "direct" },
  { name: "bash", exposure: "direct" },
  { name: "grep", exposure: "codemode" },
  { name: "find", exposure: "codemode" },
  { name: "ls", exposure: "codemode" },
  { name: "read_disk", exposure: "deferred" },
  { name: "write_disk", exposure: "deferred" },
  { name: "ddgr_search", exposure: "direct" },
];

/** Every registered tool name. Matches `tools` in lua/hive/config.lua. */
export const TOOLS = TOOL_REGISTRY.map((spec) => spec.name);

/** The tools active when the user names none, mirroring `agent.tools`' default. */
export const DEFAULT_TOOLS = [
  "read",
  "write",
  "edit",
  "bash",
  "grep",
  "find",
  "ls",
  "ddgr_search",
];

/** Whether `name` matches `pattern`, where `*` matches any characters, as in Pi's `--tools`. */
export function toolMatches(name: string, pattern: string): boolean {
  if (!pattern.includes("*")) {
    return name === pattern;
  }
  const escaped = pattern
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/\\\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

/** Peek at a `+name` or `-name` entry. */
function delta(entry: string): { sign: "+" | "-" | undefined; name: string } {
  const match = entry.match(/^([+-])(.+)$/);
  if (match) {
    return { sign: match[1] as "+" | "-", name: match[2] as string };
  }
  return { sign: undefined, name: entry };
}

/**
 * Resolve a tool selection to the exact names Pi should activate. Entries are exact names,
 * `*` patterns, or `+name`/`-name` deltas. A list of only deltas changes `base`; any plain
 * entry replaces it. Mirrors Pi's `--tools` and `defaultTools`.
 */
export function resolveTools(
  tools: readonly string[],
  base: readonly string[] = DEFAULT_TOOLS,
): string[] {
  const plain = tools.filter((entry) => !delta(entry).sign);
  const deltas = tools.filter((entry) => delta(entry).sign);
  if (plain.length > 0 && deltas.length > 0) {
    throw new Error(
      "mixing plain tool names with +name/-name deltas is not allowed",
    );
  }
  const matches = (entry: string): string[] => {
    const { name } = delta(entry);
    const found = TOOLS.filter((tool) => toolMatches(tool, name));
    if (found.length === 0) {
      throw new Error(
        `unknown tool ${entry}, expected some of ${TOOLS.join(", ")}`,
      );
    }
    return found;
  };
  if (deltas.length > 0) {
    const resolved = new Set(base);
    for (const entry of deltas) {
      const { sign } = delta(entry);
      for (const name of matches(entry)) {
        if (sign === "+") {
          resolved.add(name);
        } else {
          resolved.delete(name);
        }
      }
    }
    return [...resolved];
  }
  return [...new Set(plain.flatMap(matches))];
}

/** Whether `value` names a tool, directly or by a `*` pattern. */
export function isTool(value: string): boolean {
  return TOOLS.some((tool) => toolMatches(tool, value));
}

/** The registered spec for a tool, so its exposure stays in one place. */
function toolSpec(name: string): ToolSpec {
  const spec = TOOL_REGISTRY.find((entry) => entry.name === name);
  if (!spec) {
    throw new Error(`no spec for tool ${name}`);
  }
  return spec;
}

/** Pi's own tool under `name`, which reads or writes the file on disk instead of Neovim's buffer. */
function onDisk<T extends { name: string; label: string; description: string }>(
  tool: T,
  name: string,
): T {
  return {
    ...tool,
    name,
    label: name,
    description: `${tool.description} Works on the file on disk and ignores unsaved changes in Neovim's buffers.`,
  };
}

/** Register a tool with the exposure its spec declares. */
function register<T extends { name: string }>(
  tool: T,
): T & { exposure: ToolExposure } {
  return { ...tool, exposure: toolSpec(tool.name).exposure };
}

/**
 * The tools a session registers. read, write and edit go through Neovim's buffers; the rest
 * read the filesystem, except the `_disk` variants which bypass the buffers on purpose.
 */
export function buildTools(cwd: string, ops: NvimOperations) {
  return [
    register(
      defineTool(createReadToolDefinition(cwd, { operations: ops.read })),
    ),
    register(
      defineTool(createWriteToolDefinition(cwd, { operations: ops.write })),
    ),
    register(
      defineTool(createEditToolDefinition(cwd, { operations: ops.edit })),
    ),
    register(defineTool(createBashToolDefinition(cwd))),
    register(defineTool(createGrepToolDefinition(cwd))),
    register(defineTool(createFindToolDefinition(cwd))),
    register(defineTool(createLsToolDefinition(cwd))),
    register(defineTool(onDisk(createReadToolDefinition(cwd), "read_disk"))),
    register(
      defineTool(onDisk(createWriteToolDefinition(cwd), "write_disk")),
    ),
  ];
}

/**
 * Make `tools` the active set. `tools` is the raw selection, which may hold globs or deltas, so
 * resolve it to exact names first. Each change adds to the transcript, so an unchanged set is left alone.
 */
export function setTools(session: AgentSession, tools: readonly string[]): void {
  const resolved = resolveTools(tools);
  const active = session.getActiveToolNames();
  if (
    active.length !== resolved.length ||
    resolved.some((tool) => !active.includes(tool))
  ) {
    session.setActiveToolsByName(resolved);
  }
}
