--- OpenAI-compatible endpoint bindings.
---
--- Only `/v1/completions` is implemented. Headers, model and base URL come from
--- `hive.config`; callers supply nothing but the prompt and a token budget.

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
    message = vim.trim(body)
  end
  if message == "" then
    return ("HTTP %d"):format(status)
  end
  return ("HTTP %d: %s"):format(status, message)
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

  return {
    url = Config.base_url .. "/v1/completions",
    method = "POST",
    headers = Config.headers,
    timeout = Config.timeout,
    body = vim.json.encode({
      model = Config.model,
      prompt = prompt,
      max_tokens = max_tokens,
      stream = false,
    }),
  }
end

---Request a text completion from `POST /v1/completions`.
---
--- Asynchronous when `callback` is given, blocking otherwise:
--- >lua
---   -- async
---   require("hive.api").completions("The capital of France is", 16, function(err, out)
---     if err then return end
---     print(out.text)
---   end)
---
---   -- blocking
---   local err, out = require("hive.api").completions("2 + 2 =", 8)
--- <
---@param prompt string the prompt to complete
---@param max_tokens integer maximum number of tokens to generate
---@param callback? fun(err: string|nil, completion: Hive.Completion|nil)
---@return string|nil err set only in blocking mode
---@return Hive.Completion|nil completion set only in blocking mode
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

  Curl.request(req, function(request_err, res)
    if request_err then
      return callback(request_err, nil)
    end
    callback(M.parse_completion(res --[[@as Hive.Curl.Response]]))
  end)
end

return M
