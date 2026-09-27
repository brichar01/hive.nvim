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
  <p><em>Code context, templated prompts and a coding agent, inside Neovim</em></p>
</div>

______________________________________________________________________

## 💡 Mission statement

Hive implements a few core ideas:
- Separate suggestions from the code to reduce visual clutter in the IDE, but provide efficient tools for accepting suggestions, even partial suggestions.
- Control a task-oriented array of smaller agentic models and access patterns to them, hence the hive name, each insect does a single, specialised job, in parallel to others.
- Improve control and generation accuracy by allowing the user to fine tune the context sent to the models, while using enough generated context to give the model a good chance to produce the specific output the user wants (emphasising shape from automatically sourced code, direction from user input).
- Use local resources efficiently by giving the developer the tools and knowledge to produce good llm outputs, deferring to cloud solutions only when the task is appropriately large or general.

The aim of these core ideas is to provide a user with more control over code style than pure vibe coding. Allowing the user to inject their real world context into the code shape itself, providing effective abstractions instead of the common brute force and re-implementation methods typified by generated code. 

## 🗺️ Status

Hive has three layers, each with its own command.

| Command | Layer | Modules | State |
| --- | --- | --- | --- |
| `:Hive` | Agent: a Neovim frontend for pi-coding-agent | `hive.agent`, `hive.fs` (planned) | Planned, see [`PLAN.md`](PLAN.md) |
| `:HiveBare` | Direct: templated prompts sent straight to an endpoint | `hive.direct.*` | Fill-in-the-middle works |
| `:HiveContext` | Context: select, gather and copy code | `hive.context.*`, `hive.workbench` | Works |

### Agent (planned)

Neovim starts a Node service that wraps `@earendil-works/pi-coding-agent`. The
service owns the agent loop. Neovim is the filesystem: the agent's `read`, `write`
and `edit` tools use buffers and never touch disk. An edit to an open file changes
the buffer and leaves the file on disk as it was. A write to a new file opens a
listed, modified, unsaved buffer. `bash`, `grep`, `find` and `ls` still read the
filesystem.

Lua only sends notifications to Node, and Node drives Neovim through the API. Lua
never waits on Node, so a tool that reads a buffer cannot deadlock the editor.

The API key stays in the secret store that `:HiveBare` uses. Lua resolves it and
gives it to Node in the child's environment, never on the command line and never in
Pi's own credential file.

The build runs in stages: the RPC channel, a session that streams events into a
buffer, a layer that rebuilds exact file bytes from buffer lines (line endings,
BOM, trailing newline), the buffer-backed tools, open on write, then diff
rendering and approval. One decision is open: when agent-touched buffers get saved,
because `bash` and test runs read stale disk until they are.
[`PLAN.md`](PLAN.md) has the full design.

### Templated prompts

A templated prompt is a fixed instruction, plus the context that `hive.context`
gathers for it, sent as one request by `hive.direct.api`. The editor picks the
context from the code (shape), and you give the direction.

| Template | Context | State |
| --- | --- | --- |
| Fill in the middle | The enclosing function, split at the cursor | `:HiveBare fim`, `POST /v1/fim/completions` |
| Summarise this diff | `git diff` of the file against a revision | Context works (`:HiveContext diff`), template planned |
| Write a unit test for this function | The function, the file outline, and the definitions and usages of its symbols | Context works (`:HiveContext outline`, `:HiveContext symbol`), template planned |

The server builds the FIM sentinels from `prompt` and `suffix`, so Hive sends
the two sides as plain text and never writes a model's special tokens.

`:HiveBare fim` appends the filled function to the project's workbench, a Markdown
scratch file under `stdpath("cache")/workbenches`. The code in the buffer does not
change, so you can compare the suggestion and take all or part of it.

### Context

`:HiveContext` finds code with treesitter and LSP. Selection uses node types for
each language (Python, C, Rust, Lua and TypeScript), and a shared fallback list
for other languages.

| Subcommand | Does |
| --- | --- |
| `select call\|method\|class\|parent` | Select the enclosing node. With a range, select the nearest one that extends past it. |
| `ref` | Copy `<path>:<first>-<last>` for a range, or `<signature> [<path>:<first>-<last>]` for the element at the cursor |
| `rel` | Copy the buffer's path relative to the working directory |
| `file` | Copy the buffer's absolute path |
| `outline [reg]` | Copy a tree of signatures for the buffer, or for the range |
| `symbol [reg]` | Copy the definitions and references of the symbol at the cursor, from LSP |
| `diff [rev=<rev>] [reg]` | Copy the `git diff` of the buffer's file against `rev` (default `HEAD`) |
| `fim` | Append the enclosing function, split at the cursor with FIM markers, to the workbench |
| `workbench open\|new\|next\|previous` | Open this project's workbench, start a new one, or step between them |

`[reg]` defaults to `+`.

## ⚡️ Requirements

- **[Neovim](https://github.com/neovim/neovim)** 0.12.2 or later
- **[curl](https://curl.se/)**: every `:HiveBare` request is a `curl` subprocess
- A server with Mistral's `POST /v1/fim/completions`, such as `https://api.mistral.ai` with `codestral-latest`
- Treesitter parsers for the languages you select in, a language server for `:HiveContext symbol`, and **[git](https://git-scm.com/)** for `:HiveContext diff`
- **[Node.js](https://nodejs.org/)**, for `:Hive` when the agent lands

For development, also: **[StyLua](https://github.com/JohnnyMorganz/StyLua)**, **[LuaLS](https://github.com/LuaLS/lua-language-server)**, **[git](https://git-scm.com/)** and **[Make](https://www.gnu.org/software/make/)**. Optionally **[lazydev.nvim](https://github.com/folke/lazydev.nvim)**.

## 📦 Installation

With [lazy.nvim](https://github.com/folke/lazy.nvim):

```lua
{
  "brichar01/hive.nvim",
  cmd = { "HiveBare", "HiveContext" },
  opts = {
    base_url = "https://api.mistral.ai",
    model = "codestral-latest",
    api_key_env = "MISTRAL_API_KEY",
  },
}
```

`setup()` is optional — hive.nvim works with its hard-coded defaults. Check the connection with `:checkhealth hive`.

## 🚀 Usage

```lua
-- Async: the callback runs via vim.schedule(), so buffers and windows are safe.
require("hive").completions("def add(a, b):\n    ", "\n    return total", 64, function(err, out)
  if err then
    return vim.notify(err, vim.log.levels.ERROR)
  end
  vim.notify(out.text)
end)

-- Blocking: returns (err, completion). An empty suffix puts the cursor at the end.
local err, out = require("hive").completions("2 + 2 =", "", 8)
print(err or out.text)
```

The completion table carries `text`, `finish_reason`, `usage` and `raw` (the decoded
response body, verbatim). Exactly one of `err` and `out` is set.

From the command line:

```vim
:HiveBare complete The capital of France is
:HiveBare fim 128
:HiveBare health
:'<,'>HiveContext outline a
:HiveContext diff rev=main
```

Map keys to the commands in your own config. Use `<Cmd>` in normal mode, and `:` in
visual mode so the command gets the range:

```lua
vim.keymap.set("n", "vsm", "<Cmd>HiveContext select method<CR>")
vim.keymap.set("x", "vsm", ":HiveContext select method<CR>")
vim.keymap.set("x", "<C-Left>", ":HiveContext select parent<CR>")
vim.keymap.set("n", "<leader>nf", "<Cmd>HiveBare fim<CR>")
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
| `hive.config` | Defaults, validation and API key resolution |
| `hive.endpoint` | Classifies `base_url`: loopback, TLS or remote plaintext |
| `hive.health` | `:checkhealth hive` |
| `hive.direct.api` | Endpoint bindings: builds the request, decodes the response |
| `hive.direct.curl` | Transport: builds a `curl` argv, runs it with `vim.system()`, returns `{ status, body }` |
| `hive.context.selection` | Treesitter node types for each language, and node selection |
| `hive.context.format` | Splits a node's text at the cursor |
| `hive.context.gather` | Outlines, and definitions and usages from LSP |
| `hive.context.diff` | `git diff` of a file |
| `hive.context.path` | Buffer paths and `<path>:<line>` references |
| `hive.workbench` | The project's Markdown workbench files |

`hive.direct.curl` knows nothing about the endpoints. The request body goes to
curl's stdin (`--data-binary @-`) so large prompts never reach the command line.
The HTTP status comes back from `--write-out` behind a marker, so the body stays
byte-exact.

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
