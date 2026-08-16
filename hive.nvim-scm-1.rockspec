---@diagnostic disable: lowercase-global

local _MODREV, _SPECREV = "scm", "-1"
rockspec_format = "3.0"
version = _MODREV .. _SPECREV

local user = "brichar01"
package = "hive.nvim"

description = {
	summary = "Query an OpenAI-compatible API from Neovim",
	detailed = [[
hive.nvim queries an OpenAI-compatible HTTP API by shelling out to curl through
vim.system(). It implements POST /v1/completions with hard-coded headers and
configuration, and exposes an async-or-blocking Lua API taking a prompt and a
token budget.
  ]],
	labels = { "neovim", "plugin", "lua", "openai", "llm", "ai", "curl" },
	homepage = "https://github.com/" .. user .. "/" .. package,
	license = "MIT",
}

dependencies = {
	"lua >= 5.1",
}

source = {
	url = "git://github.com/" .. user .. "/" .. package,
}

build = {
	type = "builtin",
}
