--- Thin transport layer over the `curl` binary, driven by |vim.system()|.
---
--- This module knows nothing about OpenAI — it speaks HTTP and returns raw
--- status/body pairs. See `hive.api` for the endpoint bindings.

---@class Hive.Curl
local M = {}

-- curl writes the body to stdout, then `--write-out` appends this marker
-- followed by the HTTP status code. Splitting on the marker keeps the body
-- byte-exact even when it ends in newlines.
local MARKER = "\n__hive_status__:"

-- Exit codes worth translating; anything else falls back to stderr.
---@type table<integer, string>
local CURL_ERRORS = {
  [3] = "malformed URL",
  [6] = "could not resolve host",
  [7] = "failed to connect to host",
  [22] = "HTTP error returned by server",
  [28] = "operation timed out",
  [52] = "empty reply from server",
  [56] = "failure receiving network data",
}

---@class Hive.Curl.Request
---@field url string full request URL
---@field method? string HTTP verb (default "GET")
---@field headers? table<string, string> request headers
---@field body? string raw request body, sent on curl's stdin
---@field timeout? integer milliseconds before the request is aborted (default 60000)

---@class Hive.Curl.Response
---@field status integer HTTP status code
---@field body string raw response body

---Build the argv for a request. Exposed for testing and debugging.
---@param req Hive.Curl.Request
---@return string[] cmd argv suitable for |vim.system()|
function M.build_args(req)
  local timeout = req.timeout or 60000

  local cmd = {
    "curl",
    "--silent", -- no progress meter
    "--show-error", -- but do report errors on stderr
    "--location", -- follow redirects
    "--request",
    req.method or "GET",
    "--url",
    req.url,
    "--max-time",
    tostring(timeout / 1000),
    "--write-out",
    MARKER .. "%{http_code}",
  }

  -- Sort header names so the argv is deterministic (pairs() order is not).
  local names = vim.tbl_keys(req.headers or {})
  table.sort(names)
  for _, name in ipairs(names) do
    table.insert(cmd, "--header")
    table.insert(cmd, ("%s: %s"):format(name, req.headers[name]))
  end

  if req.body then
    -- Read the body from stdin: keeps large prompts off the command line.
    table.insert(cmd, "--data-binary")
    table.insert(cmd, "@-")
  end

  return cmd
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

---Perform an HTTP request.
---
--- Asynchronous when `callback` is given (invoked via |vim.schedule()|, so it is
--- safe to touch buffers and windows from it). Blocking otherwise.
---
---@param req Hive.Curl.Request
---@param callback? fun(err: string|nil, res: Hive.Curl.Response|nil)
---@return string|nil err set only in blocking mode
---@return Hive.Curl.Response|nil res set only in blocking mode
function M.request(req, callback)
  if vim.fn.executable("curl") ~= 1 then
    local err = "curl executable not found in $PATH"
    if callback then
      vim.schedule(function()
        callback(err, nil)
      end)
      return
    end
    return err
  end

  local cmd = M.build_args(req)
  local opts = {
    text = true,
    stdin = req.body,
    -- Give curl's own --max-time a head start so timeouts surface as exit
    -- code 28 rather than as a SIGTERM from vim.system.
    timeout = (req.timeout or 60000) + 5000,
  }

  if not callback then
    return handle(vim.system(cmd, opts):wait())
  end

  vim.system(cmd, opts, function(out)
    local err, res = handle(out)
    vim.schedule(function()
      callback(err, res)
    end)
  end)
end

return M
