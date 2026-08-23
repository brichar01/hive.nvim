#!/usr/bin/env -S nvim -l
--
-- Measures what §7.4 (notes/implementation/05-context-region.md) is built on:
-- can a language server tell us what *calls* the function under the cursor,
-- and by which request.
--
--   nvim -l scripts/measure/consumers.lua
--
-- Self-contained. Writes throwaway fixtures under a temp dir, starts each
-- server it can find, and prints the table in §7.4 plus [R§11.9]. Servers that
-- are not installed are skipped, not failed.
--
-- Re-run this on any machine whose server set differs from the 2026-08-23
-- baseline (lua_ls 3.18.2-dev, pyright 1.1.411, tsgo 7.0.0-dev.20260707.2,
-- clangd 22.1.6); §7.4's choice of `textDocument/references` over
-- `callHierarchy/incomingCalls` is a conclusion about *those four* and nothing
-- more.

local ROOT = vim.fs.joinpath(vim.fn.tempname(), "consumers")
local MASON = vim.fs.joinpath(vim.fn.stdpath("data"), "mason", "bin")

local function out(...)
  io.stdout:write(string.format(...), "\n")
  io.stdout:flush()
end

local function exe(name)
  local m = vim.fs.joinpath(MASON, name)
  if vim.fn.executable(m) == 1 then
    return m
  end
  if vim.fn.executable(name) == 1 then
    return name
  end
  return nil
end

local function write(rel, lines)
  local path = vim.fs.joinpath(ROOT, rel)
  vim.fn.mkdir(vim.fs.dirname(path), "p")
  vim.fn.writefile(lines, path)
  return path
end

-- ---------------------------------------------------------------- fixtures --
-- Each case is one callee (`sym`, matched on the line matching `pat`) and one
-- caller file that already references it. `append` adds a *second* caller to
-- the caller buffer without writing it to disk — that is the unsaved-buffer
-- test, and it only means anything because the symbol is already in scope
-- there. (A first pass appended a call to a symbol that was never imported,
-- measured zero callers, and nearly concluded that unsaved buffers do not
-- work at all.)

local CASES = {
  {
    name = "lua_ls",
    cmd = function()
      local e = exe("lua-language-server")
      return e and { e }
    end,
    dir = "lua",
    files = {
      ["lua/lib.lua"] = {
        "local M = {}",
        "",
        "--- Build the curl argv for a request.",
        "function M.request(req, opts)",
        "  local timeout = (opts and opts.timeout) or 30",
        "  return { req.url, timeout }",
        "end",
        "",
        "return M",
      },
      ["lua/caller.lua"] = {
        'local lib = require("lib")',
        "",
        "local function fetch_user(id)",
        '  return lib.request({ url = "/users/" .. id }, { timeout = 5 })',
        "end",
        "",
        "local function fetch_all()",
        '  return lib.request({ url = "/users" })',
        "end",
        "",
        "return { fetch_user = fetch_user, fetch_all = fetch_all }",
      },
      ["lua/.luarc.json"] = { '{ "runtime": { "version": "LuaJIT" } }' },
    },
    target = "lua/lib.lua",
    caller = "lua/caller.lua",
    pat = "function M%.request",
    sym = "request",
    append = { "", "local function fetch_one(id)", '  return lib.request({ url = "/one/" .. id })', "end" },
  },
  {
    name = "pyright",
    cmd = function()
      local e = exe("pyright-langserver")
      return e and { e, "--stdio" }
    end,
    dir = "py",
    files = {
      ["py/helper.py"] = { "def helper(value: int) -> int:", '    """Add one."""', "    return value + 1" },
      ["py/main.py"] = {
        "from helper import helper",
        "",
        "",
        "def run(n: int) -> int:",
        "    total = helper(n)",
        "    return helper(total)",
      },
    },
    target = "py/helper.py",
    caller = "py/main.py",
    pat = "def helper",
    sym = "helper",
    append = { "", "", "def run_twice(n: int) -> int:", "    return helper(helper(n))" },
  },
  {
    name = "tsgo",
    cmd = function()
      local e = exe("tsgo")
      return e and { e, "--lsp", "--stdio" }
    end,
    dir = "ts",
    files = {
      ["ts/lib.ts"] = {
        "export function add(a: number, b: number): number {",
        "  return a + b;",
        "}",
        "",
        "export const mul = (a: number, b: number): number => a * b;",
      },
      ["ts/main.ts"] = {
        'import { add, mul } from "./lib";',
        "",
        "export function total(xs: number[]): number {",
        "  let acc = 0;",
        "  for (const x of xs) {",
        "    acc = add(acc, x);",
        "  }",
        "  return mul(acc, 2);",
        "}",
      },
      ["ts/tsconfig.json"] = { '{ "compilerOptions": { "strict": true, "target": "es2020" } }' },
    },
    target = "ts/lib.ts",
    caller = "ts/main.ts",
    pat = "export function add",
    sym = "add",
    append = { "", "export function twice(a: number): number {", "  return add(a, a);", "}" },
  },
  {
    name = "clangd",
    cmd = function()
      local e = exe("clangd")
      return e and { e, "--background-index" }
    end,
    dir = "c",
    files = {
      ["c/lib.c"] = { "int helper(int x) { return x + 1; }" },
      ["c/main.c"] = {
        "int helper(int x);",
        "int run(int n) {",
        "  int t = helper(n);",
        "  return helper(t);",
        "}",
      },
    },
    target = "c/lib.c",
    caller = "c/main.c",
    pat = "int helper",
    sym = "helper",
    append = { "int run2(int n) { return helper(n) + helper(n); }" },
    -- written after ROOT is known
    compile_commands = true,
  },
}

-- ------------------------------------------------------------------- probe --

local function request(client, method, params, ms)
  local done, res, err
  local t0 = vim.uv.hrtime()
  client:request(method, params, function(e, r)
    err, res, done = e, r, true
  end)
  vim.wait(ms or 10000, function()
    return done
  end, 20)
  return res, err, (vim.uv.hrtime() - t0) / 1e6
end

--- Classify what a server puts in `CallHierarchyItem.range` for the *caller*.
--- The spec says "the range enclosing this symbol ... e.g. comments and code",
--- which reads as the whole function. Servers disagree; §7.4 depends on not
--- believing any of them.
local function range_shape(call)
  local r, s = call.from.range, call.from.selectionRange
  if
    r.start.line == s.start.line
    and r.start.character == s.start.character
    and r["end"].line == s["end"].line
    and r["end"].character == s["end"].character
  then
    return "name only (== selectionRange)"
  end
  if r["end"].line > r.start.line then
    return "full body"
  end
  return "declaration line"
end

local function locate(buf, pat, sym)
  for i, line in ipairs(vim.api.nvim_buf_get_lines(buf, 0, -1, false)) do
    if line:find(pat) then
      return i - 1, (line:find(sym, 1, true) or 1) - 1
    end
  end
end

local function consumers(client, buf, row, col)
  local pos = {
    textDocument = vim.lsp.util.make_text_document_params(buf),
    position = { line = row, character = col },
  }
  local r = { callers = 0, sites = 0, refs = 0, shape = "-", prepare_ms = 0, incoming_ms = 0, refs_ms = 0 }

  local prep, perr, pdt = request(client, "textDocument/prepareCallHierarchy", pos)
  r.prepare_ms = pdt
  r.prepare_err = perr and (perr.message or vim.inspect(perr)) or nil
  r.prepare_code = perr and perr.code or nil
  if prep and prep[1] then
    local inc, _, idt = request(client, "callHierarchy/incomingCalls", { item = prep[1] })
    r.incoming_ms = idt
    r.callers = inc and #inc or 0
    for _, call in ipairs(inc or {}) do
      r.sites = r.sites + #(call.fromRanges or {})
      r.shape = range_shape(call)
    end
  end

  local refs, _, rdt = request(
    client,
    "textDocument/references",
    vim.tbl_extend("force", pos, { context = { includeDeclaration = false } })
  )
  r.refs_ms = rdt
  r.refs = refs and #refs or 0
  return r
end

local ROWS = {}

for _, case in ipairs(CASES) do
  local cmd = case.cmd()
  out("\n========== %s ==========", case.name)
  if not cmd then
    out("  not installed — skipped")
    ROWS[#ROWS + 1] = { case.name, "not installed", "-", "-", "-", "-" }
    goto continue
  end

  for rel, lines in pairs(case.files) do
    write(rel, lines)
  end
  local root = vim.fs.joinpath(ROOT, case.dir)
  if case.compile_commands then
    local entries = {}
    for _, f in ipairs({ "lib.c", "main.c" }) do
      entries[#entries + 1] =
        string.format('{"directory":%s,"command":"cc -c %s","file":%s}', vim.json.encode(root), f, vim.json.encode(f))
    end
    write(case.dir .. "/compile_commands.json", { "[" .. table.concat(entries, ",") .. "]" })
  end

  local id = vim.lsp.start({ name = case.name, cmd = cmd, root_dir = root }, { attach = false })
  if not id then
    out("  failed to start — skipped")
    goto continue
  end

  local bufs = {}
  for _, rel in ipairs({ case.target, case.caller }) do
    local b = vim.fn.bufadd(vim.fs.joinpath(ROOT, rel))
    vim.fn.bufload(b)
    vim.lsp.buf_attach_client(b, id)
    bufs[rel] = b
  end

  local client = vim.lsp.get_client_by_id(id)
  vim.wait(20000, function()
    return client.initialized
  end, 50)
  vim.wait(4000) -- indexing; clangd's background index is the slow one

  local caps = client.server_capabilities or {}
  out("  offset_encoding      %s", client.offset_encoding)
  out("  callHierarchyProvider %s", vim.inspect(caps.callHierarchyProvider))
  out("  referencesProvider    %s", vim.inspect(caps.referencesProvider))

  local tbuf = bufs[case.target]
  local row, col = locate(tbuf, case.pat, case.sym)
  if not row then
    out("  could not locate %s — skipped", case.sym)
    goto stop
  end

  do
    local before = consumers(client, tbuf, row, col)
    if before.prepare_err then
      out("  prepareCallHierarchy  ERROR %s %q", tostring(before.prepare_code), before.prepare_err)
    else
      out("  prepareCallHierarchy  %.0f ms", before.prepare_ms)
      out(
        "  incomingCalls         %.0f ms  callers=%d call-sites=%d  from.range = %s",
        before.incoming_ms,
        before.callers,
        before.sites,
        before.shape
      )
    end
    out("  references            %.0f ms  n=%d", before.refs_ms, before.refs)

    -- unsaved-buffer test: a second caller that exists only in the buffer
    vim.api.nvim_buf_set_lines(bufs[case.caller], -1, -1, false, case.append)
    vim.wait(3000)
    local after = consumers(client, tbuf, row, col)
    out(
      "  after unsaved edit    callers %d -> %d, references %d -> %d  (disk unchanged)",
      before.callers,
      after.callers,
      before.refs,
      after.refs
    )

    ROWS[#ROWS + 1] = {
      case.name,
      before.prepare_err and ("**" .. tostring(before.prepare_code) .. "**")
        or string.format("%.0f + %.0f ms", before.prepare_ms, before.incoming_ms),
      before.prepare_err and "-" or before.shape,
      string.format("%.0f ms", before.refs_ms),
      string.format("%d", before.refs),
      (after.refs > before.refs or after.callers > before.callers) and "yes" or "no",
    }
  end

  ::stop::
  client:stop(true)
  vim.wait(1000)
  ::continue::
end

out("\n\n| Server | prepare + incomingCalls | `from.range` | references | refs | sees unsaved caller |")
out("| --- | --- | --- | --- | --- | --- |")
for _, r in ipairs(ROWS) do
  out("| `%s` | %s | %s | %s | %s | %s |", unpack(r))
end
out("")

vim.cmd("qa!")
