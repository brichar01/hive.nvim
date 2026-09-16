---@module 'luassert'

--- Covers the options that only matter once the server is not on this machine:
--- the connect deadline, TLS, and credential handling. See IMPLEMENTATION.md §9.6.

local hive = require("hive")
local Api = require("hive.api")
local Config = require("hive.config")
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

---Reconfigure the plugin, bypassing the once-only setup guard
---@param opts table
local function configure(opts)
  hive.did_setup = false
  hive.setup(opts)
end

describe("connect timeout", function()
  after_each(function()
    configure({})
  end)

  it("defaults to a value well under the request timeout", function()
    configure({})
    assert.is_true(Config.connect_timeout < Config.timeout)
  end)

  it("is emitted as --connect-timeout in seconds", function()
    local cmd = Curl.build_args({ url = "http://x", connect_timeout = 2500 })
    assert.are.equal("2.5", cmd[index_of(cmd, "--connect-timeout") + 1])
  end)

  it("is omitted when unset, preserving the previous argv shape", function()
    local cmd = Curl.build_args({ url = "http://x" })
    assert.is_nil(index_of(cmd, "--connect-timeout"))
  end)

  it("rides on every request built by the api layer", function()
    configure({ connect_timeout = 1500 })
    assert.are.equal(1500, Api.fim_request("hi", "", 4).connect_timeout)
  end)

  it("is rejected when it exceeds the request timeout", function()
    configure({ timeout = 5000, connect_timeout = 9000 })
    assert.are.equal(Config.defaults().connect_timeout, Config.connect_timeout)
    assert.are.equal(Config.defaults().timeout, Config.timeout)
  end)

  -- The point of the option: a host that drops packets instead of refusing the
  -- connection must not hold the editor for the whole request timeout.
  it("bounds a blackholed host well inside the request timeout", function()
    -- 203.0.113.0/24 is TEST-NET-3: routable-looking, never routed.
    local started = vim.uv.now()
    local err = Curl.request({
      url = "http://203.0.113.1:8080/v1/models",
      timeout = 30000,
      connect_timeout = 1000,
    })
    local elapsed = vim.uv.now() - started

    assert.is_not_nil(err)
    assert.is_true(elapsed < 10000)
  end)
end)

describe("tls options", function()
  after_each(function()
    configure({})
  end)

  it("passes a CA bundle through to curl", function()
    local cmd = Curl.build_args({ url = "https://x", cacert = "/etc/ssl/lan.pem" })
    assert.are.equal("/etc/ssl/lan.pem", cmd[index_of(cmd, "--cacert") + 1])
  end)

  it("emits --insecure only when asked", function()
    assert.is_nil(index_of(Curl.build_args({ url = "https://x" }), "--insecure"))
    assert.is_not_nil(index_of(Curl.build_args({ url = "https://x", insecure = true }), "--insecure"))
  end)

  it("verifies certificates by default", function()
    configure({})
    assert.is_false(Config.tls.insecure)
    assert.is_nil(Config.tls.cacert)
  end)

  it("rejects a cacert path that does not exist", function()
    configure({ tls = { cacert = "/nonexistent/ca.pem" } })
    assert.is_nil(Config.tls.cacert)
  end)
end)

describe("api key", function()
  local ENV = "HIVE_TEST_TOKEN"

  before_each(function()
    vim.env[ENV] = nil
  end)

  after_each(function()
    vim.env[ENV] = nil
    configure({})
  end)

  it("sends no Authorization header when unset", function()
    configure({})
    local req = Api.fim_request("hi", "", 4)

    assert.is_nil(req.headers["Authorization"])
    assert.is_nil(req.expand_headers)
    assert.is_nil(req.secrets)
  end)

  it("is read from the environment variable named by api_key_env", function()
    vim.env[ENV] = "from-env"
    configure({ api_key_env = ENV })

    local token, source = Config.resolve_api_key()
    assert.are.equal("from-env", token)
    assert.are.equal("env", source)
  end)

  it("prefers an explicit api_key over the environment", function()
    vim.env[ENV] = "from-env"
    configure({ api_key = "from-config", api_key_env = ENV })

    local token, source = Config.resolve_api_key()
    assert.are.equal("from-config", token)
    assert.are.equal("config", source)
  end)

  it("accepts a function so the token can be fetched lazily", function()
    configure({
      api_key = function()
        return "from-function"
      end,
    })
    assert.are.equal("from-function", (Config.resolve_api_key()))
  end)

  it("treats an empty token as absent", function()
    vim.env[ENV] = ""
    configure({ api_key = "", api_key_env = ENV })
    assert.is_nil((Config.resolve_api_key()))
  end)

  -- The whole reason for the --variable indirection: on a curl that supports
  -- it, the token must not be reconstructable from the command line.
  it("keeps the token off the argv where curl supports it", function()
    configure({ api_key = "super-secret-value" })
    local req = Api.fim_request("hi", "", 4)
    local cmd = Curl.build_args(req)

    if Curl.supports_expand() then
      assert.are.equal("Bearer {{HIVE_TOKEN}}", req.expand_headers["Authorization"])
      assert.are.equal("super-secret-value", req.secrets["HIVE_TOKEN"])
      assert.is_nil(req.headers["Authorization"])
      for _, arg in ipairs(cmd) do
        assert.is_nil(arg:find("super-secret-value", 1, true))
      end
    else
      -- Old curl has no way to indirect; the fallback must still authenticate.
      assert.are.equal("Bearer super-secret-value", req.headers["Authorization"])
    end
  end)

  it("does not leak the token into the shared config headers table", function()
    configure({ api_key = "leaky" })
    Api.fim_request("hi", "", 4)
    assert.is_nil(Config.headers["Authorization"])
  end)
end)

describe("curl version detection", function()
  it("parses a three-part version", function()
    local v = Curl.version()
    if v then
      assert.are.equal(3, #v)
      assert.is_number(v[1])
    end
  end)

  it("agrees with itself about --expand-header support", function()
    local v = Curl.version()
    if v then
      local expected = v[1] > 8 or (v[1] == 8 and v[2] >= 3)
      assert.are.equal(expected, Curl.supports_expand())
    end
  end)
end)

describe("models", function()
  after_each(function()
    configure({})
  end)

  it("reports an error rather than an empty list when nothing answers", function()
    configure({ base_url = "http://127.0.0.1:1", timeout = 2000, connect_timeout = 1000 })
    local err, models = Api.models(2000)

    assert.is_not_nil(err)
    assert.is_nil(models)
  end)
end)
