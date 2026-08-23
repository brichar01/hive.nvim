# Research notes for `hive.nvim`

Companion to `IMPLEMENTATION.md`. That document is the build order; this one is
the set of verified facts it rests on. Sections are cited from there as `[R§n]`.

**This is a distilled document.** An earlier version surveyed how Neovim core and
ten third-party plugins move buffer text to external processes, in full. Once the
plugin's design was fixed — a three-region workbench buffer, one-shot HTTP per
request, FIM into a hole — most of that survey stopped being load-bearing. What
remains here is what `IMPLEMENTATION.md` actually cites: the mechanisms it uses,
and the traps that cost real debugging time if rediscovered. Retired sections are
kept as one-line stubs so the numbering and every cross-reference still resolve,
with a note on why they went. The full survey is recoverable from git history.

## Provenance of these facts

Measured on this machine, 2026-08-21: NVIM v0.12.4, `$VIMRUNTIME` =
`/usr/share/nvim/runtime`, 31 plugins under `~/.local/share/nvim/lazy/`, ollama
0.32.5 on `:11434`, `lua-language-server` via mason. Core and third-party line
numbers were re-resolved against disk on that date.

Two caveats about scope:

- `copilot.lua`, `supermaven-nvim`, `codecompanion.nvim` and `avante.nvim` are
  **not installed here**. §9's line numbers are from upstream sources as read,
  not re-resolved, and are less firm than everything else. The one §9 claim that
  *was* verified locally is §9.3's, because it turns on plenary and plenary is
  installed.
- `nvim-treesitter` is installed but **archived upstream and never `setup()`-ed**;
  `tree-sitter-manager.nvim` is the live query supply. §11.6.1 is the consequence
  and it is the most implementation-relevant finding in §11.

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

---

## 8. Third-party plugins: what to copy

### 8.1 conform.nvim — the reference implementation

`~/.local/share/nvim/lazy/conform.nvim/lua/conform/runner.lua` is the most
complete buffer→CLI code on this machine and the single best thing to read. What
hive takes:

- **`pcall` around `vim.system`** (`:405`), per §2.
- **Staleness guard** (`:557`) — capture, compare, discard:
  ```lua
  local changedtick = vim.b[bufnr].changedtick
  ...
  if not vim.api.nvim_buf_is_valid(bufnr) or changedtick ~= util.buf_get_changedtick(bufnr) then
    err = { code = errors.ERROR_CODE.CONCURRENT_MODIFICATION, ... }
  ```
  logged at INFO, not ERROR (`errors.lua:19`, `:25`), so a racing edit does not
  spam notifications.
- **The shutdown edge case** at `util.lua:187`, which is not guessable:
  ```lua
  -- changedtick gets set to -1 when vim is exiting. We have an autocmd that should
  -- store it in last_changedtick before it is set to -1.
  if changedtick == -1 then return vim.b[bufnr].last_changedtick or -1
  ```
  fed by a `BufWinLeave` autocmd (`init.lua:177`). Without it, any
  format/apply-on-exit path *always* discards its result.
- **Write-back is a diff, never a full replace** (`:182` `M.apply_format`):
  append `""` to both old and new before diffing because `indices` cannot signal
  an eol-only change (`:199`–`:207`); **abort on suspicious empty output**
  (`:210`, *"black outputs nothing for excluded files"*); diff with
  `histogram` (`:221`); shrink each hunk by common byte prefix/suffix (`:92`,
  `:133`) so marks inside untouched parts of a changed line survive; then
  `pcall(vim.cmd.undojoin)` (`:286`) and `apply_text_edits`.
- **Cancellation by pid stamp** — `vim.b[bufnr].conform_pid` at `:477`, and a new
  run kills the old one with `uv.kill` at `:551`. If a job fails *and* the pid no
  longer matches it reports `INTERRUPTED` rather than `RUNTIME` (`:452`), so the
  error is attributed correctly.
- **Interruptible sync wait** at `:709`, per §2.
- **Per-tool exit codes** (`:402`, checked at `:417`) — many tools exit non-zero
  as *signal*, not failure.
- **Notify debounce** (`errors.lua:6`) so a persistently broken tool notifies once
  and points at a log.

Two things conform does that hive must **not** copy: `pcall(vim.cmd.undojoin)` is
exactly backwards for partial accept (§12.6), and the tempfile mode
(`stdin = false`) is irrelevant.

### 8.2 gitsigns.nvim — the architecture, not just the helper

Two contributions. The first is `util.buf_lines` (`util.lua:128`), the most
complete buffer→bytes function anywhere — `fileformat`, `endofline` *and* `bomb`
(§1).

The second is more important and is the model for §12.8: **gitsigns keeps the
base text as truth and recomputes the diff; extmarks are display only.**
`compare_text` is the cached base (`cache.lua:20`) and `CacheEntry:get_hunks()`
(`cache.lua:295`) is `run_diff(text, buftext, false)`. Every extmark in the
codebase — `signs.lua:113`, `word_diff.lua:84`, `blame.lua`, `preview.lua`,
`deleted_preview.lua` — is rendering. Nothing reads one back as data.

Also worth stealing: every git call goes through one hardened wrapper
(`git/cmd.lua:21`) with `-c gc.auto=0` (`:27`, *"Disable auto-packing which emits
messages to stderr"*) and `LC_ALL=C LANGUAGE=C` at `:44` so **stderr
pattern-matching survives a translated git**. Its staleness guard is a *retry*
rather than a discard (`cache.lua:164`), plus a detach guard — *"the buffer may
have been detached … while an earlier blame was in flight"*.

### 8.3 The tempfile fallback — *retired*

Was: conform's `.conform.$RANDOM.$FILENAME` written next to the real file (not in
`/tmp`) so project-relative config discovery still works, `0700`, cleanup on every
exit path. hive sends on stdin and never needs a temp file (§9.3).

### 8.4 Cancellation: kill *and* a generation counter

From telescope. The job is killed on every keystroke
(`async_job_finder.lua:31`), **and** a monotonic `find_id` generation counter
(minted at `pickers.lua:499`, compared at `:1415`) drops results from a stale
generation. Two layers, because a killed process's callback may already be
queued. neo-tree's variant follows `job:shutdown()` with a hard `kill -9` because
`fd` may ignore SIGTERM.

That belt-and-braces pattern is what `IMPLEMENTATION.md` §9.3 adopts: kill the
in-flight `SystemObj`, and also drop any response whose generation is stale.

### 8.5–8.9 Chunking, incremental stdin, blocking calls, the summary matrix — *retired*

Was: blink.cmp's byte-budget chunker (20 KB sync / 200 KB async / 500 KB total,
soft-min 2000 / hard-max 4000 bytes, whitespace-aligned, `vim.schedule` between
chunks); `uv.spawn` + `new_pipe` for incremental stdin writes (mason, plenary
`Job`); an inventory of plugins that block the editor with `vim.fn.system`; and a
matrix mapping every pattern to every plugin.

Retired: hive's budget is token-based and prompt-shaped, not a buffer-scanning
budget (`IMPLEMENTATION.md` §8.3), and its body is one `stdin` string.

One correction to that framing, from measurement: hive's budget is token-shaped
but **latency-bound**. `IMPLEMENTATION.md` §8.3.1 measures 59–88 tok/s of prefill
on this CPU-only machine, so the ceiling is set by how long a submit may take,
not by what the model can hold — and those figures, and every default derived
from them, must be re-measured on a machine with a dedicated GPU (§8.3.4).

### 8.10 Correctness checklist

The densest useful thing in the original survey. Kept in full because it is a
review checklist, not prose.

- **Trailing newline out:** conform `runner.lua:371` (`vim.bo.eol`); gitsigns
  `util.lua:140` (`endofline`); core `vim/lsp.lua:110`.
- **Trailing newline back:** conform `runner.lua:430` — drop one trailing `""`,
  then re-insert if the array went empty, because *"Vim will never let the lines
  array be empty"*.
- **CRLF / fileformat:** conform writes back with `util.buf_line_ending`, not
  `\n`; telescope strips all CR on read.
- **BOM:** only gitsigns (`util.lua:148`).
- **Cursor / marks / extmarks:** minimal `TextEdit` diffs + `apply_text_edits`,
  never whole-buffer `set_lines`.
- **Undo:** `pcall(vim.cmd.undojoin)` to *merge* (conform `runner.lua:286`);
  `let &undolevels=&undolevels` to *break* (§9.1, §12.6). Choose deliberately.
- **Staleness:** discard (conform) vs retry (gitsigns) vs cache-key (blink) —
  plus conform's `changedtick == -1` shutdown case.
- **Buffer validity / detach:** `nvim_buf_is_valid` on every async return.
- **Cancellation:** pid stamp + `uv.kill`, *and* a generation counter (§8.4).
- **Timeouts:** hive's 5 s head start over curl's `--max-time` is already right.
- **Exit codes:** configurable per tool; non-zero is often a signal, not failure.
- **Error surfacing:** notify debounce so a broken tool notifies once; ENOENT
  turned into "could not find executable in PATH" (mason `process.lua:227`).
- **No silent caps:** if a budget drops content, say so. Silent truncation reads
  as "covered everything" when it didn't. Note that hive is not the only party
  that can truncate: ollama silently drops the *head* of an over-long prompt,
  taking the FIM sentinel with it, and returns HTTP 200
  (`IMPLEMENTATION.md` §8.3.7).
- **Hygiene:** large payloads kept off argv via stdin; env redacted before
  logging (mason `process.lua:155`).

---

## 9. The AI plugins: the findings that survive

Four plugins whose entire job is shipping buffer text to a model —
`copilot.lua`, `supermaven-nvim`, `codecompanion.nvim`, `avante.nvim`. **None is
installed here**; these were read from upstream sources, so treat the line
numbers as softer than the rest of this document.

### 9.1 copilot.lua — the undo *break*, and a live utf-16 bug

**The undo break.** `suggestion/init.lua:657`:

```lua
-- Create an undo breakpoint
vim.cmd("let &undolevels=&undolevels")
```

The exact opposite of conform's `undojoin`, and correct: each accepted suggestion
should be independently undoable. §12.6 measures why this is the *only* thing
that works.

**A verified bug worth knowing**, because it is the trap §4 warns about.
`get_doc` deliberately requests utf-16 positions, so the server's ranges come
back in utf-16 offsets. But the accept path computes its encoding as
(`suggestion/init.lua:662`):

```lua
if not encoding or encoding == "" or encoding ~= "utf-8" or encoding ~= "utf-16" or encoding ~= "utf-32" then
```

Those `or`s are a tautology — no string differs from all three — so both branches
always fire and `encoding` is unconditionally `"utf-8"`. The intent was `and`.
Net effect: utf-16 ranges handed to `apply_text_edits` as utf-8, so on any line
with non-ASCII before the suggestion the edit lands at the wrong column.
`panel/init.lua:233` passes the literal `"utf-16"` and is correct, so the two
call sites disagree. **lua_ls negotiates utf-16 here too**; convert once at the
boundary.

Also from copilot: it never serializes a buffer at all, driving the agent as an
LSP server so core's `didOpen`/`didChange` carries the text. And it guards
staleness by deep-comparing the whole param table
(`suggestion/init.lua:378`) — since that table holds both `doc.version`
(= changedtick) and `position`, one `vim.deep_equal` subsumes a changedtick guard
*and* a cursor guard.

supermaven's contribution, in one line: it sends the cursor as a **byte offset**
(`offset = #prefix`), sidestepping the whole utf-16 problem copilot tripped on.

### 9.2 Persistent NDJSON peers — *retired*

Was: supermaven's `sm-agent stdio` with newline-delimited JSON instead of
`Content-Length`, its 50-generation stale-response *reuse* (strip what you have
since typed off the front of an old completion and use the remainder), and its
25 ms polling render loop. All interesting, none applicable to one-shot HTTP.

### 9.3 Body transport: hive's is already the best of the five

codecompanion (`http.lua:35`) and avante (`llm.lua:575`) both write the request
body to a temp file and pass the *path* as plenary's `body`. plenary's `body` is
polymorphic — verified in the local copy, `parse.file` at `curl.lua:153` emits
`{ "-d", "@" .. path }`, reached via the `in_file` branch at `:212` and appended
at `:239`; the `--data-raw`-on-argv branch is at `:124` and neither plugin
reaches it.

Three problems with the temp-file approach, all avoided by `--data-binary @-`
with `stdin = req.body`, which is what `hive.curl` already does:

1. **It's `-d @file`, not `--data-binary @file`.** Plain `-d` *strips CR and LF
   from the file*. Safe today only because `vim.json.encode` emits single-line
   JSON; any adapter that pretty-printed its body would be silently mangled.
2. **codecompanion retains the temp files on error** (`http.lua:57`), so the body
   *and* a plaintext API-key header file (it passes `--header @file` too) survive
   every failed request, and every request at `DEBUG`/`TRACE`. Written `0644`.
3. avante leaks them deliberately under `Config.debug` (`llm.lua:612`).

**Conclusions: do not "upgrade" to a body file**, and **do not add `--retry` to
the POST** — codecompanion's `--retry 3` (`http.lua:132`) makes a non-idempotent
completion re-issuable.

### 9.4 Streaming caveats, for when streaming is added

Deferred in v1. Four things to get right, three of them mistakes made upstream:

- **SSE `[DONE]` must be handled explicitly.** codecompanion's whole parser is
  `local find_json_start = string.find(data, "{") or 1` with **no `[DONE]`
  handling anywhere in the repo** — `data: [DONE]` contains no `{`, so it falls
  through, fails `vim.json.decode`, and is dropped. Real protocol corruption
  becomes indistinguishable from normal end-of-stream. avante does it properly
  per-provider (`openai.lua:592`), covering both wire shapes.
- **Partial-line carry is nobody's job by default.** Neither plugin implements it;
  both inherit it from plenary's `Job`, whose `on_output` is a `coroutine.wrap`
  keeping `result_line` across chunk boundaries (`job.lua:289`). Outside plenary
  it is yours — and per §2, `text = true` is ignored when `stdout` is a function.
- **Accumulate into a table joined once.** Every NDJSON implementation surveyed
  is `buffer = buffer .. data`, i.e. quadratic; core has
  `vim._core.stringbuffer` precisely to avoid it.
- **Disable compression while streaming** — gzipped bytes defeat line-splitting.

### 9.5 Incremental JSON parsing — *retired*

Was: avante's `libs/jsonparser.lua`, a real character state machine with an
`INCOMPLETE` state whose `finalize()` materializes truncated input tagged
`_incomplete`, so a half-arrived tool call still renders a live diff preview. Plus
the best single detail in the original survey — `llm_tools/replace_in_file.lua:33`
renames a parameter to `the_diff` so that alphabetical key order puts `path`
before the diff bytes and streaming can start rendering earlier.

Retired: hive requests plain code into a FIM hole, not a JSON tool call.

### 9.6 Render partial output as virtual text; write real text on completion

avante's streaming preview is virtual-only until the tool call completes
(`replace_in_file.lua:688`):

```lua
if not is_streaming then
  insert_diff_blocks_new_lines()      -- nvim_buf_set_lines
else
  highlight_streaming_diff_blocks()   -- virt_lines extmarks only
end
```

**This is the one design decision all four plugins get wrong somewhere**, and it
sidesteps the entire staleness problem for the streaming case. avante's
`selection.lua:146` does the opposite on its `AvanteEdit` path, re-splitting the
whole accumulated response and `set_lines`-ing on every chunk.

Its gating is also worth copying if streaming lands: two seconds of wall clock
**and** a line-count-changed check, both keyed by request id
(`replace_in_file.lua:121`), rather than the single time-based debounce
everything else uses.

### 9.7 Write-back: use `apply_text_edits`

The spectrum, worst to best:

- **codecompanion** (`insert_edit_into_file/init.lua:136`): wholesale
  `nvim_buf_set_lines(bufnr, 0, -1, ...)` then a forced `vim.cmd("silent write")`.
  Destroys every extmark and mark in the buffer, no `undojoin`, no cursor
  restore, and silently saves the user's file. It *does* compute a real
  `vim.text.diff` — but only to render its review UI, never to minimize the edit.
- **avante** writes real git conflict markers into the buffer on its legacy path
  (`sidebar.lua:760`).
- **copilot.lua and supermaven both use `vim.lsp.util.apply_text_edits`**,
  inheriting all of §4 for free. That remains the right default.

One genuinely better detail, from avante's diff UI (`replace_in_file.lua:193`):
**`undojoin` once per logical operation, not per write.**

```lua
local undo_joined = session_ctx.undo_joined[opts.tool_use_id]
if not undo_joined then
  pcall(vim.cmd.undojoin)
  session_ctx.undo_joined[opts.tool_use_id] = true
end
```

One undo entry per tool call across many re-applications; a naive join-every-write
would collapse the user's own preceding edit into the model's. That is the same
distinction `IMPLEMENTATION.md` §10.3 draws between a refresh (one break, many
writes) and an accept (one break each).

### 9.8 Repairing the model's diff — *retired*

Was: avante's five-tier fuzzy match ladder for locating old text
(`utils/init.lua:680`) and `Utils.fix_diff` (`:1682`), which transcodes a unified
diff into SEARCH/REPLACE, injects a missing `------- SEARCH`, and synthetically
closes an unterminated block — with the honest comment *"Some models (e.g.,
gpt-4o) cannot correctly return diff content and often miss the SEARCH line."*
Also a warning: tier 3 is `gsub("%s*", "")`, so `x = a+b` and `x = a + b` compare
equal, and `try_find_match` returns the *first* hit without checking uniqueness,
so a SEARCH block matching several sites silently edits the earliest.

Retired because hive designs the problem class out: it asks for code in a FIM
hole and computes the diff itself.

### 9.9 Nobody handles `fileformat`, `endofline` or BOM

All four are `table.concat(nvim_buf_get_lines(...), "\n")` — supermaven
`util.lua:139`, codecompanion `utils/buffers.lua:119`, avante
`utils/init.lua:330` and `:1380`; copilot sidesteps it only by never serializing a
buffer. **That is the strongest possible confirmation of §1**: the correctness
work core does in `_buf_get_full_text` is skipped in the wild by every plugin
whose core competency is sending buffers to a process.

Staleness guards range from good to absent: copilot deep-compares the param
table; supermaven compares content; codecompanion uses `mtime.sec` for files
(so sub-second races pass) and `changedtick` in exactly one place; avante
captures `changedtick` in `Utils.get_doc` and then **never uses it as a staleness
check** — its confirm-dialog rollback is `nvim_buf_set_lines(bufnr, 0, -1, false,
original_lines)`, which discards the user's concurrent edits along with the
model's.

---

## 10. The transport gaps in `hive.curl` today

Four concrete gaps, each with a precedent above. `IMPLEMENTATION.md` §9.3 is the
fix list.

1. **No `pcall` around `vim.system`** (`hive/curl.lua:141`, `:144`). The
   `vim.fn.executable("curl")` pre-check at `:120` covers the common case but not
   a bad `cwd` or a non-executable binary. Per §2, an unguarded throw in a
   coroutine is a silent hang.
2. **No cancellation handle.** `M.request` discards the `SystemObj`, so there is
   no `:kill()`. Required for supersede-on-refresh; pair it with a generation
   counter (§8.4).
3. **The blocking `:wait()` at `:141` is not interruptible.** conform's
   `vim.wait(remaining, fn, 5)` keeps the event loop turning so `<C-c>` works.
4. **No buffer→bytes function exists** — zero `nvim_buf_get_lines` and zero
   `changedtick` anywhere in `lua/hive/` (all seven modules, 558 lines).

What is already right and should not be touched: `stdin = req.body` with
`--data-binary @-` (§9.3), the `vim.schedule` around the callback, and the 5 s
timeout headroom over curl's own `--max-time`.

---

## 11. Selecting which bytes to send

### 11.1 Three layers, and what each cannot do

| Layer | Answers | Cannot answer | Latency |
| --- | --- | --- | --- |
| **treesitter** | where does this construct start and end | what is this identifier, where else is it used | sync, sub-millisecond |
| **LSP** | what is related to this, across files | anything, while the server is still indexing | one round trip, **async only** |

**LSP has no synchronous mode.** That is why `IMPLEMENTATION.md` §7.1 gives the
`documentSymbol` request a hard timeout and degrades region 2 to empty rather
than delaying a refresh.

*Retired:* a third row for "vimscript lists" — `getbufinfo().lastused`,
`getjumplist()`, `getchangelist()`, gitsigns hunks — as a recency signal. Cheap
and high-value for a completion prompt, but the workbench's context comes from
region 1 and the target cursor, so recency has no place in v1.

### 11.2 Treesitter: the boundary layer

Four core calls do the whole enclosing-construct walk: `vim.treesitter.get_node()`
(`treesitter.lua:394`), `node:parent()`, `vim.treesitter.get_node_text()`
(`:232`), and `vim.treesitter.select('parent')` (`:520`) if a user-driven "widen"
is ever wanted.

**Two traps, both silent.**

**`get_node()` on an unparsed tree returns a wrong node, and core says so.** The
docstring at `treesitter.lua:383` reads *"Calling this on an unparsed tree can
yield an invalid node"* and points at `get_parser(bufnr):parse(range)`. Nothing
guarantees the highlighter has run for the current tick, so the parse must be
explicit. Per §11.5 it costs 0.09 ms.

**Do not match node types by substring.** `while n:type():find('function')` is the
obvious walk and it stops at the first lambda. Measured with the cursor on
`lua/hive/curl.lua:125`, inside the `vim.schedule(function()` callback at `:123`:
it returns a `function_definition` starting at row 122 with no name and
`prev_named_sibling() == nil`, so §11.3's doc-comment walk then indexes `nil`.
Match an explicit per-language declaration type.

**The signature slice needs no per-language table** — but `body` is an *optional*
field, and this is the correction that matters most for a FIM plugin. Measured:

| Source | `body` |
| --- | --- |
| `lua`: `function M.f()` + `return 1` + `end` | `block` |
| `lua`: `function M.f() end` | **`nil`** |
| `lua`: `function M.f()` + `end` (two lines) | **`nil`** |
| `lua`: body of whitespace only | **`nil`** |
| `lua`: body of one comment only | **`nil`** |
| `python`: `def f():` + `pass`, or `...` | `block` |
| `typescript`: `function f() {}` | `statement_block` |
| `c`: `int f(void) {}` | `compound_statement` |

**Languages whose block is delimited by tokens (`{}`) always emit the body node
even when it is empty. Languages whose block is a bare statement list — Lua's
`block` between `)` and `end` — omit the field entirely when there is nothing in
it.** Ruby (`def f` … `end`) and the Erlang/Elixir family are the same shape and
should be assumed to behave the same way until measured.

The consequence is specific and severe for this plugin: **"I have written the
signature, fill in the body" is the central FIM use case, and it is exactly the
case where `field('body')` is `nil`.** A walk conditioned on
`node:field('body')[1] and DECL_TYPES[node:type()]` climbs straight past a
freshly-written empty function and falls back to a line window, silently. Test the
declaration *type* first and treat `body` as optional.

When `body` is present the slice is `node:start()` → `body:start()`; measured on
`function M.request` (`curl.lua:119`), `block` spans rows 119–148 so the slice is
row 118 alone — `function M.request(req, callback)`. When `body` is absent, fall
back to the end of the `parameters` node — the branch an empty Lua function
actually takes, since Lua's `function_declaration` does carry `parameters` — and
when that too is absent, to the declaration's own end row. Re-measured
2026-08-21: that last branch is unreached for every measured language. C lacks
the fields (see below) but its `function_definition` always carries a
`compound_statement` body, even for `{}` — a prototype is a `declaration` node,
a different type — so the body branch always fires for C; the end-row fallback
guards unmeasured grammars only.

**`field('parameters')` is missing on C as well**, not just `field('name')`: both
live inside `declarator`. Measured `params=false` for `int f(void) {}`.

The *declaration type* does need a table. Re-verified here for the five parsers
installed (`lua` `function_declaration`/`block`; `python`
`function_definition`/`block`; `typescript` and `tsx`
`function_declaration`/`statement_block`; `c` `function_definition`/
`compound_statement`), carried over from the earlier pass for `javascript`,
`rust` (`function_item`), `go`, `cpp`, `java`/`c_sharp` (`method_declaration`),
`ruby` (`method`/`body_statement`). **C and C++ have no `name` field** — the name
lives inside `declarator` — so anything keying on `name` breaks there. Verified
for `c`.

Use `get_node_text` rather than `nvim_buf_get_text` directly: its
`buf_range_get_text` helper (`treesitter.lua:203`) carries the `end_col == 0`
newline fixup at `:205`.

**Third trap: the declaration is often not a direct child of the root.** Measured
by walking the ancestor chain from a cursor in the body, per language:

| Source | node picked by "first ancestor with a `body` field" | its `prev_named_sibling()` |
| --- | --- | --- |
| `lua`: `function M.add(a, b)` | `function_declaration` | `comment` ✓ |
| `c`: `static inline int add(…)` | `function_definition` | `comment` ✓ |
| `typescript`: `function add(…)` | `function_declaration` | `comment` ✓ |
| `typescript`: **`export` function add(…)`** | `function_declaration` | **`nil`** |
| `typescript`: `export const add = (…) => {}` | **`arrow_function`** | `identifier` |
| `tsx`: `export const Button = (…) => {}` | **`arrow_function`** | `identifier` |
| `python`: `@app.route(…)` + `def handler(…)` | `function_definition` | **`decorator`** |

Three distinct structural facts, each of which breaks a naive walk:

1. **Wrapper nodes.** In TS/JS the declaration is a child of `export_statement`;
   in Python a decorated `def` is a child of `decorated_definition`. The chain is
   `function_declaration < export_statement < program`. So `prev_named_sibling()`
   on the declaration is `nil` — **the doc comment is a sibling of the wrapper,
   not of the declaration.** §11.3's walk silently finds nothing for every
   exported function in TS/JS, which is most of them.
2. **Value-position functions.** `export const add = (a, b) => {}` gives
   `arrow_function < variable_declarator < lexical_declaration < export_statement`.
   The `arrow_function` carries `body` but has **no `name` field** — the name is
   on `variable_declarator`. It is also not a "declaration" type, so a
   type-matched walk climbs straight past it and finds nothing. In modern TS and
   in every React codebase this is the common form, not an edge case.
3. **Non-comment preludes.** Python decorators are `decorator` siblings; Rust
   attributes (`#[derive(…)]`) and C#/Java annotations are the same shape. A walk
   that accepts only `comment` stops at the first one and drops it — and
   `@app.route("/x")` is frequently the single most informative line about what a
   function *is*.

The fix is two small per-language sets rather than one: **unwrap** node types to
climb through before deciding, and **prelude** node types to accept in §11.3's
walk alongside `comment`. `IMPLEMENTATION.md` §6.3 and §6.4 carry them.

### 11.2.1 Import and include sections

Measured node types at the top level, for the parsers installed here:

| Language | Import node types | Notes |
| --- | --- | --- |
| `python` | `import_statement`, `import_from_statement`, `future_import_statement` | three distinct types, all direct children of the root |
| `typescript` / `tsx` / `javascript` | `import_statement`, **plus `export_statement` that has a `source` field** | `import type {…}` and bare `import "./x.css"` are both `import_statement`. Re-exports (`export {bar} from "./bar"`, `export * from "./all"`) are `export_statement`; the `source` field is what distinguishes them from `export function f(){}` — verified true and false respectively |
| `c` / `cpp` | `preproc_include` | ranges have **`end_col == 0` and `end_row` = the following row**, so a slice must use `end_row` rather than `end_row + 1` — the same newline fixup class as §11.2's `get_node_text` note |
| **`lua`** | **none** | `local Config = require("hive.config")` is an ordinary `variable_declaration`, structurally identical to `local M = {}` and `local api = vim.api`. The grammar does not distinguish an import from any other local binding |

Reasoned from grammar shape, not measured here (no parser installed): `rust`
`use_declaration`; `go` `import_declaration`; `java` `import_declaration`;
`c_sharp` `using_directive`; `ruby` — same problem as Lua, `require` is a method
call.

**For languages with no import node, the portable substitute is the file
prologue**: every top-level node before the first node whose type is in
`DECL_TYPES`. Measured, it collects the right thing in all four cases:

```
lua          local api = vim.api | local Config = require("hive.config") | local M = {}
python       <module docstring> | import os | from flask import Flask | CONST = 1
typescript   import fs from "node:fs" | export { bar } from "./bar" | const K = 1
c            #include <stdio.h> | #define MAX 10 | typedef int myint;
```

Note it deliberately over-collects relative to a strict import list — `local api =
vim.api` is an alias rather than an import, `CONST = 1` is module state, `#define`
and `typedef` are neither — and that is the right call for a FIM prompt, because
all of them are names the completion may need to use. **The prologue boundary must
be keyed on `DECL_TYPES`, not on `field('body')`**, for the reason in §11.2: an
empty-bodied Lua function has no `body` field, so a body-keyed scan runs past it
and swallows the rest of the file.

### 11.3 Doc comments are siblings, not children

**The finding worth acting on first, because it fails silently.**

`function M.request` starts at `lua/hive/curl.lua:119`. Its LuaCATS block — nine
lines carrying every parameter and return type — occupies lines 110–118 and is
**not inside the `function_declaration` node**. A cut of the node range drops the
most information-dense text in the file and the prompt still looks fine.

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

The `prev_end < first - 1` guard is the whole trick; without it the walk keeps
climbing through unrelated comments further up the file. Re-measured against the
current `curl.lua`: consumes exactly 9 comments and stops at row 109.

**Python is the exception.** A docstring is the first statement *of the body*, so
it is inside the node and this walk must be skipped — two opposite bugs from one
naive implementation.

**LSP disagrees, by specification.** `lsp.DocumentSymbol.range` is *"the range
enclosing this symbol not including leading/trailing whitespace but everything
else like comments"* (`lsp/_meta/protocol.lua:1336`; the "comments and code"
wording belongs to `CallHierarchyItem.range`, `:212`). So treesitter and
LSP put the start of a function in different places. Normalize to one convention
before mixing them in a prompt.

### 11.4 Injected languages — the hazard that became a feature

`LanguageTree:language_for_range` (`languagetree.lua:1444`) gives the real
language at a position. Measured on a markdown buffer with a fenced Lua block:

| Row | Content | `language_for_range` |
| --- | --- | --- |
| 0 | `# t` | `markdown` |
| 3 | `local x = 1` inside a ` ```lua ` fence | `lua` |
| 6 | plain prose | `markdown_inline` |

**`parse()` alone is not enough.** Injections only exist after `parse(true)`,
which parses the child trees too; without it every row above reports `markdown`.
That is a third silent-wrong-answer case alongside §11.2's two.

Two consequences. The enclosing node must come from the *injected* tree, via
`tree_for_range` (`:1394`) or `node_for_range` (`:1421`), not the root parser.
And the output is a **parser** name, not a language name — row 6's
`markdown_inline` shows why it must be mapped before going in a prompt.

`IMPLEMENTATION.md` §3.3 turns this mechanism into the reason the session buffer
is markdown: prose regions get `markdown_inline`, fenced regions get the target
language, so region 2 and region 3 highlight correctly and are parseable as real
code with no extra work.

### 11.5 Parse cost is not a reason to avoid any of this

Re-measured on `lua/hive/curl.lua`, 152 lines, best of repeated runs:

| Operation | Measured |
| --- | --- |
| `get_parser()`, parser already loaded in-process, `lua` | 0.004–0.009 ms |
| `get_parser()`, already loaded, `python` (not runtime-bundled) | 0.051–0.077 ms |
| `get_parser()`, genuinely cold first call in a fresh process | ~3 ms `lua`, ~6–10 ms `python` |
| first `parse()` | 0.47–0.50 ms |
| `parse()` with no edit since | 0.0006 ms |
| `parse()` after a one-character insert | **0.090 ms** median |

An earlier pass recorded 22 ms for `get_parser()`; that does not reproduce — the
`.so` is `dlopen`ed, not compiled. Re-measured 2026-08-21: a genuinely cold
first call is ~3 ms (`lua`) / ~6–10 ms (`python`), so the sub-0.1 ms rows are
the warm path, and bundled-vs-site is ~2× cold rather than ~10×. Still an order
of magnitude under the retracted number, and it happens once per buffer.

**The number that matters is 0.090 ms.** There is no budget argument for keeping a
stale tree, debouncing the parse, or pre-loading a parser.

### 11.6 Query supply

Core ships queries for seven languages only (`c`, `lua`, `markdown`,
`markdown_inline`, `query`, `vim`, `vimdoc`). Counts of language directories
carrying each query **on disk**:

| Query | Core | nvim-treesitter | tree-sitter-manager |
| --- | --- | --- | --- |
| `folds` | 5 | 224 | 225 |
| `locals` | 0 | 151 | 153 |
| `textobjects` | **0** | **0** | **0** |

**`textobjects.scm` is not here.** `@function.outer` and `@class.outer` are the
obvious cross-language way to name constructs and nothing on this machine supplies
them, including tree-sitter-manager's 332-language bundle. Using them means adding
a dependency, not using what is present. §11.2's declaration-type table (five
languages measured, the rest reasoned) is the cheap substitute.

Read queries through core — `vim.treesitter.query.get(lang, name)`
(`treesitter/query.lua:290`, memoized) resolves from the rtp, so both plugins are
just files and hive imports neither Lua API. **But read §11.6.1 before relying on
the non-core columns above.**

### 11.6.1 The correction: those queries are not on the rtp

**The most implementation-relevant finding in §11.** The table above counts files
on disk. What `query.get` can load is much smaller, and it does **not** include
`locals` for Lua — the language hive is written in.

```
queries[lua]         highlights=true folds=true indents=false locals=false textobjects=false
queries[python]      highlights=true folds=true indents=true  locals=true  textobjects=false
queries[typescript]  highlights=true folds=true indents=true  locals=true  textobjects=false
queries[c]           highlights=true folds=true indents=true  locals=true  textobjects=false
```

`nvim_get_runtime_file('queries/lua/locals.scm', true)` returns `{}`;
`queries/lua/folds.scm` resolves to exactly one path, and it is core's.

Three independent reasons:

1. **Both plugins keep queries under `<plugin>/runtime/queries/`, not
   `<plugin>/queries/`.** lazy.nvim puts `<plugin>` on the rtp, so the search path
   becomes `<plugin>/queries/<lang>/<name>.scm`, which does not exist. Both plugin
   roots are on the rtp and neither contributes a single query file.
2. **`<plugin>/runtime/queries/` is an installer's *source*.** nvim-treesitter
   copies out of it into `install_dir`, defaulting to `stdpath('data')/site`
   (`config.lua:10`) — already on the rtp, which is why `setup()`'s rtp line
   (`config.lua:19`) only matters for a custom path. Nothing was installed through
   it here because this config declares it `lazy = false` with **no `config`,
   `opts` or `setup()` call at all**. It is on the rtp and inert — and archived
   upstream, so it will not grow a fix.
3. **tree-sitter-manager supplies queries per installed language, by symlink.**
   `installer.lua:22` `copy_queries()` symlinks
   `<plugin>/runtime/queries/<lang>` into `stdpath('data')/site/queries/<lang>`.
   Today that is 8 symlinks — `c`, `ecma`, `html`, `html_tags`, `jsx`, `python`,
   `tsx`, `typescript` — matching the 5 installed parsers plus shared includes.

**`lua` is absent because the Lua parser ships with the runtime**, so it was never
installed through the manager and nothing created the symlink. That is the trap:
*the language whose parser is most certainly present has the thinnest query
supply.*

**The fix hive ships: vendor the `.scm` files.** Verified — dropping a copy into a
`queries/lua/` directory on the rtp makes `query.get('lua', 'locals')` resolve to
it, and lazy.nvim already puts hive's root on the rtp, so no code is required.
`query.get` is memoized, so a query added mid-session needs
`vim.treesitter.query.get:clear()` (which is exactly what tree-sitter-manager
calls at `installer.lua:150` after an install).

**`vim.treesitter.query.get(lang, name) == nil` is a normal runtime state, not an
install error.** Every call site needs a nil branch.

### 11.7 `folds.scm` is the free language-agnostic chunker

The reachable count is core's 5 languages, not the 224 on disk — but `folds` is
the one non-trivial query reachable for Lua at all, it comes from core, and it
needs no plugin API.

Core's Lua `folds.scm` captures `do_statement`, `while_statement`,
`repeat_statement`, `if_statement`, `for_statement`, `function_declaration`,
`function_definition`, `parameters`, `arguments` and `table_constructor` as
`@fold`. Measured on `curl.lua`: **55 captures, 13 spanning more than three
lines.** Coarser than textobjects — `parameters` and `arguments` are
structurally uninteresting, and there is no capture name to tell a function from a
loop — but good enough to answer *"give me the next-largest complete construct"*.
(v1 later cut `folds` from region 3's strategy ladder — the fold-as-unit step
was never fully specified — so this survives as `IMPLEMENTATION.md` §7.3's R2
chunker only; revisit for the ML/homoiconic families.)

### 11.8 `locals.scm` is the discovery trigger

The interesting question for region 2 is not "what is near the cursor" but "what
does this code use that is defined somewhere else". `locals.scm` answers it with
no language server: collect `@local.scope` and `@local.definition.*`, then any
`@local.reference` with no matching definition in an enclosing scope is a
candidate.

Measured on `curl.lua` (query loaded by hand, per §11.6.1): 16 scopes, 24
distinct definitions, 151 `@local.reference` matches — those three counts are
file-wide. Restricting the *references* to `M.request`'s rows while resolving
bindings file-wide gives this free-reference set:

```
executable, fn, schedule, stdin, system, text, vim, wait
```

**Eight names, of which seven are fields of `vim`.** Both `lua/locals.scm:54` and
`python/locals.scm:124` are a bare `(identifier) @local.reference`, so every
identifier matches, field names included. Excluding identifiers that are the
`field` child of a `dot_index_expression` **or `method_index_expression`** —
`:wait()` is a method field, missed by the dot rule alone — (or `attribute` in
Python) leaves
`stdin, text, vim` — the right order of magnitude for a ranking key. The
field-side set here is `body, build_args, executable, fn, request, schedule,
system, timeout`.

There is no local reference implementation to copy: the earlier pass cited
`lua/arborist/locals.lua` and arborist is no longer installed;
tree-sitter-manager is an installer with no scope-resolution API. The query plus
the walk above is the whole of it.

### 11.9 What LSP adds, and what it costs

| Want | Method | Core wrapper |
| --- | --- | --- |
| file outline, nearby signatures | `textDocument/documentSymbol` | `lsp/buf.lua:918` |
| resolve a free identifier | `textDocument/definition`, `textDocument/hover` | `lsp/buf.lua:343`, `:75` |
| callers and callees | `callHierarchy/incomingCalls`, `outgoingCalls` | `lsp/buf.lua:1020`, `:1027` |

`DocumentSymbol.detail` is specified as *"More detail for this symbol, e.g the
signature of a function"* (`lsp/_meta/protocol.lua:1320`). That is a rendered
signature for every symbol in the file, hierarchical, for one request, with no
per-language query to maintain — **the best tokens-per-round-trip available**, and
what `IMPLEMENTATION.md` §7.1 uses.

**`detail` is optional in the spec and most servers do not populate it.**
Measured on three servers over equivalent files, plus `clangd` (22.x,
mason-installed and auto-enabled here) in the 2026-08-21 verification pass — the
C row the original survey missed:

| Server | `detail` | kinds | `offset_encoding` |
| --- | --- | --- | --- |
| `lua_ls` | `"function (req)"` — but **omits the name** | very noisy: every local, table element, and `for`/`if` block, the last two typed `Package` | utf-16 |
| `pyright` | **`nil` for every symbol** | clean: `Function`, `Class`, `Method`, `Variable` | utf-16 |
| `tsgo` | **`nil` for every symbol** | clean, but an arrow function assigned to a `const` is **`Variable`**, not `Function` | **utf-8** |
| `clangd` | populated but **omits the name**: `"int (int)"`, `"const int"` | clean and shallow; a `const` global is **`Variable`**, never `Constant` | **utf-8** |

Three consequences, none of which the original survey anticipated:

1. **Do not build stubs from `detail`.** Two of four servers return nothing, and
   the two that populate it (lua_ls, clangd) omit the symbol's name. Any
   renderer that pattern-matches lua_ls's `"function (…)"` shape produces empty
   output everywhere else.
2. **`kind` is not a portable filter for "is this callable".** On `tsgo`,
   `export const mul = (a, b) => …` is `Variable`. A filter of
   `Function|Method|Class|…` drops most of a modern TS codebase. Constants are
   just as unportable: lua_ls types plain locals by *value* (`local CONST = 42`
   is `Number`, strings `String`, tables `Object`) and clangd's `const` globals
   are `Variable`, never `Constant`.
3. **`offset_encoding` is per-client, not global** — lua_ls and pyright utf-16,
   clangd and tsgo utf-8. Read it off the client that answered, never assume
   (§4, §9.1).

**`textDocument/hover` is the portable signature source.** Same three files:

```
python  def helper       -> "```python\n(function) def helper(value: int) -> int\n```"
ts      const mul arrow  -> "```typescript\nconst mul: (a: number, b: number) => number\n```\nMultiplies."
ts      function add     -> "```typescript\nfunction add(a: number, b: number): number\n```\nAdds two numbers."
```

Clean, fenced, and on TS it carries the doc comment too. clangd is the shape
exception: heading-first markdown (`### function ...`) with the fenced signature
**last**, and fenced as `cpp` even for C — so extract the fenced block wherever
it sits, never "first line after the fence". The cost is one request
per symbol instead of one per file, which is why `IMPLEMENTATION.md` §7.1 uses
`documentSymbol` only as an *inventory* (what exists, where, what kind) and gets
the signature from either a treesitter slice (same file, free) or `hover`
(cross-file, capped and cached per `changedtick`).

Call hierarchy is the strongest cross-file signal and the most expensive: two
requests, and the results are positions that then have to be read. Cache per
`changedtick`, and never on a keystroke path.

*Retired:* `textDocument/selectionRange` as a semantic widen. §11.2's treesitter
walk covers the workbench's needs synchronously.

### 11.10 Recency signals — *retired*

See the note under §11.1.

### 11.11 `vim.lsp.inline_completion` — the `on_accept` seam only

`$VIMRUNTIME/lua/vim/lsp/inline_completion.lua` (499 lines, 15,110 bytes) ships
the LSP 3.18 `textDocument/inlineCompletion` feature as overlay text, with a
Copilot quickstart in its module docs at `:9`.

The earlier pass advised checking it *before* building a context builder, on the
grounds that fronting the model as a language server would let core handle buffer
sync, rendering, staleness and cancellation. **That advice is retired for this
design.** The workbench's entire value is a hand-assembled three-region prompt,
which no `textDocument/inlineCompletion` request can express, and
`IMPLEMENTATION.md` §0.2 declares it a non-goal.

What survives is the file as a reference for two things: `on_accept` as the
extension seam (§12.1), and `lcp()` at `:111` as the longest-common-prefix
helper for skipping text the user has already typed — both reused in
`IMPLEMENTATION.md` §10.2.

### 11.12 nvim-treesitter-context, aerial.nvim, textobjects — *retired*

Not installed here, and §11.2's declaration table plus §11.7's `folds.scm` cover
what they would have supplied.

### 11.13 Build order — *retired*

Superseded by `IMPLEMENTATION.md` §15.

---

## 12. Provenance and partial accept

Which bytes in a buffer came from the model, and how to get an accepted — or
partially accepted — suggestion in without lying about either.

**No reference implementation exists.** Not one of the ten plugins surveyed tracks
where generated text came from after it lands; copilot, supermaven, avante and
codecompanion all forget the moment the text is in the buffer. Everything below
was derived from primitives and measured here.

### 12.1 Core's `inline_completion` is the seam, and it has no provenance

Its namespace holds ghost text only: one extmark written in `Completor:show()`
(`:204`, the extmark at `:258`) with `virt_text`/`virt_lines`, and
`Completor:hide()` (`:269`) is
`nvim_buf_clear_namespace(bufnr, namespace, 0, -1)`. `M.get()` calls
`abort()` → `hide()` **before** `accept()` runs (`:477`), so by the time the text
exists in the buffer every trace that a model produced it is gone.

**`on_accept` is the documented extension point and exactly the right shape**
(`:444`):

```
--- You can use it to modify the completion item that is about to be accepted
--- and return it to apply the changes, or return `nil` to prevent the changes
--- from being applied to the buffer so you can implement custom behavior.
---@field on_accept? fun(item: vim.lsp.inline_completion.Item): vim.lsp.inline_completion.Item?
```

An `Item` is `{ insert_text, range, client_id, command, _index }`. Partial accept
is `on_accept` returning an item with a sliced `insert_text`; provenance stamping
is the same callback returning `nil` and doing the write itself.

`Completor:accept()` (`:342`) is `nvim_buf_set_text` when `item.range` is set and
`nvim_paste` otherwise. **There is no `undojoin` and no undo break on either
path** — per §12.6 that means consecutive accepts are not independently undoable.

### 12.2 Extmarks are the primitive, and the *default* gravity is the one you want

Range extmark over `"generated"` (cols 4–13) in `"AAA generated ZZZ"`:

| Edit | default `rg=T, erg=F` | "grow" `rg=F, erg=T` |
| --- | --- | --- |
| insert inside (col 8) | `[4,15)` grows | `[4,15)` grows |
| insert **at start** (col 4) | `[6,15)` — **excluded** | `[4,15)` — **absorbed** |
| insert **at end** (col 13) | `[4,13)` — **excluded** | `[4,15)` — **absorbed** |
| delete 3 inside | `[4,10)` shrinks | `[4,10)` shrinks |
| newline in middle | `[0,4)-[1,5)` splits rows | same |

**Gravity only matters at the two boundaries** — interior edits grow or shrink in
every configuration, free. And the intuitive choice is wrong: the
`right_gravity = false, end_right_gravity = true` "grow" configuration **silently
claims text the user types immediately before or after the generated region.** The
API defaults exclude adjacent typing on both sides, which is the honest answer to
"did the model write this byte".

So: default gravity, and grow the range **explicitly** by re-setting the same `id`
when *you* extend it. Do not let gravity do it.

**Do not bracket an insertion with two point marks.** It looks elegant — an
`rg=false` mark and an `rg=true` mark, insert between them, read the pair as the
range — and it fails the same way: measured, after inserting `pcall(f)` the pair
reads correctly, but typing `ZZ` immediately after pushes the right mark and the
bracket becomes `"pcall(f)ZZ"`. A single range extmark with default gravity
already gets this right.

### 12.3 `invalidate = true` plus the default `undo_restore`

Deleting the entire marked range, then undoing:

| Config | after delete | after undo |
| --- | --- | --- |
| `invalidate=true` (default `undo_restore=true`) | `[4,4)` **INVALID** | `[4,13)` **restored exactly** |
| `invalidate=true, undo_restore=false` | **mark deleted** | still gone |
| no `invalidate` | `[4,4)`, collapsed but *valid* | `[4,13)` restored |

The first row is what provenance wants: while the text is deleted the mark
reports `invalid` in `details` so queries can filter it, and an undo brings the
exact original range back. **Omitting `invalidate` is the trap** — the mark
collapses to zero width but is still reported valid, so a query says "there is
provenance here" pointing at nothing. Reap `invalid` marks on a schedule, not
eagerly; eagerly defeats the undo restore.

### 12.4 `overlap = true` is not optional

```
cursor col 8 (middle of a mark spanning [4,13)), plain : {}
cursor col 8, overlap=true                             : {1}
cursor col 4 (the mark's start), plain                 : {1}
```

`nvim_buf_get_extmarks` over a range returns marks that *begin* inside it; a mark
that **contains** the position is missed entirely. The obvious "what is the
provenance under my cursor" query therefore works at the first byte of a
generated region and returns nothing for every other byte — a bug that presents
as "provenance mostly doesn't work" rather than as a wrong flag. Always pass
`{ details = true, overlap = true }`.

### 12.5 A reload silently re-points marks at unrelated text

**The worst finding here.** Mark on `"GENERATED"` at `[1,6)-[1,15)`, change the
file on disk, `:edit!`:

| Reload | mark | now covers |
| --- | --- | --- |
| file grew at the end | `[1,6)-[1,15)` | `"GENERATED"` — right, by luck |
| a line was **prepended** | `[1,6)-[1,15)` | `"aaa"` |
| every line differs | `[1,6)-[1,15)` | `"ent"` |

**A reload does not delete extmarks. It keeps them at their byte coordinates and
lets whatever text now occupies those coordinates inherit the provenance.** The
mark is still "valid", `invalidate` does not fire, nothing warns. `:bwipeout` and
reopen is the honest failure: new bufnr, zero marks.

Because the session buffer is a real file that *will* be reloaded, the guard is
mandatory. Fail closed — verified to drop the marks to zero:

```lua
api.nvim_create_autocmd({ 'BufReadPost', 'FileChangedShellPost' }, {
  buffer = bufnr,
  callback = function() api.nvim_buf_clear_namespace(bufnr, NS, 0, -1) end,
})
```

Provenance is cheap to regenerate; confidently wrong provenance is worse than
none.

### 12.6 Partial accept: slice the suggestion, and break undo every time

The mechanic is trivial — slice the stored suggestion string, insert the slice,
keep the remainder. Verified accepting `'pcall(require, "hive")'` a word at a time
with the mark extended in place by re-setting the same `id`:

```
accept word 1 (new)       buf={"local x = pcall"}          prov=id1="pcall"
accept word 2 (extended)  buf={"local x = pcall("}         prov=id1="pcall("
accept word 3 (extended)  buf={"local x = pcall(require"}  prov=id1="pcall(require"
```

One mark, not four. **The undo break is the part that is not optional:**

| Between three successive accepts | one undo removes |
| --- | --- |
| nothing | **all three** |
| `vim.wait(10)` | **all three** |
| `sleep 10m` | **all three** |
| `pcall(vim.cmd.undojoin)` | **all three** |
| `vim.cmd('let &undolevels=&undolevels')` | just the last |

Repeated in real insert mode through `nvim_feedkeys` with an accept mapping:
without the break the whole insert session collapses to one undo step; with it
each accept is its own step. `nvim_paste` behaves identically, so neither of
core's two accept paths escapes it.

**Neither the passage of time nor an event-loop turn separates undo blocks.**
copilot.lua's `let &undolevels=&undolevels` (§9.1) is load-bearing, not
stylistic, and conform's `pcall(vim.cmd.undojoin)` is exactly backwards here —
right for a formatter, wrong for an accept. Re-measured: `undojoin` is worse
than no break at all — it merges the accepts into the *preceding* undo block,
so one undo also removed the user's own edit made before the first accept.

### 12.7 Provenance does not survive a rewrite; re-derive it

**Insert path** (a completion accept): the edit is a pure insertion at a known
position, so it is *already* minimal. Use `nvim_buf_set_text`; running
`vim.text.diff` buys nothing and costs what follows.

**Rewrite path** (the model replaces a region): §4 and §8.1's territory. Marks
*outside* the changed hunks survive correctly, including across an inserted row
(`[1,0)` → `[2,0)`), and a whole-buffer `nvim_buf_set_lines(0, -1, …)` destroys
everything and can leave a reversed range (`[3,0)-[0,0)`, INVALID). But:

**Every diff granularity destroys marks inside a rewritten hunk.** Rewriting
`local function f(a)\n  return a` to `f(a, b)\n  return a + b` with a mark on
`"return a"`:

| Strategy | mark |
| --- | --- |
| line-granular hunk, no shrink | **INVALID** |
| + conform's byte prefix/suffix shrink (`runner.lua:92`, `:133`) | **INVALID** |
| `ctxlen=0, linematch=10` | **INVALID** |
| `algorithm='minimal'` | **INVALID** |

All four produce the same hunk `{1, 2, 1, 2}`; the shrink cannot help because the
changed span runs `[0,18)`→`[1,10)`, straight through the mark. Semantically
correct — those bytes were replaced — but it means **provenance is not preserved
through a rewrite, it is re-derived as you apply it.**

The verified recipe: reverse-sort hunks so earlier positions stay valid (§4), one
undo break for the whole rewrite, then apply-and-stamp each hunk immediately.
Measured on a two-hunk rewrite: provenance covers exactly the rewritten regions,
an unrelated mark on an untouched row is undisturbed, and one undo reverts
everything. `IMPLEMENTATION.md` §10.4 is this loop.

### 12.8 The durable model: store the base, recompute the diff

gitsigns' architecture (§8.2) is the design that survives editing, and it is
**not** mark-based: `compare_text` is truth, `get_hunks()` recomputes, every
extmark is display. That inversion buys three things extmarks cannot — immunity
to §12.5 (a reload just changes `buftext`), immunity to §12.7 (a rewrite is just
a new `buftext`), and persistability (§12.10).

The cost is that it answers a slightly different question — *"how does this differ
from what the model produced"* rather than *"which bytes are the model's"* — and
needs a diff per query rather than a lookup.

**The hybrid is what hive builds:** the session file on disk is the durable
record, and extmarks with default gravity, `invalidate = true` and the §12.5
reload guard are the live index for rendering. When they disagree, the file wins.

### 12.9 `on_bytes` if per-byte truth is ever needed

Region marks degrade honestly but coarsely. Measured: accept `"\n  return true"`,
then let the user replace `return` with `error` inside it — the mark now reports
`"\n  error true"` as generated. At region granularity provenance means *"this
region was seeded by the model"*, which is usually the useful claim.

For the stronger claim, `nvim_buf_attach`'s `on_bytes` gives every edit as an
exact byte delta with the `changedtick`:

```
set_text(b, 0, 5, 0, 5, {' there'})   tick=3 start=[0,5]@5 old=(0,0,0) new=(0,6,6)
set_text(b, 0, 0, 0, 5, {'HI'})       tick=4 start=[0,0]@0 old=(0,5,5) new=(0,2,2)
```

Enough to maintain an interval map and attribute each edit to model or user. It is
the most code of any option here and the same feed core uses for incremental
parsing (`languagetree.lua:1247`). Not in v1.

### 12.10 Nothing persists extmarks

Extmarks live for the lifetime of the buffer and no longer — `:bwipeout` and
reopen gives zero marks (§12.5). `:h api-extended-marks` makes no persistence
claim, and grepping `starting.txt` and `undo.txt` for `extmark` returns nothing;
ShaDa stores file marks, uppercase marks, registers and jumplists, not extmarks,
and undo files do not carry them.

**This is why the session buffer is a real file** rather than a scratch buffer
(`IMPLEMENTATION.md` §3.1): text plus a path is the only substrate that
round-trips a restart.

### 12.11 Rendering it

All five presentations work on a single provenance mark, so it is a taste
decision: `hl_group` on the range, `sign_text` + `sign_hl_group`,
`line_hl_group`, `number_hl_group`, or trailing `virt_text` with
`virt_text_pos = 'eol'`.

If provenance highlighting ever gets expensive, avante's decoration-provider
pattern (`diff.lua:439`, `nvim_set_decoration_provider` gated on `changedtick`)
computes only for visible windows at redraw, once per tick — strictly less work
than any autocmd. Start with `hl_group` and only reach for that if a large buffer
shows it.

### 12.12 Build order — *retired*

Superseded by `IMPLEMENTATION.md` §15.

---

## Verification

Reading confirmation and measurement, not tests — nothing here modifies the
plugin. `make test` and `:checkhealth hive` are unaffected.

**§1 — line endings.** On a buffer with `:set noeol nofixeol`, and again with
`:set fileformat=dos`:

```vim
:lua =vim.inspect(vim.lsp._buf_get_full_text(0))
:lua =vim.inspect(vim.api.nvim_buf_get_lines(0,0,-1,true))
```

The difference between those two outputs is the entire §1 argument. Then check a
filter is byte-exact, and watch it fail with the table form:

```lua
:lua local t = vim.lsp._buf_get_full_text(0)
     print(vim.system({'cat'}, { stdin = t, text = true }):wait().stdout == t)
```

**§11.2/§11.3 — the node walk.** Cursor inside a doc-commented function, Lua
buffer:

```lua
:lua local n = (vim.treesitter.get_parser(0):parse() and vim.treesitter.get_node())
     while n and n:type() ~= 'function_declaration' do n = n:parent() end
     local prev = n and n:prev_named_sibling()
     print(n:start(), prev and prev:type(), prev and prev:start())
```

On `lua/hive/curl.lua:131` this prints `118  comment  117`. Move the cursor to
`:125` and swap the condition for `n:type():find('function')` to reproduce the
lambda trap. Then the signature slice:

```lua
:lua local body = n:field('body')[1]
     print(vim.inspect(vim.api.nvim_buf_get_lines(0, n:start(), body:start(), false)))
```

gives `{ "function M.request(req, callback)" }`.

**§11.4 — injections.** In a markdown buffer with a fenced Lua block:

```lua
:lua local r = vim.fn.line('.') - 1
     local p = vim.treesitter.get_parser(0); p:parse(true)
     print(p:language_for_range({r,0,r,0}):lang())
```

Drop the `true` and every row reports `markdown`.

**§11.5 — parse cost.** In a *fresh* `nvim`, so the timer covers a cold load:

```lua
:lua local t = vim.uv.hrtime(); local ps = vim.treesitter.get_parser(0)
     print(('get_parser %.3f ms'):format((vim.uv.hrtime()-t)/1e6))
     t = vim.uv.hrtime(); ps:parse()
     print(('first parse %.3f ms'):format((vim.uv.hrtime()-t)/1e6))
```

~3 ms cold (sub-0.01 ms once loaded) and ~0.5 ms. If you measure 22 ms, the
timer is wrong.

**§11.6.1 — query supply.** In a **Lua** buffer:

```lua
:lua for _, q in ipairs({'highlights','folds','indents','locals','textobjects'}) do
       print(q, vim.treesitter.query.get(vim.bo.filetype, q) ~= nil) end
```

Expected: `highlights true`, `folds true`, and `indents`/`locals`/`textobjects`
all `false`. Then confirm *why*, which is the part that is easy to misdiagnose:

```lua
:lua =vim.api.nvim_get_runtime_file('queries/lua/locals.scm', true)   -- {}
:lua =vim.api.nvim_get_runtime_file('queries/lua/folds.scm', true)    -- core only
:lua =vim.treesitter.query.get('python', 'locals') ~= nil             -- true
:lua =vim.uv.fs_readlink(vim.fn.stdpath('data')..'/site/queries/python')
```

**§12.4 — the overlap trap.**

```lua
:lua local b=vim.api.nvim_create_buf(false,true)
     vim.api.nvim_buf_set_lines(b,0,-1,false,{'AAA generated ZZZ'})
     local ns=vim.api.nvim_create_namespace('t')
     vim.api.nvim_buf_set_extmark(b,ns,0,4,{end_row=0,end_col=13})
     print(#vim.api.nvim_buf_get_extmarks(b,ns,{0,8},{0,8},{}))              -- 0
     print(#vim.api.nvim_buf_get_extmarks(b,ns,{0,8},{0,8},{overlap=true}))  -- 1
```

**§12.6 — the undo break.**

```lua
:lua vim.cmd('enew!') vim.bo.undolevels=1000
     vim.api.nvim_buf_set_lines(0,0,-1,false,{''})
     for i=1,3 do
       vim.cmd('let &undolevels=&undolevels')   -- comment out to see it collapse
       local l=vim.api.nvim_get_current_line()
       vim.api.nvim_buf_set_text(0,0,#l,0,#l,{'w'..i..' '})
     end
     vim.cmd('undo') print(vim.inspect(vim.api.nvim_get_current_line()))
```

With the break: `"w1 w2 "`. Without it: `""`.

**§12.5 — the reload trap.** Place a mark, change the file on disk so a line is
*prepended*, `:edit!`, then read the text the mark now covers. It will be the
wrong line, and the mark will still report valid.

**Machine facts**, if this is ever re-read elsewhere:

```sh
nvim --version | head -1                       # NVIM v0.12.4
nvim --headless -c 'lua io.write(vim.env.VIMRUNTIME)' -c q
ls ~/.local/share/nvim/site/parser/            # c html python tsx typescript
ls -l ~/.local/share/nvim/site/queries/        # 8 symlinks into tree-sitter-manager
ls /usr/share/nvim/runtime/parser/             # the 7 bundled parsers
curl -s localhost:11434/api/version            # the local model server
```

If `site/queries/` is empty or the symlinks point elsewhere, §11.6.1 is the
section to re-derive first — §11.7, §11.8 and `IMPLEMENTATION.md` §7.2 all hang
off it.
