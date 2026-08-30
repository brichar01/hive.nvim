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

local function format_header(key, value)
  -- Normalize header name to Title-Case
  local normalized = key
    :gsub("(%l)(%w*)", function(first, rest)
      return first:upper() .. rest:lower()
    end)
    :gsub("%-(%w)", function(c)
      return "-" .. c:upper()
    end)

  return normalized .. ": " .. value
end

---@class Hive.Curl.RequestBuilder
---@field url string full request URL
---@field method string HTTP verb (default "GET")
---@field headers? table<string, string> request headers, placed on the argv
---@field body? string raw request body, sent on curl's stdin
---@field timeout? integer milliseconds for the whole request (default 60000)
---@field secrets? table<string, string> env var name and heaer type, bypasses nvim
local RequestBuilder = {}
RequestBuilder.__index = RequestBuilder

---@return Hive.Curl.RequestBuilder
function RequestBuilder.new()
  local args = { ["url"] = nil, ["method"] = "GET", ["timeout"] = 60000 }
  return setmetatable(args, RequestBuilder)
end

---@return Hive.Curl.RequestBuilder
function M.new_request()
  return RequestBuilder.new()
end

-- Breakout, for appending custom flags placed at the end
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

---@param method "GET"|"POST"|"OPTIONS"
function RequestBuilder:with_method(method)
  self["method"] = method
  return self
end

---@param timeout integer
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

---@param headers table<string, string> ENV var to Header mapping
---@return Hive.Curl.RequestBuilder
function RequestBuilder:with_secrets(headers)
  if not self.secrets then
    self.secrets = {}
  end
  for k, v in pairs(headers) do
    self.headers[k] = v
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
  table.insert(args, self.timeout or 60000)

  if self.headers then
    for k, v in pairs(self.headers) do
      table.insert(args, "--header")
      table.insert(args, format_header(k, v))
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

  if self.secrets then
    for env, secret_header in self.secrets do
      table.insert(args, "--variable")
      table.insert(args, ("%%%s"):format(env))
      table.insert(args, "--expand-header")
      table.insert(args, ("%s: {{%s}}"):format(secret_header, env))
    end
  end

  local opts = {
    text = true,
    stdin = self.body == "@-" or nil,
    timeout = self.timeout + 5000,
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
