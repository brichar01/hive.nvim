import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { NvimConnection } from "../src/nvim_wrapper.ts";
import {
  createChunker,
  createRouter,
  createSessions,
  DEFAULT_TOOLS,
  endLine,
  entryLine,
  type ForwardedEvent,
  forward,
  KEY_ENV,
  type PromptRequest,
  preview,
  resolveTools,
  type Router,
  type SessionOptions,
  takeApiKey,
  THINKING_PREVIEW_CHARS,
  thinkingLine,
  toolMatches,
  TOOLS,
} from "../src/session.ts";
import type { LoggedEntry } from "../src/workbench_log.ts";

const sandbox = mkdtempSync(join(tmpdir(), "hive-session-"));
// The embedded session discovers extensions from `<agentDir>/extensions`. Stub the tool the
// default set expects, so `DEFAULT_TOOLS` matches what a session can actually activate.
mkdirSync(join(sandbox, "extensions"), { recursive: true });
writeFileSync(
  join(sandbox, "extensions", "ddgr.ts"),
  `import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
export default function (pi) {
  pi.registerTool(defineTool({
    name: "ddgr_search",
    label: "DuckDuckGo Search",
    description: "Search the web",
    parameters: Type.Object({ query: Type.String() }),
    async execute() {
      return { content: [{ type: "text", text: "ok" }], details: {} };
    },
  }));
}
`,
);
process.env.PI_OFFLINE = "1";
Reflect.deleteProperty(process.env, "DEEPSEEK_API_KEY");

// ------- Stub DeepSeek server -------

interface StubMessage {
  role: string;
  content?: string | { type: string; text?: string }[];
}

interface StubBody {
  model?: string;
  reasoning_effort?: string;
  messages?: StubMessage[];
  tools?: { function: { name: string } }[];
}

/** A message's text, whether the request carries it as a string or as content parts. */
const textOf = (message: StubMessage): string => {
  if (typeof message.content === "string") {
    return message.content;
  }
  return (message.content ?? []).flatMap((part) => part.text ?? []).join("\n");
};

/** Whether this request asks for a reasoning stream, which the stub sends before its text. */
const wantsThinking = (body: StubBody): boolean =>
  body.messages?.some(
    (message) => message.role === "user" && textOf(message).includes("think"),
  ) ?? false;

let requests: {
  url: string | undefined;
  headers: IncomingHttpHeaders;
  body: StubBody;
}[] = [];
let baseUrl = "";

const chunk = (body: unknown): string => `data: ${JSON.stringify(body)}\n\n`;

const server = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (data: Buffer) => chunks.push(data));
  req.on("end", () => {
    const body = JSON.parse(Buffer.concat(chunks).toString("utf-8")) as StubBody;
    requests.push({
      url: req.url,
      headers: req.headers,
      body,
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    if (wantsThinking(body)) {
      for (const reasoning of ["check the ", "fold logic"]) {
        res.write(
          chunk({
            id: "1",
            choices: [{ index: 0, delta: { role: "assistant", reasoning_content: reasoning } }],
          }),
        );
      }
    }
    for (const content of ["Hel", "lo"]) {
      res.write(
        chunk({
          id: "1",
          choices: [{ index: 0, delta: { role: "assistant", content } }],
        }),
      );
    }
    res.write(
      chunk({
        id: "1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 2, total_tokens: 3 },
      }),
    );
    res.end("data: [DONE]\n\n");
  });
});

before(async () => {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
});

// ------- Helpers -------

function fakeNvim(): { nvim: NvimConnection; events: ForwardedEvent[] } {
  const events: ForwardedEvent[] = [];
  const nvim: NvimConnection = {
    on: () => {},
    exec: (code, args = []) => {
      if (code.includes("on_event")) {
        events.push(args[0] as ForwardedEvent);
      }
      return Promise.resolve(0);
    },
  };
  return { nvim, events };
}

const request = (text: string): PromptRequest => ({
  text,
  model: "deepseek-flash",
  thinking: "off",
  workbench: "project-20261004000000",
  cwd: sandbox,
  tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
  log: join(sandbox, "project-20261004000000.log"),
});

const options = (extra: SessionOptions = {}): SessionOptions => ({
  agentDir: sandbox,
  baseUrl,
  settings: { retry: { enabled: false } },
  ...extra,
});

// ------- Tests -------

test("toolMatches treats * as any characters", () => {
  assert.equal(toolMatches("read_disk", "read_disk"), true);
  assert.equal(toolMatches("read_disk", "read"), false);
  assert.equal(toolMatches("read_disk", "*_disk"), true);
  assert.equal(toolMatches("read", "*_disk"), false);
  assert.equal(toolMatches("mcp__radius__search", "mcp__radius__*"), true);
});

test("resolveTools selects plain names and globs", () => {
  assert.deepEqual(resolveTools(["read", "bash"]), ["read", "bash"]);
  assert.deepEqual(resolveTools(["*_disk"]), ["read_disk", "write_disk"]);
});

test("resolveTools applies deltas to the default selection", () => {
  assert.deepEqual(resolveTools(["+read_disk"]), [...DEFAULT_TOOLS, "read_disk"]);
  assert.deepEqual(
    resolveTools(["-write"]),
    DEFAULT_TOOLS.filter((tool) => tool !== "write"),
  );
  assert.deepEqual(
    resolveTools(["+read_disk", "-write"]),
    [...DEFAULT_TOOLS.filter((tool) => tool !== "write"), "read_disk"],
  );
});

test("resolveTools rejects unknown names, mixing, and empty patterns", () => {
  assert.throws(() => resolveTools(["rm"]), /unknown tool/);
  assert.throws(() => resolveTools(["read", "+write_disk"]), /mixing plain tool names/);
  assert.throws(() => resolveTools(["zzz*"]), /unknown tool/);
});

test("every registered tool has a spec", () => {
  assert.deepEqual(new Set(TOOLS).size, TOOLS.length);
  assert.deepEqual([...TOOLS].sort(), [
    "bash",
    "ddgr_search",
    "edit",
    "find",
    "grep",
    "ls",
    "read",
    "read_disk",
    "write",
    "write_disk",
  ]);
});

test("takeApiKey reads the key and removes it from the environment", () => {
  const env = { [KEY_ENV]: "secret" };
  assert.equal(takeApiKey(env), "secret");
  assert.equal(KEY_ENV in env, false);
});

test("takeApiKey treats an empty value as no key", () => {
  assert.equal(takeApiKey({ [KEY_ENV]: "" }), undefined);
});

test("a prompt streams text deltas and ends", async () => {
  const { nvim, events } = fakeNvim();
  await createSessions("runtime-key", options()).prompt(nvim, request("hello"));

  const header = events.flatMap((e) => (e.type === "message_end" ? e.header : []));
  const you = header.find((line) => line.startsWith("You (")) ?? "";
  const response = header.find((line) => line.startsWith("Response (")) ?? "";
  assert.match(you, /^You \([0-9a-f]{8}\):$/);
  assert.match(response, /^Response \([0-9a-f]{8}\):$/);

  assert.deepEqual(events, [
    { type: "message_end", role: "user", header: ["", you] },
    { type: "message_start", role: "assistant" },
    { type: "text", delta: "Hello" },
    { type: "message_end", role: "assistant", header: ["", response] },
    { type: "end", footer: `End response to ${you.slice(5, 13)}` },
  ]);
  assert.deepEqual(
    requests.map((r) => [r.url, r.headers.authorization]),
    [["/chat/completions", "Bearer runtime-key"]],
  );
});

test("no key ends with an error and sends nothing", async () => {
  const { nvim, events } = fakeNvim();
  await createSessions(undefined, options()).prompt(nvim, request("hello"));

  const last = events.at(-1);
  assert.ok(last?.type === "end" && last.error);
  assert.equal(requests.length, 0);
});

test("a model missing from Pi's catalogue ends with an error", async () => {
  const { nvim, events } = fakeNvim();
  await createSessions("k", options()).prompt(nvim, {
    ...request("hello"),
    model: "no-such-model",
  });

  assert.deepEqual(events, [
    { type: "end", error: "unknown DeepSeek model: no-such-model" },
  ]);
});

test("the session never creates auth.json in the agent directory", async () => {
  const { nvim } = fakeNvim();
  await createSessions("runtime-key", options()).prompt(nvim, request("hello"));

  assert.equal(existsSync(join(sandbox, "auth.json")), false);
});

test("an unreachable endpoint ends with an error", async () => {
  const { nvim, events } = fakeNvim();
  await createSessions("k", options({ baseUrl: "http://127.0.0.1:1" })).prompt(
    nvim,
    request("hello"),
  );

  const last = events.at(-1);
  assert.ok(last?.type === "end" && last.error);
});

test("the thinking level reaches a model that reasons", async () => {
  const { nvim } = fakeNvim();
  await createSessions("k", options()).prompt(nvim, {
    ...request("hello"),
    model: "deepseek-v4-pro",
    thinking: "high",
  });

  assert.equal(requests[0]?.body.reasoning_effort, "high");
});

test("a thinking change keeps the session and its history", async () => {
  const { nvim } = fakeNvim();
  const sessions = createSessions("k", options());
  const small = { ...request("one"), model: "deepseek-flash" };
  await sessions.prompt(nvim, small);
  await sessions.prompt(nvim, { ...small, text: "two", thinking: "low" });

  assert.deepEqual(
    requests.map((r) => [
      r.body.reasoning_effort,
      r.body.messages?.filter((m) => m.role !== "system").length,
    ]),
    [
      // DeepSeek omits `reasoning_effort` at thinking level "off".
      [undefined, 1],
      ["low", 3],
    ],
  );
});

test("the request's tools are the active tools, and a change keeps the session", async () => {
  const { nvim } = fakeNvim();
  const sessions = createSessions("k", options());
  await sessions.prompt(nvim, request("one"));
  await sessions.prompt(nvim, { ...request("two"), tools: ["read_disk", "bash"] });

  assert.deepEqual(
    requests.map((r) => [
      r.body.tools?.map((t) => t.function.name).sort(),
      r.body.messages?.filter((m) => m.role !== "system").length,
    ]),
    [
      [["bash", "edit", "find", "grep", "ls", "read", "write"], 1],
      [["bash", "read_disk"], 3],
    ],
  );
});

test("a glob activates every matching tool", async () => {
  const { nvim } = fakeNvim();
  await createSessions("k", options()).prompt(nvim, {
    ...request("one"),
    tools: ["*_disk"],
  });

  assert.deepEqual(
    requests[0]?.body.tools?.map((t) => t.function.name).sort(),
    ["read_disk", "write_disk"],
  );
});

test("a delta changes the default selection and keeps the session", async () => {
  const { nvim } = fakeNvim();
  const sessions = createSessions("k", options());
  await sessions.prompt(nvim, { ...request("one"), tools: ["+read_disk", "-write"] });
  await sessions.prompt(nvim, { ...request("two"), tools: ["+read_disk", "-write"] });

  const expected = [...DEFAULT_TOOLS.filter((tool) => tool !== "write"), "read_disk"].sort();
  assert.deepEqual(
    requests.map((r) => r.body.tools?.map((t) => t.function.name).sort()),
    [expected, expected],
  );
  // The delta leaves the tool set unchanged, so the second prompt reuses the session.
  assert.equal(requests[1]?.body.messages?.filter((m) => m.role !== "system").length, 3);
});

test("a model change starts a new session", async () => {
  const { nvim } = fakeNvim();
  const sessions = createSessions("k", options());
  await sessions.prompt(nvim, request("one"));
  await sessions.prompt(nvim, {
    ...request("two"),
    model: "deepseek-v4-pro",
  });

  assert.deepEqual(
    requests.map((r) => [
      r.body.model,
      r.body.messages?.filter((m) => m.role !== "system").length,
    ]),
    [
      ["deepseek-flash", 1],
      ["deepseek-v4-pro", 1],
    ],
  );
});

test("each workbench keeps its own session", async () => {
  const { nvim } = fakeNvim();
  const sessions = createSessions("k", options());
  const other = { ...request("b1"), workbench: "project-20261004120000" };
  await sessions.prompt(nvim, request("a1"));
  await sessions.prompt(nvim, other);
  await sessions.prompt(nvim, request("a2"));

  assert.deepEqual(
    requests.map(
      (r) => r.body.messages?.filter((m) => m.role !== "system").length,
    ),
    [1, 1, 3],
  );
});

test("a prompt writes raw thinking to the workbench log", async () => {
  const { nvim, events } = fakeNvim();
  const log = join(sandbox, "project-thinking.log");
  await createSessions("k", options()).prompt(nvim, {
    ...request("think it through"),
    model: "deepseek-v4-pro",
    thinking: "high",
    workbench: "project-thinking",
    log,
  });

  const end = events.find(
    (event) => event.type === "message_end" && event.role === "assistant",
  );
  assert.ok(end?.type === "message_end");
  assert.match(
    end.header.join("\n"),
    /^\nThinking \([0-9a-f]{8}\): check the fold logic\nResponse \([0-9a-f]{8}\):$/,
  );
  const id = end.header[1]?.slice(10, 18) ?? "";

  const lines = readFileSync(log, "utf-8").trim().split("\n");
  assert.equal(lines.length, 1);
  const { ts, ...entry } = JSON.parse(lines[0] ?? "{}") as Record<string, unknown>;
  assert.equal(typeof ts, "string");
  assert.deepEqual(entry, {
    id,
    type: "thinking",
    text: "check the fold logic",
  });
});

test("the chunker coalesces text deltas until an event flushes them", () => {
  const chunk = createChunker();
  const end = { type: "end" } as const;

  assert.deepEqual(chunk({ type: "text", delta: "Hel" }), []);
  assert.deepEqual(chunk({ type: "text", delta: "lo" }), []);
  assert.deepEqual(chunk(end), [{ type: "text", delta: "Hello" }, end]);
  assert.deepEqual(chunk.flush(), []);
});

test("the chunker holds text past many lines, and flushes on size", () => {
  const chunk = createChunker();
  const lines = "x\n".repeat(1000);

  assert.deepEqual(chunk({ type: "text", delta: lines }), []);
  assert.deepEqual(chunk({ type: "text", delta: "y".repeat(100_000) }), [
    { type: "text", delta: lines + "y".repeat(100_000) },
  ]);
});

function fakeRouter(): {
  events: ForwardedEvent[];
  logged: LoggedEntry[];
  router: Router;
} {
  const events: ForwardedEvent[] = [];
  const logged: LoggedEntry[] = [];
  const router = createRouter(
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
  return { events, logged, router };
}

test("preview collapses whitespace and keeps the first characters", () => {
  assert.equal(preview("  check \n the\tfold logic and more "), "check the fold logic");
  assert.equal(preview("x".repeat(THINKING_PREVIEW_CHARS + 5)), "x".repeat(THINKING_PREVIEW_CHARS));
  assert.equal(preview(" \n\t "), "");
});

test("thinkingLine keys the summary by the start of the entry id", () => {
  assert.equal(thinkingLine("763328b4-rest", "check the fold logic"), "Thinking (763328b4): check the fold logic");
  assert.equal(thinkingLine("short", "hmm"), "Thinking (short): hmm");
});

test("entryLine names the role and the entry, and a tool result what it found", () => {
  assert.equal(entryLine("user", "763328b4-rest"), "You (763328b4):");
  assert.equal(entryLine("assistant", "763328b4-rest"), "Response (763328b4):");
  assert.equal(
    entryLine("toolResult", "ab12cd34-rest", 'grep "hive" lua/: 4 matches'),
    'Tool (ab12cd34): grep "hive" lua/: 4 matches',
  );
});

test("endLine names the prompt a reply answers", () => {
  assert.equal(endLine("763328b4-rest"), "End response to 763328b4");
});

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
