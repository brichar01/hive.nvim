---@class Hive.Config
---@field base_url string
---@field model string
---@field timeout integer
---@field headers table<string, string>
local M = {}

-- Hard-coded defaults. The target is a local, unauthenticated OpenAI-compatible
-- server, so there is no API key and no per-request header negotiation.
---@class Hive.DefaultOptions
local defaults = {
  base_url = "http://localhost:8080",
  model = "default",
  timeout = 60000, -- ms, passed to curl --max-time and vim.system
  headers = {
    ["Content-Type"] = "application/json",
    ["Accept"] = "application/json",
  },
}

-- Access config values directly: Config.base_url
local config = vim.deepcopy(defaults)

-- Created at module load — always available
M.augroup = vim.api.nvim_create_augroup("hive", { clear = true })
M.ns = vim.api.nvim_create_namespace("hive")

setmetatable(M, {
  __index = function(_, key)
    return config[key]
  end,
})

---Return a copy of the hard-coded defaults
---@return Hive.DefaultOptions
function M.defaults()
  return vim.deepcopy(defaults)
end

---Extend the default options table with the user options
---@param opts? Hive.UserOptions plugin options
function M.setup(opts)
  config = vim.tbl_deep_extend("force", {}, vim.deepcopy(defaults), opts or {})

  local Util = require("hive.util")

  local ok, err = pcall(function()
    vim.validate("base_url", config.base_url, "string")
    vim.validate("model", config.model, "string")
    vim.validate("timeout", config.timeout, "number")
    vim.validate("headers", config.headers, "table")
  end)

  if not ok then
    Util.error("Invalid options: " .. tostring(err))
    config = vim.deepcopy(defaults)
    return
  end

  -- A trailing slash would produce "http://host//v1/completions"
  config.base_url = (config.base_url:gsub("/+$", ""))
end

return M
