<div align="center">
  <h1>🐝&nbsp;&nbsp;hive.nvim&nbsp;&nbsp;🐝 </h1>

  <p align="center">
    <a href="https://github.com/brichar01/hive.nvim/actions/workflows/ci.yml">
      <img alt="CI badge" src="https://img.shields.io/github/actions/workflow/status/brichar01/hive.nvim/ci.yml?style=for-the-badge&label=CI"/>
    </a>
    <a href="https://luarocks.org/modules/brichar01/hive.nvim">
      <img alt="LuaRocks badge" src="https://img.shields.io/luarocks/v/brichar01/hive.nvim?style=for-the-badge&color=5d2fbf"/>
    </a>
    <a href="https://github.com/brichar01/hive.nvim/releases">
      <img alt="GitHub badge" src="https://img.shields.io/github/v/release/brichar01/hive.nvim?style=for-the-badge&label=GitHub"/>
    </a>
  </p>
  <p><em>Query an OpenAI-compatible API from Neovim</em></p>
</div>

______________________________________________________________________

## 💡 Motivation

hive.nvim talks to a local, OpenAI-compatible HTTP server and hands the result back to Lua. It shells out to `curl` through `vim.system()` — no Lua HTTP library, no plugin dependencies, nothing to vendor.

The scope is deliberately narrow right now:

- One endpoint: `POST /v1/completions`
- Hard-coded headers and configuration — no API key, no auth
- A Lua API that takes a prompt and a token budget, and nothing else
- Async by default, blocking when you want it

Rendering completions into scratch buffers, virtual text and floating windows is **not implemented yet** — the transport and API layers come first.

## ⚡️ Requirements

- **[Neovim](https://github.com/neovim/neovim)** ≥ 0.12.2
- **[curl](https://curl.se/)**: every request is a `curl` subprocess
- An OpenAI-compatible server serving `POST /v1/completions` — [`llama-server`](https://github.com/ggml-org/llama.cpp), [vLLM](https://github.com/vllm-project/vllm) and LM Studio all work

For development, also: **[StyLua](https://github.com/JohnnyMorganz/StyLua)**, **[LuaLS](https://github.com/LuaLS/lua-language-server)**, **[git](https://git-scm.com/)** and **[Make](https://www.gnu.org/software/make/)**. Optionally **[lazydev.nvim](https://github.com/folke/lazydev.nvim)**.

## 📦 Installation

With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "brichar01/hive.nvim",
  cmd = "Hive",
  opts = {},
}
```

`setup()` is optional — hive.nvim works with its hard-coded defaults. Check the connection with `:checkhealth hive`.

## 🚀 Usage

```lua
-- Async: the callback runs via vim.schedule(), so buffers and windows are safe.
require("hive").completions("The capital of France is", 16, function(err, out)
  if err then
    return vim.notify(err, vim.log.levels.ERROR)
  end
  vim.notify(out.text)
end)

-- Blocking: returns (err, completion).
local err, out = require("hive").completions("2 + 2 =", 8)
print(err or out.text)
```

The completion table carries `text`, `finish_reason`, `usage` and `raw` (the decoded response body, verbatim). Exactly one of `err` and `out` is ever set.

From the command line:

```vim
:Hive complete The capital of France is
:checkhealth hive
```

### Configuration

```lua
require("hive").setup({
  base_url = "http://localhost:8080",
  model = "default",
  timeout = 60000, -- ms
  headers = {
    ["Content-Type"] = "application/json",
    ["Accept"] = "application/json",
  },
})
```

Full documentation lives in [`:help hive`](https://github.com/brichar01/hive.nvim/blob/main/doc/hive.txt).

## 🧱 Layout

| Module | Role |
| --- | --- |
| `hive` | Public entry point (`setup`, `completions`) |
| `hive.api` | OpenAI endpoint bindings — builds the request, decodes the response |
| `hive.curl` | Transport: builds a `curl` argv, runs it via `vim.system()`, returns `{ status, body }` |
| `hive.config` | Hard-coded defaults and validation |
| `hive.health` | `:checkhealth hive` |

`hive.curl` knows nothing about OpenAI. The request body goes to curl's stdin (`--data-binary @-`) so large prompts never hit the command line, and the HTTP status is recovered from `--write-out` behind a marker, keeping the body byte-exact.

## 🧪 Development

```bash
make test      # mini.test suite via lazy.minit
make lint      # StyLua
make typecheck # LuaLS
make check     # all three
make dev       # nvim -u repro/repro.lua
```

The test suite runs without a server: transport errors are exercised against a closed port and response handling against synthetic payloads. One test in `tests/api_spec.lua` hits the configured `base_url` and skips itself when nothing answers.

## 🤖 AI Coding Agent

This project ships with [Agent Skills](https://agentskills.io/) in `.agents/skills/`. Skills follow the [Agent Skills specification](https://agentskills.io/specification) — the same `SKILL.md` format works across [many agents](https://agentskills.io/clients). Agents discover skills from different directories (e.g. `.claude/skills/`, `.github/skills/`); if yours doesn't pick them up, rename `.agents/` to its expected directory.

| Skill | Description |
| --- | --- |
| `nvim-init` | Initialize plugin project and verify development environment |
| `nvim-plugin` | Plugin development best practices and patterns |
| `nvim-test` | Execute tests and diagnose failures |
| `nvim-doc` | Write and update vimdoc help documentation |
| `nvim-commit` | Create conventional commits for release-please |
| `nvim-help` | Search Neovim's built-in `:help` documentation |

## 🙏 Acknowledgments

- [base.nvim](https://github.com/S1M0N38/base.nvim): the template this plugin started from
- [nvim-best-practices](https://github.com/lumen-oss/nvim-best-practices): Collection of DOs and DON'Ts for modern Neovim Lua plugin development
- [LuaCATS annotations](https://luals.github.io/wiki/annotations/): type annotations to your Lua code
- [mini.test](https://github.com/echasnovski/mini.test): minimal test framework with child-process isolation
