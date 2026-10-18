import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  createBashToolDefinition,
  createEditToolDefinition,
  createFindToolDefinition,
  createGrepToolDefinition,
  createLsToolDefinition,
  type CreateModelRuntimeOptions,
  createReadToolDefinition,
  createWriteToolDefinition,
  DefaultResourceLoader,
  defineTool,
  getAgentDir,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { diagnosticsExtension } from "./diagnostics.ts";
import { type ArgsOf, hint, type HintMessage, textOf } from "./hint.ts";
import { createLogger } from "./log.ts";
import { createNvimOperations } from "./nvim_ops.ts";
import type { NvimConnection } from "./nvim_wrapper.ts";
import { createWorkbenchLog, type WorkbenchLog } from "./workbench_log.ts";

const log = createLogger("session");

export const KEY_ENV = "HIVE_AGENT_API_KEY";

const HIVE_SYSTEM_PROMPT = "## The Hive Agent Harness\n" +
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

/** What Neovim sends with each prompt. */
export interface PromptRequest {
  text: string;
  model: string;
  thinking: ThinkingLevel;
  workbench: string;
  cwd: string;
  /** The active tools, resolved from `TOOLS` by exact name, `*` pattern, or `+`/`-` delta. */
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

/**
 * How much streamed text Neovim waits for before it sees a chunk. Both limits sit far above a
 * message, so in practice the next event flushes the buffer rather than its size.
 */
const STREAM_CHUNK_LINES = 2000;
const STREAM_CHUNK_CHARS = 100_000;

export interface Chunker {
  (event: ForwardedEvent): ForwardedEvent[];
  /** Send whatever is buffered now. */
  flush: () => ForwardedEvent[];
}

/**
 * Coalesce streamed text into chunks, so Neovim makes one RPC and one buffer update per chunk
 * instead of one per token. Every other event flushes what is buffered and passes through in
 * order, so a message's text reaches the buffer before the message's own event does.
 */
export function createChunker(): Chunker {
  let buffered = "";
  const flush = (): ForwardedEvent[] => {
    const delta = buffered;
    if (delta === "") {
      return [];
    }
    buffered = "";
    return [{ type: "text", delta }];
  };

  const chunk = (event: ForwardedEvent): ForwardedEvent[] => {
    if (event.type === "text") {
      buffered += event.delta;
      const lines = buffered.match(/\n/g)?.length ?? 0;
      const reached =
        buffered.length >= STREAM_CHUNK_CHARS || lines >= STREAM_CHUNK_LINES;
      return reached ? flush() : [];
    }
    return [...flush(), event];
  };
  chunk.flush = flush;
  return chunk;
}

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

export interface Router {
  (event: SessionEvent): void;
  /** Send whatever the chunker holds now. */
  flush: () => void;
  /** Resolve once every log write queued so far has finished. */
  drained: () => Promise<void>;
}

/**
 * Split a session's events by where they go: streamed text, message boundaries and the end go to
 * Neovim, while raw thinking and tool calls go to `log`, keyed by the entry of the message they
 * belong to. Neovim sees each message as a header line and its text, with a message's thinking as
 * one summary line above it and a tool result's header saying what the call found.
 */
export function createRouter(
  send: (event: ForwardedEvent) => void,
  log: WorkbenchLog,
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

  const router = (event: SessionEvent): void => {
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
      case "message_end": {
        const header: string[] = [];
        if (event.role === "assistant") {
          entry = event.id;
          const text = thinking;
          thinking = "";
          if (text !== "") {
            void log.write({ type: "thinking", id: event.id, text });
            header.push(thinkingLine(event.id, preview(text)));
          }
        } else if (event.role === "user") {
          prompt = event.id;
        }
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
        return;
      }
      case "end": {
        const ended: ForwardedEvent =
          prompt === undefined ? event : { ...event, footer: endLine(prompt) };
        sendAll(chunker(ended));
        return;
      }
    }
  };
  router.flush = (): void => {
    sendAll(chunker.flush());
  };
  router.drained = () => log.drained();
  return router;
}

export interface SessionOptions {
  /** Pi's global config directory. Defaults to Pi's own, `~/.pi/agent`. */
  agentDir?: string;
  /** Pi settings for the session. Nothing is read from Pi's settings files. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /** Replaces the catalogue's `https://api.deepseek.com`, for a stub server. */
  baseUrl?: string;
}

export interface Sessions {
  prompt: (nvim: NvimConnection, request: PromptRequest) => Promise<void>;
}

type CredentialStore = NonNullable<CreateModelRuntimeOptions["credentials"]>;
type Credential = Awaited<ReturnType<CredentialStore["read"]>>;

/** Read the key once and delete it, so the agent's own shell commands never inherit it. */
export function takeApiKey(
  env: NodeJS.ProcessEnv = process.env,
): string | undefined {
  const key = env[KEY_ENV];
  Reflect.deleteProperty(env, KEY_ENV);
  return key === "" ? undefined : key;
}

/** A credential store that never touches disk, so Pi neither reads nor creates `auth.json`. */
export function memoryStore(): CredentialStore {
  const data = new Map<string, NonNullable<Credential>>();
  return {
    read: (id) => Promise.resolve(data.get(id)),
    list: () =>
      Promise.resolve(
        [...data].map(([providerId, c]) => ({ providerId, type: c.type })),
      ),
    modify: async (id, fn) => {
      const next = await fn(data.get(id));
      if (next) {
        data.set(id, next);
      }
      return data.get(id);
    },
    delete: (id) => {
      data.delete(id);
      return Promise.resolve();
    },
  };
}

const isTagged = (role: string): role is TaggedRole =>
  role === "user" || role === "assistant" || role === "toolResult";

/**
 * Keep the events Neovim renders, in the shape `on_event` reads.
 *
 * `idOf` finds a message's session entry. Pi saves a message after its `message_end`
 * listeners run, so call this once the listener has returned. `argsOf` finds a tool
 * call's arguments, for a tool result's hint.
 */
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
 * Make `tools` the active set. `tools` is the raw selection, which may hold globs or deltas, so
 * resolve it to exact names first. Each change adds to the transcript, so an unchanged set is left alone.
 */
function setTools(session: AgentSession, tools: readonly string[]): void {
  const resolved = resolveTools(tools);
  const active = session.getActiveToolNames();
  if (
    active.length !== resolved.length ||
    resolved.some((tool) => !active.includes(tool))
  ) {
    session.setActiveToolsByName(resolved);
  }
}

async function createSession(
  nvim: NvimConnection,
  request: PromptRequest,
  apiKey: string | undefined,
  options: SessionOptions,
): Promise<AgentSession> {
  const runtime = await ModelRuntime.create({
    credentials: memoryStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  // With no key, Pi falls back to `DEEPSEEK_API_KEY` in the service's environment.
  if (apiKey) {
    await runtime.setRuntimeApiKey(PROVIDER, apiKey);
  }

  const model = runtime.getModel(PROVIDER, request.model);
  if (!model) {
    throw new Error(`unknown DeepSeek model: ${request.model}`);
  }

  const { cwd } = request;
  const ops = createNvimOperations(nvim);
  const settingsManager = SettingsManager.inMemory(options.settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir ?? getAgentDir(),
    // Replace the base prompt:
    systemPromptOverride: (base) => (base || "") + "\n\n" + HIVE_SYSTEM_PROMPT,
    settingsManager,
    extensionFactories: [
      { name: "hive-diagnostics", factory: diagnosticsExtension(nvim, cwd) },
    ],
  });
  await resourceLoader.reload();

  const { session } = await createAgentSession({
    cwd,
    agentDir: options.agentDir,
    // read, write and edit go through Neovim's buffers. The rest read the filesystem.
    noTools: "builtin",
    customTools: [
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
    ],
    resourceLoader,
    modelRuntime: runtime,
    model: options.baseUrl ? { ...model, baseUrl: options.baseUrl } : model,
    thinkingLevel: request.thinking,
    sessionManager: SessionManager.inMemory(request.cwd),
    settingsManager,
  });
  return session;
}

/**
 * One agent session for each workbench of each Neovim client. A prompt with a different model
 * replaces its workbench's session, and the history with it.
 */
export function createSessions(
  apiKey: string | undefined,
  options: SessionOptions = {},
): Sessions {
  interface Workbench {
    model: string;
    session: AgentSession;
    /** Resolves once every event so far has been forwarded. */
    drained: () => Promise<void>;
    /** Send any buffered stream text before an error ends the prompt. */
    flush: () => void;
  }
  const clients = new WeakMap<NvimConnection, Map<string, Workbench>>();

  const send = (nvim: NvimConnection, event: ForwardedEvent): void => {
    nvim
      .exec("require('hive.agent').on_event(...)", [event])
      .catch((err: unknown) => {
        log.warn(
          "on_event: %s",
          err instanceof Error ? err.message : String(err),
        );
      });
  };

  const workbenchesOf = (nvim: NvimConnection): Map<string, Workbench> => {
    let workbenches = clients.get(nvim);
    if (!workbenches) {
      const created = new Map<string, Workbench>();
      nvim.on("disconnect", () => {
        for (const { session } of created.values()) {
          session.dispose();
        }
      });
      clients.set(nvim, created);
      workbenches = created;
    }
    return workbenches;
  };

  const workbenchFor = async (
    nvim: NvimConnection,
    request: PromptRequest,
  ): Promise<Workbench> => {
    const workbenches = workbenchesOf(nvim);
    const current = workbenches.get(request.workbench);
    if (current?.model === request.model) {
      current.session.setThinkingLevel(request.thinking);
      setTools(current.session, request.tools);
      return current;
    }
    current?.session.dispose();

    const session = await createSession(nvim, request, apiKey, options);
    setTools(session, request.tools);
    const idOf = (message: object): string | undefined =>
      session.sessionManager
        .getBranch()
        .findLast(
          (entry) => entry.type === "message" && entry.message === message,
        )?.id;

    const argsOf = (callId: string): unknown =>
      session.messages
        .flatMap((m) => (m.role === "assistant" ? m.content : []))
        .flatMap((c) =>
          c.type === "toolCall" && c.id === callId ? [c.arguments] : [],
        )
        .at(-1);

    // Each event is forwarded a microtask after its listener, in order, so a message_end sees its saved entry.
    let queue = Promise.resolve();
    const router = createRouter(
      (event) => {
        send(nvim, event);
      },
      createWorkbenchLog(request.log),
    );
    session.subscribe((event) => {
      queue = queue.then(() => {
        const forwarded = forward(event, idOf, argsOf);
        if (forwarded) {
          router(forwarded);
        }
      });
    });
    const workbench = {
      model: request.model,
      session,
      drained: async () => {
        await queue;
        await router.drained();
      },
      flush: () => {
        router.flush();
      },
    };
    workbenches.set(request.workbench, workbench);
    return workbench;
  };

  return {
    prompt: async (nvim, request) => {
      try {
        const { session, drained } = await workbenchFor(nvim, request);
        await session.prompt(request.text);
        await drained();
      } catch (err) {
        clients.get(nvim)?.get(request.workbench)?.flush();
        send(nvim, {
          type: "end",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
