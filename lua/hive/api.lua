--- Mistral endpoint bindings.
---
--- `/v1/fim/completions` and `/v1/models` are implemented. Headers, model,
--- credentials and base URL come from `hive.config`; callers supply nothing but
--- the text either side of the cursor and a token budget.
---
--- The server assembles the FIM sentinels from `prompt` and `suffix`, so hive
--- sends the two sides as plain text and never spells a dialect's tokens.

---@class Hive.Api
local M = {}

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
    message = decoded and decoded.message
  end
  if type(message) ~= "string" then
    message = vim.trim(body)
  end
  if message == "" then
    return ("HTTP %d"):format(status)
  end
  return ("HTTP %d: %s"):format(status, message)
end

---Run a built request to completion, pumping the event loop while it is in
---flight.
---
--- `hive.curl` only speaks callbacks. The two blocking entry points here are
--- for `:checkhealth` and for scripts driving hive from `nvim -l`, where there
--- is no editor to keep responsive.
---@param req Hive.Curl.Request
---@return string|nil err
---@return Hive.Curl.Response|nil res
local function await(req)
  local Curl = require("hive.curl")

  local done, request_err, res = false, nil, nil
  Curl.request(req, function(err, result)
    done, request_err, res = true, err, result
  end)

  -- `req.opts.timeout` is |vim.system()|'s own millisecond budget, already
  -- padded past curl's `--max-time`; a little more on top keeps the wait from
  -- firing before the process does.
  local budget = (req.opts.timeout or 35000) + 1000
  local waited = vim.wait(budget, function()
    return done
  end, 20)

  if not waited then
    return ("request did not finish within %ds"):format(math.floor(budget / 1000))
  end
  return request_err, res
end

---Build the request every endpoint shares: credentials and the timeout.
---@param url string
---@return Hive.Curl.RequestBuilder
function M.base_request(url)
  local Config = require("hive.config")
  local Curl = require("hive.curl")

  -- stylua: ignore
  local req = Curl.new_request()
                  :with_url(url)
                  :with_timeout(Config.timeout)
                  :with_headers(Config.headers)

  local token = Config.resolve_api_key()
  if token then
    req:with_env({ HIVE_TOKEN = token })
    req:with_expand_headers({ Authorization = "Bearer {{HIVE_TOKEN}}" })
  end

  return req
end

---Turn a raw HTTP response into a completion
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
  local text = choice and choice.message and choice.message.content
  if type(text) ~= "string" then
    return "response contained no completion choices"
  end

  if text == "" then
    local generated = decoded.usage and decoded.usage.completion_tokens or 0
    if generated > 0 then
      return (
        "model returned an empty completion (server generated %d tokens but "
        .. "returned no text — check the stop strings: one that matches at "
        .. "position 0 consumes everything)"
      ):format(generated)
    end
    return "model returned an empty completion"
  end

  return nil,
    {
      text = text,
      finish_reason = choice.finish_reason,
      usage = decoded.usage,
      raw = decoded,
    }
end

---Build the request for `POST /v1/fim/completions`. Exposed for testing.
---@param prefix string text before the cursor
---@param suffix string text after the cursor, `""` when the cursor is at the end
---@param max_tokens integer
---@return Hive.Curl.RequestBuilder
function M.fim_request(prefix, suffix, max_tokens)
  local Config = require("hive.config")

  local req = M.base_request(Config.base_url .. "/v1/fim/completions")
  req:with_method("POST")
  req:with_body(vim.json.encode({
    model = Config.model,
    prompt = prefix,
    suffix = suffix,
    max_tokens = max_tokens,
    stream = false,
  }))

  return req
end

---Request a fill-in-the-middle completion from `POST /v1/fim/completions`.
---
--- Asynchronous when `callback` is given, blocking otherwise:
--- >lua
---   -- async; the third return value cancels the request
---   local _, _, obj = require("hive.api").completions(
---     "def add(a, b):\n  ", "\n  return total", 16,
---     function(err, out)
---       if err then return end
---       print(out.text)
---     end)
---
---   -- blocking, cursor at the end of the buffer
---   local err, out = require("hive.api").completions("2 + 2 =", "", 8)
--- <
---@param prefix string text before the cursor
---@param suffix string text after the cursor, `""` when the cursor is at the end
---@param max_tokens integer maximum number of tokens to generate
---@param callback? fun(err: string|nil, completion: Hive.Completion|nil)
---@return string|nil err set only in blocking mode
---@return Hive.Completion|nil completion set only in blocking mode
---@return vim.SystemObj|nil obj cancellation handle, set only in async mode
function M.completions(prefix, suffix, max_tokens, callback)
  local function fail(err)
    if callback then
      callback(err, nil)
      return
    end
    return err
  end

  local ok, verr = pcall(function()
    vim.validate("prefix", prefix, "string")
    vim.validate("suffix", suffix, "string")
    vim.validate("max_tokens", max_tokens, "number")
    vim.validate("callback", callback, "function", true)
  end)
  if not ok then
    return fail(tostring(verr))
  end

  if prefix == "" and suffix == "" then
    return fail("prefix and suffix must not both be empty")
  end
  if max_tokens < 1 or max_tokens % 1 ~= 0 then
    return fail("max_tokens must be a positive integer")
  end

  local Curl = require("hive.curl")
  local req = M.fim_request(prefix, suffix, max_tokens):build()
  ---@cast req Hive.Curl.Request

  if not callback then
    local request_err, res = await(req)
    if request_err then
      return request_err
    end
    return M.parse_completion(res --[[@as Hive.Curl.Response]])
  end

  local obj = Curl.request(req, function(request_err, res)
    if request_err then
      return callback(request_err, nil)
    end
    callback(M.parse_completion(res --[[@as Hive.Curl.Response]]))
  end)

  return nil, nil, obj
end

---List the model ids the server advertises on `GET /v1/models`.
---@param timeout? integer seconds (default 5)
---@return string|nil err
---@return string[]|nil models
function M.models(timeout)
  local Config = require("hive.config")

  local req = M.base_request(Config.base_url .. "/v1/models"):with_timeout(timeout or 5):build()
  ---@cast req Hive.Curl.Request

  local err, res = await(req)
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
