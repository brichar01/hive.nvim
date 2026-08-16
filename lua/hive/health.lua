---@class Hive.Health
local M = {}

---Validate that config values have the expected types
local function check_config()
  local Config = require("hive.config")

  local ok, err = pcall(function()
    vim.validate("base_url", Config.base_url, "string")
    vim.validate("model", Config.model, "string")
    vim.validate("timeout", Config.timeout, "number")
    vim.validate("headers", Config.headers, "table")
  end)

  if not ok then
    vim.health.error("Invalid options: " .. tostring(err))
  else
    vim.health.ok(("options are valid (base_url = %s, model = %s)"):format(Config.base_url, Config.model))
  end
end

---Check that curl is available
---@return boolean
local function check_curl()
  if vim.fn.executable("curl") ~= 1 then
    vim.health.error("curl not found in $PATH", "Install curl — hive.nvim shells out to it for every request.")
    return false
  end

  local out = vim.system({ "curl", "--version" }, { text = true }):wait()
  local version = vim.split(out.stdout or "", "\n")[1]
  vim.health.ok("curl found: " .. (version ~= "" and version or "unknown version"))
  return true
end

---Check that the configured server answers
local function check_server()
  local Config = require("hive.config")
  local Curl = require("hive.curl")

  local err, res = Curl.request({ url = Config.base_url .. "/v1/models", timeout = 2000 })
  if err then
    vim.health.warn(
      ("server at %s is not reachable: %s"):format(Config.base_url, err),
      "Start the OpenAI-compatible server, or point base_url at a running one."
    )
  elseif res and res.status >= 500 then
    vim.health.warn(("server at %s responded with HTTP %d"):format(Config.base_url, res.status))
  else
    vim.health.ok(("server at %s is reachable (HTTP %d)"):format(Config.base_url, res and res.status or 0))
  end
end

---Health check called by `:checkhealth hive`
function M.check()
  vim.health.start("hive.nvim")

  if require("hive").did_setup then
    vim.health.ok("setup() was called")
  else
    -- setup() is optional: the defaults are hard-coded and always usable.
    vim.health.info("setup() was not called — using hard-coded defaults")
  end

  check_config()
  if check_curl() then
    check_server()
  end
end

return M
