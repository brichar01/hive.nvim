---@module 'luassert'

local Api = require("hive.api")
local Config = require("hive.config")

describe("completions_request", function()
  it("targets /v1/completions on the configured base URL", function()
    local req = Api.completions_request("hello", 16)

    assert.are.equal(Config.base_url .. "/v1/completions", req.url)
    assert.are.equal("POST", req.method)
    assert.are.equal(Config.timeout, req.timeout)
    assert.are.equal("application/json", req.headers["Content-Type"])
  end)

  it("encodes prompt and max_tokens into the JSON body", function()
    local req = Api.completions_request("the capital of France is", 42)
    local body = vim.json.decode(req.body)

    assert.are.equal("the capital of France is", body.prompt)
    assert.are.equal(42, body.max_tokens)
    assert.are.equal(Config.model, body.model)
    assert.is_false(body.stream)
  end)
end)

describe("parse_completion", function()
  local function response(status, tbl)
    return { status = status, body = type(tbl) == "string" and tbl or vim.json.encode(tbl) }
  end

  it("extracts the first choice", function()
    local err, out = Api.parse_completion(response(200, {
      choices = { { text = " Paris.", finish_reason = "stop" } },
      usage = { total_tokens = 12 },
    }))

    assert.is_nil(err)
    assert.are.equal(" Paris.", out.text)
    assert.are.equal("stop", out.finish_reason)
    assert.are.equal(12, out.usage.total_tokens)
    assert.is_table(out.raw)
  end)

  it("surfaces the server's error message", function()
    local err, out = Api.parse_completion(response(400, { error = { message = "unknown model" } }))

    assert.is_nil(out)
    assert.are.equal("HTTP 400: unknown model", err)
  end)

  it("falls back to the raw body when there is no error object", function()
    local err = Api.parse_completion(response(503, "service unavailable"))
    assert.are.equal("HTTP 503: service unavailable", err)
  end)

  it("reports the status alone when the body is empty", function()
    local err = Api.parse_completion(response(500, ""))
    assert.are.equal("HTTP 500", err)
  end)

  it("rejects a non-JSON body", function()
    local err, out = Api.parse_completion(response(200, "<html>oops</html>"))

    assert.is_nil(out)
    assert.are.equal("response body is not valid JSON", err)
  end)

  it("rejects a response with no choices", function()
    local err = Api.parse_completion(response(200, { choices = {} }))
    assert.are.equal("response contained no completion choices", err)
  end)

  -- HTTP 200 with a plausible token count and nothing to show. Accepting this
  -- as success presents as "hive does nothing", with no error to search for.
  it("rejects an empty completion", function()
    local err, out = Api.parse_completion(response(200, {
      choices = { { text = "", finish_reason = "length" } },
    }))

    assert.is_nil(out)
    assert.are.equal("model returned an empty completion", err)
  end)

  it("explains an empty completion that burned tokens", function()
    local err, out = Api.parse_completion(response(200, {
      choices = { { text = "", finish_reason = "length" } },
      usage = { completion_tokens = 120 },
    }))

    assert.is_nil(out)
    assert.is_truthy(err:find("120 tokens", 1, true))
    assert.is_truthy(err:find("stop strings", 1, true))
  end)

  it("still accepts whitespace, which is a real completion", function()
    local err, out = Api.parse_completion(response(200, {
      choices = { { text = "    ", finish_reason = "stop" } },
    }))

    assert.is_nil(err)
    assert.are.equal("    ", out.text)
  end)
end)

describe("completions argument validation", function()
  -- These all fail before any HTTP request is made, so no server is needed.
  local BAD_TOKENS = "max_tokens must be a positive integer"

  local cases = {
    { name = "empty prompt", prompt = "", max_tokens = 16, expected = "prompt must not be empty" },
    { name = "zero max_tokens", prompt = "hi", max_tokens = 0, expected = BAD_TOKENS },
    { name = "negative max_tokens", prompt = "hi", max_tokens = -5, expected = BAD_TOKENS },
    { name = "fractional max_tokens", prompt = "hi", max_tokens = 1.5, expected = BAD_TOKENS },
  }

  for _, case in ipairs(cases) do
    it("rejects " .. case.name, function()
      local err, out = Api.completions(case.prompt, case.max_tokens)
      assert.is_nil(out)
      assert.are.equal(case.expected, err)
    end)
  end

  it("rejects a non-string prompt", function()
    local err = Api.completions(42 --[[@as string]], 16)
    assert.is_not_nil(err)
  end)

  it("reports validation errors through the callback", function()
    local cb_err
    Api.completions("", 16, function(err)
      cb_err = err
    end)
    assert.are.equal("prompt must not be empty", cb_err)
  end)
end)
