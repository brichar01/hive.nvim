---@module 'luassert'

local hive = require("hive")
local Config = require("hive.config")

describe("default options", function()
  before_each(function()
    hive.did_setup = false
    hive.setup({})
  end)

  it("points at the local server", function()
    assert.are.equal("http://localhost:8080", Config.base_url)
  end)

  it("sends JSON headers and no authorization", function()
    assert.are.equal("application/json", Config.headers["Content-Type"])
    assert.are.equal("application/json", Config.headers["Accept"])
    assert.is_nil(Config.headers["Authorization"])
  end)

  it("setup() sets did_setup to true", function()
    assert.is_true(hive.did_setup)
  end)
end)

describe("user defined options", function()
  after_each(function()
    hive.did_setup = false
    hive.setup({})
  end)

  it("overrides the base URL", function()
    hive.did_setup = false
    hive.setup({ base_url = "http://127.0.0.1:9000" })
    assert.are.equal("http://127.0.0.1:9000", Config.base_url)
  end)

  it("strips a trailing slash from the base URL", function()
    hive.did_setup = false
    hive.setup({ base_url = "http://127.0.0.1:9000/" })
    assert.are.equal("http://127.0.0.1:9000", Config.base_url)
  end)

  it("falls back to the defaults on an invalid option", function()
    hive.did_setup = false
    hive.setup({ timeout = "soon" })
    assert.are.equal(Config.defaults().timeout, Config.timeout)
  end)
end)

describe("double setup guard", function()
  it("keeps the first configuration", function()
    hive.did_setup = false
    hive.setup({ model = "first" })

    assert.has_no.errors(function()
      hive.setup({ model = "second" })
    end)
    assert.are.equal("first", Config.model)

    hive.did_setup = false
    hive.setup({})
  end)
end)

describe("completions", function()
  it("is exposed on the top-level module", function()
    assert.is_function(hive.completions)
  end)

  it("delegates validation to hive.api", function()
    assert.are.equal("prefix and suffix must not both be empty", hive.completions("", "", 16))
  end)
end)
