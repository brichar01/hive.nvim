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
import { type ArgsOf, hint, type HintMessage } from "./hint.ts";
import { createLogger } from "./log.ts";
import { createNvimOperations } from "./nvim_ops.ts";
import type { NvimConnection } from "./nvim_wrapper.ts";

const log = createLogger("session");

export const KEY_ENV = "HIVE_AGENT_API_KEY";

export const PROVIDER = "mistral";

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

/** Every tool a session registers. Matches `tools` in lua/hive/config.lua. */
export const TOOLS = ["read", "write", "edit", "bash", "grep", "find", "ls", "read_disk", "write_disk"] as const;

export function isTool(value: string): boolean {
  return (TOOLS as readonly string[]).includes(value);
}

/** What Neovim sends with each prompt. */
export interface PromptRequest {
  text: string;
  model: string;
  thinking: ThinkingLevel;
  workbench: string;
  cwd: string;
  /** The active tools, from `TOOLS`. */
  tools: string[];
}

/** The subset of Pi's events that Neovim renders. */
/** Messages that get an entry tag in the workbench. */
export type TaggedRole = "user" | "assistant" | "toolResult";

export type ForwardedEvent =
  /** `text` is a tool result's output, which arrives whole. `call` is its tool call's id. */
  | { type: "message_start"; role: TaggedRole; text?: string; call?: string }
  /** `hint` says what the message holds, for its entry tag. */
  | { type: "message_end"; role: TaggedRole; id: string; hint: string }
  | { type: "text"; delta: string }
  | { type: "thinking"; delta: string }
  | { type: "thinking_end" }
  | { type: "tool_start"; call: string; name: string; args: unknown }
  | { type: "tool_end"; name: string; isError: boolean }
  | { type: "end"; error?: string };

export interface SessionOptions {
  /** Pi's global config directory. Defaults to Pi's own, `~/.pi/agent`. */
  agentDir?: string;
  /** Pi settings for the session. Nothing is read from Pi's settings files. */
  settings?: Parameters<typeof SettingsManager.inMemory>[0];
  /** Replaces the catalogue's `https://api.mistral.ai`, for a stub server. */
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
  message: {
    role: string;
    content?: string | Array<{ type: string; text?: string }>;
    toolCallId?: string;
  };
}): ForwardedEvent | undefined {
  const { message } = event;
  if (message.role === "toolResult" && message.content) {
    const content =
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content;
    const text = content
      .flatMap((c) => (c.type === "text" ? [c.text] : []))
      .filter((text): text is string => text !== undefined)
      .join("\n");
    return {
      type: "message_start",
      role: "toolResult",
      text,
      call: message.toolCallId,
    };
  }
  return message.role === "assistant"
    ? { type: "message_start", role: "assistant" }
    : undefined;
}

function handleMessageEnd(
  event: { type: "message_end"; message: HintMessage },
  idOf: (message: object) => string | undefined,
  argsOf: ArgsOf,
): ForwardedEvent | undefined {
  const id = idOf(event.message);
  return isTagged(event.message.role) && id
    ? {
        type: "message_end",
        role: event.message.role,
        id,
        hint: hint(event.message, argsOf),
      }
    : undefined;
}

function handleMessageUpdate(event: {
  type: "message_update";
  assistantMessageEvent: { type: string; delta?: string };
}): ForwardedEvent | undefined {
  const update = event.assistantMessageEvent;
  switch (update.type) {
    case "text_delta":
      return { type: "text", delta: update.delta || "" };
    case "thinking_delta":
      return { type: "thinking", delta: update.delta || "" };
    case "thinking_end":
      return { type: "thinking_end" };
    default:
      return undefined;
  }
}

function handleToolExecutionStart(event: {
  type: "tool_execution_start";
  toolCallId: string;
  toolName: string;
  args: unknown;
}): ForwardedEvent {
  return {
    type: "tool_start",
    call: event.toolCallId,
    name: event.toolName,
    args: event.args,
  };
}

function handleToolExecutionEnd(event: {
  type: "tool_execution_end";
  toolName: string;
  isError: boolean;
}): ForwardedEvent {
  return { type: "tool_end", name: event.toolName, isError: event.isError };
}

function handleAgentEnd(event: {
  type: "agent_end";
  willRetry: boolean;
  messages: Array<{ role: string; errorMessage?: string }>;
}): ForwardedEvent | undefined {
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
): ForwardedEvent | undefined {
  switch (event.type) {
    case "message_start":
      return handleMessageStart(event);
    case "message_end":
      return handleMessageEnd(event, idOf, argsOf);
    case "message_update":
      return handleMessageUpdate(event);
    case "tool_execution_start":
      return handleToolExecutionStart(event);
    case "tool_execution_end":
      return handleToolExecutionEnd(event);
    case "agent_end":
      return handleAgentEnd(event);
    default:
      return undefined;
  }
}

/** Pi's own tool under `name`, which reads or writes the file on disk instead of Neovim's buffer. */
function onDisk<T extends { name: string; label: string; description: string }>(tool: T, name: string): T {
  return {
    ...tool,
    name,
    label: name,
    description: `${tool.description} Works on the file on disk and ignores unsaved changes in Neovim's buffers.`,
  };
}

/** Make `tools` the active set. Each change adds to the transcript, so an unchanged set is left alone. */
function setTools(session: AgentSession, tools: readonly string[]): void {
  const active = session.getActiveToolNames();
  if (active.length !== tools.length || tools.some((tool) => !active.includes(tool))) {
    session.setActiveToolsByName([...tools]);
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
  // With no key, Pi falls back to `MISTRAL_API_KEY` in the service's environment.
  if (apiKey) {
    await runtime.setRuntimeApiKey(PROVIDER, apiKey);
  }

  const model = runtime.getModel(PROVIDER, request.model);
  if (!model) {
    throw new Error(`unknown Mistral model: ${request.model}`);
  }

  const { cwd } = request;
  const ops = createNvimOperations(nvim);
  const settingsManager = SettingsManager.inMemory(options.settings);
  const resourceLoader = new DefaultResourceLoader({
    cwd,
    agentDir: options.agentDir ?? getAgentDir(),
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
      defineTool(createReadToolDefinition(cwd, { operations: ops.read })),
      defineTool(createWriteToolDefinition(cwd, { operations: ops.write })),
      defineTool(createEditToolDefinition(cwd, { operations: ops.edit })),
      defineTool(createBashToolDefinition(cwd)),
      defineTool(createGrepToolDefinition(cwd)),
      defineTool(createFindToolDefinition(cwd)),
      defineTool(createLsToolDefinition(cwd)),
      defineTool(onDisk(createReadToolDefinition(cwd), "read_disk")),
      defineTool(onDisk(createWriteToolDefinition(cwd), "write_disk")),
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
    session.subscribe((event) => {
      queue = queue.then(() => {
        const forwarded = forward(event, idOf, argsOf);
        if (forwarded) {
          send(nvim, forwarded);
        }
      });
    });
    const workbench = { model: request.model, session, drained: () => queue };
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
        send(nvim, {
          type: "end",
          error: err instanceof Error ? err.message : String(err),
        });
      }
    },
  };
}
