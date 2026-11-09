--- Buffer, window and cursor entry points for the MCP server's tools.
---
--- The server calls these through |nvim_exec_lua()|. Lines are 1-based and
--- inclusive, columns are 0-based bytes, the same as |nvim_win_get_cursor()|.
--- Nothing here writes to disk.

---@class Hive.Mcp
local M = {}

local Fs = require("hive.fs")

---@class Hive.Mcp.Buffer
---@field buf integer
---@field path string
---@field modified boolean
---@field line_count integer

---@class Hive.Mcp.Cursor: Hive.Mcp.Buffer
---@field line integer
---@field col integer

---@param buf integer
---@return Hive.Mcp.Buffer
local function describe(buf)
  return {
    buf = buf,
    path = vim.api.nvim_buf_get_name(buf),
    modified = vim.bo[buf].modified,
    line_count = vim.api.nvim_buf_line_count(buf),
  }
end

---@param path string absolute path
---@return integer buf the buffer for `path`, loaded from disk when there is none
local function ensure(path)
  return Fs.find(path) or Fs.open(path)
end

---@param path string absolute path
---@return integer buf
local function find(path)
  local buf = Fs.find(path)
  if not buf then
    error(("no loaded buffer for %s"):format(path), 0)
  end
  return buf
end

---@param path string absolute path
---@return string[] lines
local function disk_lines(path)
  if vim.fn.filereadable(path) ~= 1 then
    error(("%s has no buffer and is not a readable file"):format(path), 0)
  end
  local lines = vim.fn.readfile(path)
  if #lines > 0 and vim.iter(lines):all(function(line)
    return line:sub(-1) == "\r"
  end) then
    lines = vim.tbl_map(function(line)
      return line:sub(1, -2)
    end, lines)
  end
  return lines
end

-- -------------------------------------------- Entry points for the server --------------------------------------------

---Read lines `first` to `last` of `path`, from its buffer when one is loaded and from disk otherwise.
---@param path string absolute path
---@param range {first?: integer, last?: integer}
---@return {first: integer, lines: string[], total: integer, source: "buffer"|"disk"}
function M.read(path, range)
  local buf = Fs.find(path)
  local all = buf and vim.api.nvim_buf_get_lines(buf, 0, -1, true) or disk_lines(path)
  local total = #all
  local first = range.first or 1
  local last = math.min(range.last or total, total)
  if first < 1 or first > total + 1 then
    error(("start %d is outside 1-%d"):format(first, total + 1), 0)
  end
  return {
    first = first,
    lines = vim.list_slice(all, first, last),
    total = total,
    source = buf and "buffer" or "disk",
  }
end

---Replace lines `first` to `last` of the buffer for `path` with `lines`. `last = first - 1` inserts before `first`.
---@param path string absolute path
---@param first integer
---@param last integer
---@param lines string[]
---@return Hive.Mcp.Buffer
function M.edit(path, first, last, lines)
  local buf = ensure(path)
  local total = vim.api.nvim_buf_line_count(buf)
  if first < 1 or first > total + 1 then
    error(("start %d is outside 1-%d"):format(first, total + 1), 0)
  end
  if last < first - 1 or last > total then
    error(("end %d is outside %d-%d"):format(last, first - 1, total), 0)
  end
  if not vim.bo[buf].modifiable then
    error(("buffer %d is not modifiable"):format(buf), 0)
  end
  vim.api.nvim_buf_set_lines(buf, first - 1, last, true, lines)
  return describe(buf)
end

---Load `path` into a listed buffer, and show it in the current window when `focus` is set.
---@param path string absolute path
---@param focus boolean
---@return Hive.Mcp.Buffer
function M.open(path, focus)
  local buf = ensure(path)
  if focus then
    vim.api.nvim_set_current_buf(buf)
  end
  return describe(buf)
end

---@return Hive.Mcp.Buffer
function M.active()
  return describe(vim.api.nvim_get_current_buf())
end

---Show the loaded buffer for `path` in the current window.
---@param path string absolute path
---@return Hive.Mcp.Buffer
function M.set_active(path)
  vim.api.nvim_set_current_buf(find(path))
  return M.active()
end

---@return Hive.Mcp.Cursor
function M.cursor()
  local pos = vim.api.nvim_win_get_cursor(0)
  local cursor = M.active() --[[@as Hive.Mcp.Cursor]]
  cursor.line, cursor.col = pos[1], pos[2]
  return cursor
end

---Move the current window's cursor, after making the buffer for `path` active when one is given.
---@param line integer
---@param col integer
---@param path string|nil absolute path
---@return Hive.Mcp.Cursor
function M.set_cursor(line, col, path)
  if path then
    M.set_active(path)
  end
  vim.api.nvim_win_set_cursor(0, { line, col })
  return M.cursor()
end

return M
