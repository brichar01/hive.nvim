# Buffer I/O and subprocesses — §1–§7

Part of the `hive.nvim` research notes — index: [`PLAN.md`](../../PLAN.md).
Section numbers are unchanged by the split; a `§n` cross-reference still resolves
via the section map in the index.

---

## 1. Getting text out of a buffer

Core's helper, `vim/lsp.lua:107`, is the correct general form:

```lua
function lsp._buf_get_full_text(bufnr)
  local line_ending = lsp._buf_get_line_ending(bufnr)     -- from 'fileformat'
  local text = table.concat(api.nvim_buf_get_lines(bufnr, 0, -1, true), line_ending)
  if vim.bo[bufnr].eol then text = text .. line_ending end
  return text
end
```

Three deliberate details: `strict_indexing = true` (the 4th arg); the separator
comes from `'fileformat'` via `format_line_ending` at `vim/lsp.lua:69`
(`unix`→`\n`, `dos`→`\r\n`, `mac`→`\r`), not a hardcoded `\n`; and the trailing
newline is appended **only if `'endofline'`** — `nvim_buf_get_lines` never reports
it, so a plain `concat` silently strips the final newline from every file. Core
implements the same logic independently at `vim/secure.lua:48`, which is a good
signal it is the idiom rather than an accident.

`gitsigns/lua/gitsigns/util.lua:128` is the only version found anywhere that also
handles **BOM** (`vim.bo.bomb`, `:148`) alongside `fileformat` (`:132`).

**What hive needs from this.** Only the line-ending part, and only at transplant
time. Region 3 is a *mid-file slice*, never a whole file, so `'endofline'` and
`'bomb'` do not apply — but the slice must be re-joined with the target buffer's
`'fileformat'` separator, not `\n`, or a `dos` buffer gains mixed line endings.
`IMPLEMENTATION.md` §6.6 says so explicitly, and says why the rest is skipped, so
that nobody "fixes" it later.

Also: **do not pass a line table as `stdin`.** `vim/_core/system.lua:178`
unconditionally appends `\n` after *every* element including the last, so it is
wrong for a `noeol` buffer and wrong for `dos`/`mac`. Concatenate first. gitsigns
comments the same conclusion at `git/repo.lua:916`: *"Concatenate the lines into a
single string to ensure EOL is respected"*.

---

## 2. Sending it — `vim.system()`

`vim.system` (`vim/_core/system.lua`) is the single chokepoint. `hive.curl`
already uses the right form — `stdin = <string>`, written byte-exact then closed
automatically (`:456`, `obj:write(towrite)` then `obj:write(nil)`).

Sharp edges that matter, all verified on disk:

- **`vim.system` throws** if the command cannot be run — bad binary, bad `cwd` —
  unlike `jobstart`'s negative channel id. `vim/lsp/_transport.lua:51` wraps it in
  `pcall` for exactly this reason. nvim-treesitter hit the hazard and wrote it up
  at `install.lua:102`: *"vim.system throws an error when uv.spawn fails… This
  kills the coroutine, so the async'ed call simply hangs."* **An unguarded throw
  inside a coroutine is a silent hang, not an error.** conform does the same at
  `runner.lua:405` and surfaces it as its own `VIM_SYSTEM` error code (`:470`).
- **Writes are fire-and-forget.** `uv_write` is called with no callback and no
  return check, so there is no backpressure and no write-error reporting.
  (Contrast `vim/lsp/_transport.lua:151`, which *does* check the error on the TCP
  path.)
- **`text = true` only normalizes `\r\n`→`\n`, and only on the buffered path.** If
  `stdout` is a *function*, `text` is ignored entirely
  (`vim/_core/system.lua:215`, the `type(output) == 'function'` branch at `:223`).
  `{ text = true, stdout = fn }` does no normalization — a real trap the moment
  streaming is added.
- **`on_exit` runs in a fast/libuv context**, so `vim.schedule` is mandatory
  before touching buffers (`vim/net.lua:95`, `vim/pack/_lsp.lua:225`).
  `hive.curl` already gets this right.
- **`:wait()` is `vim.wait(…, fast_only = true)`** (`:138`, `:145`) — no Lua
  callbacks or autocmds run while blocked, and `<C-c>` does not interrupt. On
  timeout the exit code is rewritten to 124 (`:374`). conform's
  `vim.wait(remaining, fn, 5)` at `runner.lua:709` is the interruptible
  alternative, distinguishing `wait_reason == -1` (timeout) from interruption.
- **`vim.system` returns a `SystemObj`.** Keeping it is the only way to cancel.

---

## 3. Long-lived framed peers — *retired*

Was: `vim/lsp/_transport.lua` + `vim/lsp/rpc.lua` as the blueprint for keeping a
model process alive — `stdin = true`, `Content-Length` framing, a
`vim._core.stringbuffer` accumulator, a coroutine parser tolerant of arbitrary
chunk boundaries, and a 10-entry ring buffer for pre-connect messages.

Retired because v1 is one-shot HTTP per request. Revisit only if hive ever hosts
a model process; the two files above are still the right blueprint, and NDJSON is
the cheap framing (provably safe because `vim.json.encode` escapes newlines).

---

## 4. Applying results back to a buffer

`vim.lsp.util.apply_text_edits` (`vim/lsp/util.lua:303`) is the reference
implementation and mostly a catalogue of what goes wrong. The parts hive uses:

- **Edits are sorted last-to-first** (`:348`) so earlier positions stay valid,
  with a stable `_index` tiebreak (`:355`, stamped at `:327`). Any hand-rolled
  multi-hunk application must do the same — `IMPLEMENTATION.md` §10.4 does.
- **Local marks are saved and restored** around the edits (`:358`, `:480`),
  because `nvim_buf_set_lines` deletes them.
- **Incoming text is CRLF-normalized** at `:367` (`gsub(newText, '\r\n?', '\n')`).
- **`nvim_buf_set_text` for ranges, not wholesale `set_lines`** — narrower edits
  mean less undo and extmark churn. §12.7 measures how much that matters.
- **Column offsets go through the negotiated position encoding** (`:282`
  `get_line_byte_from_position` → `vim.str_byteindex`), never treated as byte
  offsets. lua_ls negotiates **utf-16** here, so this conversion is mandatory for
  anything built from `documentSymbol` ranges.
- **`'endofline'`/`'fixeol'`/`'binary'` are honored on the way back in** (`:490`).

**Staleness guard.** The pattern appears twice in core and is required for
anything async that writes to a buffer:

```lua
-- vim/lsp/completion.lua:905
local changedtick = vim.b[bufnr].changedtick
... if changedtick ~= vim.b[bufnr].changedtick then return end
```

**Minimal-diff application.** `vim.text.diff` (`vim/text.lua:75`, an xdiff
wrapper) turns old/new text into a small edit set:

```lua
vim.text.diff('a\n', 'b\nc\n', { result_type = 'indices' })  --> { {1,1,1,2} }
```

`algorithm` supports `myers`/`minimal`/`patience`/`histogram`.

---

## 5. Debounce discipline

One design decision from `vim/lsp/_changetracking.lua` is worth copying and the
rest of incremental sync is not. At `:359`:

```lua
-- This must be done immediately and cannot be delayed
-- The contents would further change and startline/endline may no longer fit
local changes = incremental_changes(...)
table.insert(buf_state.pending_changes, changes)
...
if debounce == 0 then send_changes(...) else timer:start(debounce, 0, ...) end
```

**The expensive synchronous work is done eagerly; only the network write is
debounced** (150 ms default). And because a debounce means the document can be
stale, `Client:request` calls `changetracking.flush()` first
(`vim/lsp/client.lua:732`) so no request ever races pending edits.

Both halves apply directly: hive's treesitter extraction costs 0.09 ms (§11.5) so
it should not be debounced at all, while the LSP round trip and the model request
should be — and a submit must flush a pending refresh first.

*Retired from this section:* incremental sync itself (`vim/lsp/sync.lua`,
~400 lines of encoding math), and the observation that
`textDocument/formatting` sends no text at all because the server already has the
document. Neither applies to a stateless HTTP request.

---

## 6. Treesitter never touches a subprocess — *retired*

Was: grepping `vim/treesitter/` for `vim.system|jobstart|uv.spawn|chansend`
returns zero hits; `LanguageTree` holds `_source` as a *bufnr*
(`languagetree.lua:104`) and the C parser reads the buffer through a callback, so
nothing is ever serialized. The lesson — if a tool can be a library, the buffer
never needs serializing — is true and settled; hive's model is over HTTP by
necessity.

One detail survives into §11.2: `get_node_text` (`treesitter.lua:232`) carries an
`end_col == 0` newline fixup at `:205`, the same trailing-newline bug class as §1.

---

## 7. Core's subprocess inventory — *retired*

Was: a table of every `vim.system`/`jobstart` call site in core Lua plus the
bundled Vimscript filters (`rustfmt.vim`, `provider/clipboard.vim`), including a
latent bug at `vim/provider/health.lua:76` where `stdin:find('^%s$')` matches only
a single whitespace character so real payloads are never sent.

Retired: interesting, not actionable. hive has exactly one subprocess and §2
covers it.

