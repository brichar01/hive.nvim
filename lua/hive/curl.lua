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

---@class Hive.Curl.Request
---@field url string full request URL
---@field method? string HTTP verb (default "GET")
---@field headers? table<string, string> request headers, placed on the argv
---@field body? string raw request body, sent on curl's stdin
---@field timeout? integer milliseconds for the whole request (default 60000)
---@field connect_timeout? integer milliseconds allowed for the connect alone
---@field cacert? string path to a CA bundle for a privately-signed server
---@field insecure? boolean skip TLS verification entirely
---@field secrets? table<string, string> env var name -> value, exported to curl only
---@field expand_headers? table<string, string> header name -> template referencing `{{VAR}}`

---@class Hive.Curl.Response
---@field status integer HTTP status code
---@field body string raw response body

---Parsed `curl --version`, resolved once per session.
---@type integer[]|nil
local version

---Return curl's version as `{ major, minor, patch }`, or nil if it cannot be read
---@return integer[]|nil
function M.version()
  if version then
    return version
  end
  if vim.fn.executable("curl") ~= 1 then
    return nil
  end

  local ok, out = pcall(function()
    return vim.system({ "curl", "--version" }, { text = true }):wait()
  end)
  if not ok or out.code ~= 0 then
    return nil
  end

  local major, minor, patch = (out.stdout or ""):match("curl%s+(%d+)%.(%d+)%.(%d+)")
  if not major then
    return nil
  end

  version = { tonumber(major), tonumber(minor), tonumber(patch) }
  return version
end

---Whether this curl understands `--variable` / `--expand-header` (curl >= 8.3.0).
---
--- Those two options are what keep a bearer token off the process command line:
--- curl reads the value from its own environment at request time instead of it
--- being interpolated into an argv that every other process on the box can read
--- through `/proc`.
---@return boolean
function M.supports_expand()
  local v = M.version()
  if not v then
    return false
  end
  return v[1] > 8 or (v[1] == 8 and v[2] >= 3)
end

---Build the argv for a request. Exposed for testing and debugging.
---@param req Hive.Curl.Request
---@return string[] cmd argv suitable for |vim.system()|
function M.build_args(req)
  local timeout = req.timeout or 60000

  local cmd = {
    "curl",
    "--silent", -- no progress meter
    "--show-error", -- but do report errors on stderr
    "--location", -- follow redirects; curl drops auth headers across hosts
    "--request",
    req.method or "GET",
    "--url",
    req.url,
    "--max-time",
    tostring(timeout / 1000),
    "--write-out",
    MARKER .. "%{http_code}",
  }

  -- Without this, a host that drops packets rather than refusing the connection
  -- stalls for the whole --max-time. On loopback that cannot happen — nothing
  -- listening means an instant ECONNREFUSED — so it only shows up off-box.
  if req.connect_timeout then
    table.insert(cmd, "--connect-timeout")
    table.insert(cmd, tostring(req.connect_timeout / 1000))
  end

  if req.cacert then
    table.insert(cmd, "--cacert")
    table.insert(cmd, req.cacert)
  end
  if req.insecure then
    table.insert(cmd, "--insecure")
  end

  -- Sort header names so the argv is deterministic (pairs() order is not).
  local names = vim.tbl_keys(req.headers or {})
  table.sort(names)
  for _, name in ipairs(names) do
    table.insert(cmd, "--header")
    table.insert(cmd, ("%s: %s"):format(name, req.headers[name]))
  end

  -- Secrets travel as curl variables read from the environment, so the value
  -- itself never reaches the argv. `request()` puts them in curl's env.
  local vars = vim.tbl_keys(req.secrets or {})
  table.sort(vars)
  for _, var in ipairs(vars) do
    table.insert(cmd, "--variable")
    table.insert(cmd, "%" .. var)
  end

  local expanded = vim.tbl_keys(req.expand_headers or {})
  table.sort(expanded)
  for _, name in ipairs(expanded) do
    table.insert(cmd, "--expand-header")
    table.insert(cmd, ("%s: %s"):format(name, req.expand_headers[name]))
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

---Options for |vim.system()|, including the environment carrying any secrets
---@param req Hive.Curl.Request
---@return table
local function system_opts(req)
  local opts = {
    text = true,
    stdin = req.body,
    -- Give curl's own --max-time a head start so timeouts surface as exit
    -- code 28 rather than as a SIGTERM from vim.system.
    timeout = (req.timeout or 60000) + 5000,
  }

  if req.secrets and next(req.secrets) then
    -- vim.system() extends the parent environment rather than replacing it.
    opts.env = vim.deepcopy(req.secrets)
  end

  return opts
end

---Perform an HTTP request.
---
--- Asynchronous when `callback` is given (invoked via |vim.schedule()|, so it is
--- safe to touch buffers and windows from it), returning the `vim.SystemObj` as
--- a third value so a superseded request can be killed. Blocking otherwise, in
--- which case the wait is interruptible with `CTRL-C`.
---
---@param req Hive.Curl.Request
---@param callback? fun(err: string|nil, res: Hive.Curl.Response|nil)
---@return string|nil err set only in blocking mode
---@return Hive.Curl.Response|nil res set only in blocking mode
---@return vim.SystemObj|nil obj cancellation handle, set only in async mode
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
  local opts = system_opts(req)

  if callback then
    -- vim.system() throws on a bad binary or cwd, which the executable() check
    -- above does not cover. Unguarded, that throw inside a coroutine is a
    -- silent hang, so route it through the same callback as any curl failure.
    local spawned, obj = pcall(vim.system, cmd, opts, function(out)
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

    return nil, nil, obj --[[@as vim.SystemObj]]
  end

  local done, completed = false, nil
  local spawned, obj = pcall(vim.system, cmd, opts, function(out)
    completed = out
    done = true
  end)

  if not spawned then
    return ("could not run curl (%s)"):format(tostring(obj))
  end

  -- vim.wait() keeps the event loop turning, so a slow server can be abandoned
  -- with CTRL-C. `SystemObj:wait()` cannot be interrupted at all — tolerable at
  -- loopback latency, not over a network.
  local finished, reason = vim.wait(opts.timeout, function()
    return done
  end, 5)

  if not finished then
    pcall(function()
      obj:kill("sigterm")
    end)
    return reason == -2 and "request interrupted" or "operation timed out"
  end

  return handle(completed --[[@as vim.SystemCompleted]])
end

return M
