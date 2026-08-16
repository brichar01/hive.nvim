---@module 'luassert'

local health = require("hive.health")
local hive = require("hive")

describe("health check", function()
  after_each(function()
    hive.did_setup = false
    hive.setup({})
  end)

  it("runs with default config without errors", function()
    hive.did_setup = false
    hive.setup({})
    assert.has_no.errors(function()
      health.check()
    end)
  end)

  it("runs with custom config without errors", function()
    hive.did_setup = false
    hive.setup({ base_url = "http://127.0.0.1:9000", model = "test-model" })
    assert.has_no.errors(function()
      health.check()
    end)
  end)

  it("handles invalid config gracefully", function()
    hive.did_setup = false
    hive.setup({ base_url = 123 })
    assert.has_no.errors(function()
      health.check()
    end)
  end)

  it("runs when setup() was never called", function()
    hive.did_setup = false
    assert.has_no.errors(function()
      health.check()
    end)
  end)
end)
