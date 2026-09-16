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
    return
  end

  vim.health.ok(
    ("options are valid (base_url = %s, model = %s, timeout = %ds)"):format(
      Config.base_url,
      Config.model,
      Config.timeout
    )
  )
end

---Report how the server is addressed and what protects the connection
local function check_endpoint()
  local Config = require("hive.config")
  local Curl = require("hive.curl")

  local scheme, host = Config.base_url:match("^(%a[%w+.-]*)://([^/:]+)")
  if not scheme then
    vim.health.error(("base_url is not a URL: %s"):format(Config.base_url))
    return
  end

  local loopback = host == "localhost" or host == "127.0.0.1" or host == "::1"
  local token = Config.resolve_api_key()

  if loopback then
    vim.health.ok(("server is on this machine (%s)"):format(host))
  elseif scheme == "https" then
    vim.health.ok(("server is remote (%s) over verified TLS"):format(host))
  else
    vim.health.warn(
      ("%s is remote and the connection is plaintext"):format(host),
      "Prompts carry your source code. Use https://, or keep the server on a trusted segment."
    )
  end

  if not token then
    vim.health.info("no API key configured — requests are unauthenticated")
    return
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

---Check that the configured server answers, and that it serves the configured model
local function check_server()
  local Config = require("hive.config")
  local Api = require("hive.api")

  local err, models = Api.models(5)
  if err then
    vim.health.warn(
      ("server at %s is not reachable: %s"):format(Config.base_url, err),
      "Start the OpenAI-compatible server, or point base_url at a running one."
    )
    return
  end
  ---@cast models string[]

  vim.health.ok(("server at %s is reachable"):format(Config.base_url))

  if #models == 0 then
    vim.health.info("server advertises no models on /v1/models — cannot verify `model`")
    return
  end

  if vim.tbl_contains(models, Config.model) then
    vim.health.ok(("server serves the configured model (%s)"):format(Config.model))
    return
  end

  -- The default `model` is a placeholder, and every server names its models
  -- differently. Moving the server is exactly when this drifts, and the
  -- symptom without this check is an HTTP 400 at request time.
  vim.health.error(
    ("server does not serve the configured model (%s)"):format(Config.model),
    ("Available: %s"):format(table.concat(models, ", "))
  )
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
    check_endpoint()
    check_server()
  end
end

return M
