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

## 💡 Mission statement

Hive implements a few core ideas:
- Separate suggestions from the code to reduce visual clutter in the IDE, but provide efficient tools for accepting suggestions, even partial suggestions.
- Control a task-oriented array of smaller agentic models and access patterns to them, hence the hive name, each insect does a single, specialised job, in parallel to others.
- Improve control and generation accuracy by allowing the user to fine tune the context sent to the models, while using enough generated context to give the model a good chance to produce the specific output the user wants (emphasising shape from automatically sourced code, direction from user input).
- Use local resources efficiently by giving the developer the tools and knowledge to produce good llm outputs, deferring to cloud solutions only when the task is appropriately large or general.

The aim of these core ideas is to provide a user with more control over code style than pure vibe coding. Allowing the user to inject their real world context into the code shape itself, providing effective abstractions instead of the common brute force and re-implementation methods typified by generated code. 

### Current scope:

#### In Scope

- One endpoint: `POST /v1/completions`
- A Lua API that takes a prompt and a token budget, and nothing else
- Async by default, blocking when you want it
- The server may be on this machine or elsewhere on your network — optional
  bearer auth and TLS, with a connect deadline so a host that is down fails
  fast instead of hanging the editor

#### Not implemented

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
  timeout = 60, -- seconds, whole request
  headers = {
    ["Content-Type"] = "application/json",
    ["Accept"] = "application/json",
  },
})
```

#### Pointing it at another machine

`base_url` is the only thing that has to change. `model` almost certainly does
too — every server names its models differently, and `:checkhealth hive` will
tell you which ones yours actually serves:

```lua
require("hive").setup({
  base_url = "http://gpubox.lan:8080",
  model = "qwen2.5-coder:7b",

  -- Optional. The token is passed to curl out of band on curl >= 8.3, so it
  -- never appears in the process list where any local process could read it.
  api_key_env = "HIVE_API_KEY",
})
```

#### The bearer token

`api_key` is unset by default, so nothing is sent unless you configure it. The
fallback order is `api_key` first, then `$HIVE_API_KEY` (renameable via
`api_key_env`), then no `Authorization` header at all.

A literal string ends up in your dotfiles. `api_key` also accepts a function, so
the token can come from a wallet instead — `resolve_api_key` calls it once and
memoises the answer, which means a blocking lookup costs one IPC round trip per
session rather than one per request:

```lua
require("hive").setup({
  api_key = function()
    if vim.fn.executable("secret-tool") ~= 1 then
      return nil
    end
    -- A locked wallet prompts for a passphrase and nothing here can answer it,
    -- so the lookup is killed rather than left waiting.
    local out = vim.system(
      { "secret-tool", "lookup", "service", "mistral", "key", "api" },
      { text = true, timeout = 10000 }
    ):wait()
    if out.code ~= 0 then
      return nil
    end
    -- A trailing newline would ride into `Authorization: Bearer` and read as a
    -- bad key.
    return vim.trim(out.stdout or "")
  end,
})
```

That reads the item created by:

```sh
secret-tool store --label='Mistral API key' service mistral key api
```

Returning `nil` from the function falls through to `$HIVE_API_KEY`, so a missing
`secret-tool`, a locked wallet or an absent item all degrade rather than fail.

Note that Secret Service items are addressed by their attribute pairs, not by a
folder and entry name — a secret already in KWallet under `kdewallet` /
`Passwords` / `MISTRAL_API_KEY` is not reachable this way and has to be stored
again with the command above.

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
