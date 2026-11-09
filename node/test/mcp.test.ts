import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { after, before, beforeEach, describe, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { dialSocket } from "../src/connection/dial.ts";
import { setLevel } from "../src/log.ts";
import { type Candidate, choose, createLocator, createMcpServer, type Locator } from "../src/mcp.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const sandbox = mkdtempSync(join(tmpdir(), "hive-mcp-"));
const socket = join(sandbox, "nvim.sock");
setLevel("warn");

let proc: ChildProcess;
let locator: Locator;
let client: Client;

before(async () => {
  proc = spawn(
    "nvim",
    ["--headless", "--clean", "-n", "--listen", socket, "--cmd", `lua vim.opt.rtp:prepend(${JSON.stringify(ROOT)})`],
    { cwd: sandbox, stdio: "ignore" },
  );
  for (let tries = 0; !existsSync(socket); tries++) {
    if (tries > 200) {
      throw new Error(`nvim did not listen on ${socket}`);
    }
    await delay(25);
  }

  locator = createLocator({ env: { HIVE_NVIM: socket }, cwd: sandbox });
  const [clientSide, serverSide] = InMemoryTransport.createLinkedPair();
  await createMcpServer(locator, sandbox).connect(serverSide);
  client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientSide);
});

after(async () => {
  await client.close();
  locator.close();
  proc.kill();
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(async () => {
  await (await locator.nvim()).exec("vim.cmd('silent! %bwipeout!')", []);
});

// ------- Helpers -------

interface Result {
  text: string;
  isError: boolean;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<Result> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as { type: string; text: string }[];
  return { text: content.map((c) => c.text).join("\n"), isError: result.isError === true };
}

async function ok(name: string, args: Record<string, unknown> = {}): Promise<string> {
  const result = await call(name, args);
  assert.equal(result.isError, false, result.text);
  return result.text;
}

const json = async (name: string, args: Record<string, unknown> = {}): Promise<Record<string, unknown>> =>
  JSON.parse(await ok(name, args)) as Record<string, unknown>;

function fixture(name: string, content: string): string {
  const path = join(sandbox, name);
  writeFileSync(path, content);
  return path;
}

// ------- Buffer tools -------

test("read_buffer reads a range from disk when no buffer holds the file", async () => {
  const path = fixture("read.txt", "one\ntwo\nthree\n");
  assert.equal(
    await ok("read_buffer", { path: "read.txt", start: 2, end: 9 }),
    `${path} lines 2-3 of 3 (disk)\n2\ttwo\n3\tthree`,
  );
});

test("read_buffer strips the CR from every line of a CRLF file on disk", async () => {
  fixture("crlf.txt", "one\r\ntwo\r\n");
  assert.match(await ok("read_buffer", { path: "crlf.txt" }), /\n1\tone\n2\ttwo$/);
});

test("edit_buffer replaces, inserts and deletes in the buffer and leaves disk alone", async () => {
  const path = fixture("edit.txt", "one\ntwo\nthree\n");

  const replaced = await json("edit_buffer", { path, start: 2, end: 2, lines: ["TWO", "2b"] });
  assert.equal(replaced.modified, true);
  assert.equal(replaced.line_count, 4);
  await ok("edit_buffer", { path, start: 1, end: 0, lines: ["zero"] });
  await ok("edit_buffer", { path, start: 5, end: 5, lines: [] });

  assert.equal(
    await ok("read_buffer", { path }),
    `${path} lines 1-4 of 4 (buffer)\n1\tzero\n2\tone\n3\tTWO\n4\t2b`,
  );
  assert.equal(readFileSync(path, "utf-8"), "one\ntwo\nthree\n");
});

test("edit_buffer refuses a range outside the buffer", async () => {
  const path = fixture("range.txt", "one\n");
  const result = await call("edit_buffer", { path, start: 3, end: 3, lines: ["x"] });
  assert.equal(result.isError, true);
  assert.match(result.text, /start 3 is outside 1-2/);
});

test("open_buffer only changes the current window when asked to focus", async () => {
  const first = fixture("first.txt", "a\n");
  const second = fixture("second.txt", "b\n");

  await ok("open_buffer", { path: first, focus: true });
  await ok("open_buffer", { path: second });
  assert.equal((await json("get_active_buffer")).path, first);

  await ok("set_active_buffer", { path: second });
  assert.equal((await json("get_active_buffer")).path, second);
});

test("set_active_buffer refuses a file with no buffer", async () => {
  const result = await call("set_active_buffer", { path: fixture("unloaded.txt", "") });
  assert.equal(result.isError, true);
  assert.match(result.text, /no loaded buffer/);
});

test("set_cursor with a path activates the buffer and moves the cursor", async () => {
  const path = fixture("cursor.txt", "one\ntwo\nthree\n");
  await ok("open_buffer", { path });

  const moved = await json("set_cursor", { line: 3, col: 2, path });
  assert.deepEqual([moved.path, moved.line, moved.col], [path, 3, 2]);
  const read = await json("get_cursor");
  assert.deepEqual([read.line, read.col], [3, 2]);
});

test("select_nvim refuses to override $HIVE_NVIM", async () => {
  const result = await call("select_nvim", { socket });
  assert.equal(result.isError, true);
  assert.match(result.text, /\$HIVE_NVIM/);
});

// ------- Choosing a Neovim -------

describe("scan", () => {
  test("finds the one Neovim working in cwd and skips dead sockets", async () => {
    const scan = createLocator({
      env: {},
      cwd: join(sandbox, "sub"),
      sockets: () => Promise.resolve([join(sandbox, "missing.sock"), socket]),
      dial: (path) => dialSocket(path),
    });
    try {
      const [found, ...rest] = await scan.candidates();
      assert.equal(rest.length, 0);
      assert.equal(found?.socket, socket);
      assert.equal(found.focusedAt, null);
      await scan.nvim();
    } finally {
      scan.close();
    }
  });
});

describe("choose", () => {
  const candidate = (name: string, cwd: string, focusedAt: number | null): Candidate => ({
    socket: name,
    pid: 1,
    cwd,
    focusedAt,
    buffer: "",
  });

  test("prefers the Neovim focused last", () => {
    const picked = choose("/p", [candidate("old", "/p", 1), candidate("new", "/p", 2), candidate("never", "/p", null)]);
    assert.equal(picked.socket, "new");
  });

  test("matches a Neovim working above or below cwd, but not a sibling", () => {
    assert.equal(choose("/p/sub", [candidate("above", "/p", null)]).socket, "above");
    assert.equal(choose("/p", [candidate("below", "/p/sub", null)]).socket, "below");
    assert.throws(() => choose("/p", [candidate("sibling", "/pq", null)]), /No Neovim works in or above \/p/);
  });

  test("refuses to guess between two with the same focus time", () => {
    assert.throws(
      () => choose("/p", [candidate("a", "/p", null), candidate("b", "/p", null)]),
      /Several Neovims .* select_nvim/s,
    );
  });
});
