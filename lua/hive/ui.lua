--- Shows the agent conversation in the project's current workbench.

---@class Hive.Ui
local M = {}

---The workbench the running prompt streams into. A newer workbench takes over at the next prompt.
---@type integer|nil
local buf = nil

---@class Hive.Ui.Pending
---@field start integer extmark on the message's first line

---Messages waiting for their header, by role.
---@type table<string, Hive.Ui.Pending>
local pending = {}

---The line the service writes at the end of a reply, naming the prompt it answered.
local END_LINE = "^End response to (%S+)$"

---@param path string
---@return integer buf
local function load(path)
  local b = vim.fn.bufadd(path)
  vim.fn.bufload(b)
  vim.bo[b].buflisted = true
  vim.bo[b].swapfile = false
  vim.bo[b].filetype = "markdown"
  return b
end

---Load the current workbench, show it in a split unless a window in the current tab
---already shows it, and start a new paragraph at its end.
---@return integer buf
---@return string path the workbench file
function M.open()
  local path = require("hive.workbench").current()
  buf = load(path)
  pending = {}

  if vim.fn.bufwinid(buf) == -1 then
    vim.cmd("vsplit")
    vim.api.nvim_win_set_buf(0, buf)
    vim.cmd.wincmd("p")
  end

  local last = vim.api.nvim_buf_line_count(buf)
  local tail = vim.api.nvim_buf_get_lines(buf, last - 1, last, false)[1]
  if tail ~= "" then
    vim.api.nvim_buf_set_lines(buf, last, last, false, { "", "" })
  end
  return buf, path
end

---Append `text` at the end of the workbench, continuing its last line.
---@param text string
function M.append(text)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then
    M.open()
  end
  ---@cast buf integer

  -- Inserted rather than replacing the last line, so start marks on it stay put.
  local row = vim.api.nvim_buf_line_count(buf) - 1
  local col = #(vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or "")
  vim.api.nvim_buf_set_text(buf, row, col, row, col, vim.split(text, "\n", { plain = true }))

  local line = vim.api.nvim_buf_line_count(buf)
  for _, win in ipairs(vim.fn.win_findbuf(buf)) do
    vim.api.nvim_win_set_cursor(win, { line, 0 })
  end
end

---@return integer row 0-based row of the last line
---@return string tail text of the last line
local function last_line()
  ---@cast buf integer
  local row = vim.api.nvim_buf_line_count(buf) - 1
  return row, vim.api.nvim_buf_get_lines(buf, row, row + 1, false)[1] or ""
end

---Mark where the message for `role` starts. Without `row`, it starts on a new line at the end.
---@param role string
---@param row? integer 0-based row the message's text starts on
function M.mark_start(role, row)
  if not (buf and vim.api.nvim_buf_is_valid(buf)) then
    M.open()
  end
  ---@cast buf integer

  if not row then
    local tail
    row, tail = last_line()
    if tail ~= "" then
      M.append("\n")
      row = row + 1
    end
  end
  local start = vim.api.nvim_buf_set_extmark(buf, require("hive.config").ns, row, 0, { right_gravity = false })
  pending[role] = { start = start }
end

---@param mark integer|nil
---@return integer|nil row 0-based, nil once the mark is gone
local function take(mark)
  if not mark then
    return nil
  end
  ---@cast buf integer
  local ns = require("hive.config").ns
  local row = vim.api.nvim_buf_get_extmark_by_id(buf, ns, mark, {})[1]
  vim.api.nvim_buf_del_extmark(buf, ns, mark)
  return row
end

---Put `lines` above the `role` message, where it started.
---@param role string
---@param lines string[] header lines for the message
function M.header(role, lines)
  local p = pending[role]
  pending[role] = nil
  if not (p and buf and vim.api.nvim_buf_is_valid(buf)) then
    return
  end
  local start = take(p.start)
  if not start or #lines == 0 then
    return
  end
  vim.api.nvim_buf_set_lines(buf, start, start, false, lines)
end

---The current workbench's text after its last `End response to <id>` line, or all of it without one.
---@return string text trimmed
---@return integer first 0-based row of the text's first non-blank line
---@return integer last 0-based row of the text's last non-blank line
---@return string path the workbench file
function M.unanswered()
  local path = require("hive.workbench").current()
  local b = load(path)
  local lines = vim.api.nvim_buf_get_lines(b, 0, -1, false)

  local first = 1
  for i = #lines, 1, -1 do
    if lines[i]:match(END_LINE) then
      first = i + 1
      break
    end
  end
  while first <= #lines and vim.trim(lines[first]) == "" do
    first = first + 1
  end
  local last = #lines
  while last >= first and vim.trim(lines[last]) == "" do
    last = last - 1
  end

  return vim.trim(table.concat(lines, "\n", first, last)), first - 1, last - 1, path
end

return M
