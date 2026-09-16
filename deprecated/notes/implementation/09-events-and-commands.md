# Events, scheduling and commands — §11–§12

Part of the `hive.nvim` implementation plan — index:
[`IMPLEMENTATION.md`](../../IMPLEMENTATION.md). Section numbers are unchanged by
the split; a `§n` cross-reference still resolves via the section map in the index.

---

## 11. Events and scheduling

### 11.1 The state machine

Per session buffer:

```lua
---@class Hive.State
---@field target Hive.Target
---@field job? vim.SystemObj      -- in flight
---@field generation integer      -- monotonic; stale responses dropped
---@field timer? uv.uv_timer_t    -- debounce
---@field remaining? string       -- un-accepted suggestion tail (§10.2)
---@field bytes_per_token number  -- rolling, reconciled per §8.3.5
---@field transport? string       -- cached probe result (§9.1)
```

### 11.2 Triggers

One augroup, reusing `Config.augroup`:

| Event | On | Action |
| --- | --- | --- |
| `events.refresh_on` (default `BufWritePost`, `CursorHold`) | the **target** buffer | debounced `refresh` |
| `WinLeave`, `BufLeave` | any non-session, `buftype == ""` buffer | update target (§5) |
| `BufReadPost`, `FileChangedShellPost` | the **session** buffer | clear provenance (§10.1) |
| `BufWipeout` | the session buffer | kill job, stop timer, drop state |
| `VimLeavePre` | — | kill all jobs |

`auto_submit = false` by default: a refresh rebuilds R2 and R3 but does not spend
a model request. `:Hive submit` is explicit. Users who want the tight loop set
`auto_submit = true` and get a debounced submit chained to each refresh.

### 11.3 Debounce

`events.debounce` (300 ms) on a `uv` timer, one per session buffer,
stopped-and-restarted per trigger. **Both `refresh` and `submit` are debounced
as wholes** — one timer semantics for both, matching §11.2's table and §2's
"applies to refresh and submit alike". [R§5]'s eager-work principle applies
*inside* a fired refresh, not as a second inner timer: once the timer fires, the
treesitter extraction (0.09 ms [R§11.5]) and the LSP request run together, with
nothing further deferred.

Follow `vim/lsp/client.lua:732`'s discipline: a `submit` flushes any pending
(scheduled but not yet fired) `refresh` first, so a request is never built from
a stale R2/R3.

### 11.4 Refresh atomicity

I3 requires that R2 and R3 are replaced together. Build both bodies fully into
local tables first, then take the undo break, then write R3 and R2 (in that
order — R3 is below, so writing it first leaves R2's header row index valid).
Any failure during building aborts before the first write.

---

## 12. Commands

Extend `plugin/hive.lua`'s `sub_cmds` table. Every entry keeps the existing
lazy-`require` discipline.

| Subcommand | Args | Behaviour |
| --- | --- | --- |
| `open` | — | open/create the session buffer for the current target; `ui.split` |
| `target` | — | set the target to the current buffer/cursor explicitly |
| `refresh` | — | rebuild R2 and R3 now |
| `submit` | — | refresh, assemble, send; fill the hole |
| `accept` | `word`\|`line`\|`all` | §10.2; default `all` |
| `transplant` | — | §10.4 |
| `cancel` | — | kill the in-flight job |
| `complete` | `<prompt>` | unchanged, existing behaviour |
| `health` | — | unchanged |

Completion for `accept` returns `{ "word", "line", "all" }`; the existing
`complete` function already dispatches to a per-subcommand `complete`.

No default keymaps. Document these in `doc/hive.txt`:

```lua
vim.keymap.set("n", "<leader>ho", "<cmd>Hive open<cr>")
vim.keymap.set("n", "<leader>hs", "<cmd>Hive submit<cr>")
vim.keymap.set("n", "<leader>ha", "<cmd>Hive accept word<cr>")
```

