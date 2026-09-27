// Checks the Pi credential interface that PLAN.md stage 2 relies on.
// Run with `npm test`. Nothing leaves the machine: the provider is a local stub.

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, beforeEach, test } from "node:test";

// Set before Pi loads, so no default path falls back to ~/.pi/agent.
const sandbox = mkdtempSync(join(tmpdir(), "hive-pi-auth-"));
process.env.PI_CODING_AGENT_DIR = sandbox;
process.env.PI_OFFLINE = "1";

const { createAgentSession, ModelRuntime, SessionManager, SettingsManager } = await import(
  "@earendil-works/pi-coding-agent"
);

const PROVIDER = "hive";
const MODEL = "stub";
const authPath = join(sandbox, "auth.json");

// ------- Stub OpenAI-compatible server -------

/** @type {{ authorization: string | undefined }[]} */
let requests = [];
let baseUrl = "";

const chunk = (body) => `data: ${JSON.stringify(body)}\n\n`;

const server = createServer((req, res) => {
  req.resume();
  req.on("end", () => {
    requests.push({ authorization: req.headers.authorization });
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(chunk({ id: "1", choices: [{ index: 0, delta: { role: "assistant", content: "ok" } }] }));
    res.write(
      chunk({
        id: "1",
        choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
        usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
      }),
    );
    res.end("data: [DONE]\n\n");
  });
});

before(async () => {
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/v1`;
});

after(() => {
  server.close();
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(() => {
  requests = [];
  rmSync(authPath, { force: true });
});

// ------- Helpers -------

/** A CredentialStore that holds nothing and never touches disk. */
function emptyStore() {
  const data = new Map();
  return {
    async read(id) {
      return data.get(id);
    },
    async list() {
      return [...data].map(([providerId, c]) => ({ providerId, type: c.type }));
    },
    async modify(id, fn) {
      const next = await fn(data.get(id));
      next ? data.set(id, next) : data.delete(id);
      return next;
    },
    async delete(id) {
      data.delete(id);
    },
  };
}

/** @param {import("@earendil-works/pi-coding-agent").CreateModelRuntimeOptions} options */
async function runtimeWith(options, provider = {}) {
  const runtime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false, ...options });
  runtime.registerProvider(PROVIDER, {
    ...provider,
    baseUrl,
    api: "openai-completions",
    models: [
      {
        id: MODEL,
        name: MODEL,
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 8192,
        maxTokens: 256,
      },
    ],
  });
  return runtime;
}

/** Send one prompt and return the final assistant message. */
async function promptOnce(runtime) {
  const { session } = await createAgentSession({
    cwd: sandbox,
    agentDir: sandbox,
    modelRuntime: runtime,
    model: runtime.getModel(PROVIDER, MODEL),
    noTools: "all",
    sessionManager: SessionManager.inMemory(sandbox),
    settingsManager: SettingsManager.inMemory(),
  });
  try {
    await session.prompt("hello");
    return session.messages.findLast((m) => m.role === "assistant");
  } finally {
    session.dispose();
  }
}

// ------- Tests -------

test("runtime key reaches the provider as a bearer token", async () => {
  const runtime = await runtimeWith({ credentials: emptyStore() });
  await runtime.setRuntimeApiKey(PROVIDER, "runtime-key");

  const reply = await promptOnce(runtime);

  assert.equal(reply?.stopReason, "stop", reply?.errorMessage);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer runtime-key");
});

test("default store creates an empty auth.json and never writes the runtime key", async () => {
  const runtime = await runtimeWith({ authPath });
  await runtime.setRuntimeApiKey(PROVIDER, "runtime-key");

  await promptOnce(runtime);

  assert.equal(requests[0]?.authorization, "Bearer runtime-key");
  assert.equal(readFileSync(authPath, "utf8"), "{}");
});

test("custom store never creates auth.json", async () => {
  const runtime = await runtimeWith({ credentials: emptyStore() });
  await runtime.setRuntimeApiKey(PROVIDER, "runtime-key");

  await promptOnce(runtime);

  assert.equal(existsSync(authPath), false);
});

test("default store falls back to auth.json when no runtime key is set", async () => {
  writeFileSync(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: "file-key" } }));
  const runtime = await runtimeWith({ authPath });

  await promptOnce(runtime);

  assert.equal(requests[0]?.authorization, "Bearer file-key");
});

test("custom store ignores auth.json", async () => {
  writeFileSync(authPath, JSON.stringify({ [PROVIDER]: { type: "api_key", key: "file-key" } }));
  const runtime = await runtimeWith({ credentials: emptyStore() });
  await runtime.setRuntimeApiKey(PROVIDER, "runtime-key");

  await promptOnce(runtime);

  assert.equal(requests[0]?.authorization, "Bearer runtime-key");
});

test("built-in providers fall back to their environment variable", async () => {
  process.env.OPENAI_API_KEY = "env-key";
  try {
    const runtime = await runtimeWith({ credentials: emptyStore() });
    const resolved = await runtime.getAuth("openai");
    assert.equal(resolved?.auth?.apiKey, "env-key");
  } finally {
    delete process.env.OPENAI_API_KEY;
  }
});

test("no key: prompt is refused before any request", async () => {
  const runtime = await runtimeWith({ credentials: emptyStore() });

  await assert.rejects(promptOnce(runtime), /No API key found for hive/);
  assert.equal(requests.length, 0);
});

test("no key with authHeader false: prompt is still refused", async () => {
  const runtime = await runtimeWith({ credentials: emptyStore() }, { authHeader: false });

  await assert.rejects(promptOnce(runtime), /No API key found for hive/);
  assert.equal(requests.length, 0);
});

test("placeholder key: authHeader false does not suppress the bearer header", async () => {
  const runtime = await runtimeWith({ credentials: emptyStore() }, { authHeader: false });
  await runtime.setRuntimeApiKey(PROVIDER, "unauthenticated");

  await promptOnce(runtime);

  assert.equal(requests.length, 1);
  assert.equal(requests[0].authorization, "Bearer unauthenticated");
});
