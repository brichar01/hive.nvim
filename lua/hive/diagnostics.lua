--- LSP diagnostics for the agent's `write` and `edit` results.
---
--- Language servers check the buffer, so the agent sees problems in its unsaved
--- changes. The service calls `collect` through |nvim_exec_lua()|.

---@class Hive.Diagnostics
local M = {}

local fs = require("hive.fs")

local timeout_ms = 2000

---@class Hive.Diagnostic
---@field line integer 1-based
---@field col integer 1-based
---@field severity "error"|"warning"
---@field message string
---@field source string|nil

---@type table<integer, integer> each buffer's `changedtick` at its last DiagnosticChanged
local checked = {}

local group = vim.api.nvim_create_augroup("hive.diagnostics", { clear = true })

vim.api.nvim_create_autocmd("DiagnosticChanged", {
  group = group,
  callback = function(args)
    if vim.api.nvim_buf_is_valid(args.buf) then
      checked[args.buf] = vim.b[args.buf].changedtick
    end
  end,
})

vim.api.nvim_create_autocmd("BufWipeout", {
  group = group,
  callback = function(args)
    checked[args.buf] = nil
  end,
})

---Errors and warnings for the buffer serving `path`, once its diagnostics cover the current text.
---
--- Waits up to `timeout_ms` for a DiagnosticChanged at the buffer's current
--- `changedtick`, then returns what the buffer has.
---@param path string absolute path
---@return Hive.Diagnostic[]|nil diagnostics nil when no buffer serves `path` or no language server is attached
function M.collect(path)
  local buf = fs.find(path)
  if not buf or #vim.lsp.get_clients({ bufnr = buf }) == 0 then
    return nil
  end

  local tick = vim.b[buf].changedtick
  vim.wait(timeout_ms, function()
    return (checked[buf] or -1) >= tick
  end, 20)

  local severity = vim.diagnostic.severity
  ---@type Hive.Diagnostic[]
  local out = {}
  for _, d in ipairs(vim.diagnostic.get(buf, { severity = { min = severity.WARN } })) do
    out[#out + 1] = {
      line = d.lnum + 1,
      col = d.col + 1,
      severity = d.severity == severity.ERROR and "error" or "warning",
      message = d.message,
      source = d.source,
    }
  end
  table.sort(out, function(a, b)
    return a.line < b.line or (a.line == b.line and a.col < b.col)
  end)
  return out
end

return M
