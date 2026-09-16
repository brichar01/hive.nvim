---@class Hive.Config
---@field base_url string
---@field model string
---@field timeout integer
---@field headers table<string, string>
---@field api_key string|fun(): string|nil
---@field api_key_env string
local M = {}

-- Hard-coded defaults. The target is an OpenAI-compatible server, local by
-- default but not necessarily on this machine: every option below that is not
-- `base_url` exists because pointing it at another host changes what can go
-- wrong. See IMPLEMENTATION.md §9.6.
---@class Hive.DefaultOptions
local defaults = {
  base_url = "http://localhost:8080",
  model = "default",
  timeout = 30, -- seconds, the whole request

  headers = {
    ["Content-Type"] = "application/json",
    ["Accept"] = "application/json",
  },

  -- Bearer token. nil sends no Authorization header at all, which is right for
  -- an unauthenticated server on a trusted segment. A literal string here ends
  -- up in your dotfiles; prefer leaving it nil and exporting `api_key_env`, or
  -- pass a function that reads a wallet -- `resolve_api_key` calls it once and
  -- memoises the answer, so a blocking lookup costs one round trip per session.
  ---@type string|fun(): string|nil
  api_key = nil,
  api_key_env = "HIVE_API_KEY",
}

-- Access config values directly: Config.base_url
local config = vim.deepcopy(defaults)

-- Memoised result of an `api_key` function. A keyring lookup is a blocking IPC
-- round trip and `resolve_api_key` runs once per request, so it is asked once
-- and the answer kept until the next `setup()`. Only a usable token is cached:
-- a lookup that came back empty because the wallet was still locked is retried
-- rather than turned into a session-long absence.
---@type string|nil
local cached_key = nil

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

---Resolve the bearer token from the config value or the environment.
---@return string|nil token
---@return "config"|"env"|nil source where the token came from
function M.resolve_api_key()
  local key = config.api_key
  if type(key) == "function" then
    if cached_key then
      return cached_key, "config"
    end
    key = key() or ""
    if type(key) == "string" and key ~= "" then
      cached_key = key
    end
  end
  if type(key) == "string" and key ~= "" then
    return key, "config"
  end

  local value = vim.env[config.api_key_env]
  if type(value) == "string" and value ~= "" then
    return value, "env"
  end

  return nil
end

---Extend the default options table with the user options
---@param opts? Hive.UserOptions plugin options
function M.setup(opts)
  config = vim.tbl_deep_extend("force", {}, vim.deepcopy(defaults), opts or {})
  cached_key = nil

  local Util = require("hive.util")

  local ok, err = pcall(function()
    vim.validate("base_url", config.base_url, "string")
    vim.validate("model", config.model, "string")
    vim.validate("timeout", config.timeout, "number")
    vim.validate("headers", config.headers, "table")
    vim.validate("api_key", config.api_key, { "string", "function" }, true)
    vim.validate("api_key_env", config.api_key_env, "string")

    if config.base_url == "" then
      error("base_url must not be empty")
    end
    if config.timeout < 1 then
      error("timeout must be at least 1 second")
    end
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
