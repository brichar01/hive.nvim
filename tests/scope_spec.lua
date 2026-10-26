---@module 'luassert'

local scope = require("hive.context.scope")

--- @param ft string
---
--- @param lines string[]
---
--- @return integer buf with `lines` and its tree refreshed
local function buffer(ft, lines)
  local buf = vim.api.nvim_create_buf(false, true)
  vim.api.nvim_buf_set_lines(buf, 0, -1, false, lines)
  vim.bo[buf].filetype = ft
  scope.refresh(buf)
  return buf
end

--- @param buf integer
---
--- @param row integer 1-indexed
---
--- @param col integer 0-indexed
---
--- @return string[]
local function names(buf, row, col)
  return vim.tbl_map(function(link)
    return link.name
  end, scope.chain(buf, { row, col }))
end

--- Skip with a warning when the grammar is not installed, since only Lua and C ship with Neovim.
---
--- @param lang string
local function require_parser(lang)
  local ok, added = pcall(vim.treesitter.language.add, lang)
  if not (ok and added) then
    vim.notify(("scope_spec: no %s parser, skipping"):format(lang), vim.log.levels.WARN)
    MiniTest.skip(("no %s parser"):format(lang))
  end
end

describe("scope.chain", function()
  it("names a dotted Lua function and skips an anonymous one", function()
    local buf = buffer("lua", {
      "local M = {}",
      "function M.outer()",
      "  local t = {",
      "    inner = function()",
      "      return 1",
      "    end,",
      "  }",
      "end",
      "local function helper() end",
      "return M",
    })
    assert.are.same({ "M.outer" }, names(buf, 5, 6))
    assert.are.same({ "helper" }, names(buf, 9, 0))
    assert.are.same({}, names(buf, 1, 0))
  end)

  it("reads C names through nested declarators", function()
    local buf = buffer("c", {
      "struct point { int x; };",
      "static int *make(int n) {",
      "  return 0;",
      "}",
      "typedef struct { int y; } pair;",
    })
    assert.are.same({ "point" }, names(buf, 1, 15))
    assert.are.same({ "make" }, names(buf, 3, 2))
    assert.are.same({ "pair" }, names(buf, 5, 17))
  end)

  it("names a decorated Python method once", function()
    require_parser("python")
    local buf = buffer("python", {
      "class Foo:",
      "    @staticmethod",
      "    def bar():",
      "        return 1",
    })
    assert.are.same({ "Foo", "bar" }, names(buf, 4, 8))
  end)

  it("names a Rust impl by its type inside a module", function()
    require_parser("rust")
    local buf = buffer("rust", {
      "mod m {",
      "    impl<T> Foo<T> {",
      "        fn bar() {}",
      "    }",
      "}",
    })
    assert.are.same({ "m", "Foo", "bar" }, names(buf, 3, 18))
  end)

  it("names an exported TypeScript class once", function()
    require_parser("typescript")
    local buf = buffer("typescript", {
      "export class A {",
      "  m() {",
      "    const f = () => 1;",
      "  }",
      "}",
    })
    assert.are.same({ "A", "m" }, names(buf, 3, 20))
  end)

  it("is empty for a buffer with no cached tree", function()
    local buf = vim.api.nvim_create_buf(false, true)
    vim.api.nvim_buf_set_lines(buf, 0, -1, false, { "local x = 1" })
    assert.are.same({}, scope.chain(buf, { 1, 0 }))
  end)

  it("keeps the cached ranges until the next refresh", function()
    local buf = buffer("lua", { "local function a()", "  return 1", "end" })
    vim.api.nvim_buf_set_lines(buf, 0, 0, false, { "", "", "" })
    assert.are.same({}, names(buf, 5, 2))
    scope.refresh(buf)
    assert.are.same({ "a" }, names(buf, 5, 2))
  end)
end)
