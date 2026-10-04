---@class Hive.Config
---@field base_url string
---@field model string
---@field timeout integer
---@field headers table<string, string>
---@field api_key string|fun(): string|nil
---@field api_key_env string
---@field agent Hive.AgentOptions
local M = {}

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
  -- pass a function that reads a wallet.
  ---@type string|fun(): string|nil
  api_key = nil,
  api_key_env = "HIVE_API_KEY",

  -- `:Hive` runs on Pi's built-in Mistral provider, independent of the options above.
  agent = {
    model = "codestral-latest",
    -- Pi's default. Pi clamps it to what the model supports, so a model without reasoning runs at "off".
    thinking = "medium",
    -- `read_disk` and `write_disk` are Pi's own read and write, which skip Neovim's buffers.
    tools = { "read", "write", "edit", "bash", "grep", "find", "ls" },
    ---@type string|fun(): string|nil
    api_key = nil,
    api_key_env = "MISTRAL_API_KEY",
  },
}

-- Matches `THINKING_LEVELS` in node/src/session.ts.
M.thinking_levels = { "off", "minimal", "low", "medium", "high", "xhigh", "max" }

-- Matches `TOOLS` in node/src/session.ts.
M.tools = { "read", "write", "edit", "bash", "grep", "find", "ls", "read_disk", "write_disk" }

---@param tools string[]
---@return string|nil err for a name not in `M.tools`
function M.check_tools(tools)
  for _, tool in ipairs(tools) do
    if not vim.list_contains(M.tools, tool) then
      return ("unknown tool %s, expected some of %s"):format(tool, table.concat(M.tools, ", "))
    end
  end
end

-- Access config values directly: Config.base_url
local config = vim.deepcopy(defaults)

---@type table<string, string>
local cached_keys = {}

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

---@param slot string cache key for a function-valued `key`
---@param key string|fun(): string|nil
---@param env string environment variable read when `key` gives nothing
---@return string|nil token
local function resolve(slot, key, env)
  if type(key) == "function" then
    if cached_keys[slot] then
      return cached_keys[slot]
    end
    key = key() or ""
    if type(key) == "string" and key ~= "" then
      cached_keys[slot] = key
    end
  end
  if type(key) == "string" and key ~= "" then
    return key
  end

  local value = vim.env[env]
  if type(value) == "string" and value ~= "" then
    return value
  end

  return nil
end

---Resolve the bearer token from the config value or the environment.
---@return string|nil token
function M.resolve_api_key()
  return resolve("bare", config.api_key, config.api_key_env)
end

---Resolve the agent's Mistral key from `agent.api_key` or the environment.
---@return string|nil token
function M.resolve_agent_api_key()
  return resolve("agent", config.agent.api_key, config.agent.api_key_env)
end

---Extend the default options table with the user options
---@param opts? Hive.UserOptions plugin options
function M.setup(opts)
  config = vim.tbl_deep_extend("force", {}, vim.deepcopy(defaults), opts or {})
  cached_keys = {}

  local Util = require("hive.util")

  local ok, err = pcall(function()
    vim.validate("base_url", config.base_url, "string")
    vim.validate("model", config.model, "string")
    vim.validate("timeout", config.timeout, "number")
    vim.validate("headers", config.headers, "table")
    vim.validate("api_key", config.api_key, { "string", "function" }, true)
    vim.validate("api_key_env", config.api_key_env, "string")
    vim.validate("agent", config.agent, "table")
    vim.validate("agent.model", config.agent.model, "string")
    vim.validate("agent.thinking", config.agent.thinking, function(level)
      return vim.list_contains(M.thinking_levels, level)
    end, table.concat(M.thinking_levels, "|"))
    vim.validate("agent.tools", config.agent.tools, function(tools)
      return vim.islist(tools) and M.check_tools(tools) == nil
    end, "list of " .. table.concat(M.tools, "|"))
    vim.validate("agent.api_key", config.agent.api_key, { "string", "function" }, true)
    vim.validate("agent.api_key_env", config.agent.api_key_env, "string")

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
