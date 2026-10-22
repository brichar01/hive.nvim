import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { NvimConnection } from "../src/nvim_wrapper.ts";
import type { ForwardedEvent, PromptRequest } from "../src/protocol.ts";
import { createSessions, type SessionOptions } from "../src/sessions.ts";
import { DEFAULT_TOOLS } from "../src/tools.ts";

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
  // No model in a test: a summary with nothing to say leaves the thinking's start in place.
  summarizer: { summarize: () => Promise.resolve("") },
  ...extra,
});

// ------- Tests -------
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
