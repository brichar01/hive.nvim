import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import type { NvimConnection } from "../src/nvim_wrapper.ts";
import {
  createSessions,
  type ForwardedEvent,
  forward,
  KEY_ENV,
  type PromptRequest,
  type SessionOptions,
  takeApiKey,
} from "../src/session.ts";

const sandbox = mkdtempSync(join(tmpdir(), "hive-session-"));
process.env.PI_OFFLINE = "1";
Reflect.deleteProperty(process.env, "MISTRAL_API_KEY");

// ------- Stub Mistral server -------

interface StubBody {
  model?: string;
  reasoning_effort?: string;
  messages?: { role: string }[];
}

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
    requests.push({
      url: req.url,
      headers: req.headers,
      body: JSON.parse(Buffer.concat(chunks).toString("utf-8")) as StubBody,
    });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
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
    exec: (_code, args = []) => {
      events.push(args[0] as ForwardedEvent);
      return Promise.resolve(0);
    },
  };
  return { nvim, events };
}

const request = (text: string): PromptRequest => ({
  text,
  model: "codestral-latest",
  thinking: "off",
  workbench: "project-20261004000000",
  cwd: sandbox,
});

const options = (extra: SessionOptions = {}): SessionOptions => ({
  agentDir: sandbox,
  baseUrl,
  settings: { retry: { enabled: false } },
  ...extra,
});

// ------- Tests -------

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

  const ids = events.flatMap((e) => (e.type === "message_end" ? [e.id] : []));
  assert.equal(ids.length, 2);
  assert.deepEqual(events, [
    { type: "message_end", role: "user", id: ids[0] },
    { type: "message_start", role: "assistant" },
    { type: "text", delta: "Hel" },
    { type: "text", delta: "lo" },
    { type: "message_end", role: "assistant", id: ids[1] },
    { type: "end" },
  ]);
  assert.deepEqual(
    requests.map((r) => [r.url, r.headers.authorization]),
    [["/v1/chat/completions", "Bearer runtime-key"]],
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
    { type: "end", error: "unknown Mistral model: no-such-model" },
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
    model: "mistral-small-latest",
    thinking: "high",
  });

  assert.equal(requests[0]?.body.reasoning_effort, "high");
});

test("a thinking change keeps the session and its history", async () => {
  const { nvim } = fakeNvim();
  const sessions = createSessions("k", options());
  const small = { ...request("one"), model: "mistral-small-latest" };
  await sessions.prompt(nvim, small);
  await sessions.prompt(nvim, { ...small, text: "two", thinking: "low" });

  assert.deepEqual(
    requests.map((r) => [
      r.body.reasoning_effort,
      r.body.messages?.filter((m) => m.role !== "system").length,
    ]),
    [
      [undefined, 1],
      ["high", 3],
    ],
  );
});

test("a model change starts a new session", async () => {
  const { nvim } = fakeNvim();
  const sessions = createSessions("k", options());
  await sessions.prompt(nvim, request("one"));
  await sessions.prompt(nvim, {
    ...request("two"),
    model: "mistral-small-latest",
  });

  assert.deepEqual(
    requests.map((r) => [
      r.body.model,
      r.body.messages?.filter((m) => m.role !== "system").length,
    ]),
    [
      ["codestral-latest", 1],
      ["mistral-small-latest", 1],
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

test("forward passes thinking through, and a tool result's text with its start", () => {
  const none = (): undefined => undefined;
  const update = (assistantMessageEvent: object) =>
    ({ type: "message_update", message: {}, assistantMessageEvent }) as never;

  assert.deepEqual(
    forward(update({ type: "thinking_delta", delta: "hmm" }), none),
    { type: "thinking", delta: "hmm" },
  );
  assert.deepEqual(forward(update({ type: "thinking_end" }), none), {
    type: "thinking_end",
  });
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
    { type: "message_start", role: "toolResult", text: "a\nb" },
  );
});
