# Buffer → CLI: how Neovim core and other plugins do it

## Context

You asked how other Neovim plugins send buffer contents to command-line tools,
starting from upstream LSP and treesitter. The reason it matters here: your
`hive.nvim` (`/home/benri/src/hive.nvim`) already shells out to `curl` via
`vim.system()` with `--data-binary @-` and `stdin = req.body`, but so far the
payload is a *string prompt* typed at `:Hive complete`. Sending a **buffer** is
the next step, and that is where the subtle correctness work lives.

This document is a research write-up: the patterns, where they live in real
code, and the tradeoffs. §1–§8 were read on this machine — `$VIMRUNTIME` =
`/usr/local/share/nvim/runtime` (NVIM v0.12.4) and `~/.local/share/nvim/lazy/`.
§9 covers `copilot.lua`, `supermaven-nvim`, `codecompanion.nvim` and `avante.nvim`,
which are not installed here and were read from their GitHub sources — these are
the plugins whose entire purpose is shipping buffer text to an external process,
so they are the closest analogues to where hive is heading.

§11 is a second question, added later: which *part* of a buffer to send. It
was measured on this machine against NVIM v0.12.4.

---

## The three shapes

Almost every plugin that moves buffer text to an external tool picks one of
three shapes. Distinguishing them first makes the rest of the code obvious:

| Shape | Process lifetime | Payload | Canonical example |
| --- | --- | --- | --- |
| **One-shot filter** | one process per request | whole buffer or a range, stdin closed immediately | `conform.nvim`, `nvim-lint`, `hive.curl` today |
| **Long-lived framed peer** | one process for the session | many messages, length-prefixed, incremental | `vim.lsp` |
| **No process at all** | in-process library | buffer read directly at the C level | `vim.treesitter` |

Your `hive.curl` is squarely shape 1. If you later keep a model process alive,
shape 2 is the blueprint.

---

## 1. Getting the text out of the buffer

This is the part almost everyone gets wrong, and core has a single correct
helper worth copying verbatim — `vim/lsp.lua:107`:

```lua
function lsp._buf_get_full_text(bufnr)
  local line_ending = lsp._buf_get_line_ending(bufnr)
  local text = table.concat(api.nvim_buf_get_lines(bufnr, 0, -1, true), line_ending)
  if vim.bo[bufnr].eol then
    text = text .. line_ending
  end
  return text
end
```

Three deliberate details:

1. **`strict_indexing = true`** (the 4th arg), not `false`.
2. **The separator comes from `'fileformat'`, not a hardcoded `\n`** —
   `vim/lsp.lua:69`:
   ```lua
   local format_line_ending = { ['unix'] = '\n', ['dos'] = '\r\n', ['mac'] = '\r' }
   ```
3. **The trailing newline is appended only if `'endofline'` is set.**
   `nvim_buf_get_lines` never reports it, so a plain `table.concat` silently
   strips the final newline from every file.

Core implements this twice, independently — `vim/secure.lua:48` hashes a buffer
for the trust database with the same `concat` + `'endofline'` logic (a little
less thorough: unix vs dos only). That repetition is a good signal it's the
idiom rather than an accident.

Whole-buffer serialization is used at `vim/lsp/client.lua:1150` (`didOpen`) and
`vim/lsp/_changetracking.lua:318` (Full sync). Note
`vim/lsp/_changetracking.lua:180` wraps it in `vim.func._memoize('concat', ...)`
so N attached clients pay for one serialization.

**Related:** `vim/lsp/util.lua:192` `get_lines()` reads *unloaded* buffers by
`uv.fs_open`/`fs_read` on the file directly, to avoid triggering buffer-read
autocmds — falling back to `bufload()` for non-`file://` URIs. It assumes `\n`,
so it would mishandle a `mac`-format file.

---

## 2. Sending it — `vim.system()` stdin semantics

`vim.system` is the single chokepoint for subprocesses in modern core
(`vim/_core/system.lua`; it moved from `vim/_system.lua`). Its `stdin` option
takes three forms, and the difference matters:

```lua
--- @field stdin? string|string[]|true
```

- **`stdin = "…"` (string)** — written byte-exact, then stdin is closed
  automatically (`vim/_core/system.lua:456`). This is what `hive.curl` already
  does, and it is the right choice for a one-shot filter.
- **`stdin = { "line", "line" }` (table)** — convenient but lossy.
  `vim/_core/system.lua:178`:
  ```lua
  if type(data) == 'table' then
    for _, v in ipairs(data) do
      stdin:write(v)
      stdin:write('\n')      -- after EVERY element, including the last
    end
  ```
  It unconditionally appends `\n` per element, so it is wrong for a `noeol`
  buffer and wrong for `fileformat=dos`/`mac`. Passing
  `nvim_buf_get_lines(...)` straight through is tempting and subtly incorrect.
- **`stdin = true`** — opens a persistent pipe you drive with
  `SystemObj:write(...)`, closing it with `obj:write(nil)`. This is shape 2.

Other sharp edges found in the implementation:

- **Writes are fire-and-forget.** `uv_write` is called with no callback and no
  return check, so there is **no backpressure and no write-error reporting**.
  (Contrast `vim/lsp/_transport.lua:151`, which *does* check the error on the
  TCP path.)
- **Closing stdin is a 3-step async dance** (`write('') → shutdown → close`)
  with an acknowledged upstream caveat at `vim/_core/system.lua:187`:
  *"apparently shutdown doesn't behave this way"*.
- **`text = true` only normalizes `\r\n` → `\n`, and only on the buffered
  path.** If you pass a *function* for `stdout`, `text` is ignored entirely
  (`vim/_core/system.lua:223`). `{ text = true, stdout = fn }` does no
  normalization — a real trap.
- **`on_exit` runs in a fast/libuv context**, so `vim.schedule` is mandatory
  before touching buffers — see `vim/net.lua:94` and
  `vim/pack/_lsp.lua:225` (`vim.schedule_wrap(on_exit)`). `hive.curl` already
  gets this right.
- **`:wait()` is `vim.wait(..., fast_only = true)`** — no Lua callbacks or
  autocmds run while blocked. Fine for health checks; `man.lua:15` pairs it with
  `timeout = 10000`. On timeout the exit code is rewritten to 124
  (`vim/_core/system.lua:371`).
- **`vim.system` throws** if the command can't be run, unlike `jobstart`'s
  negative channel id — hence the `pcall` at `vim/lsp/_transport.lua:51`.

`vim.system` vs `jobstart`: `vim.system` is pure libuv and hands you raw byte
chunks; `jobstart` hands you line-split tables and needs `chansend`/`chanclose`
for stdin. Core Lua uses `jobstart` in exactly **one** place
(`vim/provider/health.lua:67`) — and that call site has a latent bug worth
knowing about, since it's the closest core-Lua analogue of "feed text to a
filter":

```lua
if stdin:find('^%s$') then          -- vim/provider/health.lua:76
  vim.fn.chansend(jobid, stdin)
end
```

`'^%s$'` matches only a string that is *exactly one whitespace character*, so
real payloads are never sent. It's a mechanical translation of the old
Vimscript `=~# '^\s$'`, and it never `chanclose(jobid, 'stdin')` either.

### Async without blocking: `vim._async`

`vim.pack` wraps `vim.system` in a coroutine so it reads like synchronous code
— `vim/pack.lua:247`:

```lua
local out = async.await(3, vim.system, cmd, sys_opts)
async.await(1, vim.schedule)   -- explicitly leave the fast context
```

This is core's native equivalent of `plenary.async` / gitsigns' await
abstraction. Cost: the whole call chain has to be `@async`.

---

## 3. Reading results back

For a one-shot filter, buffered `stdout` is enough. For a stream, core's LSP
transport shows the full pattern.

**Spawn** — `vim/lsp/_transport.lua:51`, notably via `vim.system`, not
`uv.spawn`:

```lua
local ok, sysobj_or_err = pcall(vim.system, cmd, {
  stdin = true,        -- persistent pipe, written incrementally
  stdout = on_read,    -- streaming callback, NOT buffered
  stderr = on_stderr,
  cwd = ..., env = ..., detach = detached,
}, function(obj) on_exit(obj.code, obj.signal) end)
```

with ENOENT sniffed out of the error to produce the familiar *"language server
is either not installed, missing from PATH, or not executable"* message
(`:62`). `terminate()` is `sysobj:kill(15)`; stderr is only logged (`:34`).

**Framing** — length-prefixed, `vim/lsp/rpc.lua:11`:

```lua
local function format_message_with_content_length(message)
  return table.concat({ 'Content-Length: ', tostring(#message), '\r\n\r\n', message })
end
```

**Reassembly** — a coroutine parser (`vim/lsp/rpc.lua:196`) fed by
`create_read_loop` (`:220`), accumulating into `vim._core.stringbuffer`
specifically to avoid O(n²) `s = s .. chunk`. Chunk boundaries land anywhere,
so the parser yields for more data mid-header and mid-body. The header parser
(`:30`) is a hand-rolled byte state machine, deliberately tolerant of servers
that dump log lines to stdout.

Read-loop error handling (`:225`) is a clean three-way split: `err` →
`READ_ERROR`; `chunk == nil` (EOF) → `on_exit()`; parser exception →
`INVALID_SERVER_MESSAGE`, which at `:606` terminates the transport. Every
dispatcher is `schedule_wrap`ped (`:584`) so handlers never run in fast context.

A queueing detail worth stealing: because `connect()` returns before the socket
is up, outgoing messages buffer in a **ring buffer of 10**
(`vim/lsp/_transport.lua:104`) and flush on connect. Silent overflow past 10.

---

## 4. Applying results back to the buffer

`vim.lsp.util.apply_text_edits` (`vim/lsp/util.lua:303`) is the reference
implementation, and it's mostly a catalogue of things that go wrong:

- **Edits are sorted last-to-first** (`:348`) so earlier positions stay valid,
  with a stable `_index` tiebreak.
- **Local marks are saved and restored** around the edits (`:359`, `:480`),
  because `nvim_buf_set_lines` deletes them.
- **Incoming text is CRLF-normalized** (`:369`:
  `gsub(newText, '\r\n?', '\n')`), plus a dedicated hack at `:401` for
  clangd-on-Windows returning a `\r` inside a line.
- **`nvim_buf_set_text`** for ranges, not wholesale `set_lines` — narrower
  edits mean less undo/extmark churn.
- **`'endofline'` / `'fixeol'` / `'binary'` are honored on the way back in**
  (`:489`):
  ```lua
  local fix_eol = has_eol_text_edit
  fix_eol = fix_eol and (vim.bo[bufnr].eol or (vim.bo[bufnr].fixeol and not vim.bo[bufnr].binary))
  fix_eol = fix_eol and get_line(bufnr, max - 1) == ''
  if fix_eol then api.nvim_buf_set_lines(bufnr, -2, -1, false, {}) end
  ```
- **Column offsets are converted through the negotiated position encoding**
  (`:282` `get_line_byte_from_position` → `vim.str_byteindex`), never treated
  as byte offsets.

**Staleness guard.** The pattern for "don't apply a result to a buffer that
moved on" appears twice:

```lua
-- vim/lsp/buf.lua:31 — ctx_is_valid
or api.nvim_get_current_buf() ~= bufnr
or vim.lsp.util.buf_versions[bufnr] ~= ctx.version

-- vim/lsp/completion.lua:905
local changedtick = vim.b[bufnr].changedtick
... if changedtick ~= vim.b[bufnr].changedtick then return end
```

Anything async that writes to a buffer needs one of these. `vim/lsp/buf.lua:585`
also documents outright that editing during async formatting is unsafe.

**Minimal-diff application.** `vim.text.diff` (`vim/text.lua:77`, an xdiff
wrapper over `vim.diff`) is the built-in for turning "old text / new text" into
a small set of edits instead of replacing the whole buffer:

```lua
vim.text.diff('a\n', 'b\nc\n', { result_type = 'indices' })  --> { {1,1,1,2} }
```

`algorithm` supports `myers`/`minimal`/`patience`/`histogram`.

---

## 5. What LSP sends, and what it *doesn't*

Two contrasts that are easy to miss:

**Formatting sends no text at all.** `vim.lsp.util.make_formatting_params`
(`vim/lsp/util.lua:2240`) sends only the URI and options — `tabSize` from
`get_effective_tabstop()` and `insertSpaces` from `vim.bo.expandtab`. The
server already has the document from `didOpen`/`didChange`. This is the payoff
of shape 2: text is synced once, then requests are tiny.

**Incremental sync is where the complexity is.**
`vim/lsp/_changetracking.lua:86` keeps a *shadow copy* of the last-sent buffer
state and patches only the changed slice
(`nvim_buf_get_lines(bufnr, firstline, new_lastline, true)` at `:90`),
double-buffering `lines`/`lines_tmp` to cut GC churn. Clients are grouped by
`(sync_kind, position_encoding)` (`:47`) so the diff is computed once per
distinct pair.

The dispatch split at `:340` is the interesting design decision:

```lua
-- This must be done immediately and cannot be delayed
-- The contents would further change and startline/endline may no longer fit
local changes = incremental_changes(...)
table.insert(buf_state.pending_changes, changes)
...
if debounce == 0 then send_changes(...) else timer:start(debounce, 0, ...) end
```

**The diff is computed eagerly and synchronously inside `on_lines`; only the
RPC write is debounced** (150 ms default). Because a debounce means the
document can be stale, `Client:request` calls `changetracking.flush()` first
(`vim/lsp/client.lua:731`) so no request ever races pending edits.

Encoding math lives in `vim/lsp/sync.lua`: `align_end_position` (`:58`) snaps
byte offsets to codepoint boundaries, and `compute_range_length` (`:334`)
accounts for line-ending *width* per encoding. Roughly 400 lines of core code
to make incremental sync correct — worth knowing before choosing it.

---

## 6. Treesitter: the instructive non-answer

You asked about treesitter specifically, and the answer is that it never
touches a subprocess. Grepping `vim/treesitter/` for
`vim.system|jobstart|uv.spawn|systemlist|chansend` returns **zero hits** —
parser compilation lives in `nvim-treesitter`, not core.

Instead, `LanguageTree` holds `_source` as a *bufnr*
(`vim/treesitter/languagetree.lua:104`, `:143`) and hands it straight to the C
parser, which reads the buffer through a callback — no serialization at all:

```lua
-- vim/treesitter/languagetree.lua:434
local parse_time, tree, tree_changes = tcall(
  self._parser.parse, self._parser, self._trees[i], self._source, true, thread_state.timeout)
```

Incremental updates arrive as byte ranges via `_on_bytes` → `_edit`
(`:1247`, `:1163`), the same shape as LSP's `didChange` but with no wire
format. Long parses are time-sliced by **coroutine yield**
(`:445`), not by a subprocess.

`vim/treesitter.lua:216` does use `nvim_buf_get_text` + `table.concat(lines,
'\n')` in `get_node_text`, with a careful `end_col == 0` newline fixup at
`:185` — the same trailing-newline class of bug as §1, in miniature.

The lesson for hive: if a tool can be a library, the buffer never needs
serializing. Once it's a process, you own the encoding, the framing, and the
staleness problem.

---

## 7. Full inventory of core subprocess call sites

| File:line | Mechanism | stdin | Sync |
| --- | --- | --- | --- |
| `vim/lsp/_transport.lua:51` | `vim.system{stdin=true, stdout=cb}` | persistent pipe, incremental | async |
| `vim/_watch.lua:285` | `vim.system` + `inotifywait --monitor`, streaming cbs, `obj:kill(2)` to cancel | — | async, long-lived |
| `vim/net.lua:81` | `vim.system{'curl',…}`, buffered, `job:kill('sigint')` | — | async |
| `vim/pack.lua:247` | `async.await(3, vim.system, …)` | — | async-as-sync |
| `vim/pack/_lsp.lua:225` | `vim.system(…, vim.schedule_wrap(on_exit))` | — | async |
| `vim/ui.lua:204` | `vim.system{text=true, detach=true}` for `gx` | — | async |
| `vim/health/*`, `vim/provider/*`, `vim/_core/editor.lua:69`, `man.lua:15` | `vim.system(…):wait()` | — | **blocking** |
| `vim/provider/health.lua:67` | `jobstart` + `chansend` + `jobwait` (only `jobstart` in core Lua) | `chansend` | blocking |

Where core *actually* pipes buffer text to a filter, it's the bundled
Vimscript, and both idioms are worth seeing:

**`systemlist(cmd, lines)`** — blocking, list-in/list-out —
`autoload/rustfmt.vim:139`:

```vim
let l:buffer = getline(1, '$')
silent let out = systemlist(l:command, l:buffer)
```

The surrounding machinery is the real lesson: stderr redirected to a tempfile
by the shell because `system()` merges streams (`:135`); `lchdir` to the file's
directory first (`:144`); results applied via `s:DeleteLines(...)` +
`setline(1, content)` rather than `%d` to preserve undo and marks (`:176`);
`silent undojoin` when called from `BufWritePre` (`:171`);
`winsaveview`/`winrestview` (`:126`, `:231`); errors scraped into a location
list (`:184`).

Also `autoload/provider/clipboard.vim:39` —
`systemlist(a:cmd, a:0 ? a:1 : [''], 1)`. That third arg is `keepempty=1`, and
it's what preserves trailing-newline fidelity.

**`jobstart` + `jobsend` + `jobclose`** — async, streamed —
`autoload/provider/clipboard.vim:316`:

```vim
call jobsend(jobid, a:lines)
call jobclose(jobid, 'stdin')
" xclip does not close stdout when receiving input via stdin
if selection.argv[0] ==# 'xclip'
  call jobclose(jobid, 'stdout')
endif
```

**Closing stdin is mandatory** — most filters emit nothing until EOF. And some
tools hold streams open in surprising ways, hence the `xclip` special case.

The generic `:{range}!cmd` / `'formatprg'` / `'equalprg'` filter is implemented
in C (`ex_cmds.c`) via tempfiles and `'shell'`, not reachable from Lua.

---

## 8. Third-party plugins

Surveyed `~/.local/share/nvim/lazy/` (33 entries). `~/.local/share/nvim/site/pack`
and `~/.config/nvim/pack` don't exist, so that's the whole plugin set.
**Not installed:** `nvim-lint`, `fzf-lua`, `copilot.lua`, `codecompanion`,
`avante`, `supermaven`. Everything in this section is from disk; the four AI
plugins were read from their GitHub sources instead and are covered separately in
§9. `nvim-lint` and `fzf-lua` remain uncovered.

### 8.1 conform.nvim — the reference implementation

`conform.nvim/lua/conform/runner.lua` is the most complete buffer→CLI code
anywhere on this machine. Worth reading end to end; the highlights:

**Payload** (`runner.lua:369`) — same `'eol'` idea as core, done on the list:

```lua
local add_extra_newline = vim.bo[bufnr].eol
if add_extra_newline then table.insert(input_lines, "") end
buffer_text = table.concat(input_lines, "\n")
if add_extra_newline then table.remove(input_lines) end
```

It joins with `"\n"` unconditionally — formatters always get LF — and defers the
CRLF question to write-back. `input_lines` is mutated then restored, because
`format_lines_async` chains formatters over the same table.

**Spawn** (`runner.lua:402`):

```lua
local ok, job_or_err = pcall(vim.system, cmd, {
  cwd = cwd, env = env,
  stdin = config.stdin and buffer_text or nil,
  text = true,
}, vim.schedule_wrap(function(result) ... end))
```

`pcall` because `vim.system` *throws* on spawn failure — surfaced as its own
`VIM_SYSTEM` error code (`:468`). Then `vim.split(result.stdout, "\r?\n")`
(`:415`), tolerating a formatter that emits CRLF into a `unix` buffer.
`exit_codes` is per-formatter configurable (`:402`) since some formatters exit
non-zero on "found issues".

**Cancellation via pid stamp** — `vim.b[bufnr].conform_pid` is set at `:476`,
and a new run kills the old one at `:548`:

```lua
if prev_pid and opts.exclusive then
  if uv.kill(prev_pid) == 0 then log.info("Canceled previous format job") end
end
```

If a job fails *and* the pid no longer matches, it reports `INTERRUPTED` rather
than `RUNTIME` (`:450`) — the error is attributed correctly.

**Staleness guard** (`runner.lua:556`) — capture, compare, discard:

```lua
local changedtick = vim.b[bufnr].changedtick
...
if not vim.api.nvim_buf_is_valid(bufnr) or changedtick ~= util.buf_get_changedtick(bufnr) then
  err = { code = errors.ERROR_CODE.CONCURRENT_MODIFICATION, ... }
```

`CONCURRENT_MODIFICATION` is logged at INFO, not ERROR (`errors.lua:23`), so a
racing edit doesn't spam notifications. And there's a genuinely non-obvious
shutdown edge case at `util.lua:180`:

```lua
-- changedtick gets set to -1 when vim is exiting. We have an autocmd that should store it in
-- last_changedtick before it is set to -1.
if changedtick == -1 then return vim.b[bufnr].last_changedtick or -1
```

fed by a `BufWinLeave` autocmd (`init.lua:176`). Without it, `format_after_save`
on `:wq` would *always* discard its result.

**Write-back is a diff, never a full replace** (`runner.lua:182`
`apply_format`):

1. Append `""` to both old and new text before diffing, because
   `vim.text.diff`'s `indices` result type has no way to signal an
   eol-only change (`:199`).
2. **Abort on suspicious empty output** (`:210`):
   ```lua
   -- Abort if output is empty but input is not ... to hack around oddly behaving
   -- formatters (e.g black outputs nothing for excluded files).
   if new_text:match("^%s*$") and not original_text:match("^%s*$") then
   ```
3. `vim.text.diff(..., { result_type = "indices", algorithm = "histogram" })`
   (`:219`).
4. Each hunk → an LSP `TextEdit`, **shrunk by common byte prefix/suffix**
   (`:92`, `:120`) so extmarks and marks inside the untouched parts of a
   changed line survive.
5. `pcall(vim.cmd.undojoin)` — *"may fail if after undo, Vim:E790"* (`:283`) —
   then `vim.lsp.util.apply_text_edits(text_edits, bufnr, "utf-8")`, inheriting
   all the §4 machinery for free.

The newline written back is the buffer's, via `util.buf_line_ending`
(`util.lua:259`), not `\n`.

**Range formatting** has two mechanisms: native `range_args` with byte offsets
from `nvim_buf_get_offset` (stylua's `--range-start/--range-end`,
`formatters/stylua.lua:16`), and an "aftermarket" fallback that formats the
whole buffer and applies only hunks overlapping the range (`runner.lua:248`) —
with a nice subtlety at `:274`, extending the range so paired delete/insert
hunks aren't half-applied.

**Sync mode** (`runner.lua:671`) uses `vim.wait(remaining, fn, 5)` on a done
flag rather than `:wait()`, so the event loop keeps turning and `<C-c>` can
interrupt; it distinguishes `wait_reason == -1` (timeout) from interruption.

### 8.2 gitsigns.nvim — the most correct buffer→bytes function

`gitsigns/lua/gitsigns/util.lua:128` handles one thing more than core does —
**BOM**:

```lua
function M.buf_lines(bufnr)
  -- nvim_buf_get_lines strips carriage returns if fileformat==dos
  local buftext = vim.api.nvim_buf_get_lines(bufnr, 0, -1, false)
  local dos = vim.bo[bufnr].fileformat == 'dos'
  if dos then
    for i = 1, #buftext - 1 do buftext[i] = buftext[i] .. '\r' end
  end
  if vim.bo[bufnr].endofline then
    if dos then buftext[#buftext] = buftext[#buftext] .. '\r' end
    buftext[#buftext + 1] = ''
  end
  if vim.bo[bufnr].bomb then
    buftext[1] = add_bom(buftext[1], vim.bo[bufnr].fileencoding)
  end
  return buftext
end
```

Three real buffer→stdin call sites: staging a hunk (`git.lua:211`, generated
patch → `git apply --cached --unidiff-zero -`), staging arbitrary lines
(`git/repo.lua:913`, → `git hash-object -w --path <p> --stdin`), and blaming an
unsaved buffer (`git/blame.lua:262`, → `git blame --incremental --contents -`).

The `hash-object` one is the tersest good example, and note *why* it concatenates
rather than passing the list:

```lua
-- Concatenate the lines into a single string to ensure EOL is respected
local text = table.concat(lines, '\n')
local res = self:command({ 'hash-object', '-w', '--path', path, '--stdin' }, { stdin = text })[1]
```

Every git call goes through one hardened wrapper (`git/cmd.lua:12`):
`--no-pager --no-optional-locks --literal-pathspecs`, `-c gc.auto=0`
(*"Disable auto-packing which emits messages to stderr"*), `color.ui=false`, and
`LC_ALL=C LANGUAGE=C` so **stderr pattern-matching survives a translated git**.
It also drops the trailing empty string after splitting stdout (`:63`).

Its staleness guard is a *retry*, not a discard (`cache.lua:155`):

```lua
local tick = vim.b[bufnr].changedtick
local blame, commits = self.git_obj:run_blame(contents, lnum0, ...)
async.schedule()
if not api.nvim_buf_is_valid(bufnr) then return {}, {} end
if vim.b[bufnr].changedtick == tick then return blame, commits, lnum0 == nil end
```

plus a detach guard just above — *"the buffer may have been detached (and the
git object closed) while an earlier blame was in flight"*.

The async layer (`gitsigns/async.lua`) is a coroutine Task class whose
`M.wrap(argc, func)` (`:486`) turns `vim.system` into something awaitable —
`local asystem = async.wrap(3, ...)` at `git/cmd.lua:5`. `M.schedule =
M.wrap(1, vim.schedule)` (`:498`) must be awaited before touching the API.
Cancellation propagates to children via `_current_child` (`:47`), so closing a
task kills the in-flight process. Same idea as core's `vim._async` (§2).

Also worth noting: gitsigns' *default* diff path avoids the subprocess entirely
— `diff_int.lua:20` runs `vim.text.diff` on a `uv.new_work` thread pool with
`string.dump` + mpack marshalling. The external-diff path (`diff_ext.lua`) uses
tempfiles, and contains two hard-won comments: `tmpname` must not be called in a
fast context (`:29`), and `-c core.safecrlf=false` suppresses *"LF will be
replaced by CRLF"* warnings on CRLF repos (`:41`).

### 8.3 The tempfile fallback — and why it isn't in `/tmp`

About a third of conform's formatter definitions set `stdin = false` (`buf`,
`shellcheck`, `php_cs_fixer`, …), switching the runner to in-place-file mode.
The path construction (`runner.lua:514`) is the interesting part:

```lua
template = config.tmpfile_format or ".conform.$RANDOM.$FILENAME"
```

written **next to the real file**, not in `/tmp`, so project-relative config
discovery (`.stylua.toml`, `.eslintrc`, `tsconfig.json`) still works; dotfile
prefix to hide it; `$RANDOM` to avoid collisions between concurrent buffers.
`phpcbf` overrides it to a non-dot name (`formatters/phpcbf.lua:15`) because
PHP_CodeSniffer skips dotfiles.

Cleanup is guaranteed on every exit path via `util.wrap_callback` (`:380`), the
file is created `0700` so a copy of your source isn't world-readable, and
`dir_manager` removes any parent dirs it had to create, deepest-first. For
unnamed or `nofile` buffers it fabricates `<cwd>/unnamed_temp.<ext>` from a
filetype→extension table (`:498`) so extension-sensitive tools still work.

### 8.4 Streaming and cancellation — telescope

Not buffer→stdin (telescope has no writer path at all — `async_job_finder.lua:43`
literally `error "async_job_finder.writer is not yet implemented"`), but the read
side is the best local reference for a firehose.

`LinesPipe:read()` (`telescope/_.lua:127`) is a **`read_start` → `read_stop` per
chunk** pump bridged into a coroutine:

```lua
self.handle:read_start(function(err, data)
  assert(not err, err)
  self.handle:read_stop()
  read_tx(data)
  if data == nil then self.eof_tx() end
end)
return read_rx()
```

That gives real backpressure — nothing is read until the consumer asks, so `rg`
output can't balloon memory. `:iter()` (`:144`) splits on `\n` incrementally,
carrying the partial tail across chunk boundaries, and strips all CR.
`BasePipe:close(force)` with `force = false` awaits EOF first — *"ensures we
don't end up with weird race conditions"*.

Cancellation is two-layered: the job is killed on every keystroke
(`async_job_finder.lua:29`), *and* a monotonic `find_id` generation counter
(`pickers.lua:1401`) drops results from a stale generation — returning `true`
from the processor also breaks the consuming loop, so the process stops being
drained.

neo-tree's variant (`filter_external.lua:226`) enforces a single-job invariant
(`running_jobs:for_each(kill_job)` before starting) and follows `job:shutdown()`
with a hard `kill -9` / `taskkill /F /T`, because `fd` may ignore SIGTERM. It
sets `enable_recording = false` on the plenary Job so results aren't
accumulated in memory.

### 8.5 Chunking a large buffer — blink.cmp

blink.cmp ships nothing to an external process, but its gathering layer is the
best local model for "this buffer is too big to send in one piece".

Size budgeting (`sources/buffer/utils.lua:16`) uses `nvim_buf_get_offset` to get
a byte count without concatenating, then sorts buffers by a configurable
`retention_order` and greedily fills a budget — 20 KB sync / 200 KB async /
500 KB total by default. Then a three-tier strategy (`parser.lua:106`):

```lua
if len < opts.max_sync_buffer_size then        -- "should take less than 2ms"
  return parser.run_sync(buf_text)
elseif len < opts.max_async_buffer_size then  -- "should take less than 10ms"
  ...
else
  return async.task.identity({})              -- Too big, skip
end
```

The chunker (`parser.lua:64`) has a soft min (2000 bytes) and hard max (4000),
walks forward to a whitespace boundary so it never splits mid-word,
`vim.schedule`s between chunks to keep the UI responsive, and checks a cancel
flag at the top of each chunk. That's the shape to copy for streaming a large
buffer out in pieces.

It also uses `changedtick` as a *cache key* rather than just a guard
(`sources/buffer/init.lua:130`).

### 8.6 Incremental stdin writes need `uv.spawn`

`vim.system`'s `stdin` string is one-shot. When you need to write a prologue and
then a payload, plugins drop to raw pipes — mason.nvim feeds a shell script over
stdin instead of `-c` (`mason-core/installer/managers/common.lua:107`):

```lua
async_uv.write(stdin, "set -euxo pipefail;\n")
async_uv.write(stdin, build.run)
async_uv.shutdown(stdin)
async_uv.close(stdin)
```

plenary's `Job.writer` (`plenary/job.lua:417`) does the list form manually, and
gets the ordering right in a way that's easy to miss — **close inside the write
completion callback**, not right after the write:

```lua
self.stdin:write("\n", function()
  pcall(self.stdin.close, self.stdin)
end)
```

A plenary `Job`'s writer can be another `Job` (`:378`, `self.stdin =
self.writer.stdout`), giving real shell-style pipelines.

Two independent implementations — gitsigns' `vim.system` backport
(`system/compat.lua:244`) and mason (`mason-core/process.lua:207`) — both
converge on a `uv.new_check()` that waits until all three pipes are closing
before reporting completion, so no output is lost. Mason's comment: *"ensure all
pipes are closed, for I am a qualified plumber"*.

### 8.7 The `vim.system` throws trap, again

nvim-treesitter hit exactly the hazard conform's `pcall` solves, and wrote it up
(`nvim-treesitter/lua/nvim-treesitter/install.lua:98`):

```lua
---vim.system throws an error when uv.spawn fails, in particular if cmd or cwd
---does not exist. This kills the coroutine, so the async'ed call simply hangs.
local function system_wrap(_cmd, _opts, on_exit)
  local ok, ret = pcall(vim.system, _cmd, _opts, on_exit)
  if not ok then
    on_exit({ code = 125, signal = 0, stdout = '', stderr = ret })
    return nil
  end
  return ret
end
```

If you `async.wrap` `vim.system`, an unguarded throw kills the coroutine and the
await never returns — a silent hang rather than an error.

### 8.8 Blocking `vim.fn.system` is still everywhere

Worth knowing which neighbours block your editor: neo-tree runs
`git status --porcelain` synchronously on a hot path (`git/init.lua:251`,
mitigated only by caching the raw text), and three sequential `rev-parse` calls
at `:531`; alpha-nvim runs `git branch --show-current` on every dashboard render
(`themes/startify.lua:40`); several `nvim-lspconfig` server configs use
`vim.system(...):wait()` at setup time. `plenary.curl` is also notable for the
opposite choice from hive and mason — it puts the request body on **argv**
(`--data-raw <string>`, `curl.lua:202`) rather than stdin. *(Only in its string
branch — see §9.3: pass a file path as `body` and it switches to `-d @file`,
which is how both codecompanion and avante avoid argv entirely.)*

### 8.9 Summary matrix

| Pattern | Plugins | Reference |
| --- | --- | --- |
| `vim.system` + `stdin = <string>` | conform, gitsigns (`hash-object`, `blame --contents`), render-markdown (latex), **hive.curl**, nvim-treesitter (`stylua -`) | `conform/runner.lua:404`; `gitsigns/git/repo.lua:919` |
| `vim.system` + `stdin = <string[]>` | gitsigns (`git apply -`, `check-attr --stdin`) | `gitsigns/git.lua:227`; semantics at `system/compat.lua:75` |
| `uv.spawn` + `new_pipe` + `:write()` | mason, plenary `Job`, telescope, neo-tree, lazy.nvim, gitsigns compat shim | `mason-core/installer/managers/common.lua:107`; `plenary/job.lua:417` |
| `jobstart` / `termopen` / `chansend` | lualine, telescope term previewer, blink.cmp (terminal completion), lspconfig probes | `lualine/utils/job.lua:10`; `blink/cmp/lib/text_edits.lua:61` |
| tempfile → run → read back | conform (`stdin = false`), gitsigns external diff | `conform/runner.lua:380`, `:514`; `gitsigns/diff_ext.lua:11` |
| blocking `vim.fn.system` / `:wait()` | neo-tree (hot path), alpha-nvim, lazydev, lspconfig | `neo-tree/git/init.lua:251` |
| streaming read + cancellation | telescope (`LinesPipe`, `find_id`), neo-tree, plenary.curl `stream` | `telescope/_.lua:127`; `telescope/pickers.lua:1401` |
| avoid the subprocess: threads / FFI | gitsigns `diff_int` (`uv.new_work`), blink.cmp `run_async_rust`, telescope-fzf-native (`ffi.load`) | `gitsigns/diff_int.lua:20` |

### 8.10 Correctness checklist, by concern

Collected from all of the above — this is the actual answer to "what do I have to
get right":

- **Trailing newline out:** conform `runner.lua:371` (`vim.bo.eol`); gitsigns
  `util.lua:141` (`endofline`); core `vim/lsp.lua:110`.
- **Trailing newline back:** conform `runner.lua:426` — drop one trailing `""`,
  then re-insert if the array went empty, because *"Vim will never let the lines
  array be empty"*.
- **CRLF / fileformat:** gitsigns tracks index-vs-worktree CRLF separately
  (`git.lua:14`, `:130`, `:211`); conform writes back with
  `util.buf_line_ending`; telescope strips all CR on read.
- **BOM:** only gitsigns (`util.lua:148`).
- **Cursor / marks / extmarks:** minimal `TextEdit` diffs +
  `vim.lsp.util.apply_text_edits`, never whole-buffer `set_lines`.
- **Undo:** `pcall(vim.cmd.undojoin)` (conform `runner.lua:283`); Vimscript's
  `silent undojoin` when called from `BufWritePre` (`rustfmt.vim:171`).
- **Staleness:** discard (conform) vs retry (gitsigns) vs cache-key (blink) —
  plus conform's `changedtick == -1` shutdown case.
- **Buffer validity / detach:** `nvim_buf_is_valid` on every async return.
- **Cancellation:** pid stamp + `uv.kill` (conform), generation counter
  (telescope), post-kill callback suppression (lualine `job.lua:25`).
- **Timeouts:** per-formatter budget carved from a shared `timeout_ms`
  (conform `runner.lua:680`); hive's 5 s head start over curl's `--max-time`.
- **Exit codes:** configurable per tool — many tools exit non-zero as *signal*,
  not failure (conform `exit_codes`; gitsigns `ignore_error` because
  *"git-diff implies --exit-code"*).
- **Error surfacing:** notify debounce so a persistently broken tool notifies
  once (conform `errors.lua:8`, → *"See :ConformInfo for details"*); ENOENT
  turned into "could not find executable in PATH" (mason `process.lua:230`).
- **Hygiene:** temp files `0700`; env redacted before logging (mason
  `process.lua:139`); `GIT_TERMINAL_PROMPT=0` and scrubbed `GIT_*` (lazy
  `manage/process.lua:125`); large payloads kept off argv via stdin.

---

## 9. The four AI plugins (read from GitHub, not installed locally)

`copilot.lua`, `supermaven-nvim`, `codecompanion.nvim` and `avante.nvim` are the
plugins whose entire job is shipping buffer text to an external process, so they
are the most on-point references — and they disagree with each other completely.

### 9.0 Four plugins, four different transports

| Plugin | Process | Body goes | Framing |
| --- | --- | --- | --- |
| **copilot.lua** | LSP server (`node … --stdio`) | nowhere — core's `didChange` carries the text | core's `Content-Length` |
| **supermaven** | own `sm-agent` binary, persistent | stdin, one JSON line per message | newline-delimited JSON |
| **codecompanion** | `curl` per request | **temp file** → `-d @file` | SSE |
| **avante** | `curl` per request | **temp file** → `-d @file` | SSE |

Two of the four write the request body to a temp file; none uses
`--data-binary @-`. That makes `hive.curl`'s existing choice the best of the
five, for reasons §9.3 spells out.

### 9.1 copilot.lua — don't build a transport, borrow one

It drives the Copilot agent as an **LSP server**, so buffer text reaches the
model through core's `didOpen`/`didChange` and the plugin never serializes a
buffer. There is no `_buf_get_full_text` equivalent in it at all. The payload is
URI + position + editor metadata only (`util.lua:81`):

```lua
local params = vim.lsp.util.make_position_params(0, "utf-16") -- copilot server uses utf-16
local doc = {
  uri = params.textDocument.uri,
  version = vim.api.nvim_buf_get_var(0, "changedtick"),
  relativePath = relative_path(absolute),
  insertSpaces = vim.o.expandtab,
  tabSize = vim.fn.shiftwidth(),
  indentSize = vim.fn.shiftwidth(),
  position = params.position,
}
```

That is §5's "formatting sends no text at all" generalized: sync once via the
protocol, then every request is tiny. It starts the client with
`vim.lsp.start(M.config, { attach = false })` (`client/init.lua:168`) and
attaches per-buffer itself, so one client serves N buffers and keymaps are
installed as a side effect of attach.

Two idioms worth taking:

- **It forces an undo *break*, not a join** (`suggestion/init.lua:657`):
  ```lua
  -- Create an undo breakpoint
  vim.cmd("let &undolevels=&undolevels")
  ```
  The exact opposite of conform's `pcall(vim.cmd.undojoin)`, and correct here —
  each accepted suggestion should be independently undoable.
- **Staleness by deep-comparing the whole param table**
  (`suggestion/init.lua:378`): `if not vim.deep_equal(ctx.params, params) then`.
  Since that table holds both `doc.version` (= changedtick) and `position`, one
  comparison subsumes a changedtick guard *and* a cursor guard. It also does
  real `client:cancel_request(ctx.first)` on supersede.

**A verified bug worth knowing**, because it's the exact trap §4 warns about.
`get_doc` deliberately asks for utf-16 positions, so the server's `range` comes
back in utf-16 offsets. But the accept path computes its encoding like this
(`suggestion/init.lua:662`):

```lua
if not encoding or encoding == "" or encoding ~= "utf-8" or encoding ~= "utf-16" or encoding ~= "utf-32" then
```

Those `or`s are a tautology — no string differs from all three — so both
branches always fire and `encoding` is unconditionally `"utf-8"`. The intent was
`and`. Net effect: utf-16 ranges handed to `apply_text_edits` as utf-8, so on any
line with non-ASCII before the suggestion the edit lands at the wrong column.
`panel/init.lua:233` passes the literal `"utf-16"` and is correct, so the two
call sites disagree.

### 9.2 supermaven — NDJSON over a persistent pipe, and speculative reuse

The purest example of the shape hive would need for a long-lived model process.
Raw libuv pipes (`binary_handler.lua:39`), `sm-agent stdio`, and **newline-
delimited JSON instead of `Content-Length`** (`:240`):

```lua
function BinaryLifecycle:send_json(msg)
  local message = vim.json.encode(msg) .. "\n"
  loop.write(self.stdin, message) -- fails silently
end
```

This is dramatically simpler than §3's framing, and it is *safe* for arbitrary
buffer content precisely because JSON escapes newlines — verified:
`vim.json.encode` turns a literal newline into the two-character `\n` escape, so
an encoded message never contains a raw newline. **That is the cheap alternative
to length-prefixed framing**, and the reason it works.

Two things it gets wrong, both instructive:

- `buffer = buffer .. data` in the read loop (`:146`) — the O(n²) accumulation
  that core's `stringbuffer` exists to avoid.
- `-- fails silently` appears four times (`:77`, `:241`, `:523`, `:529`). The
  no-backpressure/no-write-error property from §2, acknowledged in shipping code
  rather than fixed.

**The genuinely novel idea: stale responses are reused, not discarded.** It
retains the last 50 request generations (`max_state_id_retention = 50`, purged at
`:254`) and on each poll scans every retained state for one whose recorded prefix
is a prefix of what you've now typed (`:382`), strips the characters you've since
typed off the front of that completion (`strip_prefix`, `:470`), and keeps
whichever yields the longest remaining text:

```lua
if state_prefix ~= nil and #prefix >= #state_prefix then
  if string.sub(prefix, 1, #state_prefix) == state_prefix then
    local user_input = prefix:sub(#state_prefix + 1)
    local remaining_completion = self:strip_prefix(state.completion, user_input)
```

So a completion requested three keystrokes ago still gets used if you typed what
it predicted. Compare telescope's `find_id`, which throws stale generations
away — this is the opposite trade, and it's why the plugin feels instant.

Rendering is driven by a **25 ms polling timer** (`:27`) gated by a
`wants_polling` flag that auto-disarms after five seconds of quiet (`:275`),
rather than by the response callback. Cursor position is sent as a **byte
offset** (`offset = #prefix`, `:417`), sidestepping the whole utf-16 problem
copilot.lua tripped on. There is no incremental sync: every `TextChanged` and
`CursorMoved` ships the entire document (`:418`) with no debounce, deduplicated
by content comparison rather than `changedtick` (`:96`, `:428`), with a 10 MB
hard skip (`:25`).

Its ghost text is one extmark with a fixed `id = 1` so re-render overwrites in
place and disposal is delete-by-id, `virt_text` for the first line plus
`virt_lines` for the rest, and two placement modes — inline at the cursor, or
pushed to `eol` when text after the cursor would collide
(`completion_preview.lua:40`). Accept goes through `apply_text_edits` but is
preceded by a `nvim_feedkeys("<Space><Left><Del>")` hack (`:158`) that is a wart,
not a pattern.

One real anti-pattern: `fetch_binary()` runs at **module load time**
(`binary_handler.lua:10`) via blocking `vim.fn.system`, so `require` can block
Neovim on an HTTP round-trip and a binary download. Its temp path is relative,
so `curl -o` writes into the current working directory.

### 9.3 The temp-file transport, and why hive's is better

codecompanion writes the request body to a temp file (`http.lua:35`):

```lua
local function write_body_file(body)
  local path = vim.fn.tempname() .. ".json"
  files.write_to_path(path, body)
  return path
end
```

avante does the same (`llm.lua:575`), and both then pass that *path* as
plenary's `body`. plenary's `body` is polymorphic — `parse.request` picks the
`in_file` branch when the string is an existing file, and `parse.file` emits
`{ "-d", "@" .. path }` (verified in the local copy, `plenary/curl.lua:207` and
`:153`). So **this corrects §8.8**: plenary only puts the body on argv in its
*string* branch. Neither plugin reaches it, and neither risks `E2BIG` on a
multi-hundred-KB prompt.

codecompanion goes further and passes **headers** the same way,
`--header @file` — which requires curl ≥ 7.55 and puts the API key on disk.

Three problems with the temp-file approach, all avoided by `--data-binary @-`:

1. **It's `-d @file`, not `--data-binary @file`.** Plain `-d` *strips CR and LF
   from the file*. Safe today only because `vim.json.encode` emits single-line
   JSON; any adapter that pretty-printed its body would be silently mangled.
2. **codecompanion retains the temp files on error** (`http.lua:57`):
   ```lua
   if status == "error" or not vim.tbl_contains({ "ERROR", "INFO" }, config.opts.log_level) then
     return
   end
   ```
   So the body *and* the plaintext API-key header file survive any failed
   request, and survive every request at `DEBUG`/`TRACE` — or `WARN`, which
   looks unintended. Written `0644`.
3. avante leaks them deliberately under `Config.debug` (`llm.lua:612`), which is
   at least intentional.

avante also reads **response headers out of a curl `-D` dump file** rather than
from the callback (`llm.lua:625`), racing curl's header flush and winning, so
rate-limit headers are available before the body finishes — with a comment noting
plenary deletes the file out from under it (`:496`).

codecompanion's `--retry 3` (`http.lua:132`) is applied to a POST, so a
non-idempotent completion can be issued more than once. It also disables
compression while streaming (`:464`), necessary because gzipped bytes would
defeat line-splitting.

### 9.4 Streaming: three NDJSON implementations, and a speculative parser

**SSE parsing is where corners get cut.** codecompanion's is one line
(`adapters/utils/init.lua:158`):

```lua
local find_json_start = string.find(data, "{") or 1
return string.sub(data, find_json_start)
```

No `data:` grammar, and **no `[DONE]` handling anywhere in the repo** — `data:
[DONE]` contains no `{`, so it falls through, fails `vim.json.decode`, and gets
dropped. Which means real protocol corruption is indistinguishable from normal
end-of-stream. avante does it properly per-provider, defensively covering both
wire shapes (`openai.lua:592`):

```lua
if data_stream:match('"%[DONE%]":') or data_stream == "[DONE]" then
```

**Neither implements partial-line carry** — both inherit it from plenary's Job,
whose `on_output` is a `coroutine.wrap` that keeps `result_line` across chunk
boundaries (`plenary/job.lua:285`). So a JSON object split across two TCP chunks
is handled, one layer down. Worth knowing if you ever drop plenary: that
correctness is not in the plugin.

**Where they do own the framing, all three converge on NDJSON and all three
hand-roll the same naive buffer.** codecompanion's ACP and MCP clients
(`acp/init.lua:432`, `mcp/client.lua:83`) use `vim.system{stdin = true}` with a
shared `LineBuffer` (`utils/jsonrpc.lua:114`), and avante's ACP client uses raw
libuv pipes (`libs/acp_client.lua:471`). All use `buffer = buffer .. data` plus
`sub`, none uses a stringbuffer, so a very long line assembled from many chunks
is quadratic in all three. codecompanion at least documents why the buffer
exists (`acp/init.lua:553`): *"JSON-RPC doesn't guarantee message boundaries
align with I/O boundaries so we need to buffer and handle this carefully."*

Two teardown patterns worth stealing:

- **MCP's three-stage shutdown ladder** (`mcp/client.lua:174`): close stdin
  (`self._sysobj:write(nil)`) → deferred `SIGTERM` → deferred `SIGKILL`.
- **Protocol-level cancellation instead of a kill** — codecompanion sends a
  `session/cancel` notification (`acp/prompt_builder.lua:294`), avante calls
  `acp_client:cancel_session` (`llm.lua:1626`). A signal is the fallback, not
  the mechanism.

**avante's speculative parse** is the cheapest framing trick here — for
providers that emit pretty-printed or multi-line JSON, it just tries to decode
after every line and treats success as the message boundary (`llm.jsonl:553`):

```lua
response_body = response_body .. line
local ok, jsn = pcall(vim.json.decode, response_body)
if ok then
  ...
  response_body = ""
end
```

### 9.5 avante's incremental JSON parser — the genuinely novel find

`libs/jsonparser.lua` is a real character-state-machine `StreamParser` with an
`INCOMPLETE` state, a persistent `buffer`/`position`, `addData` that appends and
re-drives the parse, and separate carry slots for a string/number/literal cut
mid-token. The payoff is `finalize()`, which does not fail on truncated input —
it *materializes* what it has and tags it (`jsonparser.lua:644`):

```lua
if item and item.value then
  -- 标记为不完整
  if type(item.value) == "table" then item.value._incomplete = true end
```

So a half-arrived `{"path":"foo.lua","the_diff":"------- SEARCH\nlocal x` yields
a usable table whose `the_diff` is the partial string, marked `_incomplete`.
That is what lets avante render a **live diff preview from an unfinished tool
call**: `openai.lua:447` re-parses the entire accumulated text on every content
delta, and `llm.lua:1908` dispatches the still-generating tool use.

**And the best single detail in this whole document** —
`llm_tools/replace_in_file.lua:33`:

```lua
--- IMPORTANT: Using "the_diff" instead of "diff" is to avoid LLM streaming
--- generating function parameters in alphabetical order, which would result in
--- generating "path" after "diff", making it impossible to achieve a streaming diff view.
```

The streaming preview needs `path` before the diff bytes arrive. Models emit
JSON keys in schema/alphabetical order, so `d` < `p` would put the huge diff
first and the path last. Renaming the parameter to `the_diff` makes `p` < `t`.
A prompt-engineering fix for a rendering-latency problem.

Caveat found in the same pass: the per-delta re-render is **commented out** on
both native tool-calling paths (`claude.lua:487`, `openai.lua:767`), so all this
machinery is live only for ReAct/XML-mode providers.

### 9.6 Throttling by content, not just by time

avante's streaming preview is gated three ways at once
(`replace_in_file.lua:121`):

```lua
if current_timestamp - prev_streaming_diff_timestamp < 2 then
  return false, "Diff hasn't changed in the last 2 seconds"
end
...
if streaming_diff_lines_count == prev_streaming_diff_lines_count then
  return false, "Diff lines count hasn't changed"
end
```

Two seconds of wall clock **and** a line-count-changed check, both keyed by
`tool_use_id` — plus a third layer where only *unstable* (newly-changed) blocks
get re-extmarked (`:631`) and settled blocks are served from a cache keyed
`"<idx>:<#new_lines>"` that deliberately excludes the still-growing block
(`:296`). Compare the single time-based debounce everything else uses.

**During streaming the preview is virtual only** (`:688`):

```lua
if not is_streaming then
  insert_diff_blocks_new_lines()      -- nvim_buf_set_lines
  ...
else
  highlight_streaming_diff_blocks()   -- virt_lines extmarks only
end
```

Real text lands only when the tool call completes. That is a materially better
answer than writing tokens into the buffer live — which is exactly what
`selection.lua:146` does on the `AvanteEdit` path, re-splitting the whole
accumulated response and `nvim_buf_set_lines`-ing the range on every chunk.

### 9.7 Write-back: the full spectrum, worst to best

- **codecompanion's apply is the crudest thing here**
  (`insert_edit_into_file/init.lua:136`): wholesale
  `nvim_buf_set_lines(bufnr, 0, -1, ...)` followed by a forced
  `vim.cmd("silent write")`. Destroys every extmark and mark in the buffer,
  doesn't `undojoin`, doesn't restore the cursor, and silently saves the user's
  file. It *does* compute a real `vim.text.diff` — but only to render the review
  UI, never to minimize the applied edit.
- **avante has two coexisting UIs.** The legacy `:AvanteApply` path writes real
  **git conflict markers** into the buffer (`sidebar.lua:760`,
  `<<<<<<< HEAD` / `=======` / `>>>>>>> Snippet`) and resolves them with
  `co`/`ct`/`cb`. The modern tool path inserts new lines for real and shows the
  old ones as strikethrough extmarks with per-hunk accept/reject.
- **copilot.lua and supermaven both use `vim.lsp.util.apply_text_edits`**,
  inheriting all of §4 for free. That remains the right default.

Three details from avante's diff UI that are better than what's in §8:

- **`undojoin` once per `tool_use_id`, not per write** (`replace_in_file.lua:193`):
  ```lua
  local undo_joined = session_ctx.undo_joined[opts.tool_use_id]
  if not undo_joined then
    pcall(vim.cmd.undojoin)
    session_ctx.undo_joined[opts.tool_use_id] = true
  end
  ```
  One undo entry per tool call across many streaming re-applications. Naive
  join-every-write would have collapsed the user's own preceding edit into the
  AI's.
- **Diagnostics and inlay hints are disabled while conflict markers exist**
  (`diff.lua:407`) — `vim.diagnostic.enable(false, {bufnr})` plus
  `vim.lsp.inlay_hint.enable(false, ...)` with the prior state saved and
  restored, because a file full of `<<<<<<<` is unparseable.
- **Conflict re-scanning runs from a decoration provider, not autocmds**
  (`diff.lua:439`): `nvim_set_decoration_provider(NAMESPACE, { on_win = ... })`,
  gated on `changedtick`. So parsing happens lazily at redraw of a visible
  window, once per tick — strictly less work than any autocmd approach.

codecompanion's review UI is the most sophisticated *rendering*: three separately
tuned `vim.text.diff` option sets (`diff/init.lua:29` — `histogram`/`ctxlen=0`/
`linematch=10` for lines, `minimal` for inline, plus a word-level pass), hunks
applied in reverse order, deleted text as `virt_lines` given real tree-sitter
highlighting via a shared reusable scratch buffer named `codecompanion://diff`,
and a blank spacer line inserted when hunk 1 deletes line 1 because
`virt_lines_above` has nothing to anchor to.

### 9.8 A whole problem class we hadn't seen: repairing the model's diff

Nothing in §8 needs this, because a formatter's output is trustworthy. An LLM's
is not, so avante carries two layers §1–§8 have no analogue for.

**A five-tier fuzzy match ladder** for locating the old text
(`utils/init.lua:680`), tried in order: exact → trailing-whitespace-insensitive →
*all* whitespace removed → un-mangle literal `\n`/`\t`/`\"` the model emitted as
text → tiers 3+4 combined. Then indentation is re-derived from the buffer and
re-applied to both sides (`replace_in_file.lua:214`), so a model that got
indentation wrong still lands correctly.

**A diff-repair pass**, `Utils.fix_diff` (`utils/init.lua:1682`), with an honest
comment: *"Some models (e.g., gpt-4o) cannot correctly return diff content and
often miss the SEARCH line."* It transcodes a unified diff into SEARCH/REPLACE
if the model emitted the wrong format, normalizes git markers, injects a missing
leading `------- SEARCH`, drops everything after a duplicated `=======`, and
appends a missing `+++++++ REPLACE` — which doubles as the streaming-truncation
fix, since an unterminated block gets closed synthetically so the partial diff
parses.

Both layers are a warning as much as a pattern: tier 3 is
`gsub("%s*", "")`, which makes `x = a+b` and `x = a + b` compare equal, and
`try_find_match` returns the *first* hit without checking uniqueness — so a
SEARCH block matching several sites silently edits the earliest.

### 9.9 What all four ignore

**None of the four handles `'fileformat'`, `'endofline'`, or BOM.** Every one is
`table.concat(nvim_buf_get_lines(...), "\n")`:

- supermaven `util.lua:139`
- codecompanion `utils/buffers.lua:119`
- avante `utils/init.lua:330` and `:1380`
- copilot.lua sidesteps it only by never serializing a buffer at all

That is the strongest possible confirmation of §1: the correctness work core does
in `_buf_get_full_text` is genuinely skipped in the wild by every plugin whose
core competency is sending buffers to a process. avante has an asymmetry worth
noting — its disk path does `gsub("\r\n", "\n")` but doesn't strip a UTF-8 BOM,
while its buffer path does neither, so the same file produces two different byte
streams depending on whether it happens to be loaded.

**Staleness guards range from good to absent.** copilot.lua deep-compares the
param table; supermaven compares content; codecompanion uses `mtime.sec` for
files (`insert_edit_into_file/io.lua:17`, so sub-second races pass) and
`changedtick` in exactly one place; avante captures `changedtick` in
`Utils.get_doc` and then never uses it as a staleness check — its confirm-dialog
rollback is `nvim_buf_set_lines(bufnr, 0, -1, false, original_lines)`, which
discards the user's concurrent edits along with the AI's.

**codecompanion's inline path has a real hole**: the selection range is captured
at request time but `original_content` is re-read at *response* time
(`inline/init.lua:512`) and combined with those stale coordinates, with no tick
comparison and no warning.

**avante dirties the buffer while merely previewing** (`suggestion.lua:342`):

```lua
local buf_lines_count = #buf_lines
while buf_lines_count < end_row do
  api.nvim_buf_set_lines(bufnr, buf_lines_count, -1, false, { "" })
  buf_lines_count = buf_lines_count + 1
end
```

To place an extmark past EOF it appends real empty lines — one call per line, so
N undo entries and N `changedtick` bumps, on every `show()` including cycling.
`virt_lines` on the last real line would have worked. And since `suggest()`
appends two sentinel blank lines to the *payload* so the model can append past
EOF, this is the common path, not an edge case.

## 10. What this means for `hive.nvim`

Findings applied to the code that exists today:

- **`hive.curl` is already on the right pattern.** `stdin = req.body` (string
  form) + `--data-binary @-` is exactly what core recommends for a one-shot,
  and it avoids both the argv length limit and the table-form newline bug. The
  `vim.schedule` around the callback and the `timeout` headroom over curl's own
  `--max-time` are the details most plugins miss.
- **The gap is a text-extraction helper.** There is no buffer→string function
  yet. `vim/lsp.lua:107` is the thing to port — `'fileformat'` separator plus
  the `'endofline'` conditional — rather than a bare
  `table.concat(lines, '\n')`.
- **`vim.net.request` is not a substitute.** `vim/net.lua:56` is GET-only with
  no stdin body, so `hive.curl` is strictly more capable. Its `outbuf` handling
  (`:96`) is however a tidy model for dumping a response into a scratch buffer:
  `vim.split(stdout, '\n', {plain=true})` + `nvim_buf_set_lines`, inside
  `vim.schedule`.
- **Any write-back path needs a staleness guard** — capture
  `vim.b[bufnr].changedtick` before the request and compare on return, per
  `vim/lsp/completion.lua:905`.
- **If a model process is ever kept alive**, `vim/lsp/_transport.lua` +
  `vim/lsp/rpc.lua` are the blueprint: `stdin = true`, `obj:write` per message,
  explicit framing, a `stringbuffer` accumulator, and a coroutine parser that
  tolerates arbitrary chunk boundaries.

Four concrete gaps in the current transport, each with a precedent above:

1. **No `pcall` around `vim.system`** (`hive/curl.lua:141`, `:144`). The
   `vim.fn.executable("curl")` pre-check at `:117` covers the common case, but
   not a bad `cwd` or a non-executable binary. Compare `conform runner.lua:404`
   and the nvim-treesitter writeup in §8.7 — and note that if hive ever wraps
   this in a coroutine, an unguarded throw becomes a silent hang.
2. **No cancellation handle.** `vim.system` returns a `SystemObj`; `M.request`
   discards it, so there is no `:kill()`. Compare conform's pid stamp
   (`runner.lua:476` + `uv.kill` at `:548`) or blink.cmp returning
   `function() return proc:kill('TERM') end` from its task constructor.
3. **The blocking `:wait()` at `curl.lua:141` isn't interruptible.**
   `conform runner.lua:709` shows the `vim.wait(remaining, fn, 5)` version that
   keeps the event loop turning so `<C-c>` works.
4. **No buffer→bytes function exists yet** — zero `nvim_buf_get_lines` and zero
   `changedtick` anywhere in `lua/hive/`. `gitsigns util.buf_lines`
   (`util.lua:128`, §8.2) is the most complete spec: `fileformat`, `endofline`,
   *and* `bomb`. `vim/lsp.lua:107` is the smaller correct version.

And from the four AI plugins specifically (§9):

- **`hive.curl`'s transport is the best of the five.** `--data-binary @-` with
  `stdin = req.body` beats codecompanion's and avante's temp files on three
  counts: no API key on disk, no `-d`-strips-CRLF trap, and nothing to clean up
  on failure. Don't "upgrade" to a body file.
- **Don't add `--retry` to the POST.** codecompanion's `--retry 3`
  (`http.lua:132`) makes a non-idempotent completion re-issuable.
- **If hive ever streams** (`api.lua` currently hardcodes `stream = false`): note
  from §2 that `vim.system` with a *function* `stdout` handler ignores
  `text = true` and hands you raw chunks, so partial-line carry becomes hive's
  problem — nobody gets it for free outside plenary's Job. Handle `[DONE]`
  explicitly rather than letting it fail a JSON decode (§9.4), and accumulate
  into a table joined once rather than `s = s .. chunk` (§8, §9.2).
- **If hive ever keeps a model process alive**, NDJSON is the cheap framing and
  is provably safe because `vim.json.encode` escapes newlines (§9.2) — but use a
  real accumulator, since all three NDJSON implementations found are quadratic.
  Steal MCP's close-stdin → SIGTERM → SIGKILL ladder (§9.4).
- **Render partial output as virtual text, write real text only on completion**
  (§9.6). That sidesteps the entire staleness problem for the streaming case,
  and it's the one design decision all four plugins get wrong somewhere.

## 11. Selecting code down conceptual lines

§1–§10 answer *how to ship bytes*. This section answers *which bytes*: given a
cursor, cut the enclosing function or class, its signature, the nearby
signatures, and whatever else a small local model needs in a FIM prompt.

Everything below was measured on this machine. `$VIMRUNTIME` is
`/usr/local/share/nvim/runtime` (NVIM v0.12.4), and the query supply is
`~/.local/share/nvim/lazy/nvim-treesitter` (main branch) plus
`~/.local/share/nvim/lazy/arborist.nvim`. Three plugins worth stealing from are
named in §11.12 and were **not** read: they are not installed here.

### 11.1 Three layers, and what each one cannot do

| Layer | Answers | Cannot answer | Latency |
| --- | --- | --- | --- |
| **treesitter** | where does this construct start and end | what is this identifier, where else is it used | sync, sub-millisecond warm |
| **LSP** | what is related to this, across files | anything, while the server is still indexing | one round trip, async only |
| **vimscript lists** | what did the user touch recently | anything structural | sync, free |

The split that matters for FIM: **treesitter is the only layer callable from
`InsertCharPre`**. LSP has no synchronous mode, so a keystroke-triggered
completion can only use LSP data that was already cached from an earlier tick.
And neither layer knows about recency, which is the single cheapest useful
signal a completion prompt can carry.

### 11.2 Treesitter: the boundary layer

The whole enclosing-construct walk is four core calls:

| Task | Call | Site |
| --- | --- | --- |
| node under cursor | `vim.treesitter.get_node()` | `treesitter.lua:394` |
| walk outward | `node:parent()` | C |
| extract | `vim.treesitter.get_node_text()` | `treesitter.lua:232` |
| widen as a user action | `vim.treesitter.select('parent')` | `treesitter.lua:520` |

**`get_node()` on an unparsed tree returns a wrong node, and says so.** The
docstring at `treesitter.lua:382` reads "Calling this on an unparsed tree can
yield an invalid node", and points at
`vim.treesitter.get_parser(bufnr):parse(range)`. On the `InsertCharPre` path
nothing guarantees the highlighter has run for the current tick, so the parse
has to be explicit. Per §11.5 it costs 0.76 ms.

**Do not match node types by substring.** `while n:type():find('function')` is
the obvious walk and it stops at the first lambda. With the cursor on
`lua/hive/curl.lua:125`, inside the `vim.schedule(function()` callback at
`:123`, it returns a `function_definition` with no name and no
`prev_named_sibling`, so §11.3's doc-comment walk then indexes nil. Test for the
language's named declaration type, or for the presence of a name field.

`select()` is new in 0.12 and takes
`'parent'|'child'|'next'|'prev'|'extend_next'|'extend_prev'`, dispatching to
`treesitter/_select.lua`. It maintains a parent chain rather than re-deriving
the node each call, so repeated presses do not drift. Read it before writing a
"grow the context" mapping by hand.

Use `get_node_text` rather than `nvim_buf_get_text` directly. Its
`buf_range_get_text` helper (`treesitter.lua:203`) carries the `end_col == 0`
fixup, `append_newline` at `:205`, which is the same trailing-newline bug class
as §1 and already noted in §6.

**The signature is one field access, no query needed.** For
`function M.request` in `lua/hive/curl.lua:119`:

```lua
local fn   = -- walked to function_declaration, rows 118-149
local body = fn:field('body')[1]           -- block, rows 119-148
-- signature = rows fn:start() .. body:start()-1
```

Row numbers here are treesitter's, 0-indexed. A `file:line` reference is
1-indexed, so the same declaration is row 118 and `curl.lua:119`.

Measured: `block` rows 119–148, so the signature slice is row 118 alone, which
is `function M.request(req, callback)`.

**`body` is a field on every grammar tested.** Eleven parsers from
`~/.local/share/nvim/site/parser`, one function each:

| Language | Declaration node | `body` field |
| --- | --- | --- |
| `lua` | `function_declaration` | `block` |
| `python` | `function_definition` | `block` |
| `javascript` | `function_declaration` | `statement_block` |
| `typescript` | `function_declaration` | `statement_block` |
| `rust` | `function_item` | `block` |
| `go` | `function_declaration` | `block` |
| `c` | `function_definition` | `compound_statement` |
| `cpp` | `function_definition` | `compound_statement` |
| `java` | `method_declaration` | `block` |
| `c_sharp` | `method_declaration` | `block` |
| `ruby` | `method` | `body_statement` |

So the *signature* slice needs no per-language table at all: find the enclosing
node that has a `body` field, and cut from its start to the body's start. The
enclosing-*node* step does need one, because those eleven languages give five
distinct type names, and that five-entry table is what `textobjects.scm` would
have saved (§11.6). Note the C and C++ rows: there is no
`name` field, the name is inside `declarator`, so anything keying on `name`
breaks there.

### 11.3 Doc comments are siblings, not children

This is the finding worth acting on first, because it fails silently.

`function M.request` starts at `lua/hive/curl.lua:119`. Its LuaCATS block, nine
lines with the parameter and return types, occupies lines 110–118. Those nine
lines are **not inside the `function_declaration` node**. A cut of the node
range drops the most information-dense text in the file and the prompt still
looks fine.

Confirmed by walking `prev_named_sibling()` from the declaration: nine
consecutive `comment` siblings, the block starting at row 109 (line 110)
against the function's row 118.

```lua
local first = fn:start()
local n = fn
while true do
  local prev = n:prev_named_sibling()
  if not prev or prev:type() ~= 'comment' then break end
  local _, _, prev_end = prev:range()
  if prev_end < first - 1 then break end   -- blank line: not attached
  first, n = prev:start(), prev
end
```

The `prev_end < first - 1` guard is the whole trick. Without it the walk keeps
climbing through unrelated comments further up the file.

**Python is the exception.** A docstring is the first statement of the body, so
it is inside the node, and a signature-only slice cuts it off instead. Two
opposite bugs from one naive implementation.

**LSP does not have this problem, by specification.** `lsp.DocumentSymbol.range`
is "the range enclosing this symbol not including leading/trailing whitespace
but everything else like comments"
(`lsp/_meta/protocol.lua:1336`). So the two sources disagree on where a function
begins, deliberately. Do not mix them in one prompt without normalising to one
convention first.

### 11.4 Injected languages change the answer and the prompt

`LanguageTree:language_for_range` (`languagetree.lua:1444`) gives the real
language at a position. Measured on a markdown buffer with a fenced Lua block:

| Row | Content | `language_for_range` |
| --- | --- | --- |
| 0 | `# t` | `markdown` |
| 3 | `local x = 1` inside ```` ```lua ```` | `lua` |
| 6 | plain prose | `markdown_inline` |

`parse()` alone is not enough here. Injections only exist after
`parse(true)`, which parses the child trees as well, and without it every row
above reports `markdown`. That is a third silent-wrong-answer case, alongside the
two in §11.2.

Two consequences. The enclosing node has to come from the injected tree, via
`tree_for_range` (`:1394`) or `node_for_range` (`:1421`), not from the root
parser. And the language tag in the FIM prompt has to match, which means row 6
shows the output is a *parser* name and not a language name. Map it before
putting it in a prompt.

### 11.5 Parse cost is not a reason to avoid any of this

Measured on `lua/hive/curl.lua`, 152 lines:

| Operation | Time |
| --- | --- |
| `get_parser()`, loads the parser library | 22.06 ms |
| first `parse()` | 1.55 ms |
| `parse()` with no edit since | 0.006 ms |
| `parse()` after a one-character insert | 0.76 ms |

The 22 ms is once per language per session and happens on `FileType` anyway if
highlighting is on. The number that matters for `InsertCharPre` is 0.76 ms.
There is no budget argument for keeping a stale tree or debouncing the parse.

### 11.6 Query supply is a dependency decision, already half made

Core ships queries for seven languages only: `c`, `lua`, `markdown`,
`markdown_inline`, `query`, `vim`, `vimdoc`. Counts of language directories
carrying each query, on this rtp today:

| Query | Core | nvim-treesitter | arborist.nvim |
| --- | --- | --- | --- |
| `highlights` | 7 | 323 | 330 |
| `injections` | 6 | 300 | 306 |
| `folds` | 5 | 224 | 225 |
| `indents` | 0 | 168 | 169 |
| `locals` | 0 | 151 | 151 |
| `textobjects` | 0 | 0 | 0 |

Two things fall out of that table.

**`textobjects.scm` is not here.** `@function.outer` and `@class.outer` are the
obvious way to name constructs across languages, and nothing on this rtp
supplies them. Main-branch nvim-treesitter does not carry them and
nvim-treesitter-textobjects is not installed. Using them is adding a
dependency, not using what is already present.

**Read queries through core, depend on neither plugin.**
`vim.treesitter.query.get(lang, name)` (`treesitter/query.lua:290`, memoized,
with `get_files` at `:158`) resolves from the rtp. Both plugins are then just
files on the rtp and hive imports neither Lua API. Core itself is not ready to
be the supply: `treesitter/_headings.lua:7` still carries
`TODO(clason): use runtimepath queries (for other languages)` above a table of
hardcoded heading queries.

### 11.7 `folds.scm` is the free language-agnostic chunker

`folds` covers 224 languages against `locals`'s 151, and it needs no plugin API.
Core's Lua `folds.scm` captures `do_statement`, `while_statement`,
`repeat_statement`, `if_statement`, `for_statement`, `function_declaration`,
`function_definition`, `parameters`, `arguments` and `table_constructor` as
`@fold`. Filtering `curl.lua`'s captures to ranges over three lines gives 13
chunks.

Coarser than textobjects, because `parameters` and `arguments` are structurally
uninteresting for a prompt, and there is no capture name to tell a function from
a loop. Good enough to answer "give me the next-largest complete construct", and
`vim.treesitter.foldexpr` (`treesitter.lua:511`, backed by
`treesitter/_fold.lua`) is the same data if a fold level is easier to consume
than a node.

### 11.8 `locals.scm` is the retrieval trigger

The interesting question for a FIM prompt is not "what is near the cursor", it
is "what does this code use that is defined somewhere else". `locals.scm`
answers it without a language server: collect `@local.scope` and
`@local.definition.*`, then any `@local.reference` with no matching definition in
an enclosing scope is a candidate for cross-file retrieval.

arborist implements exactly this lookup in `lua/arborist/locals.lua`.
`find_definition_kind(node, bufnr)` returns the captured definition kind, or
`nil` when nothing is in scope, and caches per `changedtick` in a weak-valued
table. It is O(definitions) with a text comparison per candidate, which is fine
per keystroke on one buffer and not fine over a project.

**The caveat that makes a naive version useless.** Both `lua/locals.scm:54` and
`python/locals.scm:124` are a bare `(identifier) @local.reference`, so every
identifier matches, field names included. Run it over `M.request` in
`curl.lua` and the free-reference set is:

```
executable, fn, schedule, stdin, system, text, vim, wait
```

Eight names, of which seven are fields of `vim`. The only real signal is `vim`
itself. Filter to identifiers that are not the field side of a
`dot_index_expression`, or `attribute` in Python, before treating the set as a
retrieval list.

For scale, `curl.lua` yields 16 scopes and 24 distinct definitions.

### 11.9 What LSP adds, and what it costs

| Want | Method | Core wrapper |
| --- | --- | --- |
| file outline, nearby signatures | `textDocument/documentSymbol` | `lsp/buf.lua:918` |
| resolve a free identifier | `textDocument/definition`, or `textDocument/hover` | `lsp/buf.lua:343`, `:75` |
| callers and callees of this function | `callHierarchy/incomingCalls`, `outgoingCalls` | `lsp/buf.lua:1020`, `:1027` |
| semantic widen | `textDocument/selectionRange` | `lsp/buf.lua:1506` |

`DocumentSymbol.detail` is specified as "More detail for this symbol, e.g the
signature of a function" (`lsp/_meta/protocol.lua:1320`). That is a rendered
signature for every symbol in the file, hierarchical, for one request, and with
no per-language query to maintain. It is the best tokens-per-round-trip in the
list.

Call hierarchy is the strongest cross-file signal and the most expensive: two
requests, and the results are positions that then have to be read. Cache per
`changedtick`, per §10.

`M.selection_range(direction, timeout_ms)` (`:1506`) keeps its
hierarchy in a module-level `selection_ranges` (`:1471`) and walks an index, so
repeated calls cost one request. It differs from `treesitter.select('parent')`
wherever syntax and semantics diverge, macros and templates most visibly.

### 11.10 Recency needs no parser and no server

The neighbouring-tabs heuristic is the cheapest high-value signal in a
completion prompt, and it is three vimscript calls:

- `getbufinfo({buflisted = 1})` returns `lastused` per buffer, confirmed
  present alongside `changedtick`, `changed` and `lnum`. Sort by it.
- `getjumplist()` and `getchangelist()` give where the user has been and what
  they edited, both as position lists.
- gitsigns hunks, already on this rtp, give the uncommitted diff, which is the
  best available proxy for "what this change is about".

### 11.11 `vim.lsp.inline_completion` already does this end to end

`lsp/inline_completion.lua` is 15 KB of core shipping the LSP 3.18
`textDocument/inlineCompletion` feature, presented as overlay text, and its
module docs at `:9` walk through a Copilot quickstart. If the local model can be
fronted by a small language server, the buffer sync, the overlay rendering, the
staleness handling and the cancellation are all already written, and hive's job
shrinks to the transport it already has.

Check that before building any of §11.2–§11.10. It is the difference between
writing a context builder and writing a language server, and the second one
lets core do the parts §1 and §10 say are easy to get wrong.

### 11.12 Steal, do not depend

Three plugins solve pieces of this and are not installed here, so they are named
rather than cited:

- **nvim-treesitter-context** computes the exact chain a FIM prefix wants, class
  then method then loop header, each collapsed to its first line.
- **aerial.nvim** normalises an LSP outline and a treesitter outline behind one
  shape, which is §11.3's disagreement solved in practice.
- **nvim-treesitter-textobjects** is the only supply of `textobjects.scm`, per
  §11.6.

### 11.13 Build order for hive

1. **Buffer to bytes first** (§10 gap 4). Every item below slices a buffer, and
   there is still no correct extraction function in `lua/hive/`.
2. **Enclosing node plus attached doc comments**, using `prev_named_sibling`
   with the blank-line guard from §11.3 and `get_node_text` for extraction.
   Special-case Python. This is the whole of the local context and it needs no
   query and no server.
3. **Signatures of the siblings**, via `field('body')` slices of the enclosing
   scope's other children. Still no query, still sync.
4. **Recency**, per §11.10. Three function calls for the signal that Copilot
   rates highest.
5. **`folds.scm` chunking** where step 2 has no parser-specific answer, read
   through `vim.treesitter.query.get`.
6. **Free identifiers** from `locals.scm`, with the field filter, as the trigger
   for retrieval rather than as context itself.
7. **LSP, cached per `changedtick`**, and never on the keystroke path:
   `documentSymbol` first, `hover` on free identifiers second, call hierarchy
   only if the prompt budget is still unspent.

---

## If you read only one thing

`~/.local/share/nvim/lazy/conform.nvim/lua/conform/runner.lua` — 740 lines that
solve this exact problem (buffer → CLI stdin → buffer) with every edge case
annotated in comments. Then `gitsigns/lua/gitsigns/util.lua:128` for the one
function it doesn't get fully right.

For the AI-specific half — streaming, partial results, untrustworthy output —
read avante's `lua/avante/llm_tools/replace_in_file.lua` alongside
`lua/avante/libs/jsonparser.lua` (§9.5–§9.8).

## Verification

This is research, not a code change, so verification is reading confirmation
rather than tests:

- `:h vim.system()` for the `stdin`/`text`/`timeout` contract quoted in §2 —
  specifically that the `string[]` form appends `\n` per element.
- On a buffer with `:set noeol nofixeol` and again with `:set fileformat=dos`:
  ```vim
  :lua =vim.inspect(vim.lsp._buf_get_full_text(0))
  :lua =vim.inspect(vim.api.nvim_buf_get_lines(0,0,-1,true))
  ```
  The difference between those two outputs is the entire §1 argument.
- Round-trip check that a filter is byte-exact:
  ```lua
  :lua local t = vim.lsp._buf_get_full_text(0)
       print(vim.system({'cat'}, { stdin = t, text = true }):wait().stdout == t)
  ```
  Then repeat with `stdin = vim.api.nvim_buf_get_lines(0,0,-1,true)` to watch it
  return `false` on a `noeol` buffer.
- For §11, with the cursor inside a doc-commented function, in a Lua buffer:
  ```lua
  :lua local n = (vim.treesitter.get_parser(0):parse() and vim.treesitter.get_node())
       while n and n:type() ~= 'function_declaration' do n = n:parent() end
       local prev = n and n:prev_named_sibling()
       print(n:start(), prev and prev:type(), prev and prev:start())
  ```
  On `lua/hive/curl.lua:131` that prints `118  comment  117`. A `comment`
  immediately above the declaration is §11.3: text a cut of the node range
  silently drops. Row 117 is the last of nine, so the block start still needs the
  loop in §11.3.
  Move the cursor to `:125` and swap the condition for
  `n:type():find('function')` to reproduce the lambda trap in §11.2 instead.
- Signature slice, same node:
  ```lua
  :lua local body = n:field('body')[1]
       print(vim.inspect(vim.api.nvim_buf_get_lines(0, n:start(), body:start(), false)))
  ```
  Gives `{ "function M.request(req, callback)" }`.
- Query supply on the rtp, which decides §11.6 and §11.7:
  ```lua
  :lua for _, q in ipairs({'folds','locals','textobjects'}) do
         print(q, vim.treesitter.query.get(vim.bo.filetype, q) ~= nil) end
  ```
  `textobjects` returning `false` is the finding, not a broken install.
- Cursor language in a markdown code block, per §11.4:
  ```lua
  :lua local r = vim.fn.line('.') - 1
       local p = vim.treesitter.get_parser(0); p:parse(true)
       print(p:language_for_range({r,0,r,0}):lang())
  ```
- In `hive.nvim`: `make test` and `:checkhealth hive` are unaffected — nothing
  here modifies the plugin.
