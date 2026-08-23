--- OpenAI-compatible endpoint bindings.
---
--- Only `/v1/completions` is implemented. Headers, model, credentials and base
--- URL come from `hive.config`; callers supply nothing but the prompt and a
--- token budget.

---@class Hive.Api
local M = {}

-- The curl variable a bearer token is passed through. Any name works; it exists
-- so the token reaches curl via the environment instead of the argv.
local TOKEN_VAR = "HIVE_TOKEN"

---@class Hive.Completion
---@field text string the generated text
---@field finish_reason string|nil why generation stopped ("stop", "length", ...)
---@field usage table|nil token accounting reported by the server
---@field raw table the decoded response body, verbatim

---Decode a JSON payload, tolerating garbage from a misbehaving server
---@param body string
---@return table|nil decoded
local function decode(body)
  local ok, value = pcall(vim.json.decode, body, { luanil = { object = true, array = true } })
  return (ok and type(value) == "table") and value or nil
end

---Pull the most useful error message out of a non-2xx response
---@param status integer
---@param body string
---@return string
local function error_message(status, body)
  local decoded = decode(body)
  local message = decoded and decoded.error and decoded.error.message
  if type(message) ~= "string" then
    message = vim.trim(body)
  end
  if message == "" then
    return ("HTTP %d"):format(status)
  end
  return ("HTTP %d: %s"):format(status, message)
end

---Build the fields every request shares: credentials, TLS and the timeouts.
---
--- Exposed so `hive.health` probes the server exactly the way a real request
--- would, rather than reaching a server the completion path could not.
---@param url string
---@return Hive.Curl.Request
function M.base_request(url)
  local Config = require("hive.config")
  local Curl = require("hive.curl")

  ---@type Hive.Curl.Request
  local req = {
    url = url,
    headers = vim.deepcopy(Config.headers),
    timeout = Config.timeout,
    connect_timeout = Config.connect_timeout,
    cacert = Config.tls.cacert,
    insecure = Config.tls.insecure,
  }

  local token = Config.resolve_api_key()
  if token then
    if Curl.supports_expand() then
      -- curl >= 8.3: the token is read from curl's environment, so it never
      -- appears in `/proc/<pid>/cmdline` for the life of the request.
      req.secrets = { [TOKEN_VAR] = token }
      req.expand_headers = { ["Authorization"] = ("Bearer {{%s}}"):format(TOKEN_VAR) }
    else
      -- Older curl has no way to indirect through the environment. The header
      -- goes on the argv; `:checkhealth hive` reports this.
      req.headers["Authorization"] = "Bearer " .. token
    end
  end

  return req
end

---Turn a raw HTTP response into a completion. Exposed for testing.
---@param res Hive.Curl.Response
---@return string|nil err
---@return Hive.Completion|nil completion
function M.parse_completion(res)
  if res.status < 200 or res.status >= 300 then
    return error_message(res.status, res.body)
  end

  local decoded = decode(res.body)
  if not decoded then
    return "response body is not valid JSON"
  end

  local choice = decoded.choices and decoded.choices[1]
  if not choice or type(choice.text) ~= "string" then
    return "response contained no completion choices"
  end

  -- An empty string is a successful-looking failure: HTTP 200, a plausible
  -- token count, and nothing to show. The usual cause is a thinking model
  -- behind a compatibility layer that maps only the answer channel and drops
  -- the reasoning one, so the tokens are real but unreachable.
  if choice.text == "" then
    local generated = decoded.usage and decoded.usage.completion_tokens or 0
    if generated > 0 then
      return (
        "model returned an empty completion (server generated %d tokens but "
        .. "returned no text — a thinking model on an endpoint that drops the "
        .. "reasoning channel? try a non-thinking model, or a server whose "
        .. "native endpoint exposes it)"
      ):format(generated)
    end
    return "model returned an empty completion"
  end

  return nil,
    {
      text = choice.text,
      finish_reason = choice.finish_reason,
      usage = decoded.usage,
      raw = decoded,
    }
end

---Build the request for `POST /v1/completions`. Exposed for testing.
---@param prompt string
---@param max_tokens integer
---@return Hive.Curl.Request
function M.completions_request(prompt, max_tokens)
  local Config = require("hive.config")

  local req = M.base_request(Config.base_url .. "/v1/completions")
  req.method = "POST"
  req.body = vim.json.encode({
    model = Config.model,
    prompt = prompt,
    max_tokens = max_tokens,
    stream = false,
  })

  return req
end

---Request a text completion from `POST /v1/completions`.
---
--- Asynchronous when `callback` is given, blocking otherwise:
--- >lua
---   -- async; the third return value cancels the request
---   local _, _, obj = require("hive.api").completions("The capital of France is", 16,
---     function(err, out)
---       if err then return end
---       print(out.text)
---     end)
---
---   -- blocking
---   local err, out = require("hive.api").completions("2 + 2 =", 8)
--- <
---@param prompt string the prompt to complete
---@param max_tokens integer maximum number of tokens to generate
---@param callback? fun(err: string|nil, completion: Hive.Completion|nil)
---@return string|nil err set only in blocking mode
---@return Hive.Completion|nil completion set only in blocking mode
---@return vim.SystemObj|nil obj cancellation handle, set only in async mode
function M.completions(prompt, max_tokens, callback)
  -- Report a bad argument through whichever channel the caller chose.
  local function fail(err)
    if callback then
      callback(err, nil)
      return
    end
    return err
  end

  local ok, verr = pcall(function()
    vim.validate("prompt", prompt, "string")
    vim.validate("max_tokens", max_tokens, "number")
    vim.validate("callback", callback, "function", true)
  end)
  if not ok then
    return fail(tostring(verr))
  end
  if prompt == "" then
    return fail("prompt must not be empty")
  end
  if max_tokens < 1 or max_tokens % 1 ~= 0 then
    return fail("max_tokens must be a positive integer")
  end

  local Curl = require("hive.curl")
  local req = M.completions_request(prompt, max_tokens)

  if not callback then
    local request_err, res = Curl.request(req)
    if request_err then
      return request_err
    end
    return M.parse_completion(res --[[@as Hive.Curl.Response]])
  end

  local _, _, obj = Curl.request(req, function(request_err, res)
    if request_err then
      return callback(request_err, nil)
    end
    callback(M.parse_completion(res --[[@as Hive.Curl.Response]]))
  end)

  return nil, nil, obj
end

---List the model ids the server advertises on `GET /v1/models`.
---
--- Blocking, and deliberately short-deadlined: this backs `:checkhealth hive`,
--- where the answer to "is the configured model actually served" matters more
--- than it does at request time. A server that does not implement the endpoint
--- returns an error rather than an empty list, so the two stay distinguishable.
---@param timeout? integer milliseconds (default 5000)
---@return string|nil err
---@return string[]|nil models
function M.models(timeout)
  local Config = require("hive.config")
  local Curl = require("hive.curl")

  local req = M.base_request(Config.base_url .. "/v1/models")
  req.timeout = timeout or 5000
  -- Never let the connect budget outlive the request budget it sits inside.
  req.connect_timeout = math.min(Config.connect_timeout, req.timeout)

  local err, res = Curl.request(req)
  if err then
    return err
  end
  ---@cast res Hive.Curl.Response

  if res.status < 200 or res.status >= 300 then
    return error_message(res.status, res.body)
  end

  local decoded = decode(res.body)
  if not decoded or type(decoded.data) ~= "table" then
    return "response body is not a model list"
  end

  local ids = {}
  for _, entry in ipairs(decoded.data) do
    if type(entry) == "table" and type(entry.id) == "string" then
      table.insert(ids, entry.id)
    end
  end

  return nil, ids
end

return M
