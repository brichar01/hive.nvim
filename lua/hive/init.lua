---@class Hive.Plugin
local M = {}

M.did_setup = false

---Setup the plugin. Optional — hive.nvim works with its hard-coded defaults.
---@param opts? Hive.UserOptions plugin options
function M.setup(opts)
  if M.did_setup then
    local Util = require("hive.util")
    return Util.warn("hive.nvim is already setup")
  end
  M.did_setup = true
  require("hive.config").setup(opts)
end

---Request a fill-in-the-middle completion from `POST /v1/fim/completions`.
---
--- Asynchronous when `callback` is given, blocking otherwise. See
--- `hive.api.completions` for details.
---@param prefix string text before the cursor
---@param suffix string text after the cursor, `""` when the cursor is at the end
---@param max_tokens integer maximum number of tokens to generate
---@param callback? fun(err: string|nil, completion: Hive.Completion|nil)
---@return string|nil err set only in blocking mode
---@return Hive.Completion|nil completion set only in blocking mode
---@return vim.SystemObj|nil obj cancellation handle, set only in async mode
function M.completions(prefix, suffix, max_tokens, callback)
  return require("hive.api").completions(prefix, suffix, max_tokens, callback)
end

return M
