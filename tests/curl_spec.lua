---@module 'luassert'

local Curl = require("hive.curl")

---Index of `value` in `list`, or nil
---@param list string[]
---@param value string
---@return integer|nil
local function index_of(list, value)
  for i, item in ipairs(list) do
    if item == value then
      return i
    end
  end
end

describe("build_args", function()
  it("defaults to GET with no body flags", function()
    local cmd = Curl.build_args({ url = "http://localhost:8080/v1/models" })

    assert.are.equal("curl", cmd[1])
    assert.are.equal("GET", cmd[index_of(cmd, "--request") + 1])
    assert.are.equal("http://localhost:8080/v1/models", cmd[index_of(cmd, "--url") + 1])
    assert.is_nil(index_of(cmd, "--data-binary"))
  end)

  it("sends the body on stdin", function()
    local cmd = Curl.build_args({ url = "http://x", method = "POST", body = '{"a":1}' })

    assert.are.equal("POST", cmd[index_of(cmd, "--request") + 1])
    assert.are.equal("@-", cmd[index_of(cmd, "--data-binary") + 1])
    -- The body itself must never reach the command line.
    assert.is_nil(index_of(cmd, '{"a":1}'))
  end)

  it("converts the timeout from milliseconds to seconds", function()
    local cmd = Curl.build_args({ url = "http://x", timeout = 1500 })
    assert.are.equal("1.5", cmd[index_of(cmd, "--max-time") + 1])
  end)

  it("defaults the timeout to 60 seconds", function()
    local cmd = Curl.build_args({ url = "http://x" })
    assert.are.equal("60", cmd[index_of(cmd, "--max-time") + 1])
  end)

  it("emits headers in a deterministic order", function()
    local headers = { ["Content-Type"] = "application/json", ["Accept"] = "application/json" }
    local first = Curl.build_args({ url = "http://x", headers = headers })
    local second = Curl.build_args({ url = "http://x", headers = headers })

    assert.are.same(first, second)
    assert.are.equal("Accept: application/json", first[index_of(first, "--header") + 1])
  end)

  it("requests the HTTP status via --write-out", function()
    local cmd = Curl.build_args({ url = "http://x" })
    assert.is_truthy(cmd[index_of(cmd, "--write-out") + 1]:find("%%{http_code}"))
  end)
end)

describe("request", function()
  -- Port 1 is privileged and never has a listener, so this reliably fails to
  -- connect without depending on any server being up.
  local unreachable = "http://127.0.0.1:1/v1/completions"

  it("reports a connection failure in blocking mode", function()
    local err, res = Curl.request({ url = unreachable, timeout = 2000 })

    assert.is_not_nil(err)
    assert.is_nil(res)
    assert.is_truthy(err:find("connect"))
  end)

  it("reports a connection failure through the callback", function()
    local done, cb_err, cb_res = false, nil, nil

    Curl.request({ url = unreachable, timeout = 2000 }, function(err, res)
      done, cb_err, cb_res = true, err, res
    end)

    assert.is_true(vim.wait(5000, function()
      return done
    end, 20))
    assert.is_not_nil(cb_err)
    assert.is_nil(cb_res)
  end)
end)
