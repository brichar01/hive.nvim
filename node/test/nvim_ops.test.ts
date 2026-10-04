import assert from "node:assert/strict";
import { type ChildProcess, spawn } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, beforeEach, test } from "node:test";
import {
  createEditToolDefinition,
  createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { attach } from "neovim";
import { setLevel } from "../src/log.ts";
import { createNvimOperations, type NvimOperations } from "../src/nvim_ops.ts";
import { createNvim, type NvimConnection } from "../src/nvim_wrapper.ts";

const ROOT = resolve(import.meta.dirname, "..", "..");
const sandbox = mkdtempSync(join(tmpdir(), "hive-ops-"));
setLevel("warn");

let proc: ChildProcess;
let nvim: NvimConnection;
let ops: NvimOperations;

before(async () => {
  proc = spawn("nvim", ["--embed", "--headless", "--clean", "-n"], {
    cwd: sandbox,
  });
  nvim = createNvim(attach({ proc }));
  await nvim.exec("vim.opt.rtp:prepend(...)", [ROOT]);
  ops = createNvimOperations(nvim);
});

after(() => {
  proc.kill();
  rmSync(sandbox, { recursive: true, force: true });
});

beforeEach(async () => {
  await nvim.exec("vim.cmd('silent! %bwipeout!')", []);
});

// ------- Helpers -------

const fixtures: Record<string, string> = {
  lf: "one\ntwo\n",
  crlf: "one\r\ntwo\r\n",
  bom: "﻿one\ntwo\n",
  "no trailing newline": "one\ntwo",
  empty: "",
  "one newline": "\n",
};

function fixture(name: string, content: string): string {
  const path = join(sandbox, `${name.replaceAll(" ", "-")}.txt`);
  writeFileSync(path, content, "utf-8");
  return path;
}

const disk = (path: string): string => readFileSync(path, "utf-8");

const open = (path: string) =>
  nvim.exec("vim.cmd.edit(vim.fn.fnameescape(...))", [path]);

const lines = (path: string) =>
  nvim.exec(
    "return vim.api.nvim_buf_get_lines(vim.fn.bufnr(...), 0, -1, true)",
    [path],
  );

const modified = async (path: string) =>
  (await nvim.exec("return vim.bo[vim.fn.bufnr(...)].modified", [path])) ===
  true;

const save = (path: string) =>
  nvim.exec(
    "vim.api.nvim_buf_call(vim.fn.bufnr(...), function() vim.cmd('silent write') end)",
    [path],
  );

// ------- Fidelity -------

for (const [name, content] of Object.entries(fixtures)) {
  test(`${name}: a buffer reads as the bytes on disk`, async () => {
    const path = fixture(name, content);
    await open(path);

    assert.equal((await ops.read.readFile(path)).toString("utf-8"), content);
  });

  test(`${name}: writing the same bytes back leaves the buffer unmodified`, async () => {
    const path = fixture(name, content);
    await open(path);
    await ops.edit.writeFile(
      path,
      (await ops.edit.readFile(path)).toString("utf-8"),
    );

    assert.equal(await modified(path), false);
  });

  test(`${name}: written content reaches disk through :write`, async () => {
    const path = fixture(name, content);
    await open(path);
    const changed =
      content === ""
        ? "x"
        : content.replace("two", "three").replace("\n", "\nzero\n");
    await ops.edit.writeFile(path, changed);

    assert.equal(disk(path), content);
    assert.equal((await ops.read.readFile(path)).toString("utf-8"), changed);
    await save(path);
    // fixendofline is on, so :write adds a missing final newline.
    assert.equal(disk(path), changed.endsWith("\n") ? changed : `${changed}\n`);
  });
}

test("a write without a final newline leaves fixendofline to add one on :write", async () => {
  const path = fixture("fixeol", "one\ntwo\n");
  await open(path);
  await ops.write.writeFile(path, "one\nthree");

  assert.equal((await ops.read.readFile(path)).toString("utf-8"), "one\nthree");
  assert.equal(
    await nvim.exec("return vim.bo[vim.fn.bufnr(...)].fixendofline", [path]),
    true,
  );
  await save(path);
  assert.equal(disk(path), "one\nthree\n");
});

test("a CRLF buffer written with LF content switches to unix", async () => {
  const path = fixture("switch", "one\r\ntwo\r\n");
  await open(path);
  await ops.write.writeFile(path, "one\ntwo\n");
  await save(path);

  assert.equal(disk(path), "one\ntwo\n");
});

// ------- Pi's tools -------

test("the edit tool updates an open buffer and leaves disk alone", async () => {
  const path = fixture("edit", "alpha\r\nbeta\r\n");
  await open(path);
  const edit = createEditToolDefinition(sandbox, { operations: ops.edit });
  await edit.execute(
    "1",
    { path, edits: [{ oldText: "beta", newText: "gamma" }] },
    undefined,
    undefined,
    undefined as never,
  );

  assert.deepEqual(await lines(path), ["alpha", "gamma"]);
  assert.equal(await modified(path), true);
  assert.equal(disk(path), "alpha\r\nbeta\r\n");
});

test("the edit tool loads a buffer for a file with none, and leaves disk alone", async () => {
  const path = fixture("closed", "alpha\nbeta\n");
  const edit = createEditToolDefinition(sandbox, { operations: ops.edit });
  await edit.execute(
    "1",
    { path, edits: [{ oldText: "beta", newText: "gamma" }] },
    undefined,
    undefined,
    undefined as never,
  );

  assert.deepEqual(await lines(path), ["alpha", "gamma"]);
  assert.equal(await modified(path), true);
  assert.equal(disk(path), "alpha\nbeta\n");
});

test("the write tool creates a new file as a listed, modified buffer with nothing on disk", async () => {
  const path = join(sandbox, "dir", "created.txt");
  const write = createWriteToolDefinition(sandbox, { operations: ops.write });
  await write.execute(
    "1",
    { path, content: "hello\r\nworld\r\n" },
    undefined,
    undefined,
    undefined as never,
  );

  assert.deepEqual(await lines(path), ["hello", "world"]);
  assert.deepEqual(
    await nvim.exec(
      "local b = vim.fn.bufnr(...) return { vim.bo[b].buflisted, vim.bo[b].modified, vim.bo[b].fileformat }",
      [path],
    ),
    [true, true, "dos"],
  );
  assert.equal(existsSync(path), false);
  assert.equal(
    (await ops.read.readFile(path)).toString("utf-8"),
    "hello\r\nworld\r\n",
  );
});

test("the write tool fills an open buffer for a file not yet on disk", async () => {
  const path = join(sandbox, "new.txt");
  await open(path);
  const write = createWriteToolDefinition(sandbox, { operations: ops.write });
  await write.execute(
    "1",
    { path, content: "hello\n" },
    undefined,
    undefined,
    undefined as never,
  );

  assert.deepEqual(await lines(path), ["hello"]);
  assert.equal(existsSync(path), false);
});

test("an image is read from disk even with a buffer open", async () => {
  const png = Buffer.from(
    "89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489",
    "hex",
  );
  const path = join(sandbox, "pixel.png");
  writeFileSync(path, png);
  await open(path);

  assert.deepEqual(await ops.read.readFile(path), png);
});
