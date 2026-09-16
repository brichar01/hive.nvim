--- Thin transport layer over the `curl` binary, driven by |vim.system()|.

---@class Hive.Curl
local M = {}

local MARKER = "\n__hive_status__:"

-- Common curl errors
---@type table<integer, string>
local CURL_ERRORS = {
  [3] = "malformed URL",
  [5] = "could not resolve proxy",
  [6] = "could not resolve host",
  [7] = "failed to connect to host",
  [22] = "HTTP error returned by server",
  [28] = "operation timed out",
  [35] = "TLS handshake failed",
  [47] = "too many redirects",
  [52] = "empty reply from server",
  [56] = "failure receiving network data",
  [60] = "TLS certificate verification failed",
  [77] = "could not read the TLS CA certificate bundle",
}

---@class Hive.Curl.RequestBuilder
---@field url string full request URL
---@field method string HTTP verb (default "GET")
---@field headers? table<string, string> request headers, placed on the argv
---@field body? string raw request body, sent on curl's stdin
---@field timeout? integer seconds for the whole request (default 30)
---@field expand_headers? table<string, string> headers curl expands from a variable, keeping the value off the argv
---@field env? table<string, string> variables placed in curl's environment, not Neovim's
local RequestBuilder = {}
RequestBuilder.__index = RequestBuilder

---@return Hive.Curl.RequestBuilder
function RequestBuilder.new()
  local args = { ["url"] = nil, ["method"] = "GET", ["timeout"] = 30 }
  return setmetatable(args, RequestBuilder)
end

---@return Hive.Curl.RequestBuilder
function M.new_request()
  return RequestBuilder.new()
end

-- Breakout, for appending custom (unintended or dangerous) options
---@param name string
---@param value string?
---@return Hive.Curl.RequestBuilder
function RequestBuilder:with_opt(name, value)
  if not self.argv then
    self.argv = {}
  end

  table.insert(self.argv, name)

  if value then
    table.insert(self.argv, value)
  end
  return self
end

---@param url string
---@return Hive.Curl.RequestBuilder
function RequestBuilder:with_url(url)
  self.url = url
  return self
end

---@param method "GET"|"POST"|"OPTIONS"
function RequestBuilder:with_method(method)
  self["method"] = method
  return self
end

---@param timeout integer seconds for the whole request
function RequestBuilder:with_timeout(timeout)
  self["timeout"] = timeout
  return self
end

---@param headers table<string, string>
---@return Hive.Curl.RequestBuilder
function RequestBuilder:with_headers(headers)
  if not self.headers then
    self.headers = {}
  end
  for k, v in pairs(headers) do
    self.headers[k] = v
  end
  return self
end

---@param env table<string, string> variable name to value
---@return Hive.Curl.RequestBuilder
function RequestBuilder:with_env(env)
  if not self.env then
    self.env = {}
  end
  for k, v in pairs(env) do
    self.env[k] = v
  end
  return self
end

--- Headers whose value curl assembles itself from `{{NAME}}` references to the
--- variables set by `with_env`. Needs curl 8.3.0 or newer; older curl has no
--- way to indirect and the header has to go through `with_headers` instead.
---@param headers table<string, string> header name to value, `{{NAME}}` naming a `with_env` variable
---@return Hive.Curl.RequestBuilder
function RequestBuilder:with_expand_headers(headers)
  if not self.expand_headers then
    self.expand_headers = {}
  end
  for k, v in pairs(headers) do
    self.expand_headers[k] = v
  end
  return self
end

---@param body string? body data/source, nil = pipe from stdin
---@return Hive.Curl.RequestBuilder
function RequestBuilder:with_body(body)
  self["body"] = body or "@-"
  return self
end

---@class Hive.Curl.Request
---@field args string[]
---@field opts table<string, string>

---@return Hive.Curl.Request|nil
function RequestBuilder:build()
  if not self.url then
    error("No url supplied!!")
    return nil
  end

  local args = { "curl", "-sSL" }
  table.insert(args, "--write-out")
  table.insert(args, MARKER .. "%{http_code}")

  table.insert(args, "--request")
  table.insert(args, self.method)

  table.insert(args, "--url")
  table.insert(args, self.url)

  table.insert(args, "--max-time")
  table.insert(args, self.timeout or 30)

  if self.headers then
    for k, v in pairs(self.headers) do
      table.insert(args, "--header")
      table.insert(args, ("%s: %s"):format(k, v))
    end
  end

  if self.argv then
    for _, v in ipairs(self.argv) do
      table.insert(args, v)
    end
  end

  if self.body then
    table.insert(args, "--data-binary")
    table.insert(args, self.body)
  end

  if self.env then
    for name in pairs(self.env) do
      table.insert(args, "--variable")
      table.insert(args, ("%%%s"):format(name))
    end
  end

  if self.expand_headers then
    for k, v in pairs(self.expand_headers) do
      table.insert(args, "--expand-header")
      table.insert(args, ("%s: %s"):format(k, v))
    end
  end

  -- The only millisecond in the module: |vim.system()| takes one, and it is a
  -- kill switch behind curl's own `--max-time`, not a second deadline. Five
  -- seconds of slack leave curl to fail on its own terms and report why.
  local opts = {
    text = true,
    stdin = self.body == "@-" or nil,
    timeout = (self.timeout + 5) * 1000,
    env = self.env,
  }

  return { args = args, opts = opts }
end

---Split curl's stdout into body and status code
---@param stdout string
---@return integer status
---@return string body
local function split_output(stdout)
  local at = stdout:find(MARKER, 1, true)
  if not at then
    return 0, stdout
  end

  local body = stdout:sub(1, at - 1)
  local status = tonumber(stdout:sub(at + #MARKER)) or 0
  return status, body
end

---Turn a completed |vim.system()| run into a response or an error string
---@param out vim.SystemCompleted
---@return string|nil err
---@return Hive.Curl.Response|nil res
local function handle(out)
  if out.code ~= 0 then
    local reason = CURL_ERRORS[out.code]
      or (out.signal ~= 0 and ("curl killed by signal " .. out.signal))
      or ("curl exited with code " .. out.code)
    local stderr = vim.trim(out.stderr or "")
    return stderr ~= "" and ("%s (%s)"):format(reason, stderr) or reason
  end

  local status, body = split_output(out.stdout or "")
  if status == 0 then
    return "no HTTP status in curl output"
  end

  return nil, { status = status, body = body }
end

---@class Hive.Curl.Response
---@field status integer HTTP status code
---@field body string raw response body

---Perform an async HTTP request.
---@param req Hive.Curl.Request
---@param callback fun(err: string|nil, res: Hive.Curl.Response|nil)
---@return vim.SystemObj|nil obj cancellation handle
function M.request(req, callback)
  if vim.fn.executable("curl") ~= 1 then
    local err = "curl executable not found in $PATH"
    vim.schedule(function()
      callback(err, nil)
    end)
    return
  end

  local spawned, obj = pcall(vim.system, req.args, req.opts, function(out)
    local err, res = handle(out)
    vim.schedule(function()
      callback(err, res)
    end)
  end)

  if not spawned then
    vim.schedule(function()
      callback(("could not run curl (%s)"):format(tostring(obj)), nil)
    end)
    return
  end

  return obj --[[@as vim.SystemObj]]
end

return M
